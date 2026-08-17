"""The `request_id` correlation field: resolution, ingress, and both outbound hops.

Four surfaces, one id. What each group of tests is actually defending:

## `resolve_request_id` — the trust boundary

`x-request-id` is attacker-controlled on every public endpoint, and its value
lands on every log line of the flow and is forwarded downstream. The cases below
are not format trivia: an oversized value, a control character or a newline
accepted here would be replicated across a whole flow's worth of records in the
field log queries assume is well-formed. Each rejection case is asserted to
produce a FRESH valid id rather than merely "not the input" — a function that
returned `""` for bad input would pass the weaker assertion.

## The middleware — unconditional seeding

The id is seeded before anything else runs, so a 401 or a 404 carries one. Users
shipped the opposite ordering (seeded after the auth guard) and its 401s had no
id at all, which is exactly the request someone asks about later.

## The gRPC and SQS hops — omitted, never empty

Both read the id off the ambient context, and both must send NOTHING when there
is none rather than an empty value. For SQS that is not cosmetic: the pipeline's
`EnvelopeSchema` declares `request_id` `.optional()` with `.min(1)`, so a `null`
or `""` fails Zod, becomes a `PermanentError`, and the notification email is
consumed without ever being sent.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from concurrent import futures
from datetime import UTC, datetime
from typing import Any

import grpc
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.features.tracking.domain.models import Tracking
from src.shared.audit.audit_actor import AuditActor
from src.shared.grpc.generated import users_pb2, users_pb2_grpc
from src.shared.grpc.users_client import (
    API_KEY_METADATA_KEY,
    REQUEST_ID_METADATA_KEY,
    UsersGrpcClient,
)
from src.shared.http.log_context_middleware import LogContextMiddleware
from src.shared.logging.context_filter import LogContextFilter
from src.shared.logging.log_context import reset_log_context, set_log_context
from src.shared.logging.request_id import (
    REQUEST_ID_HEADER,
    REQUEST_ID_PATTERN,
    REQUEST_ID_PREFIX,
    generate_request_id,
    resolve_request_id,
)
from src.shared.messaging.sqs_event_publisher import SqsEventPublisher
from tests.conftest import TEST_API_KEY

MIDDLEWARE_LOGGER = "src.shared.http.log_context_middleware"

#: A well-formed inbound id — `req_` plus exactly 24 characters of the
#: letters-and-digits alphabet. Written out literally rather than generated, so
#: the test pins the FORMAT and not whatever the generator happens to produce
#: today.
VALID_ID = "req_V1StGXR8Z5jdHi6ByT8sQ7fL"


def is_fresh(value: str, *, other_than: str | None = None) -> bool:
    """True when `value` is a well-formed, newly minted id."""
    return bool(REQUEST_ID_PATTERN.fullmatch(value)) and value != other_than


class TestResolveHonoursOurOwnIds:
    def test_a_valid_header_is_returned_unchanged(self) -> None:
        assert resolve_request_id(VALID_ID) == VALID_ID

    def test_bytes_from_the_asgi_scope_are_accepted(self) -> None:
        """The scope yields `(bytes, bytes)`, so bytes is the REAL input shape.

        A str-only implementation would fall through to the generate branch for
        every inbound id and look like it worked — every hop would just mint its
        own, which is the exact failure this whole feature exists to prevent.
        """
        assert resolve_request_id(VALID_ID.encode()) == VALID_ID

    def test_a_generated_id_is_accepted_by_the_validator(self) -> None:
        """Generation and validation must agree, or our own ids get discarded
        one hop downstream."""
        generated = generate_request_id()

        assert generated.startswith(REQUEST_ID_PREFIX)
        assert resolve_request_id(generated) == generated

    def test_two_generated_ids_differ(self) -> None:
        assert generate_request_id() != generate_request_id()


class TestResolveDiscardsAnythingElse:
    """Every rejection yields a FRESH VALID id — never the input, never empty."""

    @pytest.mark.parametrize(
        ("header_value", "why"),
        [
            (None, "no header at all — the common case"),
            (b"", "present but empty, e.g. a proxy that stripped the value"),
            ("", "the decoded empty string"),
            ("V1StGXR8Z5jdHi6ByT8sQ7fL", "right shape, no prefix"),
            ("trk_V1StGXR8Z5jdHi6ByT8sQ7fL", "ANOTHER entity's prefix — would "
             "make a log query correlate the wrong things"),
            ("req_tooshort", "under 24 characters"),
            ("req_" + "a" * 200, "unbounded: bloats every line of the flow"),
            ("req_" + "a" * 25, "one character over — the length is exact"),
            ("req_V1StGXR8Z5jdHi6B-yT8s", "the PREVIOUS 21-char format: a "
             "service still minting it must not be silently trusted"),
            ("req_V1StGXR8Z5jdHi6ByT8sQ7f-", "a `-` is outside the alphabet now, "
             "even at the right length"),
            ("req_V1StGXR8Z5jdHi6ByT8sQ7f_", "so is `_`"),
            ("req_V1StGXR8Z5jdHi6ByT8sQ7\nL", "a newline: forges a second log line"),
            ("req_V1StGXR8Z5jdHi6ByT8sQ7\x00L", "a NUL control character"),
            ("req_V1StGXR8Z5jdHi6ByT8sQ7 L", "a space is outside the alphabet"),
            ('req_{"injected": true}xyzabcd', "JSON, to corrupt a parsed stream"),
            (12345, "not a string at all — must not raise"),
            (["req_V1StGXR8Z5jdHi6ByT8sQ7fL"], "a list — must not raise either"),
        ],
    )
    def test_generates_a_fresh_id(self, header_value: object, why: str) -> None:
        resolved = resolve_request_id(header_value)  # type: ignore[arg-type]

        assert is_fresh(resolved, other_than=str(header_value)), why

    def test_a_multiline_value_never_survives_into_the_result(self) -> None:
        """Stated separately from the table so a regression names the risk.

        A newline in the correlation field does not corrupt one value — it
        forges an extra line in a line-delimited log stream.
        """
        resolved = resolve_request_id("req_aaaaaaaaaaaaaaaaaaa\ninjected")

        assert "\n" not in resolved
        assert "injected" not in resolved


@pytest.fixture
def client() -> TestClient:
    """A tiny app behind the real middleware, plus a route that 401s.

    The 401 route is not decoration: it is the ordering case Users got wrong,
    where the id was seeded after the auth guard and the failures that most need
    correlating were the only lines missing it.
    """
    app = FastAPI()

    @app.get("/v1/trackings/{order_id}")
    async def read(order_id: str) -> dict[str, str]:  # noqa: ANN202 - fixture route
        logger = logging.getLogger(MIDDLEWARE_LOGGER)
        logger.info("handler ran")
        return {"order_id": order_id}

    @app.get("/v1/denied")
    async def denied() -> dict[str, str]:  # noqa: ANN202 - fixture route
        from fastapi import HTTPException

        raise HTTPException(status_code=401, detail="nope")

    app.add_middleware(LogContextMiddleware)
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def context_filtered_caplog(
    caplog: pytest.LogCaptureFixture,
) -> Iterator[pytest.LogCaptureFixture]:
    """`caplog`, with the production `LogContextFilter` on its handler.

    The middleware writes `request_id` into the CONTEXT, never into an `extra=`
    at the call site — that is the whole design, so every line of the flow gets
    it and not just the one the middleware itself emits. It reaches a record via
    `LogContextFilter`, which `logging/config.py` installs on the root HANDLER
    (not on a logger), so a test asserting on the raw record without it would be
    asserting against a pipeline the service does not run.
    """
    log_filter = LogContextFilter()
    caplog.handler.addFilter(log_filter)
    try:
        yield caplog
    finally:
        caplog.handler.removeFilter(log_filter)


def request_line(caplog: pytest.LogCaptureFixture) -> logging.LogRecord:
    """The single `request completed` record."""
    lines = [r for r in caplog.records if r.getMessage() == "request completed"]
    assert len(lines) == 1, f"expected one request line, got {len(lines)}"
    return lines[0]


class TestTheMiddlewareSeedsTheContext:
    """Assertions are made on the LOG RECORD, not on the context dict.

    The record is what actually reaches OpenObserve. A context that holds the id
    but never makes it onto a line would satisfy an in-memory assertion and
    deliver nothing to the person reading the logs — the spec's testing section
    calls this out explicitly.
    """

    def test_a_valid_inbound_id_is_the_one_logged(
        self, client: TestClient, context_filtered_caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog = context_filtered_caplog
        with caplog.at_level(logging.INFO, logger=MIDDLEWARE_LOGGER):
            response = client.get(
                "/v1/trackings/ord_abc123", headers={"x-request-id": VALID_ID}
            )

        assert response.status_code == 200
        assert getattr(request_line(caplog), "request_id", None) == VALID_ID

    def test_a_request_with_no_header_still_gets_one(
        self, client: TestClient, context_filtered_caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog = context_filtered_caplog
        with caplog.at_level(logging.INFO, logger=MIDDLEWARE_LOGGER):
            client.get("/v1/trackings/ord_abc123")

        logged = getattr(request_line(caplog), "request_id", None)
        assert logged is not None
        assert is_fresh(logged)

    def test_a_forged_header_is_discarded_not_echoed(
        self, client: TestClient, context_filtered_caplog: pytest.LogCaptureFixture
    ) -> None:
        """The security case, end to end through the real ASGI header path.

        The unit test above proves `resolve_request_id` rejects the value; this
        proves the middleware actually calls it, rather than decoding the header
        straight into the context the way it does for `x-user-id`.
        """
        caplog = context_filtered_caplog
        forged = "req_" + "A" * 300

        with caplog.at_level(logging.INFO, logger=MIDDLEWARE_LOGGER):
            client.get("/v1/trackings/ord_abc123", headers={"x-request-id": forged})

        logged = getattr(request_line(caplog), "request_id", None)
        assert logged != forged
        assert is_fresh(logged or "")

    def test_a_401_carries_an_id(
        self, client: TestClient, context_filtered_caplog: pytest.LogCaptureFixture
    ) -> None:
        """Seeded unconditionally, at the outermost layer. A rejected request is
        precisely the one someone asks about later."""
        caplog = context_filtered_caplog
        with caplog.at_level(logging.INFO, logger=MIDDLEWARE_LOGGER):
            response = client.get("/v1/denied", headers={"x-request-id": VALID_ID})

        assert response.status_code == 401
        assert getattr(request_line(caplog), "request_id", None) == VALID_ID

    def test_a_404_from_the_router_carries_an_id(
        self, client: TestClient, context_filtered_caplog: pytest.LogCaptureFixture
    ) -> None:
        """No handler and no dependency runs for this one — only the middleware
        is in a position to have seeded anything."""
        caplog = context_filtered_caplog
        with caplog.at_level(logging.INFO, logger=MIDDLEWARE_LOGGER):
            response = client.get(
                "/v1/no-such-route", headers={"x-request-id": VALID_ID}
            )

        assert response.status_code == 404
        assert getattr(request_line(caplog), "request_id", None) == VALID_ID

    def test_the_id_reaches_lines_logged_inside_the_handler(
        self, client: TestClient, context_filtered_caplog: pytest.LogCaptureFixture
    ) -> None:
        """Not just the middleware's own line: the whole point is that EVERY
        line of the flow carries it, via the context filter."""
        caplog = context_filtered_caplog
        with caplog.at_level(logging.INFO, logger=MIDDLEWARE_LOGGER):
            client.get("/v1/trackings/ord_abc123", headers={"x-request-id": VALID_ID})

        handler_lines = [r for r in caplog.records if r.getMessage() == "handler ran"]
        assert len(handler_lines) == 1
        assert getattr(handler_lines[0], "request_id", None) == VALID_ID

    def test_the_header_is_still_read_alongside_the_sub(
        self, client: TestClient, context_filtered_caplog: pytest.LogCaptureFixture
    ) -> None:
        """Both headers, not whichever came first.

        The loop used to `break` on the first match; looking for two values
        without removing it would silently drop whichever the client sent
        second.
        """
        caplog = context_filtered_caplog
        with caplog.at_level(logging.INFO, logger=MIDDLEWARE_LOGGER):
            client.get(
                "/v1/trackings/ord_abc123",
                headers={"x-request-id": VALID_ID, "x-user-id": "sub-123"},
            )

        record = request_line(caplog)
        assert getattr(record, "request_id", None) == VALID_ID
        assert getattr(record, "cognito_sub", None) == "sub-123"


@pytest.fixture
def log_context_with_id() -> Iterator[str]:
    """An active context carrying VALID_ID, restored afterwards.

    Restored via the token rather than left set: a leaked context would make the
    "omits when absent" tests below pass or fail depending on execution order,
    which is the kind of coupling that hides a real bug.
    """
    token = set_log_context(request_id=VALID_ID)
    try:
        yield VALID_ID
    finally:
        reset_log_context(token)


@pytest.fixture
def empty_log_context() -> Iterator[None]:
    """An active but EMPTY context — the outside-a-request case."""
    token = set_log_context()
    try:
        yield None
    finally:
        reset_log_context(token)


class MetadataRecordingServicer(users_pb2_grpc.UsersServicer):
    """Records the FULL invocation metadata of every call.

    `conftest`'s `StubUsersServicer` only keeps the api key, so it cannot answer
    the question here — whether `x-request-id` travelled, and whether it was
    absent rather than empty. A real server rather than a mocked stub for the
    reason `test_users_client.py` states: this way the key really goes over the
    wire and arrives lowercased, so a metadata bug fails here.
    """

    def __init__(self) -> None:
        self.metadata: list[dict[str, str]] = []

    def GetUserById(self, request, context):  # noqa: N802 - protoc's method name
        self.metadata.append(dict(context.invocation_metadata()))
        return users_pb2.UserResponse(
            id="usr_bbbbbbbbbbbbbbbbbbbbb",
            cognito_sub="22222222-2222-4222-8222-222222222222",
            email="user@example.com",
            full_name="Test User",
        )


@pytest.fixture
def recording_users_client() -> Iterator[
    tuple[UsersGrpcClient, MetadataRecordingServicer]
]:
    servicer = MetadataRecordingServicer()
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=2))
    users_pb2_grpc.add_UsersServicer_to_server(servicer, server)
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    client = UsersGrpcClient.for_target(f"127.0.0.1:{port}", api_key=TEST_API_KEY)
    try:
        yield client, servicer
    finally:
        client.close()
        server.stop(None).wait()


class TestTheGrpcHopForwardsTheId:
    def test_the_metadata_carries_the_context_id(
        self,
        recording_users_client: tuple[UsersGrpcClient, MetadataRecordingServicer],
        log_context_with_id: str,
    ) -> None:
        client, servicer = recording_users_client

        client.resolve("usr_bbbbbbbbbbbbbbbbbbbbb")

        assert servicer.metadata[0][REQUEST_ID_METADATA_KEY] == log_context_with_id

    def test_the_api_key_still_travels(
        self,
        recording_users_client: tuple[UsersGrpcClient, MetadataRecordingServicer],
        log_context_with_id: str,
    ) -> None:
        """Adding one entry must not displace the credential — an
        `x-api-key`-less call would be UNAUTHENTICATED against real Users."""
        client, servicer = recording_users_client

        client.resolve("usr_bbbbbbbbbbbbbbbbbbbbb")

        assert servicer.metadata[0][API_KEY_METADATA_KEY] == TEST_API_KEY

    def test_the_entry_is_omitted_when_there_is_no_id(
        self,
        recording_users_client: tuple[UsersGrpcClient, MetadataRecordingServicer],
        empty_log_context: None,
    ) -> None:
        """Absent, not empty: an `x-request-id: ""` would look like a real
        correlation value in Users' logs until someone searched for it."""
        client, servicer = recording_users_client

        client.resolve("usr_bbbbbbbbbbbbbbbbbbbbb")

        assert REQUEST_ID_METADATA_KEY not in servicer.metadata[0]
        assert servicer.metadata[0][API_KEY_METADATA_KEY] == TEST_API_KEY


