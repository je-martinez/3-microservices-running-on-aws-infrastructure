"""`DELETE /v1/trackings/e2e-cleanup` (JE-111), against the REAL app and MySQL.

Five properties, and each is the reason a different bug would ship:

1. **The flag decides whether the route EXISTS.** Off means it is absent from the
   routing table — not registered-and-refusing, because a registered route is one
   edited condition away from being live and shows up in the OpenAPI document
   either way.
2. **It deletes by TAG, and only by tag.** Untagged trackings — which is every
   tracking a real user ever created, including other users' — must survive a
   cleanup untouched. This is the property that replaced caller scoping.
3. **The tag needs the header AND the flag.** The header alone must never tag a
   row: that is the security half of the mechanism, and the half a refactor is
   most likely to drop, because dropping it breaks nothing visible.
4. **It requires no caller identity.** The harness's teardown sends no
   `x-user-id`; a `401` there would make the endpoint unusable by its only real
   caller. That is exactly what the caller-scoped version did.
5. **It is a SOFT delete.** The rows must still be in the table, stamped. The
   application database user has no `DELETE` privilege, so a hard delete would
   fail against the real server — which is exactly why these tests run against a
   real MySQL and not a mock.

## Why the app is built per test rather than reusing `client`

The flag is read while the app is CONSTRUCTED, so a fixture cannot flip it after
the fact — the routing table is already fixed. Each fixture below sets the
environment variable and then calls `create_app()`, which is also what proves the
mounting is genuinely conditional rather than a per-request check.

The tag, by contrast, reads the flag PER REQUEST (`parse_e2e_source`), so the
"flag off means no tag" case can be exercised against an app built either way —
and it is deliberately exercised against the app built WITHOUT the flag, which is
the production shape.

## Two identities, two values

As everywhere in this suite: the seeded rows carry a `usr_` id that is nothing like
the Cognito sub the caller presents. Nothing here scopes by either any more, which
is itself under test — `test_another_users_tagged_tracking_is_also_deleted` only
means something if the two people are distinguishable.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session, sessionmaker

from src.features.tracking.domain.models import (
    E2E_SOURCE_TAG,
    Tracking,
    TrackingHistory,
)
from src.features.tracking.domain.repository import TrackingRepository
from src.features.tracking.domain.status import TrackingStatus
from src.shared.audit.audit_actor import AuditActor
from src.shared.grpc.users_client import UsersGrpcClient
from tests.conftest import StubUsersServicer
from tests.test_users_client import COGNITO_SUB, known_user

pytestmark = pytest.mark.integration

# The INTERNAL ids, as resolved through Users at creation time.
USER_A = "usr_aaaaaaaaaaaaaaaaaaaaa"
USER_B = "usr_bbbbbbbbbbbbbbbbbbbbb"

# The Cognito subs the GATEWAY injects as `x-user-id` for those same two people.
SUB_A = "11111111-1111-4111-8111-111111111111"
SUB_B = "22222222-2222-4222-8222-222222222222"

CLEANUP_PATH = "/v1/trackings/e2e-cleanup"


def _build_app(engine: Engine, users_client: UsersGrpcClient) -> FastAPI:
    """The real app on the TEST engine and the stub Users server.

    The sessions and the Users client are overridden; the settings singleton
    deliberately is NOT. The mount decision reads the environment directly (see
    `settings.e2e_testing_enabled`), which is what lets the app be constructed
    without a valid environment at all — and that property is itself under test
    here, since these fixtures set nothing but the flag.

    The Users client is needed only by the tagging tests, which create through
    `POST /init-tracking` and therefore resolve a `usr_` id over gRPC. The cleanup
    route itself declares no identity dependency at all and never touches it —
    which is the point of `TestNoCallerIdentityRequired`.
    """
    from src.main import create_app
    from src.shared.http.caller import get_users_client
    from src.shared.http.dependencies import get_read_session, get_write_session

    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    def override_read() -> Iterator[Session]:
        db = factory()
        try:
            yield db
        finally:
            db.close()

    def override_write() -> Iterator[Session]:
        db = factory()
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    app = create_app()
    app.dependency_overrides[get_read_session] = override_read
    app.dependency_overrides[get_write_session] = override_write
    app.dependency_overrides[get_users_client] = lambda: users_client
    return app


@pytest.fixture
def known_caller(users_servicer: StubUsersServicer) -> str:
    """Users knows `COGNITO_SUB` and resolves it to a DIFFERENT `usr_` id.

    Returned as the sub to put in `x-user-id`, so a creating test reads as "post
    as this person" without restating the two-identities setup each time.
    """
    users_servicer.users[COGNITO_SUB] = known_user()
    return COGNITO_SUB


@pytest.fixture
def e2e_client(
    engine: Engine, users_client: UsersGrpcClient, monkeypatch: pytest.MonkeyPatch
) -> Iterator[TestClient]:
    """A client over an app built with `E2E_TESTING_ENABLED=true`."""
    monkeypatch.setenv("E2E_TESTING_ENABLED", "true")
    with TestClient(_build_app(engine, users_client)) as client:
        yield client


@pytest.fixture
def disabled_client(
    engine: Engine, users_client: UsersGrpcClient, monkeypatch: pytest.MonkeyPatch
) -> Iterator[TestClient]:
    """A client over an app built with the flag ABSENT — the production shape."""
    monkeypatch.delenv("E2E_TESTING_ENABLED", raising=False)
    with TestClient(_build_app(engine, users_client)) as client:
        yield client


def seed(
    session: Session,
    *,
    order_id: str,
    user_id: str = USER_A,
    cognito_sub: str | None = SUB_A,
    tags: list[str] | None = None,
    status: TrackingStatus = TrackingStatus.PLACED,
) -> str:
    """Create a COMMITTED tracking (plus its first history row); return its id.

    Committed, not merely flushed: the request under test runs on its own session,
    so an uncommitted row would be invisible to it and every assertion would pass
    or fail for the wrong reason.

    `tags` defaults to None -> `[]`, i.e. an ORDINARY tracking. Every test that
    wants a fixture row says so explicitly, so nothing is swept up by accident.
    """
    tracking = TrackingRepository(session).create(
        order_id=order_id,
        user_id=user_id,
        cognito_sub=cognito_sub,
        tags=tags,
        status=status,
        actor=AuditActor.CREATE_TRACKING,
    )
    session.commit()
    return tracking.id


def seed_tagged(session: Session, **kwargs) -> str:
    """A tracking tagged as an E2E fixture — what the cleanup is meant to delete."""
    return seed(session, tags=[E2E_SOURCE_TAG], **kwargs)


def as_user(cognito_sub: str) -> dict[str, str]:
    """The gateway-injected identity header — it holds a Cognito SUB."""
    return {"x-user-id": cognito_sub}


def row(session: Session, tracking_id: str) -> Tracking:
    """Read a tracking straight from the table, soft-deleted or not.

    Bypasses the repository on purpose: every read there filters `deleted_at IS
    NULL`, which is precisely the thing these assertions have to see through. A
    test that went through the repository could not tell "soft-deleted" from
    "hard-deleted", and that difference is the point of the endpoint.
    """
    session.expire_all()
    found = session.get(Tracking, tracking_id)
    assert found is not None, "the row was physically removed from the table"
    return found


class TestFlagGating:
    """The route exists only under `E2E_TESTING_ENABLED`."""

    def test_the_route_is_absent_from_the_routing_table_without_the_flag(
        self, disabled_client: TestClient
    ) -> None:
        """It must not EXIST — not exist-and-refuse.

        A route that is registered and answers `403` is still discoverable, still
        in the OpenAPI document, and still one edited condition away from being
        live. Asserted against the routing table itself, which is the fact that
        matters; the status code a request gets is a consequence of it (below).
        """
        paths = {
            (method, getattr(route, "path", None))
            for route in disabled_client.app.routes
            for method in (getattr(route, "methods", None) or set())
        }
        assert ("DELETE", CLEANUP_PATH) not in paths

    def test_the_request_is_refused_without_the_flag(
        self, disabled_client: TestClient, session: Session
    ) -> None:
        """`405`, not `404`, and that is not a bug — it is `/{order_id}` matching.

        With the cleanup router absent, `/v1/trackings/e2e-cleanup` still matches
        `trackings_router`'s `GET /v1/trackings/{order_id}` as a path; only the
        METHOD fails to match, so Starlette answers `405 Method Not Allowed`
        rather than `404`. Semantically identical for a caller — nothing serves
        `DELETE` here — and pinned rather than "fixed", because the alternative is
        registering a route in order to make it 404, which is precisely the
        exists-but-refuses shape the test above rules out.

        What is load-bearing is that it is NOT a success: no 2xx, and nothing
        written (next test).
        """
        seed_tagged(session, order_id="ord_e2eoff0000000000001")
        response = disabled_client.delete(CLEANUP_PATH)
        assert response.status_code == 405
        assert not response.is_success

    def test_nothing_is_deleted_when_the_route_is_absent(
        self, disabled_client: TestClient, session: Session
    ) -> None:
        """The 405 above is a routing miss, not a cleanup that quietly ran."""
        tracking_id = seed_tagged(session, order_id="ord_e2eoff0000000000002")
        disabled_client.delete(CLEANUP_PATH)
        assert row(session, tracking_id).deleted_at is None

    def test_the_flag_does_not_mount_a_delete_on_any_other_path(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Turning the flag on adds exactly ONE route, and it is this one.

        Soft-delete-only is a service-wide property (`test_app_factory.py` asserts
        no DELETE exists at all in the default shape). This pins that the E2E flag
        widens that surface by a single, named path rather than by a family of
        test-only routes nobody reviewed.
        """
        from src.main import create_app

        monkeypatch.setenv("E2E_TESTING_ENABLED", "true")
        deletes = [
            route.path
            for route in create_app().routes
            if "DELETE" in (getattr(route, "methods", None) or set())
        ]
        assert deletes == [CLEANUP_PATH]


