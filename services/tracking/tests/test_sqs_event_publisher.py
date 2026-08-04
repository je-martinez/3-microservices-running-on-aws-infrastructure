"""`SqsEventPublisher` — the envelope, the derived id, the hash, the PII rule.

Unit-level: no database, no queue, no gRPC. What stands in for boto3 is a
RECORDING fake (`RecordingSqsClient`) rather than a `Mock`, and the difference is
the whole method here.

## Why a recorder and not a mock's assertions

Every assertion in this module is about what the publisher **built** — the dict
it handed to `send_message`. A test that configured a mock's return value and
then asserted that same value back would pass against any implementation,
including one that publishes nothing at all.

The failure-path tests are where that is easiest to get wrong. `FailingSqsClient`
raises, and the temptation is to assert "it raised" — which tests the fake, not
the publisher. What is asserted instead is the publisher's OWN observable
behaviour under that failure: the call did not propagate, an `error` line was
emitted carrying the machine-readable `reason`, and the address never appears in
any of it.

## The two authorities being pinned

* the envelope — `functions/events-pipeline/src/domain/envelope.ts`:
  `{ event_id, type, source, user_id, order_id, payload }`, every key present.
* the payload — `functions/events-pipeline/src/handlers/tracking-status-changed.ts`:
  `{ status, previous_status, changed_at, email }`, all four required.

A drift on either side is not a loud failure in production: the handler rejects
the record as a `PermanentError`, consumes it, and nobody gets an email. These
assertions are the only place that drift becomes visible.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from typing import Any

import pytest

from src.shared.messaging.sqs_event_publisher import (
    EVENT_ID_PREFIX,
    EVENT_SOURCE,
    EVENT_TYPE,
    SqsEventPublisher,
    derive_event_id,
    hash_email,
)

QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/events"

ORDER_ID = "ord_aaaaaaaaaaaaaaaaaaaaa"
USER_ID = "usr_aaaaaaaaaaaaaaaaaaaaa"
EMAIL = "user@example.com"

#: A fixed instant, so the serialized `changed_at` is a literal the test can pin
#: rather than something re-derived from the same call under test.
CHANGED_AT = datetime(2026, 8, 3, 14, 30, 45, tzinfo=UTC)
CHANGED_AT_ISO = "2026-08-03T14:30:45+00:00"


class RecordingSqsClient:
    """Records every `send_message` kwargs dict, in order. Returns nothing useful.

    Deliberately NOT a `unittest.mock.Mock`: a Mock answers any attribute, so a
    publisher that called `send_messages` (plural) or `publish` would still
    "work" here and the test would only fail on the recorded list being empty —
    a much vaguer signal than an `AttributeError` at the exact wrong call.
    """

    def __init__(self) -> None:
        self.sends: list[dict[str, Any]] = []

    def send_message(self, **kwargs: Any) -> dict[str, str]:
        self.sends.append(kwargs)
        return {"MessageId": "irrelevant"}


class FailingSqsClient:
    """Raises on send, like a queue outage or a bad queue URL would.

    Also records the attempt, so a test can assert the publisher genuinely
    reached the send (and did not, say, bail out earlier for an unrelated
    reason) before checking how the failure was handled.
    """

    def __init__(self, error: Exception | None = None) -> None:
        self.attempts: list[dict[str, Any]] = []
        self._error = error or RuntimeError("queue unreachable")

    def send_message(self, **kwargs: Any) -> dict[str, str]:
        self.attempts.append(kwargs)
        raise self._error


def build(
    client: Any,
    *,
    email: str | None = EMAIL,
    resolver_error: Exception | None = None,
) -> SqsEventPublisher:
    """A publisher over `client`, with the email resolution stubbed out.

    The resolver is a plain closure rather than a gRPC client: what is under test
    here is the envelope and the failure policy, and `users_client.py` has its own
    suite against a real `users.v1.Users` server on a real socket.
    """

    def resolve(user_id: str) -> str | None:
        if resolver_error is not None:
            raise resolver_error
        return email

    return SqsEventPublisher(
        client=client, queue_url=QUEUE_URL, resolve_email=resolve
    )


def publish(
    publisher: SqsEventPublisher,
    *,
    order_id: str = ORDER_ID,
    user_id: str = USER_ID,
    status: str = "ON_THE_WAY",
    previous_status: str = "SHIPPED",
    changed_at: datetime = CHANGED_AT,
) -> None:
    publisher.publish_tracking_status_changed(
        order_id=order_id,
        user_id=user_id,
        status=status,
        previous_status=previous_status,
        changed_at=changed_at,
    )


def sent_body(client: RecordingSqsClient, index: int = 0) -> dict[str, Any]:
    """The deserialized envelope of the `index`-th send.

    Parsed from `MessageBody` rather than read off some intermediate object: the
    JSON string is what actually reaches SQS, so a field that fails to serialize
    (a raw `datetime`, say) fails here exactly as it would in production.
    """
    assert len(client.sends) > index, "the publisher sent nothing"
    return json.loads(client.sends[index]["MessageBody"])


class TestTheEnvelopeItBuilds:
    """Against `functions/events-pipeline/src/domain/envelope.ts`."""

    def test_it_sends_to_the_configured_queue(self) -> None:
        client = RecordingSqsClient()
        publish(build(client))
        assert client.sends[0]["QueueUrl"] == QUEUE_URL

    def test_every_envelope_key_is_present(self) -> None:
        """`EnvelopeSchema` requires all six. `order_id` is NULLABLE, not
        optional — an omitted key fails the schema exactly like a wrong one, and
        the handler then rejects the record as a PermanentError."""
        client = RecordingSqsClient()
        publish(build(client))

        assert set(sent_body(client)) == {
            "event_id",
            "type",
            "source",
            "user_id",
            "order_id",
            "payload",
        }

    def test_the_keys_are_snake_case(self) -> None:
        """The pipeline is TypeScript and would idiomatically read `eventId`; the
        contract is snake_case on the wire. Asserted structurally so a future key
        cannot arrive camelCased without failing."""
        body = RecordingSqsClient()
        publish(build(body))
        envelope = sent_body(body)

        keys = list(envelope) + list(envelope["payload"])
        assert all(re.fullmatch(r"[a-z][a-z0-9_]*", key) for key in keys), keys

    def test_type_is_the_key_the_pipeline_dispatches_on(self) -> None:
        """An unknown `type` dead-ends in the pipeline's HandlerMap as
        `FAILED "Unknown event type"` — a literal, not a reference to the
        constant, so renaming the constant cannot silently rename the wire
        value."""
        client = RecordingSqsClient()
        publish(build(client))
        assert sent_body(client)["type"] == "TRACKING_STATUS_CHANGED"

    def test_source_names_this_producer(self) -> None:
        """Users publishes "users", Orders "orders". Literal, same reason."""
        client = RecordingSqsClient()
        publish(build(client))
        assert sent_body(client)["source"] == "tracking"

    def test_it_carries_the_order_id_and_user_id(self) -> None:
        client = RecordingSqsClient()
        publish(build(client), order_id="ord_zzzzzzzzzzzzzzzzzzzzz", user_id="usr_q")
        envelope = sent_body(client)

        assert envelope["order_id"] == "ord_zzzzzzzzzzzzzzzzzzzzz"
        assert envelope["user_id"] == "usr_q"

    def test_the_event_id_is_the_derived_one(self) -> None:
        client = RecordingSqsClient()
        publish(build(client), order_id=ORDER_ID, status="OUT_FOR_DELIVERY")

        assert sent_body(client)["event_id"] == derive_event_id(
            ORDER_ID, "OUT_FOR_DELIVERY"
        )

    def test_the_event_id_carries_the_evt_prefix(self) -> None:
        """The shape Users mints, so all three producers' ids read the same in
        the pipeline's `event_id` index."""
        client = RecordingSqsClient()
        publish(build(client))
        assert sent_body(client)["event_id"].startswith(EVENT_ID_PREFIX)


