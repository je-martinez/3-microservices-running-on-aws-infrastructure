"""The request-scoped caller context (JE-101).

Two properties carry the whole design, and both are assertions about the stub
server's **call log** rather than about a return value:

1. reading `cognito_sub` (and `resolved_internal_user_id`) causes NO network call,
2. resolving twice causes ONE network call.

Neither can be checked by looking at what the context returns — a broken
implementation returns exactly the same strings while hitting the wire on every
log line. So these count `users_servicer.calls`, which only a real server can
record, which is why the stub is a real server and not a mock.

The FastAPI wiring is exercised through a real app + `TestClient` on a throwaway
route, for the same reason the REST suite drives the real app: a dependency that
looks right in isolation can still fail to compose (a missing `Depends`, a
dependency that FastAPI treats as a request body).
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.shared.grpc.users_client import UsersGrpcClient
from src.shared.http.caller import (
    Caller,
    CurrentCaller,
    UnknownUserError,
    get_users_client,
)
from tests.conftest import StubUsersServicer
from tests.test_users_client import COGNITO_SUB, USER_ID, known_user


@pytest.fixture
def caller(users_client: UsersGrpcClient) -> CurrentCaller:
    """A caller context for `COGNITO_SUB`, talking to the stub Users server."""
    return CurrentCaller(cognito_sub=COGNITO_SUB, users=users_client)


class TestSubIsNetworkFree:
    def test_reading_the_sub_makes_no_call(
        self, caller: CurrentCaller, users_servicer: StubUsersServicer
    ) -> None:
        """The single most important property here — see the module docstring."""
        users_servicer.users[COGNITO_SUB] = known_user()

        assert caller.cognito_sub == COGNITO_SUB

        assert users_servicer.calls == []

    def test_reading_the_resolved_id_before_resolution_makes_no_call(
        self, caller: CurrentCaller, users_servicer: StubUsersServicer
    ) -> None:
        """A log enricher reads this on EVERY event; it must never dial out.

        Orders' `ICurrentCaller.ResolvedInternalUserId` is a plain getter for
        exactly this reason. `None` means "not resolved yet", not "go find out".
        """
        users_servicer.users[COGNITO_SUB] = known_user()

        assert caller.resolved_internal_user_id is None

        assert users_servicer.calls == []

    def test_repeated_reads_still_make_no_call(
        self, caller: CurrentCaller, users_servicer: StubUsersServicer
    ) -> None:
        users_servicer.users[COGNITO_SUB] = known_user()

        for _ in range(5):
            assert caller.cognito_sub == COGNITO_SUB
            assert caller.resolved_internal_user_id is None

        assert users_servicer.calls == []


class TestResolution:
    def test_resolves_the_internal_id(
        self, caller: CurrentCaller, users_servicer: StubUsersServicer
    ) -> None:
        users_servicer.users[COGNITO_SUB] = known_user()

        assert caller.resolve_internal_user_id() == USER_ID

    def test_the_resolved_id_becomes_readable_afterwards(
        self, caller: CurrentCaller, users_servicer: StubUsersServicer
    ) -> None:
        """After an explicit resolve, the non-triggering view has the value."""
        users_servicer.users[COGNITO_SUB] = known_user()

        caller.resolve_internal_user_id()

        assert caller.resolved_internal_user_id == USER_ID

    def test_the_internal_id_differs_from_the_sub(
        self, caller: CurrentCaller, users_servicer: StubUsersServicer
    ) -> None:
        """CLAUDE.md §5b: two identities, never interchangeable.

        A test whose two identities were the same value could not fail on the
        mix-up this rule exists to prevent.
        """
        users_servicer.users[COGNITO_SUB] = known_user()

        assert caller.resolve_internal_user_id() != caller.cognito_sub

    def test_an_unknown_sub_raises_unknown_user(self, caller: CurrentCaller) -> None:
        """NOT_FOUND must not become a silent `None` on the write path."""
        with pytest.raises(UnknownUserError) as caught:
            caller.resolve_internal_user_id()

        assert caught.value.cognito_sub == COGNITO_SUB


class TestCaching:
    def test_a_second_resolve_does_not_hit_the_wire(
        self, caller: CurrentCaller, users_servicer: StubUsersServicer
    ) -> None:
        """Resolution is memoized for the request — one call, however many asks."""
        users_servicer.users[COGNITO_SUB] = known_user()

        first = caller.resolve_internal_user_id()
        second = caller.resolve_internal_user_id()

        assert first == second == USER_ID
        assert len(users_servicer.calls) == 1

    def test_many_resolves_still_make_exactly_one_call(
        self, caller: CurrentCaller, users_servicer: StubUsersServicer
    ) -> None:
        users_servicer.users[COGNITO_SUB] = known_user()

        for _ in range(10):
            caller.resolve_internal_user_id()

        assert len(users_servicer.calls) == 1

    def test_an_unknown_user_is_cached_too(
        self, caller: CurrentCaller, users_servicer: StubUsersServicer
    ) -> None:
        """A negative answer is an answer: don't re-ask Users per call site."""
        for _ in range(3):
            with pytest.raises(UnknownUserError):
                caller.resolve_internal_user_id()

        assert len(users_servicer.calls) == 1

    def test_a_separate_caller_resolves_independently(
        self, users_client: UsersGrpcClient, users_servicer: StubUsersServicer
    ) -> None:
        """The cache is per REQUEST, so a second request asks again.

        Cached on the instance, and the instance lives one request — a
        process-wide cache would keep serving a mapping after the user changed.
        """
        users_servicer.users[COGNITO_SUB] = known_user()

        for _ in range(2):
            CurrentCaller(
                cognito_sub=COGNITO_SUB, users=users_client
            ).resolve_internal_user_id()

        assert len(users_servicer.calls) == 2


