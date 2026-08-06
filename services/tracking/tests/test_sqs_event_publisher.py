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
  `{ status, previous_status, changed_at, email }`, plus the enrichment fields
  `{ full_name, order_id, tracking_number, shipping_address?, history[] }` from
  `docs/superpowers/specs/2026-08-05-email-payload-enrichment-design.md`.

A drift on either side is not a loud failure in production: the handler rejects
the record as a `PermanentError`, consumes it, and nobody gets an email. These
assertions are the only place that drift becomes visible.

## The tracking is a REAL entity, unsaved

The publisher takes the persisted `Tracking` row. These tests build one in
memory rather than through the repository: what is under test is the mapping
from entity to JSON, and every field it reads is a plain attribute. No database
is needed for that — the persistence side is covered against real MySQL in
`test_status_changed_emission.py`, which is where a column that does not exist
would actually fail.

Using the real model class rather than a stub object is what makes a typo in an
attribute name (`tracking.number`, `tracking.addresses`) fail here instead of
passing against a `SimpleNamespace` that answers anything.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from typing import Any

import pytest

from src.features.tracking.domain.models import Tracking, TrackingHistory
from src.shared.audit.audit_actor import AuditActor
from src.shared.grpc.users_client import ResolvedUser
from src.shared.messaging.sqs_event_publisher import (
    EVENT_ID_PREFIX,
    EVENT_SOURCE,
    EVENT_TYPE,
    SqsEventPublisher,
    derive_event_id,
    hash_email,
    serialize_history,
)

QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/events"

TRACKING_ID = "trk_aaaaaaaaaaaaaaaaaaaaa"
ORDER_ID = "ord_aaaaaaaaaaaaaaaaaaaaa"
USER_ID = "usr_aaaaaaaaaaaaaaaaaaaaa"
EMAIL = "user@example.com"
FULL_NAME = "Ada Lovelace"
TRACKING_NUMBER = "3MRAI-K7QD-2XBM-9PWA"

#: A real-shaped address snapshot. A `dict`, because the column is JSON and the
#: service stores whatever mapping it was handed without reshaping it.
SHIPPING_ADDRESS = {
    "line1": "742 Evergreen Terrace",
    "city": "Springfield",
    "country": "US",
    "postal_code": "97477",
}

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


def history_entries(
    *steps: tuple[str, datetime],
) -> list[TrackingHistory]:
    """Build history rows, already in the order the relationship would yield.

    The publisher must NOT re-sort them (see `serialize_history`), so this
    helper hands over the sequence exactly as given — a test can therefore hand
    over a deliberately awkward one and assert the order survived.
    """
    return [
        TrackingHistory(
            tracking_id=TRACKING_ID,
            order_id=ORDER_ID,
            user_id=USER_ID,
            status=status,
            datetime_=moment,
        )
        for status, moment in steps
    ]


def tracking(
    *,
    status: str = "PROCESSING",
    changed_at: datetime = CHANGED_AT,
    order_id: str = ORDER_ID,
    user_id: str = USER_ID,
    tracking_number: str = TRACKING_NUMBER,
    shipping_address: dict[str, Any] | None = None,
    history: list[TrackingHistory] | None = None,
) -> Tracking:
    """An unsaved `Tracking` shaped like the row a transition just wrote.

    `shipping_address` defaults to None — i.e. ABSENT — deliberately, so a test
    that cares about the address has to say so, and the omission assertions read
    as the default rather than as a special case.
    """
    return Tracking(
        id=TRACKING_ID,
        order_id=order_id,
        user_id=user_id,
        cognito_sub="22222222-2222-4222-8222-222222222222",
        tracking_number=tracking_number,
        status=status,
        shipping_address=shipping_address,
        tags=[],
        datetime_=changed_at,
        history=history if history is not None else [],
    )


