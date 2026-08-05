"""`user_id` on EVERY log line of an authenticated request, not just creation's.

The property under test is not "the id can be resolved" — `test_current_caller.py`
already covers that. It is that by the time a handler logs anything, and by the time
uvicorn logs its access line AFTER the handler returned, the ambient log context
already carries the internal `usr_` id. Before this, only `POST /init-tracking`
merged it, so a read's lines went out with a `cognito_sub` and nothing to join on.

## Why these assert on the CONTEXT and not on captured records

`caplog` captures records before the app's own `LogContextFilter` has run on them,
so asserting `record.user_id` would be asserting about a pipeline these tests do not
drive. What actually decides whether a line carries the field is the contextvar the
filter reads — so the tests read the same thing the filter would
(`get_log_context()`), from the two places that matter: inside a handler, and in a
dependency teardown, which runs after the handler returns and stands in for the
access line.

The teardown check is the one that would have caught the original bug. A merge
performed inside a sync `def` handler is visible *within that handler* and lost on
return, so an assertion made only from inside a handler passes against an
implementation whose access line still has no `user_id`.

## Two identities, always different values

`USER_ID` (`usr_…`) and `COGNITO_SUB` (a UUID) are deliberately unlike each other,
per `services/tracking/CLAUDE.md` §5b: a test that used one value for both could not
fail if the code stamped the sub where the internal id belongs.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator

import pytest
from fastapi import Depends, FastAPI
from fastapi.dependencies.utils import get_parameterless_sub_dependant
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from src.features.tracking.domain.repository import TrackingRepository
from src.features.tracking.domain.status import TrackingStatus
from src.shared.audit.audit_actor import AuditActor
from src.shared.grpc.users_client import UsersGrpcClient
from src.shared.http.caller import get_users_client
from src.shared.logging import get_log_context
from tests.conftest import StubUsersServicer
from tests.test_users_client import COGNITO_SUB, USER_ID, known_user

pytestmark = pytest.mark.integration

ADDRESS = {
    "line1": "742 Evergreen Terrace",
    "city": "Springfield",
    "country": "US",
    "postal_code": "97477",
}

#: A caller Users has never heard of. Authenticated (the gateway validated a JWT),
#: simply absent from the user directory.
UNKNOWN_SUB = "99999999-9999-4999-8999-999999999999"

#: The two user-scoped reads, the surfaces the context probe is attached to.
READ_PATHS = frozenset({"/v1/trackings", "/v1/trackings/{order_id}"})


@pytest.fixture
def seen() -> dict[str, dict]:
    """Where the probes record the context they observed.

    Two entries: what a handler saw while running, and what the teardown saw after
    it returned. The second is the access-line stand-in.
    """
    return {}


@pytest.fixture
def read_app(
    engine: Engine,
    users_client: UsersGrpcClient,
    users_servicer: StubUsersServicer,
    seen: dict[str, dict],
) -> FastAPI:
    """The real app, wired to the test engine and the stub Users server.

    Plus one addition the other REST fixtures do not need: a dependency injected
    onto the two READ routes that snapshots the log context during teardown.
    Attaching it to the real routes rather than to a throwaway one is the point — it
    observes the context of an actual `GET /v1/trackings/{order_id}` request, in the
    task that request ran in, after the handler has returned.
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

    async def snapshot() -> AsyncIterator[None]:
        # Runs BEFORE the handler...
        try:
            yield
        finally:
            # ...and again after it returned — the same position uvicorn's access
            # line occupies, and an `async def` so it stays in the request's own
            # task. `finally`, not a bare statement after the yield: a handler that
            # raises (the `404`) would otherwise skip the snapshot, and a failing
            # request is exactly the one whose line most needs an identity.
            seen["after_handler"] = dict(get_log_context())

    application = create_app()

    # Attached to THIS app's own route objects, after the fact. Not to
    # `trackings_router.router.dependencies`: that list is read when a route is
    # DECLARED, and these routes were declared at import time, so appending to it
    # later changes nothing (verified — the route's dependant is already built).
    # Mutating the app's copies also keeps the module-level router clean, so the
    # probe cannot leak into another suite's app.
    for route in application.routes:
        if getattr(route, "path", "") in READ_PATHS and "GET" in getattr(
            route, "methods", set()
        ):
            route.dependant.dependencies.append(
                get_parameterless_sub_dependant(
                    depends=Depends(snapshot), path=route.path
                )
            )

    application.dependency_overrides[get_read_session] = override_read
    application.dependency_overrides[get_write_session] = override_write
    application.dependency_overrides[get_settings] = override_settings
    application.dependency_overrides[get_users_client] = lambda: users_client
    return application