class TestFastApiWiring:
    """The dependency composes inside a real app, over a real request."""

    @pytest.fixture
    def app(self, users_client: UsersGrpcClient) -> FastAPI:
        """A throwaway app with one route declaring `Caller`.

        A dedicated route rather than a real one: JE-101 ships no endpoint (the
        creation endpoint is JE-105), and inventing one here to test the
        dependency would be building the thing this issue deliberately does not.
        """
        application = FastAPI()

        @application.get("/probe")
        def probe(caller: Caller) -> dict[str, str | None]:
            # Reads the sub, and reports whether anything resolved implicitly.
            return {
                "sub": caller.cognito_sub,
                "resolved": caller.resolved_internal_user_id,
            }

        @application.get("/probe-resolve")
        def probe_resolve(caller: Caller) -> dict[str, str]:
            return {"internal_id": caller.resolve_internal_user_id()}

        application.dependency_overrides[get_users_client] = lambda: users_client
        return application

    @pytest.fixture
    def client(self, app: FastAPI) -> TestClient:
        return TestClient(app)

    def test_the_dependency_supplies_the_gateway_injected_sub(
        self, client: TestClient, users_servicer: StubUsersServicer
    ) -> None:
        response = client.get("/probe", headers={"x-user-id": COGNITO_SUB})

        assert response.status_code == 200
        assert response.json() == {"sub": COGNITO_SUB, "resolved": None}

    def test_building_the_caller_makes_no_call(
        self, client: TestClient, users_servicer: StubUsersServicer
    ) -> None:
        """A route that only needs the sub must not talk to Users at all."""
        client.get("/probe", headers={"x-user-id": COGNITO_SUB})

        assert users_servicer.calls == []

    def test_a_missing_header_is_401_before_any_call(
        self, client: TestClient, users_servicer: StubUsersServicer
    ) -> None:
        """Inherited from `CallerSub`: no identity, no caller context."""
        response = client.get("/probe")

        assert response.status_code == 401
        assert users_servicer.calls == []

    def test_an_empty_header_is_401(self, client: TestClient) -> None:
        """nginx sends `""` for a missing/malformed token — empty is missing."""
        assert client.get("/probe", headers={"x-user-id": ""}).status_code == 401

    def test_resolution_works_through_the_dependency(
        self, client: TestClient, users_servicer: StubUsersServicer
    ) -> None:
        users_servicer.users[COGNITO_SUB] = known_user()

        response = client.get("/probe-resolve", headers={"x-user-id": COGNITO_SUB})

        assert response.status_code == 200
        assert response.json() == {"internal_id": USER_ID}
        assert len(users_servicer.calls) == 1
