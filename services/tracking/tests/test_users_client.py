"""The OUTBOUND Users gRPC client, against a REAL stub server (JE-101).

Every test below goes through a channel to `StubUsersServicer` (conftest), never a
mocked stub object. What that buys, and what a mock would delete:

* the `x-api-key` really travels as call metadata and arrives lowercase,
* `context.abort(NOT_FOUND)` really becomes an `RpcError` whose `.code()` this
  client has to read correctly,
* the proto fields really deserialize onto `id`/`cognito_sub`, so a mapping typo
  fails here instead of at runtime.

No database is involved, so this module never skips — unlike the suites that need
Floci's MySQL.
"""

from __future__ import annotations

import grpc
import pytest

from src.shared.grpc.generated import users_pb2
from src.shared.grpc.users_client import (
    ResolvedUser,
    UsersGrpcClient,
    normalize_target,
)
from tests.conftest import TEST_API_KEY, StubUsersServicer

#: The internal id Users hands back — what `tracking.user_id` stores.
USER_ID = "usr_bbbbbbbbbbbbbbbbbbbbb"

#: The SAME person's Cognito sub — what the gateway injects as `x-user-id`.
#: Deliberately nothing like USER_ID: the two identities are different strings,
#: and a test reusing one value could not fail on a mix-up.
COGNITO_SUB = "22222222-2222-4222-8222-222222222222"

#: The same person's email. PII on the wire, carried by `ResolvedUser` as of the
#: events-pipeline milestone because the notification payload requires it.
USER_EMAIL = "user@example.com"

#: The same person's display name. Carried for the same reason the email is: the
#: rebranded notification templates greet the reader by name, and Tracking
#: persists no name of its own. Deliberately unlike every other constant here so
#: a mapping that copied the wrong field could not pass by coincidence.
USER_FULL_NAME = "Test User"


def known_user() -> users_pb2.UserResponse:
    """A `UserResponse` shaped like the real one, address included.

    The address is populated even though `ResolvedUser` still drops it — that is
    the point: the client must not blow up on, or start carrying, a field it has
    no use for. `email` and `full_name` ARE carried (the events publisher
    consumes both), so the three together prove the narrowing is deliberate
    per-field rather than "whatever the mapping happened to copy".
    """
    return users_pb2.UserResponse(
        id=USER_ID,
        email=USER_EMAIL,
        full_name=USER_FULL_NAME,
        cognito_sub=COGNITO_SUB,
        address=users_pb2.Address(
            line1="742 Evergreen Terrace",
            city="Springfield",
            country="US",
        ),
    )