@pytest.fixture
def read_client(read_app: FastAPI) -> Iterator[TestClient]:
    with TestClient(read_app) as test_client:
        yield test_client


@pytest.fixture
def known_caller(users_servicer: StubUsersServicer) -> StubUsersServicer:
    """Users knows `COGNITO_SUB` and resolves it to `USER_ID`."""
    users_servicer.users[COGNITO_SUB] = known_user()
    return users_servicer


def seed(session: Session, *, order_id: str, cognito_sub: str = COGNITO_SUB) -> str:
    """A committed tracking owned by `cognito_sub`.

    `user_id` is a fixed internal id unrelated to the sub — the row's own value is
    irrelevant to these tests, which are about what the REQUEST resolves, not about
    what was persisted. Keeping them different is what stops a passing assertion
    from being explained by the row.
    """
    repo = TrackingRepository(session)
    tracking = repo.create(
        order_id=order_id,
        user_id="usr_zzzzzzzzzzzzzzzzzzzzz",
        cognito_sub=cognito_sub,
        shipping_address=ADDRESS,
        status=TrackingStatus.PLACED,
        actor=AuditActor.CREATE_TRACKING,
    )
    session.commit()
    return tracking.id


def as_user(cognito_sub: str) -> dict[str, str]:
    """The gateway-injected identity header — a Cognito SUB, not a `usr_` id."""
    return {"x-user-id": cognito_sub}


class TestReadsCarryTheInternalUserId:
    """THE regression test: remove the resolution and this class fails.

    A read filters by `cognito_sub` and never needs the `usr_` id to answer, which
    is exactly why nothing else would notice its absence.
    """

    def test_a_single_read_stamps_user_id_for_the_access_line(
        self,
        read_client: TestClient,
        session: Session,
        known_caller: StubUsersServicer,
        seen: dict[str, dict],
    ) -> None:
        seed(session, order_id="ord_logid0000000000001")

        response = read_client.get(
            "/v1/trackings/ord_logid0000000000001", headers=as_user(COGNITO_SUB)
        )

        assert response.status_code == 200
        # After the handler returned — where uvicorn's access line is emitted.
        assert seen["after_handler"]["user_id"] == USER_ID

    def test_the_batch_read_stamps_it_too(
        self,
        read_client: TestClient,
        session: Session,
        known_caller: StubUsersServicer,
        seen: dict[str, dict],
    ) -> None:
        """Both reads, not just the one someone remembered."""
        seed(session, order_id="ord_logid0000000000002")

        response = read_client.get(
            "/v1/trackings?order_ids=ord_logid0000000000002",
            headers=as_user(COGNITO_SUB),
        )

        assert response.status_code == 200
        assert seen["after_handler"]["user_id"] == USER_ID

    def test_the_stamped_id_is_the_internal_one_not_the_sub(
        self,
        read_client: TestClient,
        session: Session,
        known_caller: StubUsersServicer,
        seen: dict[str, dict],
    ) -> None:
        """CLAUDE.md §5b — stamping the sub under the `user_id` key is the bug."""
        seed(session, order_id="ord_logid0000000000003")

        read_client.get(
            "/v1/trackings/ord_logid0000000000003", headers=as_user(COGNITO_SUB)
        )

        context = seen["after_handler"]
        assert context["user_id"] == USER_ID
        assert context["user_id"] != context["cognito_sub"]
        assert context["cognito_sub"] == COGNITO_SUB

    def test_a_read_that_404s_still_stamps_the_caller(
        self,
        read_client: TestClient,
        known_caller: StubUsersServicer,
        seen: dict[str, dict],
    ) -> None:
        """Identity is resolved before the lookup, so a miss is still attributable.

        A failed read is the line most worth having a `user_id` on.
        """
        response = read_client.get(
            "/v1/trackings/ord_nothere000000000001", headers=as_user(COGNITO_SUB)
        )

        assert response.status_code == 404
        assert seen["after_handler"]["user_id"] == USER_ID

    def test_exactly_one_call_to_users_per_request(
        self,
        read_client: TestClient,
        session: Session,
        known_caller: StubUsersServicer,
    ) -> None:
        """The cost is bounded and known: one resolution, not one per log line.

        This is the assertion that keeps the accepted cost from quietly growing —
        a lazy enricher that resolved per line would still make every other test
        here pass.
        """
        seed(session, order_id="ord_logid0000000000004")

        read_client.get(
            "/v1/trackings/ord_logid0000000000004", headers=as_user(COGNITO_SUB)
        )

        assert len(known_caller.calls) == 1