class TestNoCallerIdentityRequired:
    """The teardown has no user session — requiring one would break its only use.

    This is the regression suite for the endpoint's original shape: it was scoped
    by the caller's `cognito_sub`, which meant it 401'd the harness that calls it.
    """

    def test_no_x_user_id_is_needed(
        self, e2e_client: TestClient, session: Session
    ) -> None:
        """The load-bearing one: a headerless call succeeds and does the work."""
        tracking_id = seed_tagged(session, order_id="ord_e2enoid000000000001")

        response = e2e_client.delete(CLEANUP_PATH)

        assert response.status_code == 200
        assert row(session, tracking_id).is_deleted

    def test_an_x_user_id_is_ignored_when_present(
        self, e2e_client: TestClient, session: Session
    ) -> None:
        """A stray header changes nothing: the scope is the tag, not the caller.

        B's tagged tracking goes even though A's header is on the request — the
        endpoint has no notion of "mine" left to consult.
        """
        theirs = seed_tagged(
            session,
            order_id="ord_e2enoid000000000002",
            user_id=USER_B,
            cognito_sub=SUB_B,
        )

        response = e2e_client.delete(CLEANUP_PATH, headers=as_user(SUB_A))

        assert response.status_code == 200
        assert row(session, theirs).is_deleted

    def test_an_empty_x_user_id_is_not_a_401_either(
        self, e2e_client: TestClient, session: Session
    ) -> None:
        """nginx sends `x-user-id: ""` for a missing/malformed token.

        The old shape answered `401` to that. This route reads no identity at all,
        so an empty header is as irrelevant as an absent one.
        """
        tracking_id = seed_tagged(session, order_id="ord_e2enoid000000000003")

        response = e2e_client.delete(CLEANUP_PATH, headers=as_user(""))

        assert response.status_code == 200
        assert row(session, tracking_id).is_deleted