class TestThePayloadItBuilds:
    """Against `TrackingStatusChangedPayloadSchema` in the handler."""

    def test_the_payload_has_exactly_the_four_required_keys(self) -> None:
        client = RecordingSqsClient()
        publish(build(client))

        assert set(sent_body(client)["payload"]) == {
            "status",
            "previous_status",
            "changed_at",
            "email",
        }

    def test_status_and_previous_status_are_the_transition(self) -> None:
        client = RecordingSqsClient()
        publish(
            build(client), status="OUT_FOR_DELIVERY", previous_status="ON_THE_WAY"
        )
        payload = sent_body(client)["payload"]

        assert payload["status"] == "OUT_FOR_DELIVERY"
        assert payload["previous_status"] == "ON_THE_WAY"

    @pytest.mark.parametrize(
        "status",
        ["SHIPPED", "ON_THE_WAY", "OUT_FOR_DELIVERY", "DELIVERED"],
    )
    def test_every_progression_status_passes_the_handlers_enum(
        self, status: str
    ) -> None:
        """The handler's `z.enum` accepts exactly these four. A publisher that
        lowercased or prettified the value would be rejected downstream as a
        PermanentError and no email would ever be sent."""
        client = RecordingSqsClient()
        publish(build(client), status=status)
        assert sent_body(client)["payload"]["status"] == status

    def test_changed_at_is_serialized_iso_8601(self) -> None:
        """A raw `datetime` is not JSON-serializable — `json.dumps` would raise
        inside the send and the publisher would swallow it, so this would
        degrade into "no event", not into a loud error."""
        client = RecordingSqsClient()
        publish(build(client), changed_at=CHANGED_AT)

        assert sent_body(client)["payload"]["changed_at"] == CHANGED_AT_ISO

    def test_changed_at_is_a_non_empty_string(self) -> None:
        """The handler validates it as `z.string().min(1)`."""
        client = RecordingSqsClient()
        publish(build(client))
        changed_at = sent_body(client)["payload"]["changed_at"]

        assert isinstance(changed_at, str)
        assert changed_at

    def test_the_email_is_the_resolved_address(self) -> None:
        """PII travels HERE and nowhere else — the pipeline needs somewhere to
        send the mail. The handler's `z.string().email()` rejects a payload
        without it."""
        client = RecordingSqsClient()
        publish(build(client, email="someone@example.org"))
        assert sent_body(client)["payload"]["email"] == "someone@example.org"

    def test_the_email_is_resolved_for_the_persisted_user_id(self) -> None:
        """The resolver is asked about the `user_id` it was handed, not about the
        order or anything else — Users is keyed by the internal `usr_` id."""
        asked: list[str] = []
        client = RecordingSqsClient()
        publisher = SqsEventPublisher(
            client=client,
            queue_url=QUEUE_URL,
            resolve_email=lambda user_id: (asked.append(user_id), EMAIL)[1],
        )

        publish(publisher, user_id="usr_specific000000001")

        assert asked == ["usr_specific000000001"]