class TestEnrichmentNeverFailsTheRequest:
    """A read must answer even when the id cannot be had. It never needed it."""

    def test_an_unknown_sub_still_gets_a_200(
        self,
        read_client: TestClient,
        session: Session,
        users_servicer: StubUsersServicer,
        seen: dict[str, dict],
    ) -> None:
        """Users has no record; the read is scoped by the sub and works regardless."""
        seed(session, order_id="ord_logid0000000000005", cognito_sub=UNKNOWN_SUB)

        response = read_client.get(
            "/v1/trackings/ord_logid0000000000005", headers=as_user(UNKNOWN_SUB)
        )

        assert response.status_code == 200
        # Omitted, never null — an absent key reads as "not known at this point".
        assert "user_id" not in seen["after_handler"]
        assert seen["after_handler"]["cognito_sub"] == UNKNOWN_SUB

    def test_users_being_down_does_not_fail_the_read(
        self,
        read_app: FastAPI,
        session: Session,
        seen: dict[str, dict],
    ) -> None:
        """The whole point: enrichment is not a dependency of serving a read.

        Simulated by pointing the client at a port nothing is listening on, which
        produces a real `UNAVAILABLE` from grpcio rather than a raised mock — the
        failure mode a Users outage actually produces.
        """
        seed(session, order_id="ord_logid0000000000006")
        dead = UsersGrpcClient.for_target(
            "127.0.0.1:1", api_key="unused", timeout=0.5
        )
        read_app.dependency_overrides[get_users_client] = lambda: dead

        try:
            with TestClient(read_app) as client:
                response = client.get(
                    "/v1/trackings/ord_logid0000000000006",
                    headers=as_user(COGNITO_SUB),
                )
        finally:
            dead.close()

        assert response.status_code == 200
        assert "user_id" not in seen["after_handler"]

    def test_an_unbuildable_client_does_not_fail_the_read(
        self,
        read_app: FastAPI,
        session: Session,
        seen: dict[str, dict],
    ) -> None:
        """The regression that broke 24 tests: the failure is at CONSTRUCTION.

        `get_users_client` reads settings, which raise on an incomplete environment.
        That happens before any RPC, so catching only `RpcError`/`UnknownUserError`
        leaves it uncaught and 500s a read that needs no identity at all.
        """
        seed(session, order_id="ord_logid0000000000007")

        def cannot_build() -> UsersGrpcClient:
            raise ValueError("no settings for you")

        read_app.dependency_overrides[get_users_client] = cannot_build

        with TestClient(read_app) as client:
            response = client.get(
                "/v1/trackings/ord_logid0000000000007", headers=as_user(COGNITO_SUB)
            )

        assert response.status_code == 200
        assert "user_id" not in seen["after_handler"]

    def test_an_unexpected_failure_does_not_fail_the_read(
        self,
        read_app: FastAPI,
        session: Session,
        seen: dict[str, dict],
    ) -> None:
        """Not just the foreseen failures — ANY of them.

        A narrow `except` was the original defect; this pins the broad one in place
        with an error deliberately outside every anticipated type.
        """
        seed(session, order_id="ord_logid0000000000008")

        class ExplodingClient:
            def resolve(self, identifier: str):
                raise RuntimeError("something nobody predicted")

        read_app.dependency_overrides[get_users_client] = ExplodingClient

        with TestClient(read_app) as client:
            response = client.get(
                "/v1/trackings/ord_logid0000000000008", headers=as_user(COGNITO_SUB)
            )

        assert response.status_code == 200
        assert "user_id" not in seen["after_handler"]