class TestTagging:
    """`x-e2e-source` decides whether a created tracking is a fixture."""

    def test_the_header_tags_the_created_tracking(
        self, e2e_client: TestClient, session: Session, known_caller: str
    ) -> None:
        response = e2e_client.post(
            "/v1/trackings/init-tracking",
            json={"order_id": "ord_e2etag00000000000001"},
            headers={**as_user(known_caller), "x-e2e-source": "true"},
        )
        assert response.status_code == 201

        created = _tracking_by_order(session, "ord_e2etag00000000000001")
        assert created.tags == [E2E_SOURCE_TAG]

    def test_without_the_header_the_tracking_is_not_tagged(
        self, e2e_client: TestClient, session: Session, known_caller: str
    ) -> None:
        """An ordinary creation must produce an ordinary row.

        `[]`, not NULL: the column is NOT NULL with a `JSON_ARRAY()` default so
        "no tags" has exactly one spelling — and because `JSON_CONTAINS(NULL, …)`
        is NULL rather than false, which would exclude such a row from the
        cleanup for a reason that reads like an accident.
        """
        response = e2e_client.post(
            "/v1/trackings/init-tracking",
            json={"order_id": "ord_e2etag00000000000002"},
            headers=as_user(known_caller),
        )
        assert response.status_code == 201

        created = _tracking_by_order(session, "ord_e2etag00000000000002")
        assert created.tags == []

    def test_the_header_does_not_tag_when_the_flag_is_off(
        self, disabled_client: TestClient, session: Session, known_caller: str
    ) -> None:
        """THE security property, and the one a refactor would silently drop.

        `e2e_source = header AND E2E_TESTING_ENABLED`. Without the conjunction any
        client could tag its own rows by sending a single header — enlisting them
        for deletion by somebody else's teardown — and nothing observable would
        break, because the tag does nothing until a cleanup runs.

        Driven against the app built WITHOUT the flag, which is the production
        shape: the tag decision is made per request, so this is a genuine
        end-to-end check of the conjunction rather than of a constant.
        """
        response = disabled_client.post(
            "/v1/trackings/init-tracking",
            json={"order_id": "ord_e2etag00000000000003"},
            headers={**as_user(known_caller), "x-e2e-source": "true"},
        )
        assert response.status_code == 201

        created = _tracking_by_order(session, "ord_e2etag00000000000003")
        assert created.tags == []

    @pytest.mark.parametrize("value", ["false", "1", "yes", "", "TRUE-ish"])
    def test_only_the_exact_value_true_tags(
        self,
        e2e_client: TestClient,
        session: Session,
        known_caller: str,
        value: str,
    ) -> None:
        """A flag that switches on for several spellings is one enabled by accident.

        Note `TRUE` itself IS accepted (case-insensitively, next test) — what is
        rejected is everything that merely resembles a truthy value.
        """
        order_id = f"ord_e2eval{abs(hash(value)) % 10**12:012d}"
        response = e2e_client.post(
            "/v1/trackings/init-tracking",
            json={"order_id": order_id},
            headers={**as_user(known_caller), "x-e2e-source": value},
        )
        assert response.status_code == 201
        assert _tracking_by_order(session, order_id).tags == []

    def test_the_value_is_case_insensitive(
        self, e2e_client: TestClient, session: Session, known_caller: str
    ) -> None:
        """`True` from a hand-written curl should not silently mean false.

        Same rule `x-test-mode` follows — case-insensitive, and nothing beyond.
        """
        response = e2e_client.post(
            "/v1/trackings/init-tracking",
            json={"order_id": "ord_e2ecase0000000000001"},
            headers={**as_user(known_caller), "x-e2e-source": "True"},
        )
        assert response.status_code == 201
        assert _tracking_by_order(session, "ord_e2ecase0000000000001").tags == [
            E2E_SOURCE_TAG
        ]

    def test_a_tagged_creation_is_deleted_by_the_cleanup(
        self, e2e_client: TestClient, session: Session, known_caller: str
    ) -> None:
        """The two halves meet: what creation tags, teardown removes.

        Neither half is worth much alone — a tag nothing selects on, or a cleanup
        selecting on a tag nothing writes — so this drives the whole round trip
        through the HTTP surface rather than trusting the two unit-level facts.
        """
        e2e_client.post(
            "/v1/trackings/init-tracking",
            json={"order_id": "ord_e2eroundtrip000001"},
            headers={**as_user(known_caller), "x-e2e-source": "true"},
        )

        response = e2e_client.delete(CLEANUP_PATH)

        assert response.json() == {"deleted": 1}
        assert _tracking_by_order(session, "ord_e2eroundtrip000001").is_deleted