class RecordingSqsClient:
    """Records `send_message` kwargs. Not a Mock — see test_sqs_event_publisher."""

    def __init__(self) -> None:
        self.sends: list[dict[str, Any]] = []

    def send_message(self, **kwargs: Any) -> dict[str, str]:
        self.sends.append(kwargs)
        return {"MessageId": "irrelevant"}


def a_tracking() -> Tracking:
    """A persisted-shaped tracking, in memory. No database needed: what is under
    test is the envelope this maps to."""
    return Tracking(
        id="trk_aaaaaaaaaaaaaaaaaaaaa",
        order_id="ord_aaaaaaaaaaaaaaaaaaaaa",
        user_id="usr_aaaaaaaaaaaaaaaaaaaaa",
        cognito_sub="11111111-1111-4111-8111-111111111111",
        tracking_number="3MRAI-K7QD-2XBM-9PWA",
        status="SHIPPED",
        datetime_=datetime(2026, 8, 15, 12, 0, 0, tzinfo=UTC),
        shipping_address=None,
        tags=[],
        history=[],
    )


def publish(client: RecordingSqsClient) -> dict[str, Any]:
    """Publish one transition and return the parsed envelope."""
    from src.shared.grpc.users_client import ResolvedUser

    publisher = SqsEventPublisher(
        client=client,
        queue_url="https://sqs.us-east-1.amazonaws.com/000000000000/events",
        resolve_user=lambda _user_id: ResolvedUser(
            internal_id="usr_aaaaaaaaaaaaaaaaaaaaa",
            cognito_sub="11111111-1111-4111-8111-111111111111",
            email="user@example.com",
            full_name="Ada Lovelace",
        ),
    )
    publisher.publish_tracking_status_changed(
        tracking=a_tracking(),
        previous_status="PROCESSING",
        actor=AuditActor.CARRIER_STATUS_UPDATE,
        cognito_sub="11111111-1111-4111-8111-111111111111",
    )
    assert len(client.sends) == 1
    return json.loads(client.sends[0]["MessageBody"])