class TestUnauthenticatedSurfacesResolveNothing:
    """Health and the carrier PUT must never call Users. §5a."""

    def test_health_makes_no_call_to_users(
        self, read_client: TestClient, users_servicer: StubUsersServicer
    ) -> None:
        """An ALB probes this constantly; it cannot depend on Users being up."""
        response = read_client.get("/v1/health")

        assert response.status_code == 200
        assert users_servicer.calls == []

    def test_the_carrier_put_makes_no_call_to_users(
        self, read_client: TestClient, session: Session,
        users_servicer: StubUsersServicer,
    ) -> None:
        """The carrier has no `x-user-id` and no user identity to resolve."""
        from tests.conftest import TEST_CARRIER_API_KEY

        seed(session, order_id="ord_logid0000000000009")

        response = read_client.put(
            "/v1/trackings/ord_logid0000000000009/status",
            json={"status": "PROCESSING"},
            headers={"x-api-key": TEST_CARRIER_API_KEY},
        )

        assert response.status_code == 200
        assert users_servicer.calls == []

    def test_a_carrier_put_carrying_a_stray_x_user_id_still_resolves_nothing(
        self, read_client: TestClient, session: Session,
        users_servicer: StubUsersServicer,
    ) -> None:
        """Why this is a dependency and not a middleware guarding on the header.

        A middleware that resolved whenever `x-user-id` was present would pay a
        call here — on a surface that has no user identity at all. Declaring the
        dependency per route makes the exemption structural.
        """
        from tests.conftest import TEST_CARRIER_API_KEY

        users_servicer.users[COGNITO_SUB] = known_user()
        seed(session, order_id="ord_logid0000000000010")

        response = read_client.put(
            "/v1/trackings/ord_logid0000000000010/status",
            json={"status": "PROCESSING"},
            headers={
                "x-api-key": TEST_CARRIER_API_KEY,
                "x-user-id": COGNITO_SUB,
            },
        )

        assert response.status_code == 200
        assert users_servicer.calls == []


class TestAuthStillComesFirst:
    """Enrichment must not have loosened the `401`."""

    def test_a_missing_header_is_still_401_and_calls_nobody(
        self, read_client: TestClient, users_servicer: StubUsersServicer
    ) -> None:
        response = read_client.get("/v1/trackings/ord_logid0000000000011")

        assert response.status_code == 401
        assert users_servicer.calls == []

    def test_an_empty_header_is_still_401(
        self, read_client: TestClient, users_servicer: StubUsersServicer
    ) -> None:
        """nginx sends `""` for a missing/malformed token — empty is missing."""
        response = read_client.get(
            "/v1/trackings/ord_logid0000000000012", headers=as_user("")
        )

        assert response.status_code == 401
        assert users_servicer.calls == []