class TestCleanup:
    """The happy path: 200 with a count, and the tagged rows are stamped deleted."""

    def test_returns_200_with_the_deleted_count(
        self, e2e_client: TestClient, session: Session
    ) -> None:
        """The count is the body, not just a log field.

        "The suite still sees its fixtures" and "the cleanup matched nothing" are
        the same symptom from the harness's side; a bodiless `204` left it unable
        to tell them apart without reading this service's logs.
        """
        seed_tagged(session, order_id="ord_e2eok00000000000001")
        response = e2e_client.delete(CLEANUP_PATH)
        assert response.status_code == 200
        assert response.json() == {"deleted": 1}

    def test_the_tagged_trackings_become_unreadable(
        self, e2e_client: TestClient, session: Session
    ) -> None:
        """The observable effect: the read endpoint no longer finds it.

        Asserted through the API rather than the table, because "soft-deleted"
        only means anything if the reads honor it.
        """
        seed_tagged(session, order_id="ord_e2eok00000000000002")
        assert (
            e2e_client.get(
                "/v1/trackings/ord_e2eok00000000000002", headers=as_user(SUB_A)
            ).status_code
            == 200
        )

        e2e_client.delete(CLEANUP_PATH)

        assert (
            e2e_client.get(
                "/v1/trackings/ord_e2eok00000000000002", headers=as_user(SUB_A)
            ).status_code
            == 404
        )

    def test_all_of_the_tagged_trackings_go_at_once(
        self, e2e_client: TestClient, session: Session
    ) -> None:
        """It is a teardown, not a single-resource delete."""
        ids = [
            seed_tagged(session, order_id=f"ord_e2emany00000000000{n}")
            for n in range(1, 4)
        ]

        response = e2e_client.delete(CLEANUP_PATH)

        assert response.json() == {"deleted": 3}
        assert all(row(session, tracking_id).is_deleted for tracking_id in ids)

    def test_another_users_tagged_tracking_is_also_deleted(
        self, e2e_client: TestClient, session: Session
    ) -> None:
        """The scope is the tag across ALL users — not "mine".

        The inverse of the old ownership test, and deliberately so: the harness
        creates fixtures as several users within one run, and a teardown that only
        reached one of them would leave the rest behind forever.
        """
        mine = seed_tagged(session, order_id="ord_e2eboth0000000000001")
        theirs = seed_tagged(
            session,
            order_id="ord_e2eboth0000000000002",
            user_id=USER_B,
            cognito_sub=SUB_B,
        )

        response = e2e_client.delete(CLEANUP_PATH)

        assert response.json() == {"deleted": 2}
        assert row(session, mine).is_deleted
        assert row(session, theirs).is_deleted

    def test_calling_it_twice_is_fine(
        self, e2e_client: TestClient, session: Session
    ) -> None:
        """Idempotent: a second run stamps nothing and still answers 200.

        A teardown that failed when there was nothing left to tear down would make
        every rerun of the E2E suite red for the least interesting reason there is.
        The count going 1 -> 0 is what shows the second run was a no-op rather than
        a re-stamp.
        """
        seed_tagged(session, order_id="ord_e2etwice000000000001")
        assert e2e_client.delete(CLEANUP_PATH).json() == {"deleted": 1}
        assert e2e_client.delete(CLEANUP_PATH).json() == {"deleted": 0}

    def test_a_run_with_nothing_to_clean_gets_200_and_zero(
        self, e2e_client: TestClient
    ) -> None:
        """"No tagged trackings remain" is true whether or not anything was stamped."""
        response = e2e_client.delete(CLEANUP_PATH)
        assert response.status_code == 200
        assert response.json() == {"deleted": 0}