class TestTheSqsEnvelopeCarriesTheId:
    def test_request_id_is_a_root_field(
        self, log_context_with_id: str
    ) -> None:
        """Root, next to `event_id`/`user_id` — NOT inside `author` or the
        payload. The pipeline's EnvelopeSchema reads it at the root, and a
        nested one would simply never be seen."""
        client = RecordingSqsClient()

        envelope = publish(client)

        assert envelope["request_id"] == log_context_with_id

    def test_the_key_is_omitted_entirely_when_there_is_no_id(
        self, empty_log_context: None
    ) -> None:
        """The expensive case. `EnvelopeSchema` declares `request_id`
        `.optional()` with `.min(1)`, so `null` AND `""` both fail Zod — and the
        handler turns that into a `PermanentError`, consuming the record without
        retry. A null here loses the notification EMAIL, not just the
        correlation."""
        client = RecordingSqsClient()

        envelope = publish(client)

        assert "request_id" not in envelope

    def test_the_rest_of_the_envelope_is_unchanged(
        self, log_context_with_id: str
    ) -> None:
        """A regression guard on the fields the pipeline already required —
        adding one key must not have disturbed the contract."""
        client = RecordingSqsClient()

        envelope = publish(client)

        assert envelope["type"] == "TRACKING_STATUS_CHANGED"
        assert envelope["source"] == "tracking"
        assert envelope["user_id"] == "usr_aaaaaaaaaaaaaaaaaaaaa"
        assert envelope["order_id"] == "ord_aaaaaaaaaaaaaaaaaaaaa"
        assert envelope["author"]["actor"] == AuditActor.CARRIER_STATUS_UPDATE.value
        assert envelope["payload"]["status"] == "SHIPPED"


class TestTheHeaderConstantIsBytes:
    def test_it_matches_the_asgi_scope_shape(self) -> None:
        """A `str` constant here would never match a scope header, so every
        inbound id would be silently discarded and every hop would mint its
        own — the failure this whole feature exists to prevent, and one that
        looks like success from the outside."""
        assert isinstance(REQUEST_ID_HEADER, bytes)
        # Lowercase, because the middleware compares against `name.lower()`.
        assert REQUEST_ID_HEADER.lower() == REQUEST_ID_HEADER