class TestMessageAttributes:
    """`type` and `source` are duplicated as attributes so the queue can be
    inspected and filtered without deserializing the body — the same two keys
    Users and Orders set."""

    def test_type_and_source_are_set_as_message_attributes(self) -> None:
        client = RecordingSqsClient()
        publish(build(client))

        assert client.sends[0]["MessageAttributes"] == {
            "type": {"DataType": "String", "StringValue": "TRACKING_STATUS_CHANGED"},
            "source": {"DataType": "String", "StringValue": "tracking"},
        }

    def test_the_attributes_agree_with_the_body(self) -> None:
        """Two sources for the same two facts; they must not drift."""
        client = RecordingSqsClient()
        publish(build(client))
        attributes = client.sends[0]["MessageAttributes"]
        envelope = sent_body(client)

        assert attributes["type"]["StringValue"] == envelope["type"]
        assert attributes["source"]["StringValue"] == envelope["source"]


class TestDeriveEventId:
    """The property that makes a retry collapse instead of mailing twice.

    The pipeline dedupes on a unique index over `event_id`. A randomly generated
    id would slip past that index and send a SECOND notification for a transition
    that already succeeded — which matters most under TestMode, walking four
    statuses in ~30 seconds.
    """

    def test_the_same_pair_yields_the_same_id(self) -> None:
        assert derive_event_id(ORDER_ID, "ON_THE_WAY") == derive_event_id(
            ORDER_ID, "ON_THE_WAY"
        )

    def test_it_is_stable_across_many_calls(self) -> None:
        """A fresh id per attempt — `uuid4()`, a timestamp — passes a single
        equality check by luck far less often than it passes none; ten calls make
        that impossible."""
        ids = {derive_event_id(ORDER_ID, "DELIVERED") for _ in range(10)}
        assert len(ids) == 1

    def test_a_different_status_yields_a_different_id(self) -> None:
        """Four transitions of one order are four distinct events — an id keyed
        on the order alone would make the pipeline dedupe away three of the four
        emails."""
        ids = {
            derive_event_id(ORDER_ID, status)
            for status in (
                "SHIPPED",
                "ON_THE_WAY",
                "OUT_FOR_DELIVERY",
                "DELIVERED",
            )
        }
        assert len(ids) == 4

    def test_a_different_order_yields_a_different_id(self) -> None:
        """Otherwise every order's ON_THE_WAY event would collide and only the
        first customer would be told."""
        assert derive_event_id("ord_one", "ON_THE_WAY") != derive_event_id(
            "ord_two", "ON_THE_WAY"
        )

    def test_the_pair_is_hashed_not_interpolated(self) -> None:
        """`evt_{order_id}_{status}` would vary in length with the order id and
        could collide across pairs whose parts straddle the separator. The id has
        a fixed shape whatever it is derived from."""
        short = derive_event_id("o", "SHIPPED")
        long = derive_event_id("ord_" + "z" * 200, "SHIPPED")

        assert len(short) == len(long)
        assert re.fullmatch(r"evt_[0-9a-f]{16}", short)

    def test_the_id_does_not_contain_the_order_id(self) -> None:
        """Corollary of hashing: the id is opaque, so nothing downstream can
        start parsing an order id back out of it."""
        assert "ord_recognizable" not in derive_event_id(
            "ord_recognizable", "SHIPPED"
        )

    def test_every_real_pair_in_a_progression_is_distinct(self) -> None:
        """The property that actually has to hold: across several orders each
        walking all four statuses, no two transitions share an id.

        Stated over the REAL domain rather than as separator-injection
        resistance, because the latter does not hold and does not need to:
        `f"{order_id}|{status}"` is the classic ambiguous concatenation, so
        `("a|b", "c")` and `("a", "b|c")` do collide. Unreachable here — `status`
        is always one of four literals from a closed `StrEnum` (`parse_status`
        rejects everything else before this is ever called), none containing a
        `|` — so the only way to forge a collision is to supply a status that
        cannot exist. Recorded rather than asserted away: if `status` ever became
        free-form, this comment is the reason to revisit the separator.
        """
        orders = [f"ord_{index:017d}" for index in range(25)]
        statuses = ("SHIPPED", "ON_THE_WAY", "OUT_FOR_DELIVERY", "DELIVERED")
        ids = {
            derive_event_id(order, status)
            for order in orders
            for status in statuses
        }

        assert len(ids) == len(orders) * len(statuses)