class TestResolve:
    def test_resolves_a_known_sub_to_the_internal_id(
        self, users_client: UsersGrpcClient, users_servicer: StubUsersServicer
    ) -> None:
        users_servicer.users[COGNITO_SUB] = known_user()

        resolved = users_client.resolve(COGNITO_SUB)

        assert resolved == ResolvedUser(
            internal_id=USER_ID,
            cognito_sub=COGNITO_SUB,
            email=USER_EMAIL,
            full_name=USER_FULL_NAME,
        )

    def test_carries_the_email_the_events_publisher_needs(
        self, users_client: UsersGrpcClient, users_servicer: StubUsersServicer
    ) -> None:
        """`email` is threaded out of the response, not dropped like `address`.

        Tracking persists no email of its own, and the events-pipeline handler
        rejects a `TRACKING_STATUS_CHANGED` payload without one as a PERMANENT
        error — silently, consuming the message and never sending the mail. So
        this RPC is the only source, and a mapping that dropped the field would
        break the notification with nothing failing loudly anywhere.
        """
        users_servicer.users[COGNITO_SUB] = known_user()

        resolved = users_client.resolve(COGNITO_SUB)

        assert resolved is not None
        assert resolved.email == USER_EMAIL

    def test_carries_the_full_name_the_enriched_payload_needs(
        self, users_client: UsersGrpcClient, users_servicer: StubUsersServicer
    ) -> None:
        """`full_name` rides the SAME response as `email`.

        The enriched `TRACKING_STATUS_CHANGED` payload greets the reader by
        name, and Tracking persists no name — so this RPC is the only source,
        exactly as it is for the address. Asserted here rather than only in the
        publisher's suite because the publisher's fake resolver would happily
        return a name this mapping never actually reads off the wire.
        """
        users_servicer.users[COGNITO_SUB] = known_user()

        resolved = users_client.resolve(COGNITO_SUB)

        assert resolved is not None
        assert resolved.full_name == USER_FULL_NAME

    def test_the_name_costs_no_second_round_trip(
        self, users_client: UsersGrpcClient, users_servicer: StubUsersServicer
    ) -> None:
        """One `GetUserById` yields both the address and the name.

        The spec's whole justification for adding `full_name` to the payload is
        that it is already on the wire ("from the existing `GetUserById` gRPC
        call. No new round trip"). Asserted on the stub server's call log, which
        is the only place a second call would be visible.
        """
        users_servicer.users[COGNITO_SUB] = known_user()

        resolved = users_client.resolve(COGNITO_SUB)

        assert resolved is not None
        assert resolved.email == USER_EMAIL
        assert resolved.full_name == USER_FULL_NAME
        assert len(users_servicer.calls) == 1

    def test_an_absent_name_stays_an_empty_string(
        self, users_client: UsersGrpcClient, users_servicer: StubUsersServicer
    ) -> None:
        """The DELIBERATE asymmetry with `email`, which is normalized to None.

        A missing address means the notification cannot be delivered at all, so
        the publisher must be able to detect it and bail out — hence `None`. A
        missing name is cosmetic: the mail still sends, and the payload field is
        a plain string the template interpolates. Normalizing it to `None` would
        only give the publisher something to convert back to `""` before every
        send.
        """
        users_servicer.users[COGNITO_SUB] = users_pb2.UserResponse(
            id=USER_ID, cognito_sub=COGNITO_SUB, email=USER_EMAIL
        )

        resolved = users_client.resolve(COGNITO_SUB)

        assert resolved is not None
        assert resolved.full_name == ""
        assert resolved.full_name is not None

    def test_an_absent_email_becomes_none_rather_than_an_empty_string(
        self, users_client: UsersGrpcClient, users_servicer: StubUsersServicer
    ) -> None:
        """proto3 has no null: an unset string arrives as `""`.

        Normalized to None so "Users holds no email" has ONE spelling. An empty
        string would travel into the payload looking like a value and be
        rejected downstream by the handler's `z.string().email()`, whereas None
        lets the publisher stop and log a `reason` before anything is queued.
        """
        users_servicer.users[COGNITO_SUB] = users_pb2.UserResponse(
            id=USER_ID, cognito_sub=COGNITO_SUB, full_name="No Email User"
        )

        resolved = users_client.resolve(COGNITO_SUB)

        assert resolved is not None
        assert resolved.email is None

    def test_unknown_sub_is_none_not_an_exception(
        self, users_client: UsersGrpcClient
    ) -> None:
        """NOT_FOUND is an answer — "no such user" — not a transport failure."""
        assert users_client.resolve("cognito-sub-nobody-has") is None

    def test_attaches_the_shared_api_key_as_metadata(
        self, users_client: UsersGrpcClient, users_servicer: StubUsersServicer
    ) -> None:
        """ADR-0003: the internal hop is authenticated by the shared key."""
        users_servicer.users[COGNITO_SUB] = known_user()

        users_client.resolve(COGNITO_SUB)

        assert users_servicer.calls == [(COGNITO_SUB, TEST_API_KEY)]

    def test_a_wrong_key_is_rejected_and_propagates(
        self, users_server: int
    ) -> None:
        """UNAUTHENTICATED must NOT be swallowed into "unknown user".

        Only NOT_FOUND maps to None. A misconfigured key that quietly read as "no
        such user" would let a write path attribute a shipment to nobody.
        """
        client = UsersGrpcClient.for_target(
            f"127.0.0.1:{users_server}", api_key="not-the-right-key"
        )
        try:
            with pytest.raises(grpc.RpcError) as caught:
                client.resolve(COGNITO_SUB)
        finally:
            client.close()

        assert caught.value.code() is grpc.StatusCode.UNAUTHENTICATED

    def test_an_unreachable_server_propagates_rather_than_resolving_to_none(
        self,
    ) -> None:
        """An outage is not "unknown user" — the distinction the mapping protects."""
        # Port 1 on loopback: reserved, nothing listens, connection refused fast.
        client = UsersGrpcClient.for_target(
            "127.0.0.1:1", api_key=TEST_API_KEY, timeout=2.0
        )
        try:
            with pytest.raises(grpc.RpcError) as caught:
                client.resolve(COGNITO_SUB)
        finally:
            client.close()

        assert caught.value.code() is not grpc.StatusCode.NOT_FOUND

    def test_accepts_an_internal_id_too(
        self, users_client: UsersGrpcClient, users_servicer: StubUsersServicer
    ) -> None:
        """`GetUserById` takes either identifier — the .proto and Users both say so."""
        users_servicer.users[USER_ID] = known_user()

        resolved = users_client.resolve(USER_ID)

        assert resolved is not None
        assert resolved.internal_id == USER_ID

    def test_does_not_expose_the_address(
        self, users_client: UsersGrpcClient, users_servicer: StubUsersServicer
    ) -> None:
        """YAGNI + PII: nothing here consumes the address, so it is not carried.

        JE-105's creation endpoint takes `shipping_address` in the request BODY,
        so pulling PII through this path would serve no caller. This pins the
        decision so re-adding it is a deliberate edit with a consumer behind it.
        """
        users_servicer.users[COGNITO_SUB] = known_user()

        resolved = users_client.resolve(COGNITO_SUB)

        assert not hasattr(resolved, "address")


class TestConstruction:
    def test_an_empty_api_key_is_rejected_at_construction(self) -> None:
        """Caught where the misconfiguration is, not as a runtime UNAUTHENTICATED."""
        with pytest.raises(ValueError, match="api_key"):
            UsersGrpcClient(channel=grpc.insecure_channel("127.0.0.1:1"), api_key="")


class TestNormalizeTarget:
    @pytest.mark.parametrize(
        "given",
        ["http://users:50051", "https://users:50051", "users:50051"],
    )
    def test_strips_a_scheme_so_orders_env_value_works_verbatim(
        self, given: str
    ) -> None:
        """Orders' .NET channel needs the scheme; grpcio must not see it.

        Both services read the same `USERS_GRPC_URL`, so this accepts either
        spelling rather than requiring a second env var for one address.
        """
        assert normalize_target(given) == "users:50051"

    def test_leaves_a_host_port_untouched(self) -> None:
        assert normalize_target("127.0.0.1:50051") == "127.0.0.1:50051"