def build(
    client: Any,
    *,
    email: str | None = EMAIL,
    full_name: str = FULL_NAME,
    user: ResolvedUser | None = None,
    unknown_user: bool = False,
    resolver_error: Exception | None = None,
) -> SqsEventPublisher:
    """A publisher over `client`, with the Users resolution stubbed out.

    The resolver is a plain closure rather than a gRPC client: what is under test
    here is the envelope and the failure policy, and `users_client.py` has its own
    suite against a real `users.v1.Users` server on a real socket.

    `unknown_user=True` is Users answering NOT_FOUND (the client maps that to
    None) — distinct from `email=None`, which is a KNOWN user with no address on
    file. Both must degrade the same way, and having two spellings is what lets
    a test assert that they do.
    """

    def resolve(user_id: str) -> ResolvedUser | None:
        if resolver_error is not None:
            raise resolver_error
        if unknown_user:
            return None
        return user or ResolvedUser(
            internal_id=user_id,
            cognito_sub="22222222-2222-4222-8222-222222222222",
            email=email,
            full_name=full_name,
        )

    return SqsEventPublisher(
        client=client, queue_url=QUEUE_URL, resolve_user=resolve
    )


def publish(
    publisher: SqsEventPublisher,
    *,
    entity: Tracking | None = None,
    previous_status: str = "PLACED",
    actor: AuditActor = AuditActor.CARRIER_STATUS_UPDATE,
    **entity_fields: Any,
) -> None:
    """Publish one transition.

    `entity_fields` are forwarded to `tracking()`, so a test that only cares
    about one field says only that (`publish(p, status="DELIVERED")`) while a
    test that needs a fully-built row passes `entity=`.
    """
    publisher.publish_tracking_status_changed(
        tracking=entity if entity is not None else tracking(**entity_fields),
        previous_status=previous_status,
        actor=actor,
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
        """`EnvelopeSchema` requires all seven. `order_id` is NULLABLE, not
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
            "author",
            "payload",
        }

    def test_the_keys_are_snake_case(self) -> None:
        """The pipeline is TypeScript and would idiomatically read `eventId`; the
        contract is snake_case on the wire. Asserted structurally so a future key
        cannot arrive camelCased without failing.

        Covers the nested objects too: `author` was added later than the rest, and
        a nested `cognitoSub` would be exactly the kind of key this catches."""
        body = RecordingSqsClient()
        publish(build(body))
        envelope = sent_body(body)

        keys = (
            list(envelope) + list(envelope["payload"]) + list(envelope["author"])
        )
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


class TestTheAuthorItBuilds:
    """WHO originated the event, as opposed to `user_id`, which is WHO it is
    about.

    This event is the reason the two are separate at all: neither of its paths
    has a human author. The carrier is an external system holding an API key and
    TestMode progression is a timer, so the author carries `actor` and nothing
    else — the order's owner belongs in the envelope's root `user_id`, and
    copying it here would assert that the buyer changed their own parcel's
    status.
    """

    def test_the_author_carries_exactly_the_actor(self) -> None:
        """No `user_id`, no `cognito_sub`: there IS no human on either path, and
        the contract omits what it does not know rather than nulling it. No
        `source` either — the envelope's root one already names the producer."""
        client = RecordingSqsClient()
        publish(build(client))

        assert set(sent_body(client)["author"]) == {"actor"}

    def test_the_omitted_identity_keys_are_absent_from_the_json(self) -> None:
        """Absence is asserted on the SERIALIZED body, not on the dict: a
        `"user_id": null` would satisfy a `.get(...) is None` check while
        violating the contract — the key must not be there at all."""
        client = RecordingSqsClient()
        publish(build(client))
        raw = client.sends[0]["MessageBody"]

        assert "cognito_sub" not in raw
        # `user_id` DOES appear at the envelope root (the subject); what must not
        # exist is one inside the author.
        assert "user_id" not in sent_body(client)["author"]

    def test_the_producer_is_named_once_at_the_root_not_twice(self) -> None:
        """`AuthorSchema` has no `source`. Two copies of a per-publisher constant
        carry no information and can only drift; the root one stays."""
        client = RecordingSqsClient()
        publish(build(client))
        envelope = sent_body(client)

        assert "source" not in envelope["author"]
        assert envelope["source"] == "tracking"

    def test_the_carrier_path_is_labelled_as_the_carrier(self) -> None:
        """A literal, not the enum: renaming the member must not silently rename
        the wire value the consumer reads."""
        client = RecordingSqsClient()
        publish(build(client), actor=AuditActor.CARRIER_STATUS_UPDATE)

        assert (
            sent_body(client)["author"]["actor"]
            == "tracking_api:carrier_status_update"
        )

    def test_the_testmode_path_is_labelled_as_testmode(self) -> None:
        """The case a hardcoded constant in the publisher would get wrong: an
        automatic progression must not reach the pipeline looking like a real
        third-party carrier update."""
        client = RecordingSqsClient()
        publish(build(client), actor=AuditActor.TEST_MODE_PROGRESSION)

        assert (
            sent_body(client)["author"]["actor"]
            == "tracking_api:test_mode_progression"
        )

    def test_the_two_paths_do_not_share_one_label(self) -> None:
        """Directly rules out the constant: no fixed value can satisfy this."""
        client = RecordingSqsClient()
        publisher = build(client)
        publish(publisher, actor=AuditActor.CARRIER_STATUS_UPDATE)
        publish(publisher, actor=AuditActor.TEST_MODE_PROGRESSION)

        assert (
            sent_body(client, 0)["author"]["actor"]
            != sent_body(client, 1)["author"]["actor"]
        )

    def test_the_actor_is_serialized_as_its_string_value(self) -> None:
        """`AuditActor` is a `StrEnum`, so `json.dumps` would serialize it either
        way — but only after someone remembers it is one. Pinned as a plain
        string so a future non-str enum cannot make `json.dumps` raise inside the
        send, where the swallow policy would turn it into "no event at all"."""
        client = RecordingSqsClient()
        publish(build(client))
        actor = sent_body(client)["author"]["actor"]

        assert isinstance(actor, str)
        assert actor.startswith("tracking_api:")


class TestThePayloadItBuilds:
    """Against `TrackingStatusChangedPayloadSchema` in the handler."""

    def test_the_payload_has_exactly_the_expected_keys(self) -> None:
        """The four original fields plus the enrichment ones.

        `shipping_address` is NOT here, and that is the assertion: this
        publishes a tracking with no address, and the key must be absent rather
        than null. `TestShippingAddressIsOmittedNotNulled` covers both
        directions.

        Asserted as an exact set, not as a subset: an extra key is as much a
        contract change as a missing one, and the handler validates the payload
        it is given.
        """
        client = RecordingSqsClient()
        publish(build(client))

        assert set(sent_body(client)["payload"]) == {
            "status",
            "previous_status",
            "changed_at",
            "email",
            "full_name",
            "order_id",
            "tracking_number",
            "history",
        }

    def test_status_and_previous_status_are_the_transition(self) -> None:
        client = RecordingSqsClient()
        publish(
            build(client), status="OUT_FOR_DELIVERY", previous_status="PROCESSING"
        )
        payload = sent_body(client)["payload"]

        assert payload["status"] == "OUT_FOR_DELIVERY"
        assert payload["previous_status"] == "PROCESSING"

    @pytest.mark.parametrize(
        "status",
        ["PLACED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"],
    )
    def test_every_progression_status_passes_the_handlers_enum(
        self, status: str
    ) -> None:
        """The handler's `z.enum` accepts exactly these five. A publisher that
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
        """The resolver is asked about the `user_id` off the ROW, not about the
        order or anything else — Users is keyed by the internal `usr_` id."""
        asked: list[str] = []
        client = RecordingSqsClient()

        def resolve(user_id: str) -> ResolvedUser:
            asked.append(user_id)
            return ResolvedUser(
                internal_id=user_id,
                cognito_sub="sub",
                email=EMAIL,
                full_name=FULL_NAME,
            )

        publisher = SqsEventPublisher(
            client=client, queue_url=QUEUE_URL, resolve_user=resolve
        )

        publish(publisher, user_id="usr_specific000000001")

        assert asked == ["usr_specific000000001"]

    def test_the_user_is_resolved_exactly_once_per_event(self) -> None:
        """`full_name` and `email` come off ONE `GetUserById` response.

        The spec's justification for carrying the name is that it costs no new
        round trip. A publisher that resolved the name separately would satisfy
        every field assertion here and quietly double the load on Users.
        """
        calls: list[str] = []
        client = RecordingSqsClient()

        def resolve(user_id: str) -> ResolvedUser:
            calls.append(user_id)
            return ResolvedUser(
                internal_id=user_id,
                cognito_sub="sub",
                email=EMAIL,
                full_name=FULL_NAME,
            )

        publish(
            SqsEventPublisher(
                client=client, queue_url=QUEUE_URL, resolve_user=resolve
            )
        )
        payload = sent_body(client)["payload"]

        assert len(calls) == 1
        assert payload["email"] == EMAIL
        assert payload["full_name"] == FULL_NAME

    def test_the_full_name_is_the_resolved_name(self) -> None:
        """What the template greets the reader with. From the same
        `GetUserById` response the address came from."""
        client = RecordingSqsClient()
        publish(build(client, full_name="Grace Hopper"))

        assert sent_body(client)["payload"]["full_name"] == "Grace Hopper"

    def test_a_missing_name_is_an_empty_string_not_a_missing_key(self) -> None:
        """Users holds no name for this user — proto3 sends `""`.

        Unlike `shipping_address`, this key stays: the greeting is
        unconditional, so the template needs something to interpolate and an
        absent key would be a `KeyError` mid-render. The mail is still
        deliverable, which is the difference from a missing email.
        """
        client = RecordingSqsClient()
        publish(build(client, full_name=""))
        payload = sent_body(client)["payload"]

        assert "full_name" in payload
        assert payload["full_name"] == ""

    def test_the_order_id_is_carried_in_the_payload_too(self) -> None:
        """It is on the envelope root as well, and the duplication is
        deliberate: the handler renders from the payload, so making a template
        reach up into the envelope for one field would be a second,
        undocumented data path."""
        client = RecordingSqsClient()
        publish(build(client), order_id="ord_zzzzzzzzzzzzzzzzzzzzz")
        envelope = sent_body(client)

        assert envelope["payload"]["order_id"] == "ord_zzzzzzzzzzzzzzzzzzzzz"
        assert envelope["payload"]["order_id"] == envelope["order_id"]

    def test_the_tracking_number_is_the_rows_own(self) -> None:
        """Read off the entity, never re-minted here: a number generated at
        publish time would differ from the one the database holds, so two
        emails about one shipment would quote two different numbers."""
        client = RecordingSqsClient()
        publish(build(client), tracking_number="3MRAI-ABCD-EFGH-JKLM")

        assert (
            sent_body(client)["payload"]["tracking_number"]
            == "3MRAI-ABCD-EFGH-JKLM"
        )

    def test_the_tracking_number_keeps_its_readable_format(self) -> None:
        """Serialized verbatim — not stripped of its separators, not
        lowercased. The value in the email is the value a customer reads back,
        and it must match what a support agent finds in the database."""
        client = RecordingSqsClient()
        publish(build(client))
        number = sent_body(client)["payload"]["tracking_number"]

        assert re.fullmatch(r"3MRAI-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}", number)


class TestShippingAddressIsOmittedNotNulled:
    """The repo-wide rule: unknown fields are OMITTED, never null.

    `Tracking.shipping_address` is nullable — proto3 has no null, so an address
    absent upstream arrives as an empty message and is persisted as NULL. A
    `"shipping_address": null` on the wire would give "no address" two spellings
    and make the template branch on both.

    Both assertions below are on the SERIALIZED body, not on the dict: a null
    value satisfies a `.get(...) is None` check while violating the contract.
    """

    def test_the_address_is_carried_when_the_row_has_one(self) -> None:
        """The other half of the rule — omitting it always would silently
        delete the address block from every email."""
        client = RecordingSqsClient()
        publish(build(client), shipping_address=SHIPPING_ADDRESS)

        assert sent_body(client)["payload"]["shipping_address"] == SHIPPING_ADDRESS

    def test_the_key_is_absent_when_the_row_has_none(self) -> None:
        client = RecordingSqsClient()
        publish(build(client), shipping_address=None)

        assert "shipping_address" not in sent_body(client)["payload"]

    def test_it_is_not_serialized_as_null(self) -> None:
        """Stated against the raw JSON, which is what actually reaches SQS: the
        string `"shipping_address"` must not appear at all."""
        client = RecordingSqsClient()
        publish(build(client), shipping_address=None)

        assert "shipping_address" not in client.sends[0]["MessageBody"]

    def test_an_empty_address_mapping_is_still_carried(self) -> None:
        """`{}` is a row that HAS an address column value, however unhelpful —
        distinct from NULL. Omitting it would make the publisher second-guess
        what the database was told to store."""
        client = RecordingSqsClient()
        publish(build(client), shipping_address={})

        assert sent_body(client)["payload"]["shipping_address"] == {}


class TestTheHistoryItSerializes:
    """`history[]` is what makes the five-step delivery timeline renderable.

    Without it a transition event can only describe its own step, and the
    template would have to invent the other four.
    """

    #: A full run, oldest first — the order `Tracking.history` yields.
    FULL_RUN = (
        ("PLACED", datetime(2026, 8, 3, 10, 0, 0)),
        ("PROCESSING", datetime(2026, 8, 3, 11, 0, 0)),
        ("SHIPPED", datetime(2026, 8, 3, 12, 0, 0)),
        ("OUT_FOR_DELIVERY", datetime(2026, 8, 3, 13, 0, 0)),
        ("DELIVERED", datetime(2026, 8, 3, 14, 0, 0)),
    )

    def test_every_transition_is_carried(self) -> None:
        """One entry per transition, not just the current step."""
        client = RecordingSqsClient()
        publish(
            build(client),
            status="DELIVERED",
            history=history_entries(*self.FULL_RUN),
        )

        assert [entry["status"] for entry in sent_body(client)["payload"]["history"]] == [
            "PLACED",
            "PROCESSING",
            "SHIPPED",
            "OUT_FOR_DELIVERY",
            "DELIVERED",
        ]

    def test_each_entry_carries_its_own_datetime(self) -> None:
        """Not the event's `changed_at` copied five times: each step happened at
        its own moment, and a timeline stamping them all identically would be
        five rows saying nothing."""
        client = RecordingSqsClient()
        publish(
            build(client),
            status="DELIVERED",
            history=history_entries(*self.FULL_RUN),
        )

        assert [
            entry["datetime"] for entry in sent_body(client)["payload"]["history"]
        ] == [
            "2026-08-03T10:00:00",
            "2026-08-03T11:00:00",
            "2026-08-03T12:00:00",
            "2026-08-03T13:00:00",
            "2026-08-03T14:00:00",
        ]

    def test_each_entry_has_exactly_status_and_datetime(self) -> None:
        """No `tracking_id`, no `user_id`, and above all no `cognito_sub`: those
        are identical across every entry, already at the envelope root, and the
        sub is an ownership key with no business leaving the service."""
        client = RecordingSqsClient()
        publish(build(client), history=history_entries(*self.FULL_RUN))

        for entry in sent_body(client)["payload"]["history"]:
            assert set(entry) == {"status", "datetime"}

    def test_the_datetimes_are_strings_not_raw_datetimes(self) -> None:
        """A `datetime` is not JSON-serializable, and `json.dumps` raising
        inside the send would be swallowed by the failure policy into "no event
        at all" rather than into a loud error."""
        client = RecordingSqsClient()
        publish(build(client), history=history_entries(*self.FULL_RUN))

        for entry in sent_body(client)["payload"]["history"]:
            assert isinstance(entry["datetime"], str)
            assert entry["datetime"]

    def test_the_order_is_preserved_and_not_re_sorted(self) -> None:
        """The relationship already sorts by `TrackingHistory.ordering()` —
        timestamp, then progression position.

        Handed a run whose timestamps all TIE (which real same-second
        transitions do), the publisher must keep the sequence it was given. A
        publisher that re-sorted on `datetime` would be free to reorder these,
        and MySQL's own tiebreak is alphabetical PK order — DELIVERED before
        PLACED, i.e. a parcel delivered before it was placed.
        """
        tied = datetime(2026, 8, 3, 9, 0, 0)
        client = RecordingSqsClient()
        publish(
            build(client),
            history=history_entries(
                ("PLACED", tied),
                ("PROCESSING", tied),
                ("SHIPPED", tied),
            ),
        )

        assert [
            entry["status"] for entry in sent_body(client)["payload"]["history"]
        ] == ["PLACED", "PROCESSING", "SHIPPED"]

    def test_the_history_includes_the_transition_being_announced(self) -> None:
        """The property that matters most: an email announcing SHIPPED whose
        timeline stops at PROCESSING is describing a state the reader cannot
        see. The command hands over an entity whose collection was expired and
        reloaded for exactly this reason."""
        client = RecordingSqsClient()
        publish(
            build(client),
            status="SHIPPED",
            previous_status="PROCESSING",
            history=history_entries(*self.FULL_RUN[:3]),
        )
        payload = sent_body(client)["payload"]

        assert payload["status"] in [
            entry["status"] for entry in payload["history"]
        ]

    def test_a_single_entry_history_is_still_a_list(self) -> None:
        """The very first transition has two entries; a hypothetical one-entry
        row must still serialize as an array, not as a bare object the template
        would then fail to iterate."""
        client = RecordingSqsClient()
        publish(build(client), history=history_entries(*self.FULL_RUN[:1]))
        history = sent_body(client)["payload"]["history"]

        assert isinstance(history, list)
        assert len(history) == 1

    def test_an_empty_history_serializes_as_an_empty_list(self) -> None:
        """Never omitted and never null — the key is unconditional so the
        template iterates one shape. (No real row reaches this state: creation
        always writes the opening `PLACED` row.)"""
        client = RecordingSqsClient()
        publish(build(client), history=[])
        payload = sent_body(client)["payload"]

        assert payload["history"] == []
        assert "history" in payload


class TestSerializeHistory:
    """The helper on its own, without a queue in the way."""

    def test_it_maps_each_entry_to_status_and_datetime(self) -> None:
        entries = history_entries(
            ("PLACED", datetime(2026, 8, 3, 10, 0, 0)),
            ("PROCESSING", datetime(2026, 8, 3, 11, 0, 0)),
        )

        assert serialize_history(entries) == [
            {"status": "PLACED", "datetime": "2026-08-03T10:00:00"},
            {"status": "PROCESSING", "datetime": "2026-08-03T11:00:00"},
        ]

    def test_it_is_json_serializable(self) -> None:
        """The property the publisher depends on: anything left as a `datetime`
        would raise inside `json.dumps`, where the swallow policy turns the
        failure into a missing email rather than an error."""
        serialized = serialize_history(
            history_entries(("PLACED", datetime(2026, 8, 3, 10, 0, 0)))
        )

        assert json.loads(json.dumps(serialized)) == serialized

    def test_an_empty_sequence_yields_an_empty_list(self) -> None:
        assert serialize_history([]) == []


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
    that already succeeded — which matters most under TestMode, walking five
    statuses in ~40 seconds.
    """

    def test_the_same_pair_yields_the_same_id(self) -> None:
        assert derive_event_id(ORDER_ID, "PROCESSING") == derive_event_id(
            ORDER_ID, "PROCESSING"
        )

    def test_it_is_stable_across_many_calls(self) -> None:
        """A fresh id per attempt — `uuid4()`, a timestamp — passes a single
        equality check by luck far less often than it passes none; ten calls make
        that impossible."""
        ids = {derive_event_id(ORDER_ID, "DELIVERED") for _ in range(10)}
        assert len(ids) == 1

    def test_a_different_status_yields_a_different_id(self) -> None:
        """Five statuses of one order are five distinct events — an id keyed
        on the order alone would make the pipeline dedupe away four of the five
        emails."""
        ids = {
            derive_event_id(ORDER_ID, status)
            for status in (
                "PLACED",
                "PROCESSING",
                "SHIPPED",
                "OUT_FOR_DELIVERY",
                "DELIVERED",
            )
        }
        assert len(ids) == 5

    def test_a_different_order_yields_a_different_id(self) -> None:
        """Otherwise every order's PROCESSING event would collide and only the
        first customer would be told."""
        assert derive_event_id("ord_one", "PROCESSING") != derive_event_id(
            "ord_two", "PROCESSING"
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
        walking all five statuses, no two transitions share an id.

        Stated over the REAL domain rather than as separator-injection
        resistance, because the latter does not hold and does not need to:
        `f"{order_id}|{status}"` is the classic ambiguous concatenation, so
        `("a|b", "c")` and `("a", "b|c")` do collide. Unreachable here — `status`
        is always one of five literals from a closed `StrEnum` (`parse_status`
        rejects everything else before this is ever called), none containing a
        `|` — so the only way to forge a collision is to supply a status that
        cannot exist. Recorded rather than asserted away: if `status` ever became
        free-form, this comment is the reason to revisit the separator.
        """
        orders = [f"ord_{index:017d}" for index in range(25)]
        statuses = (
            "PLACED",
            "PROCESSING",
            "SHIPPED",
            "OUT_FOR_DELIVERY",
            "DELIVERED",
        )
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
        assert record.status == "PROCESSING"

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

    def test_a_known_user_with_no_email_is_reported_as_no_email(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Users answered, but holds no address for this user. Not an outage, so
        it gets its own reason."""
        client = RecordingSqsClient()
        with caplog.at_level(logging.ERROR):
            publish(build(client, email=None))

        assert client.sends == []
        assert caplog.records[-1].reason == "no_email_for_user"

    def test_an_unknown_user_is_reported_as_no_email_too(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The OTHER shape of "no address": Users answered NOT_FOUND, which the
        client maps to `None` for the whole record rather than to a record with
        an empty email.

        Distinct from the case above and asserted separately, because the
        publisher now reads two fields off that record — a `user.email` on a
        `None` user would be an `AttributeError` swallowed by the outer policy
        into a silent non-publish with the WRONG reason on the log line.
        """
        client = RecordingSqsClient()
        with caplog.at_level(logging.ERROR):
            publish(build(client, unknown_user=True))

        assert client.sends == []
        assert caplog.records[-1].reason == "no_email_for_user"

    def test_an_unknown_user_does_not_raise(self) -> None:
        """The guard above stated as behaviour: a `None` record must not become
        an exception inside the publisher."""
        assert publish(build(RecordingSqsClient(), unknown_user=True)) is None

    def test_an_empty_email_is_treated_as_no_email(self) -> None:
        """proto3 has no null, so an absent address can arrive as `""`. It would
        pass a `is not None` check and fail the handler's `z.string().email()`
        downstream, where the reason is no longer legible."""
        client = RecordingSqsClient()
        publish(build(client, email=""))

        assert client.sends == []

    def test_a_missing_name_does_not_stop_the_publish(self) -> None:
        """The asymmetry, asserted at the publisher: no address means no mail
        can be sent at all, so it bails out; no name is cosmetic, so it must
        NOT. A guard that keyed on "the user record is incomplete" would silence
        a perfectly deliverable notification."""
        client = RecordingSqsClient()
        publish(build(client, full_name=""))

        assert len(client.sends) == 1
        assert sent_body(client)["payload"]["email"] == EMAIL


class TestNoPlaintextEmailInLogs:
    """The rule from [[logging-context]], asserted over the WHOLE log record —
    message, args and every extra field — because a leak is far more likely to
    arrive through a field nobody thought about than through the one under test.

    The enrichment WIDENED the PII this publisher handles: it now carries the
    reader's name and their delivery address alongside their email. Every one of
    the three is payload-only, so the class asserts on all three rather than on
    the email it was originally written for.
    """

    ADDRESS = "leaky.person@example.com"
    #: A name and a street a search can find unambiguously in a rendered record.
    NAME = "Leaky Nameington"
    HOME = {"line1": "1 Leaky Lane", "city": "Leakville", "country": "US"}

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

    def test_a_failed_send_never_logs_the_full_name(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """New PII on this path, and it has no hashed counterpart — the name is
        simply not logged. `user_id` already identifies the person for anyone
        with the authority to look them up."""
        with caplog.at_level(logging.DEBUG):
            publish(
                build(FailingSqsClient(), email=self.ADDRESS, full_name=self.NAME)
            )

        rendered = self._rendered(caplog)
        assert self.NAME not in rendered
        assert "Nameington" not in rendered

    def test_a_failed_send_never_logs_the_shipping_address(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The delivery address is the most sensitive field on this payload, and
        the failure line has never needed it: `order_id` names the shipment."""
        with caplog.at_level(logging.DEBUG):
            publish(
                build(FailingSqsClient(), email=self.ADDRESS),
                shipping_address=self.HOME,
            )

        rendered = self._rendered(caplog)
        assert "1 Leaky Lane" not in rendered
        assert "Leakville" not in rendered

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