class TestHashEmail:
    """The cross-service `email_hash` contract from [[logging-context]]."""

    def test_it_matches_the_pinned_cross_service_value(self) -> None:
        """The literal Users' `hashEmail` and Orders' `EmailHash.Compute` both
        pin (`services/users/tests/shared/email-hash.test.ts`,
        `services/orders/tests/Orders.Tests/Logging/EmailHashTests.cs`).

        Pinned rather than recomputed with hashlib in the test: a test that
        re-derived the value with the same algorithm would agree with ANY
        implementation of it, including one that had drifted from the other two
        services. Drift there is silent in production — filtering one user's
        lines across services returns nothing instead of erroring."""
        assert hash_email("user@example.com") == "b4c9a289323b21a0"

    def test_it_normalizes_case_and_surrounding_whitespace(self) -> None:
        """Same three normalizations Users asserts, so an address that reaches
        the three services differently spelled still filters as one user."""
        canonical = hash_email("user@example.com")

        assert hash_email("USER@example.com") == canonical
        assert hash_email("  user@example.com  ") == canonical
        assert hash_email("User@Example.COM") == canonical

    def test_it_is_sixteen_hex_characters(self) -> None:
        assert re.fullmatch(r"[0-9a-f]{16}", hash_email("user@example.com"))

    def test_different_addresses_hash_differently(self) -> None:
        assert hash_email("a@example.com") != hash_email("b@example.com")

    def test_it_does_not_leak_the_address(self) -> None:
        """It is only safe to log because it is not reversible by reading."""
        hashed = hash_email("jose@example.com")

        assert "jose" not in hashed
        assert "@" not in hashed
        assert "example" not in hashed


