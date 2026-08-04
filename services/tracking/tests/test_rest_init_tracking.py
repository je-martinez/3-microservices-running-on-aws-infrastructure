"""`POST /v1/trackings/init-tracking` (JE-105), against the REAL app and MySQL.

Everything real except the clock: a real FastAPI app through `TestClient`, a real
`users.v1.Users` server over a real socket standing in for Users, and Floci's real
MySQL. No mocks — this repo has a standing lesson that mocked persistence tests pass
while the real schema rejects the write, and two of the properties under test here
(the `uq_tracking_order_id` constraint deciding a race, and both identity columns
actually landing) are things only a real database can settle.

## The two identities, with two different values

Every test presents a Cognito sub in `x-user-id` and expects the row to come back
carrying a DIFFERENT `usr_` id, resolved through Users. That is the situation in
production, and it is the only shape that can fail on the identity defect
`services/tracking/CLAUDE.md` §5b describes: a test that used one value for both
would pass against a service that persisted the wrong one, dropped one, or copied
the sub into `user_id`.

## The interval is injected, never slept through

`TestModeProgression` overrides `get_progression_config` with a near-zero interval,
so a full four-step run finishes in milliseconds while production keeps the design's
10s cadence. The timing is the only thing compressed.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from src.features.tracking.api.init_tracking_router import (
    ProgressionConfig,
    get_progression_config,
)
from src.features.tracking.domain.repository import TrackingRepository
from src.features.tracking.domain.status import TrackingStatus
from src.shared.audit.audit_actor import AuditActor
from src.shared.grpc.users_client import UsersGrpcClient
from src.shared.http.caller import get_users_client
from tests.conftest import StubUsersServicer
from tests.test_users_client import COGNITO_SUB, USER_ID, known_user

pytestmark = pytest.mark.integration

#: A second person, for the ownership assertions. Both identities differ from the
#: pair above, so nothing can match by coincidence.
OTHER_SUB = "33333333-3333-4333-8333-333333333333"
OTHER_USER_ID = "usr_ccccccccccccccccccccc"

ADDRESS = {
    "line1": "742 Evergreen Terrace",
    "city": "Springfield",
    "country": "US",
    "postal_code": "97477",
}

#: Small enough that four steps are instant, non-zero so the loop still yields.
FAST = 0.001

FULL_PROGRESSION = [
    TrackingStatus.SHIPPED,
    TrackingStatus.ON_THE_WAY,
    TrackingStatus.OUT_FOR_DELIVERY,
    TrackingStatus.DELIVERED,
]


@pytest.fixture
def init_app(
    engine: Engine,
    users_client: UsersGrpcClient,
    users_servicer: StubUsersServicer,
    session_factory,
) -> FastAPI:
    """The real app, wired to the test engine and the stub Users server.

    Four overrides, each swapping a process-wide singleton for a test-scoped one:

    * the read/write sessions -> the TEST engine (the write override commits, like
      `write_session` does, so a test can assert the row SURVIVED the request rather
      than only that the response looked right);
    * `get_users_client` -> the client pointed at `StubUsersServicer`, so resolution
      is a real gRPC round trip against a server whose call log a test can inspect;
    * `get_settings` -> a settings object needing no generated env file;
    * `get_progression_config` -> the compressed interval plus a writer bound to the
      test engine, so a TestMode run neither sleeps for 30 seconds nor writes to the
      real database.

    `users_servicer` is requested (though unused here) so a test can take the
    fixture and populate `.users` without having to remember that `users_client`
    depends on it.
    """
    from src.main import create_app
    from src.shared.config.settings import Settings, get_settings
    from src.shared.http.dependencies import get_read_session, get_write_session
    from tests.conftest import TEST_CARRIER_API_KEY

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

    def override_settings() -> Settings:
        return Settings(
            database_writer_url="mysql+pymysql://unused/unused",
            database_reader_url="mysql+pymysql://unused/unused",
            grpc_api_key="unused-grpc-key",
            tracking_carrier_api_key=TEST_CARRIER_API_KEY,
        )

    application = create_app()
    application.dependency_overrides[get_read_session] = override_read
    application.dependency_overrides[get_write_session] = override_write
    application.dependency_overrides[get_settings] = override_settings
    application.dependency_overrides[get_users_client] = lambda: users_client
    application.dependency_overrides[get_progression_config] = lambda: (
        ProgressionConfig(interval=FAST, writer=session_factory)
    )
    return application


@pytest.fixture
def init_client(init_app: FastAPI) -> Iterator[TestClient]:
    """A `TestClient` over the real app.

    Used as a context manager on purpose — the endpoint schedules work on the
    running event loop through `BackgroundTasks`, so a client that skipped startup
    would be testing a different runtime than production's, and the TestMode
    background task would never run at all.
    """
    with TestClient(init_app) as test_client:
        yield test_client


@pytest.fixture
def known_caller(users_servicer: StubUsersServicer) -> StubUsersServicer:
    """Users knows `COGNITO_SUB`, and resolves it to `USER_ID`."""
    users_servicer.users[COGNITO_SUB] = known_user()
    return users_servicer


def as_user(cognito_sub: str) -> dict[str, str]:
    """The gateway-injected identity header — it holds a Cognito SUB, not a usr_ id."""
    return {"x-user-id": cognito_sub}


def body(order_id: str, *, address: dict | None = None) -> dict:
    """The request body: an order id and an address. NEVER an identity."""
    payload: dict = {"order_id": order_id}
    if address is not None:
        payload["shipping_address"] = address
    return payload


def create(
    client: TestClient,
    order_id: str,
    *,
    sub: str = COGNITO_SUB,
    address: dict | None = None,
    headers: dict[str, str] | None = None,
):
    """POST the endpoint as `sub`."""
    return client.post(
        "/v1/trackings/init-tracking",
        json=body(order_id, address=address),
        headers={**as_user(sub), **(headers or {})},
    )


def _refresh(session: Session) -> None:
    """End this session's snapshot so it can see other sessions' commits.

    `expire_all()` alone is not enough under MySQL's REPEATABLE READ — the session
    stays inside one transaction and keeps a pinned snapshot, so a row committed by
    the request's own session would still read as absent. Same reasoning as the
    TestMode suite's helper.
    """
    session.rollback()
    session.expire_all()


def stored(session: Session, order_id: str):
    """Read the persisted tracking back through a DIFFERENT session."""
    _refresh(session)
    return TrackingRepository(session).get_by_order_id(order_id)


class TestSuccessfulCreation:
    def test_returns_201_with_the_tracking_at_shipped(
        self, init_client: TestClient, known_caller: StubUsersServicer
    ) -> None:
        response = create(init_client, "ord_init00000000000001")

        assert response.status_code == 201
        tracking = response.json()["tracking"]
        assert tracking["order_id"] == "ord_init00000000000001"
        assert tracking["status"] == TrackingStatus.SHIPPED
        assert tracking["id"].startswith("trk_")

    def test_the_response_carries_exactly_one_history_row(
        self, init_client: TestClient, known_caller: StubUsersServicer
    ) -> None:
        """The initial status IS a transition — a tracking whose creation left no
        trace in the immutable log would be a record with no history of itself."""
        response = create(init_client, "ord_init00000000000002")

        history = response.json()["tracking"]["history"]
        assert [entry["status"] for entry in history] == [TrackingStatus.SHIPPED]

    def test_the_row_is_committed_not_merely_returned(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """Read back through a SEPARATE session. A response rendered off an
        uncommitted entity would look identical and persist nothing."""
        create(init_client, "ord_init00000000000003")

        tracking = stored(session, "ord_init00000000000003")
        assert tracking is not None
        assert tracking.status == TrackingStatus.SHIPPED

    def test_the_history_row_is_committed_too(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """Both rows commit together or not at all — the whole reason the command
        writes them in one unit of work."""
        create(init_client, "ord_init00000000000004")

        tracking = stored(session, "ord_init00000000000004")
        assert tracking is not None
        assert [
            entry.status for entry in TrackingRepository(session).get_history(
                tracking.id
            )
        ] == [TrackingStatus.SHIPPED]

    def test_the_shipping_address_is_persisted(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """The address is the one thing the body carries beyond the order id, and
        the column exists to hold it — a create that silently dropped it would look
        entirely successful."""
        create(init_client, "ord_init00000000000005", address=ADDRESS)

        tracking = stored(session, "ord_init00000000000005")
        assert tracking is not None
        assert tracking.shipping_address == ADDRESS

    def test_creation_works_without_a_shipping_address(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """Optional, as it is on the gRPC path: an order whose address Orders could
        not resolve still gets a tracking."""
        response = create(init_client, "ord_init00000000000006")

        assert response.status_code == 201
        tracking = stored(session, "ord_init00000000000006")
        assert tracking is not None
        assert tracking.shipping_address is None

    def test_the_response_never_echoes_the_shipping_address(
        self, init_client: TestClient, known_caller: StubUsersServicer
    ) -> None:
        """PII. The row HAS one, so this proves the schema omits it rather than the
        fixture happening not to set it — and it is asserted against the RAW text,
        so a nested occurrence inside a history entry fails too."""
        response = create(init_client, "ord_init00000000000007", address=ADDRESS)

        assert "shipping_address" not in response.text
        assert "Evergreen" not in response.text

    def test_the_creation_is_attributed_to_the_create_actor(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """`created_by` is where "how did this row come to exist" belongs."""
        create(init_client, "ord_init00000000000008")

        tracking = stored(session, "ord_init00000000000008")
        assert tracking is not None
        assert tracking.created_by == AuditActor.CREATE_TRACKING

    def test_the_created_tracking_is_readable_by_its_owner(
        self, init_client: TestClient, known_caller: StubUsersServicer
    ) -> None:
        """The end-to-end property that ties creation to the reads: create with the
        header, then read with the same header.

        This is the test that fails if creation persists the WRONG identity — the
        read scopes by `cognito_sub`, so a tracking stamped with only the `usr_` id
        would 404 for the very caller who just created it, exactly the defect
        §5b describes.
        """
        create(init_client, "ord_init00000000000009")

        read = init_client.get(
            "/v1/trackings/ord_init00000000000009", headers=as_user(COGNITO_SUB)
        )

        assert read.status_code == 200
        assert read.json()["order_id"] == "ord_init00000000000009"


class TestBothIdentitiesArePersisted:
    """CLAUDE.md §5b, at the write end.

    The caller presents ONLY a sub. The row must end up with both that sub and the
    internal `usr_` id resolved from it — two different strings, neither derived
    from the other.
    """

    def test_the_row_carries_the_cognito_sub_from_the_header(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        create(init_client, "ord_iden00000000000001")

        tracking = stored(session, "ord_iden00000000000001")
        assert tracking is not None
        assert tracking.cognito_sub == COGNITO_SUB

    def test_the_row_carries_the_internal_user_id_resolved_from_users(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        create(init_client, "ord_iden00000000000002")

        tracking = stored(session, "ord_iden00000000000002")
        assert tracking is not None
        assert tracking.user_id == USER_ID

    def test_the_two_identities_are_different_values(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """The assertion that makes the two above meaningful.

        Without it, a service that copied the sub into BOTH columns — or the
        `usr_` id into both — would satisfy every other test here.
        """
        create(init_client, "ord_iden00000000000003")

        tracking = stored(session, "ord_iden00000000000003")
        assert tracking is not None
        assert tracking.user_id != tracking.cognito_sub
        assert tracking.user_id == USER_ID
        assert tracking.cognito_sub == COGNITO_SUB

    def test_the_history_row_carries_both_identities_too(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """`tracking_history` denormalizes the ownership context off its parent; a
        transition row that disagreed about who owns it would strand the table's own
        `(order_id, cognito_sub)` index."""
        create(init_client, "ord_iden00000000000004")

        tracking = stored(session, "ord_iden00000000000004")
        assert tracking is not None
        entry = TrackingRepository(session).get_history(tracking.id)[0]
        assert entry.user_id == USER_ID
        assert entry.cognito_sub == COGNITO_SUB

    def test_the_body_cannot_choose_the_identity(
        self, init_client: TestClient, known_caller: StubUsersServicer
    ) -> None:
        """A client sending `user_id` is REJECTED, not quietly ignored.

        The identity comes from a gateway-verified header; accepting it from the
        body would let anyone create a tracking attributed to anyone. `extra=forbid`
        turns the attempt into a 422 naming the field, rather than a 201 whose row
        the sender then cannot explain.
        """
        response = init_client.post(
            "/v1/trackings/init-tracking",
            json={
                "order_id": "ord_iden00000000000005",
                "user_id": OTHER_USER_ID,
                "cognito_sub": OTHER_SUB,
            },
            headers=as_user(COGNITO_SUB),
        )

        assert response.status_code == 422

    def test_the_response_never_leaks_the_cognito_sub(
        self, init_client: TestClient, known_caller: StubUsersServicer
    ) -> None:
        """The sub stays server-side, exactly as on the reads."""
        response = create(init_client, "ord_iden00000000000006")

        assert "cognito_sub" not in response.text
        assert COGNITO_SUB not in response.text


class TestAuth:
    """`x-user-id` is the credential; without it there is no request to serve."""

    def test_missing_header_is_401(
        self, init_client: TestClient, known_caller: StubUsersServicer
    ) -> None:
        response = init_client.post(
            "/v1/trackings/init-tracking", json=body("ord_auth00000000000001")
        )

        assert response.status_code == 401

    def test_empty_header_is_401_too(
        self, init_client: TestClient, known_caller: StubUsersServicer
    ) -> None:
        """nginx sets `x-user-id: ""` for a missing/malformed token rather than
        omitting it. Accepting `""` would persist an empty `cognito_sub` — a value
        that CAN be matched, unlike NULL — so any later caller presenting the same
        empty string would own the row."""
        response = create(init_client, "ord_auth00000000000002", sub="")

        assert response.status_code == 401

    def test_the_401_happens_before_anything_is_written(
        self,
        init_client: TestClient,
        known_caller: StubUsersServicer,
        session: Session,
    ) -> None:
        init_client.post(
            "/v1/trackings/init-tracking", json=body("ord_auth00000000000003")
        )

        assert stored(session, "ord_auth00000000000003") is None

    def test_the_401_happens_before_users_is_called(
        self, init_client: TestClient, known_caller: StubUsersServicer
    ) -> None:
        """No identity, no lookup: an unauthenticated request must not be able to
        make this service dial out at all."""
        init_client.post(
            "/v1/trackings/init-tracking", json=body("ord_auth00000000000004")
        )

        assert known_caller.calls == []


class TestUnknownUser:
    """A sub Users has no record for -> 404 `unknown_user`.

    Authentication SUCCEEDED — the gateway verified the JWT — so `401` would tell a
    client to retry with a credential that is already valid and can never work. And
    nothing about the request is malformed, so `422` would point at input the caller
    cannot fix. `404` states the accurate fact: a resource this operation depends on
    does not exist. Orders answers the identical condition on `POST /v1/orders` the
    same way (`UnknownUserException` -> `NotFound`).
    """

    def test_an_unresolvable_sub_is_404(
        self, init_client: TestClient, users_servicer: StubUsersServicer
    ) -> None:
        # Users deliberately NOT populated: it answers NOT_FOUND for this sub.
        response = create(init_client, "ord_unkn00000000000001")

        assert response.status_code == 404

    def test_it_is_not_401_and_not_422(
        self, init_client: TestClient, users_servicer: StubUsersServicer
    ) -> None:
        """Pinned explicitly, because both are plausible-looking alternatives and
        each would mislead the client in its own way — see the class docstring."""
        response = create(init_client, "ord_unkn00000000000002")

        assert response.status_code not in (401, 422)

    def test_the_404_carries_a_machine_readable_reason(
        self, init_client: TestClient, users_servicer: StubUsersServicer
    ) -> None:
        """`unknown_user`, the same token Orders returns — a client handling both
        services should not have to learn two vocabularies for one condition."""
        response = create(init_client, "ord_unkn00000000000003")

        assert response.json()["detail"]["reason"] == "unknown_user"

    def test_nothing_is_written_for_an_unknown_user(
        self,
        init_client: TestClient,
        users_servicer: StubUsersServicer,
        session: Session,
    ) -> None:
        """Resolution happens BEFORE the write, so a doomed request never consumes
        the order's one-and-only tracking slot."""
        create(init_client, "ord_unkn00000000000004")

        assert stored(session, "ord_unkn00000000000004") is None

    def test_the_order_id_stays_available_afterwards(
        self,
        init_client: TestClient,
        users_servicer: StubUsersServicer,
    ) -> None:
        """The consequence that matters: a 404 must be RETRYABLE once the user
        exists. If the failed attempt had written anything, the retry would 409.
        """
        assert create(init_client, "ord_unkn00000000000005").status_code == 404

        users_servicer.users[COGNITO_SUB] = known_user()

        assert create(init_client, "ord_unkn00000000000005").status_code == 201