class TestUntaggedRowsSurvive:
    """The property that replaced caller scoping — and the one that matters most.

    This endpoint is an unscoped mass soft-delete. The only thing standing between
    it and a real user's data is the tag predicate, so every shape of untagged row
    is pinned here explicitly rather than left implied by the happy path.
    """

    def test_an_untagged_tracking_is_untouched(
        self, e2e_client: TestClient, session: Session
    ) -> None:
        """A real user's tracking, created without the header. It must survive."""
        real = seed(session, order_id="ord_e2ekeep0000000000001")
        tagged = seed_tagged(session, order_id="ord_e2ekeep0000000000002")

        response = e2e_client.delete(CLEANUP_PATH)

        assert response.json() == {"deleted": 1}
        assert row(session, real).deleted_at is None
        assert row(session, tagged).is_deleted

    def test_another_users_untagged_tracking_is_untouched(
        self, e2e_client: TestClient, session: Session
    ) -> None:
        """Untagged means safe regardless of whose it is."""
        theirs = seed(
            session,
            order_id="ord_e2ekeep0000000000003",
            user_id=USER_B,
            cognito_sub=SUB_B,
        )

        e2e_client.delete(CLEANUP_PATH)

        assert row(session, theirs).deleted_at is None

    def test_a_differently_tagged_tracking_is_untouched(
        self, e2e_client: TestClient, session: Session
    ) -> None:
        """The predicate is membership of the EXACT value, not "has any tag".

        A near-miss spelling must not match either — `JSON_CONTAINS` compares the
        whole element, so "e2e source" is a different string and stays.
        """
        other = seed(
            session, order_id="ord_e2ekeep0000000000004", tags=["something else"]
        )
        near_miss = seed(
            session, order_id="ord_e2ekeep0000000000005", tags=["e2e source"]
        )

        response = e2e_client.delete(CLEANUP_PATH)

        assert response.json() == {"deleted": 0}
        assert row(session, other).deleted_at is None
        assert row(session, near_miss).deleted_at is None

    def test_a_tracking_carrying_the_tag_among_others_is_deleted(
        self, e2e_client: TestClient, session: Session
    ) -> None:
        """Membership, not equality: the array may hold more than the one tag.

        Nothing writes a second tag today, but the predicate is
        `JSON_CONTAINS(tags, …)` rather than `tags = '["E2E Source"]'` precisely so
        it does not become wrong the first time something does.
        """
        tracking_id = seed(
            session,
            order_id="ord_e2emulti000000000001",
            tags=["another", E2E_SOURCE_TAG],
        )

        e2e_client.delete(CLEANUP_PATH)

        assert row(session, tracking_id).is_deleted

    def test_an_untagged_trackings_history_is_untouched(
        self, e2e_client: TestClient, session: Session
    ) -> None:
        """The cascade follows the FK from TAGGED parents only.

        `tracking_history` carries no `tags` column of its own, so this is what
        pins that the subquery selecting its parents is the tagged set and not
        every tracking.
        """
        real = seed(session, order_id="ord_e2ekeep0000000000006")
        seed_tagged(session, order_id="ord_e2ekeep0000000000007")

        e2e_client.delete(CLEANUP_PATH)

        assert not any(entry.is_deleted for entry in _history(session, real))