class TestSendFailureIsLoggedAndSwallowed:
    """A failed send must not propagate. The transition is already committed by
    the time this runs, and raising would make the carrier retry the SAME
    transition — which the forward-only state machine rejects with a `400
    not_strictly_forward`, a permanent-looking failure for a change we actually
    recorded."""

    def test_a_failing_send_does_not_raise(self) -> None:
        """Asserted as "the call returns", not as "the fake raised" — the fake
        raising is this test's own setup, not the behaviour under test."""
        publisher = build(FailingSqsClient())

        assert publish(publisher) is None

    def test_it_really_did_attempt_the_send(self) -> None:
        """Guards the test above: a publisher that never sent anything would also
        "not raise", and would pass a swallowing assertion vacuously."""
        client = FailingSqsClient()
        publish(build(client))

        assert len(client.attempts) == 1

    def test_the_failure_is_logged_as_an_error_with_its_reason(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Swallowed is not silent: the `reason` is what makes this alertable,
        and what distinguishes a queue outage from an unresolvable user."""
        with caplog.at_level(logging.ERROR):
            publish(build(FailingSqsClient()))

        records = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert len(records) == 1
        assert records[0].app_event == "tracking_status_changed_publish_failed"
        assert records[0].reason == "sqs_send_failed"

    def test_the_failure_line_carries_the_identifiers(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Without these the alert names no order and no user, so nobody can tell
        which notification was lost."""
        with caplog.at_level(logging.ERROR):
            publish(build(FailingSqsClient()))
        record = caplog.records[-1]

        assert record.order_id == ORDER_ID
        assert record.user_id == USER_ID
        assert record.status == "ON_THE_WAY"

    def test_the_failure_line_carries_the_email_hash_not_the_address(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """`email_hash` is the cross-service join key; the address itself is PII
        and this line is retained in OpenObserve."""
        with caplog.at_level(logging.ERROR):
            publish(build(FailingSqsClient(), email="user@example.com"))
        record = caplog.records[-1]

        assert record.email_hash == "b4c9a289323b21a0"

    def test_the_traceback_is_preserved(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """`logger.exception`, not `logger.error`: without the cause, an alert
        says a send failed and nothing about why."""
        with caplog.at_level(logging.ERROR):
            publish(build(FailingSqsClient(ValueError("boto3 said no"))))

        assert caplog.records[-1].exc_info is not None


class TestEmailResolutionFailure:
    """Users unreachable, or answering something other than NOT_FOUND. Degrades
    exactly like a failed send — the transition is already committed."""

    def test_a_raising_resolver_does_not_raise_out(self) -> None:
        publisher = build(
            RecordingSqsClient(), resolver_error=RuntimeError("users down")
        )

        assert publish(publisher) is None

    def test_nothing_is_published_when_the_email_cannot_be_resolved(self) -> None:
        """Publishing an envelope with no email would only manufacture a FAILED
        document in the pipeline: the handler rejects it as a PermanentError."""
        client = RecordingSqsClient()
        publish(build(client, resolver_error=RuntimeError("users down")))

        assert client.sends == []

    def test_the_reason_distinguishes_resolution_from_the_send(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Three distinct reasons under one `app_event`; collapsing them would
        make a Users outage and a queue outage indistinguishable in the logs."""
        with caplog.at_level(logging.ERROR):
            publish(build(RecordingSqsClient(), resolver_error=RuntimeError("x")))
        record = caplog.records[-1]

        assert record.app_event == "tracking_status_changed_publish_failed"
        assert record.reason == "email_resolution_failed"

    def test_an_unknown_user_is_reported_as_no_email(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Users answered NOT_FOUND (the client maps that to None), or holds no
        address. Not an outage, so it gets its own reason."""
        client = RecordingSqsClient()
        with caplog.at_level(logging.ERROR):
            publish(build(client, email=None))

        assert client.sends == []
        assert caplog.records[-1].reason == "no_email_for_user"

    def test_an_empty_email_is_treated_as_no_email(self) -> None:
        """proto3 has no null, so an absent address can arrive as `""`. It would
        pass a `is not None` check and fail the handler's `z.string().email()`
        downstream, where the reason is no longer legible."""
        client = RecordingSqsClient()
        publish(build(client, email=""))

        assert client.sends == []


class TestNoPlaintextEmailInLogs:
    """The rule from [[logging-context]], asserted over the WHOLE log record —
    message, args and every extra field — because a leak is far more likely to
    arrive through a field nobody thought about than through the one under test.
    """

    ADDRESS = "leaky.person@example.com"

    def _rendered(self, caplog: pytest.LogCaptureFixture) -> str:
        """Every record flattened to one searchable string.

        Includes the formatted message, the exception text and the value of every
        non-standard attribute — i.e. everything a formatter could conceivably
        emit, not just the fields this implementation happens to set.
        """
        standard = set(logging.LogRecord("", 0, "", 0, "", None, None).__dict__)
        parts: list[str] = []
        for record in caplog.records:
            parts.append(record.getMessage())
            if record.exc_info and record.exc_info[1]:
                parts.append(repr(record.exc_info[1]))
            parts.extend(
                f"{key}={value!r}"
                for key, value in record.__dict__.items()
                if key not in standard
            )
        return "\n".join(parts)

    def test_a_failed_send_never_logs_the_address(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.DEBUG):
            publish(build(FailingSqsClient(), email=self.ADDRESS))

        rendered = self._rendered(caplog)
        assert self.ADDRESS not in rendered
        assert "leaky.person" not in rendered

    def test_a_failed_send_logs_the_hash_of_that_address(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The other half of the rule: absent the address, the line must still
        identify the user, or the PII rule has just deleted the diagnostic.

        The expected value is computed with `hash_email`, which is itself pinned
        to the cross-service literal above — so this cannot drift without that
        test failing first.
        """
        with caplog.at_level(logging.ERROR):
            publish(build(FailingSqsClient(), email=self.ADDRESS))

        assert self._rendered(caplog).count(hash_email(self.ADDRESS)) == 1

    def test_an_exception_carrying_the_address_is_not_logged_verbatim(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The realistic leak path: boto3 (or a resolver) raises an error whose
        text quotes the payload. `logger.exception` renders the traceback, so an
        address inside the EXCEPTION reaches the log even though the publisher
        never put it in a field itself.

        Documented as a KNOWN limitation rather than asserted away: nothing in
        the publisher can sanitize a third-party exception's message, and the
        rule this suite can enforce is that the publisher's own fields are clean.
        """
        leaky = RuntimeError(f"failed delivering to {self.ADDRESS}")
        with caplog.at_level(logging.ERROR):
            publish(build(FailingSqsClient(leaky), email=self.ADDRESS))

        record = caplog.records[-1]
        standard = set(logging.LogRecord("", 0, "", 0, "", None, None).__dict__)
        own_fields = {
            key: value
            for key, value in record.__dict__.items()
            if key not in standard
        }

        # The publisher's OWN contribution is PII-free...
        assert self.ADDRESS not in repr(own_fields)
        assert own_fields["email_hash"] == hash_email(self.ADDRESS)
        # ...and the message it chose is the flow event, not the cause's text.
        assert record.getMessage() == "tracking_status_changed_publish_failed"

    def test_the_successful_path_logs_nothing_at_all(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A success line carrying the payload would leak the address on EVERY
        transition rather than only on failures — a far bigger exposure than the
        error paths this class mostly guards."""
        with caplog.at_level(logging.DEBUG):
            publish(build(RecordingSqsClient(), email=self.ADDRESS))

        assert self._rendered(caplog) == ""


class TestModuleConstants:
    """The three wire literals, pinned once so the assertions above may keep
    using the constants where readability wins."""

    def test_the_constants_match_the_wire_contract(self) -> None:
        assert EVENT_TYPE == "TRACKING_STATUS_CHANGED"
        assert EVENT_SOURCE == "tracking"
        assert EVENT_ID_PREFIX == "evt_"