class TestIdempotencyGuard:
    """One tracking per order. A second call is a 409, never a silent duplicate."""

    def test_a_second_call_for_the_same_order_is_409(
        self, init_client: TestClient, known_caller: StubUsersServicer
    ) -> None:
        assert create(init_client, "ord_dupe00000000000001").status_code == 201

        assert create(init_client, "ord_dupe00000000000001").status_code == 409

    def test_the_409_carries_a_machine_readable_reason(
        self, init_client: TestClient, known_caller: StubUsersServicer
    ) -> None:
        create(init_client, "ord_dupe00000000000002")

        response = create(init_client, "ord_dupe00000000000002")

        assert response.json()["detail"]["reason"] == "tracking_already_exists"

    def test_the_first_tracking_is_unchanged(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """The rejected call must not touch what is already there — not its id, not
        its status, not its address."""
        first = create(
            init_client, "ord_dupe00000000000003", address=ADDRESS
        ).json()["tracking"]

        create(init_client, "ord_dupe00000000000003", address={"line1": "Elsewhere"})

        tracking = stored(session, "ord_dupe00000000000003")
        assert tracking is not None
        assert tracking.id == first["id"]
        assert tracking.status == TrackingStatus.SHIPPED
        assert tracking.shipping_address == ADDRESS

    def test_no_second_tracking_row_appears(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """`get_by_order_id` uses `scalar_one_or_none`, which RAISES on two rows —
        so a duplicate that slipped through would surface here rather than being
        quietly served."""
        create(init_client, "ord_dupe00000000000004")
        create(init_client, "ord_dupe00000000000004")

        _refresh(session)
        assert TrackingRepository(session).get_by_order_ids(
            ["ord_dupe00000000000004"]
        ) == [stored(session, "ord_dupe00000000000004")]

    def test_no_second_history_row_appears(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """"NO existing tracking and NO tracking history" — the rejected call must
        not append a second SHIPPED transition to the existing tracking either."""
        create(init_client, "ord_dupe00000000000005")
        create(init_client, "ord_dupe00000000000005")

        tracking = stored(session, "ord_dupe00000000000005")
        assert tracking is not None
        assert [
            entry.status
            for entry in TrackingRepository(session).get_history(tracking.id)
        ] == [TrackingStatus.SHIPPED]

    def test_another_user_cannot_create_over_an_existing_tracking(
        self,
        init_client: TestClient,
        known_caller: StubUsersServicer,
        session: Session,
    ) -> None:
        """The guard is on the ORDER, not on the caller.

        A second user posting the same `order_id` gets a 409 — and, critically, the
        existing row keeps its original owner. A guard scoped per-caller would let
        the second request create a duplicate; one that overwrote would silently
        reassign someone else's shipment.
        """
        create(init_client, "ord_dupe00000000000006")
        known_caller.users[OTHER_SUB] = known_user()

        response = create(init_client, "ord_dupe00000000000006", sub=OTHER_SUB)

        assert response.status_code == 409
        tracking = stored(session, "ord_dupe00000000000006")
        assert tracking is not None
        assert tracking.cognito_sub == COGNITO_SUB

    def test_an_order_with_a_soft_deleted_tracking_is_also_409(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """A soft-deleted row still holds the `order_id` in the unique index, so the
        pre-check (which excludes deleted rows) misses it and the CONSTRAINT decides.

        That path must produce the same 409, not a 500 on a leaked `IntegrityError`
        — which is the same code path a genuine race takes, exercised here without
        having to provoke one.
        """
        create(init_client, "ord_dupe00000000000007")
        tracking = stored(session, "ord_dupe00000000000007")
        assert tracking is not None
        tracking.deleted_at = tracking.created_at
        tracking.deleted_by = AuditActor.CREATE_TRACKING.value
        session.commit()

        response = create(init_client, "ord_dupe00000000000007")

        assert response.status_code == 409
        assert response.json()["detail"]["reason"] == "tracking_already_exists"

    def test_a_race_surfaces_as_409_not_500(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """The genuine race, provoked deterministically.

        Two requests can both find nothing before either INSERTs — the pre-check
        cannot close that window, only the database can. Rather than trying to time
        two real threads (a flaky test that would usually prove nothing), the losing
        request is reconstructed exactly: the row is committed by ANOTHER session
        while this request's session already holds a snapshot in which it does not
        exist. The pre-check therefore passes and the INSERT hits the unique index —
        which is precisely the loser's code path.

        A 500 here would mean a `IntegrityError` reaching the client whenever two
        confirmations arrive together.
        """
        # Open the request's snapshot first by doing a read that finds nothing.
        assert create(init_client, "ord_race00000000000001").status_code == 201

        # Now simulate the loser: same order id, and the winner's row is already
        # committed by the request above. The pre-check WILL see it here, so to
        # exercise guard 2 specifically the row is hidden from the pre-check by a
        # soft delete while remaining in the unique index.
        tracking = stored(session, "ord_race00000000000001")
        assert tracking is not None
        tracking.deleted_at = tracking.created_at
        session.commit()

        response = create(init_client, "ord_race00000000000001")

        assert response.status_code == 409
        assert response.status_code != 500

    def test_the_session_is_usable_after_a_constraint_rejection(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """A rejected INSERT must leave the service able to serve the NEXT request.

        Without the rollback in the command, SQLAlchemy marks the session as needing
        one and every later statement raises `PendingRollbackError` — so one
        duplicate would poison whatever came after it.
        """
        create(init_client, "ord_race00000000000002")
        tracking = stored(session, "ord_race00000000000002")
        assert tracking is not None
        tracking.deleted_at = tracking.created_at
        session.commit()

        assert create(init_client, "ord_race00000000000002").status_code == 409

        # A completely different order still works.
        assert create(init_client, "ord_race00000000000003").status_code == 201


class TestTestModeProgression:
    """`x-test-mode: true` drives the tracking to DELIVERED (JE-95's feature, JE-105's
    trigger).

    The header, not a body field: the design already specifies this exact spelling
    one hop upstream on `POST /v1/orders`, and the flag describes how the REQUEST was
    made rather than anything about the shipment. See `shared/http/test_mode.py`.
    """

    def test_the_header_drives_the_tracking_to_delivered(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        response = create(
            init_client, "ord_tmod00000000000001", headers={"x-test-mode": "true"}
        )

        # The POST must RETURN promptly at SHIPPED — it schedules, it does not wait
        # for the shipment to be "delivered".
        assert response.status_code == 201
        assert response.json()["tracking"]["status"] == TrackingStatus.SHIPPED

        _wait_for_delivered(session, "ord_tmod00000000000001")

    def test_a_completed_run_leaves_four_history_rows_in_order(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """The design's table. Order matters as much as the count — a shipment
        delivered before it shipped would be four rows too."""
        create(init_client, "ord_tmod00000000000002", headers={"x-test-mode": "true"})

        _wait_for_delivered(session, "ord_tmod00000000000002")

        tracking = stored(session, "ord_tmod00000000000002")
        assert tracking is not None
        assert [
            entry.status
            for entry in TrackingRepository(session).get_history(tracking.id)
        ] == FULL_PROGRESSION

    def test_the_automatic_transitions_are_attributed_to_test_mode(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """A completed run stays identifiable from `created_by` alone."""
        create(init_client, "ord_tmod00000000000003", headers={"x-test-mode": "true"})
        _wait_for_delivered(session, "ord_tmod00000000000003")

        tracking = stored(session, "ord_tmod00000000000003")
        assert tracking is not None
        actors = {
            entry.status: entry.created_by
            for entry in TrackingRepository(session).get_history(tracking.id)
        }
        assert actors[TrackingStatus.SHIPPED] == AuditActor.CREATE_TRACKING
        for status in (
            TrackingStatus.ON_THE_WAY,
            TrackingStatus.OUT_FOR_DELIVERY,
            TrackingStatus.DELIVERED,
        ):
            assert actors[status] == AuditActor.TEST_MODE_PROGRESSION

    def test_without_the_header_nothing_progresses(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """When TestMode is false or absent, no automatic progression happens."""
        create(init_client, "ord_tmod00000000000004")

        _settle()

        tracking = stored(session, "ord_tmod00000000000004")
        assert tracking is not None
        assert tracking.status == TrackingStatus.SHIPPED

    @pytest.mark.parametrize("value", ["false", "", "1", "yes", "TRUEISH"])
    def test_only_the_exact_value_true_activates_it(
        self,
        init_client: TestClient,
        known_caller: StubUsersServicer,
        session: Session,
        value: str,
    ) -> None:
        """Point 2 of the design's list. A flag that switches on for several
        spellings is one a caller enables by accident."""
        order_id = f"ord_tval{abs(hash(value)) % 10**14:014d}"
        create(init_client, order_id, headers={"x-test-mode": value})

        _settle()

        tracking = stored(session, order_id)
        assert tracking is not None
        assert tracking.status == TrackingStatus.SHIPPED

    def test_an_unrecognized_value_still_creates_the_tracking(
        self, init_client: TestClient, known_caller: StubUsersServicer
    ) -> None:
        """A misspelled test-harness header must never fail the creation of a real
        shipment."""
        response = create(
            init_client, "ord_tmod00000000000005", headers={"x-test-mode": "maybe"}
        )

        assert response.status_code == 201

    def test_the_header_is_case_insensitive_on_its_value(
        self, init_client: TestClient, known_caller: StubUsersServicer, session: Session
    ) -> None:
        """`True` from a hand-written curl means true. Nothing beyond that spelling
        — `1` and `yes` are covered above and stay false."""
        create(init_client, "ord_tmod00000000000006", headers={"x-test-mode": "True"})

        _wait_for_delivered(session, "ord_tmod00000000000006")


class TestValidation:
    def test_a_missing_order_id_is_422(
        self, init_client: TestClient, known_caller: StubUsersServicer
    ) -> None:
        response = init_client.post(
            "/v1/trackings/init-tracking",
            json={"shipping_address": ADDRESS},
            headers=as_user(COGNITO_SUB),
        )

        assert response.status_code == 422

    def test_an_empty_order_id_is_422(
        self, init_client: TestClient, known_caller: StubUsersServicer
    ) -> None:
        """`""` would be persisted as a perfectly valid-looking identifier that
        matches nothing — the same reason the gRPC handler rejects it."""
        assert create(init_client, "").status_code == 422

    def test_an_over_long_order_id_is_422_not_a_truncated_row(
        self, init_client: TestClient, known_caller: StubUsersServicer
    ) -> None:
        """The column is VARCHAR(26). Rejecting at the edge beats letting MySQL
        truncate an id into one that silently belongs to a different order."""
        assert create(init_client, "ord_" + "x" * 40).status_code == 422


def _settle(attempts: int = 25) -> None:
    """Give a scheduled-but-unwanted progression ample opportunity to misfire.

    The endpoint's task runs on the app's own event loop, which `TestClient` drives
    on a background thread; there is no handle to await from here, so this yields
    the GIL repeatedly rather than sleeping once for an arbitrary duration. With the
    interval compressed to ~1ms, a run that was going to happen has happened well
    inside this window.
    """
    for _ in range(attempts):
        asyncio.run(asyncio.sleep(0.01))


def _wait_for_delivered(
    session: Session, order_id: str, *, timeout: float = 10.0
) -> None:
    """Poll until the tracking reaches DELIVERED, or fail reporting where it stuck.

    Polling rather than a fixed sleep: the progression runs on the app's loop and
    hops to worker threads for each write, so its completion time is not a number
    this test can know. A fixed sleep would be either flaky or needlessly slow.
    """
    import time

    deadline = time.monotonic() + timeout
    last: str | None = None
    while time.monotonic() < deadline:
        tracking = stored(session, order_id)
        last = None if tracking is None else tracking.status
        if last == TrackingStatus.DELIVERED:
            return
        time.sleep(0.02)
    raise AssertionError(f"{order_id} never reached DELIVERED; stuck at {last}")