class TestSoftDeleteIsReal:
    """The rows stay in the table, stamped — never a physical DELETE."""

    def test_the_row_is_still_there_with_the_audit_columns_stamped(
        self, e2e_client: TestClient, session: Session
    ) -> None:
        tracking_id = seed_tagged(session, order_id="ord_e2esoft0000000000001")
        e2e_client.delete(CLEANUP_PATH)

        # `row()` asserts the row exists at all; a hard delete fails there.
        deleted = row(session, tracking_id)
        assert deleted.deleted_at is not None
        assert deleted.deleted_by == AuditActor.E2E_CLEANUP.value
        assert deleted.is_deleted

    def test_the_rest_of_the_row_is_left_alone(
        self, e2e_client: TestClient, session: Session
    ) -> None:
        """Only the two delete columns move: this is a stamp, not a scrub.

        Data must remain recoverable and auditable ([[soft-delete]]), which it is
        not if the cleanup also blanks the payload — or the tag that explains why
        the row was removed — on its way out.
        """
        tracking_id = seed_tagged(session, order_id="ord_e2esoft0000000000002")
        e2e_client.delete(CLEANUP_PATH)

        deleted = row(session, tracking_id)
        assert deleted.order_id == "ord_e2esoft0000000000002"
        assert deleted.user_id == USER_A
        assert deleted.cognito_sub == SUB_A
        assert deleted.status == TrackingStatus.PLACED.value
        assert deleted.tags == [E2E_SOURCE_TAG]

    def test_the_history_rows_are_soft_deleted_too(
        self, e2e_client: TestClient, session: Session
    ) -> None:
        """Otherwise a tracking's transitions outlive the tracking itself.

        `tracking_history` carries its own `deleted_at` and `get_history` filters
        on it, so leaving the children live would strand a readable trail under an
        unreachable parent.
        """
        tracking_id = seed_tagged(session, order_id="ord_e2esoft0000000000003")
        e2e_client.delete(CLEANUP_PATH)

        entries = _history(session, tracking_id)
        # The creation history row is still physically present…
        assert entries
        # …and every one of them is stamped by the cleanup actor.
        assert all(entry.is_deleted for entry in entries)
        assert all(
            entry.deleted_by == AuditActor.E2E_CLEANUP.value for entry in entries
        )


def _tracking_by_order(session: Session, order_id: str) -> Tracking:
    """Read a tracking by `order_id` straight from the table, deleted or not."""
    session.expire_all()
    found = session.execute(
        select(Tracking).where(Tracking.order_id == order_id)
    ).scalar_one_or_none()
    assert found is not None, f"no tracking was created for {order_id}"
    return found


def _history(session: Session, tracking_id: str) -> list[TrackingHistory]:
    """Every history row of a tracking, soft-deleted or not."""
    session.expire_all()
    return list(
        session.execute(
            select(TrackingHistory).where(
                TrackingHistory.tracking_id == tracking_id
            )
        ).scalars()
    )
