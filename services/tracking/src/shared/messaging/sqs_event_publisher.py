"""The real SQS publisher for `TRACKING_STATUS_CHANGED`.

The boto3 counterpart of Users' `SqsEventPublisher` (TypeScript) and Orders'
(C#): same envelope shape, same `type`/`source` message attributes, same shared
queue.

## The wire contract, and where it comes from

The AUTHORITY is the consumer, not this file:

* envelope — `functions/events-pipeline/src/domain/envelope.ts`:
  `{ event_id, type, source, user_id, order_id, author, payload }`, all
  snake_case, **every key present** (`order_id` is nullable, not optional; here
  it is always a real order). Inside `author`, only `actor` is required;
  `user_id`/`cognito_sub` are OMITTED when there is no human author — which, on
  this event, is always. There is no `author.source`: the root `source` already
  names the producer.
* payload — `functions/events-pipeline/src/handlers/tracking-status-changed.ts`:
  `{ status, previous_status, changed_at, email }`, plus the enrichment fields
  `{ full_name, order_id, tracking_number, shipping_address?, history[] }`
  specified in
  `docs/superpowers/specs/2026-08-05-email-payload-enrichment-design.md`.
  `status` is an enum of the five progression values.

A missing or misnamed field is NOT a loud failure: the handler rejects it as a
`PermanentError`, the record is consumed rather than retried, and the user never
gets an email. Nothing upstream notices. That is why the payload below is built
literally against those two schemas.

## Why this publisher resolves the user itself

The handler requires `email` (and now `full_name`), and Tracking persists
neither — `tracking` stores `user_id` and `cognito_sub`, never a name or an
address. Users holds both, and Tracking already has an outbound client to Users
(`shared/grpc/users_client.py`) whose `GetUserById` response carries `email` and
`full_name` on the same wire message. One round trip yields both; there is no
second call for the name.

Resolution happens HERE rather than in `update_tracking_status` on purpose: the
command's job is the state transition, and threading a gRPC call plus PII
through it would make every caller (the carrier PUT, TestMode) handle a Users
outage in the middle of a database write. Behind the port, a failed resolution
degrades exactly like a failed send — see the failure policy below.

## PII

`email`, `full_name` and `shipping_address` travel in the payload because the
pipeline needs somewhere to send the mail and something to render in it, and
NOWHERE else. None of them is ever logged: failure lines carry `email_hash` (the
cross-service SHA-256/16 contract from [[logging-context]]) plus `user_id` and
`order_id`, never the address, the name, or the delivery address itself.

## Omitted, never null

`shipping_address` is nullable on the row (proto3 has no null, so an address
absent upstream arrives as an empty message and is persisted as NULL). When it
is absent the KEY IS OMITTED from the payload rather than sent as `null` — the
repo-wide rule from [[logging-context]] and the envelope contract alike: unknown
fields are omitted, never nulled. A `"shipping_address": null` would make the
template branch on two spellings of "no address" instead of one.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Callable, Iterable
from functools import lru_cache
from typing import TYPE_CHECKING, Any

import boto3

from src.shared.audit.audit_actor import AuditActor
from src.shared.config.settings import get_settings
from src.shared.grpc.users_client import ResolvedUser, shared_users_client

if TYPE_CHECKING:
    from src.features.tracking.domain.models import Tracking, TrackingHistory

logger = logging.getLogger(__name__)

#: The envelope's `type`, and one of the two SQS message attributes. Must match
#: the key the pipeline's HandlerMap dispatches on — an unknown type dead-ends in
#: `FAILED "Unknown event type"`.
EVENT_TYPE = "TRACKING_STATUS_CHANGED"

#: The envelope's `source`, and the other message attribute. Names the producer;
#: Users publishes "users", Orders "orders".
EVENT_SOURCE = "tracking"

#: Prefix on the derived `event_id`, matching the `evt_` shape Users mints.
EVENT_ID_PREFIX = "evt_"

#: Length of the truncated hash inside a derived `event_id`. 16 hex chars is the
#: same width the log convention's `email_hash` uses, and far beyond
#: collision-relevant for a key that only has to be unique per (order, status).
EVENT_ID_HASH_LENGTH = 16

#: Resolves an internal `usr_` id to the Users record behind it, or None when
#: unknown.
#:
#: Returns the whole `ResolvedUser` rather than just the email, as it used to:
#: the payload needs the recipient's `full_name` as well as their address, both
#: of which arrive on the SAME `GetUserById` response. Narrowing the resolver to
#: a `str` would have forced a second round trip (or a second resolver) for a
#: field that was already on the wire.
UserResolver = Callable[[str], "ResolvedUser | None"]


def derive_event_id(order_id: str, status: str) -> str:
    """The idempotency key for one transition, derived from `(order_id, status)`.

    **Deterministic on purpose — never a fresh id per attempt.** The pipeline
    dedupes on a unique index over `event_id`, so a redelivery is only collapsed
    if the retried message carries the SAME id. A randomly generated one would
    slip past that index and send a SECOND notification email for a transition
    that already succeeded.

    `(order_id, status)` is a genuine natural key here, not a convenient one:
    the state machine is forward-only and `tracking_history`'s primary key is
    `(tracking_id, status)`, so a given order enters each status at most once.
    Two events with this id are therefore, by construction, the same transition.

    This matters most under TestMode, which walks all five statuses in ~40
    seconds: a transient SQS error anywhere in that burst retries into the same
    id rather than into a duplicate email.

    The pair is HASHED rather than interpolated (`evt_{order_id}_{status}`) so
    the id has a fixed shape and length whatever an order id contains — an
    interpolated id would vary in length and could, with an unlucky order id
    containing the separator, collide across different pairs. The hash is not a
    security boundary; it is a formatting one.
    """
    digest = hashlib.sha256(f"{order_id}|{status}".encode()).hexdigest()
    return f"{EVENT_ID_PREFIX}{digest[:EVENT_ID_HASH_LENGTH]}"


def hash_email(email: str) -> str:
    """A non-reversible id for an email, safe to log.

    The CROSS-SERVICE contract from [[logging-context]]: SHA-256 of the trimmed,
    lowercased address, hex, first 16 chars — identical to Users' `hashEmail`
    and Orders' `EmailHash.Compute`. If the three drift, filtering one user's
    lines across services silently returns nothing instead of erroring.
    """
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()[:16]


def serialize_history(
    entries: Iterable[TrackingHistory],
) -> list[dict[str, str]]:
    """Render a tracking's transitions as `[{ status, datetime }, …]`.

    This is what makes the email's five-step delivery timeline renderable. A
    transition event describes ONE step; without the history the template could
    only ever show the step that just happened, and would have to invent the
    other four (or render a timeline with a single entry, which is not a
    timeline).

    ## The order is the relationship's, not one re-derived here

    `entries` arrives already sorted — `Tracking.history` declares
    `order_by=TrackingHistory.ordering()`, which is transition timestamp then
    position in the forward-only progression. This function preserves that order
    and deliberately does not re-sort: a bare `datetime` sort ties when two
    transitions share a second (a carrier sending two updates inside one second,
    or any unit of work stamping several rows with one `now`), and MySQL then
    falls back to primary-key order — alphabetical for `(tracking_id, status)`,
    which puts DELIVERED before PLACED. A timeline that shows a parcel delivered
    before it was placed is worse than no timeline.

    ## The load this does and does not cost

    `Tracking.history` is `lazy="selectin"`, so on any ordinary read the entries
    arrive with the tracking and serializing them costs nothing beyond this loop.

    On the transition path there IS one load, and it is not incidental:
    `TrackingRepository.update_status` expires the collection after appending
    (see its docstring), precisely because the in-memory one is stale — it still
    holds the transitions from before the update. So the reload is what makes the
    timeline include the step the email is announcing. It is a single `selectin`
    query for one tracking's rows, not an N+1, and it replaces the alternative of
    publishing a history that demonstrably omits the event being published.

    Each entry carries only `status` and `datetime`: `tracking_id`, `order_id`,
    `user_id` and `cognito_sub` are on every row but are identical across all of
    them and already present at the envelope root, so repeating them per entry
    would be five copies of one fact — and `cognito_sub` in particular is an
    ownership key with no business leaving the service.
    """
    return [
        {
            "status": entry.status,
            # ISO-8601, for the same reason `changed_at` is: a `datetime` is not
            # JSON-serializable, and `json.dumps` raising inside the send would
            # be swallowed by the failure policy into "no event at all".
            "datetime": entry.datetime_.isoformat(),
        }
        for entry in entries
    ]


class SqsEventPublisher:
    """Publishes `TRACKING_STATUS_CHANGED` to the shared events queue.

    ## Failure policy: LOG AND SWALLOW, deliberately

    Neither a failed email resolution nor a failed `send_message` propagates out
    of `publish_tracking_status_changed`. The transition is already persisted
    and committed by the time this runs, and this endpoint's two callers make
    raising the worse option:

    * **The carrier webhook** is an external third party. A 500 makes it retry
      the PUT — and the retry hits the SAME transition it already applied, which
      the forward-only state machine rejects with a `400
      not_strictly_forward`. So the carrier would see a permanent-looking
      failure for a status change we actually recorded, and would keep
      redelivering until it gave up. Worse, any retry that DID get through would
      re-publish, and only the deterministic `event_id` above stops that
      becoming a duplicate email.
    * **TestMode progression** already swallows everything by design (it is a
      fixture on a background task); an exception here would just be logged as
      `unexpected_error` and silently end the run three transitions early.

    The notification is a secondary effect of a delivery update, so a queue
    outage degrades the email rather than corrupting the state machine — the
    same stance Users' publisher took, for the same reason (the primary write
    already happened). This is NOT silent: every failure is an `error` line with
    `app_event=tracking_status_changed_publish_failed` and a machine-readable
    `reason`, which is what makes it alertable.

    The trade accepted here is at-most-once delivery of the notification. That
    is the correct direction for this event: a missed "out for delivery" email
    is a degraded experience, while a duplicate one is a bug report.
    """

    def __init__(
        self,
        *,
        client: Any,
        queue_url: str,
        resolve_user: UserResolver,
    ) -> None:
        self._client = client
        self._queue_url = queue_url
        self._resolve_user = resolve_user

    def publish_tracking_status_changed(
        self,
        *,
        tracking: Tracking,
        previous_status: str,
        actor: AuditActor,
    ) -> None:
        """Emit one transition. Never raises — see the class docstring.

        `tracking` is the row `update_tracking_status` just wrote, and every
        subject-side field of the envelope is read off it: the owner
        (`user_id`), the order, the new status, the transition's own timestamp,
        the tracking number, the address and the whole history. Nothing comes
        from the request — this endpoint's caller is an external carrier whose
        gateway route has no Cognito authorizer, so no caller identity reaches
        the service at all (see the port's docstring).

        `previous_status` is the one parameter that cannot come off the entity:
        `tracking.status` is already the NEW status by the time this runs.

        `actor` becomes the envelope's `author.actor`. It is handed down from
        `update_tracking_status` rather than fixed here: the carrier PUT and
        TestMode progression share this publisher, and a constant would mislabel
        one of them (see the port's docstring).
        """
        order_id = tracking.order_id
        user_id = tracking.user_id
        status = tracking.status

        try:
            user = self._resolve_user(user_id)
        except Exception:  # noqa: BLE001 - a notification must not break a write
            # Users unreachable, or answering something other than NOT_FOUND.
            # `logger.exception` keeps the traceback; the extra fields carry no
            # PII (no email is known at this point anyway).
            logger.exception(
                "tracking_status_changed_publish_failed",
                extra={
                    "app_event": "tracking_status_changed_publish_failed",
                    "reason": "email_resolution_failed",
                    "order_id": order_id,
                    "user_id": user_id,
                    "status": status,
                },
            )
            return

        email = user.email if user else None
        if not email:
            # Users answered NOT_FOUND, or holds no address for this user. The
            # pipeline would reject the payload as a PermanentError anyway, so
            # publishing it would only manufacture a FAILED document; better to
            # stop here where the reason is still legible.
            #
            # Keyed on the EMAIL rather than on the name: without an address
            # there is nowhere to send the mail at all, whereas a missing name
            # is a cosmetic gap in a message that can still be delivered.
            logger.error(
                "tracking_status_changed_publish_failed",
                extra={
                    "app_event": "tracking_status_changed_publish_failed",
                    "reason": "no_email_for_user",
                    "order_id": order_id,
                    "user_id": user_id,
                    "status": status,
                },
            )
            return

        envelope = {
            "event_id": derive_event_id(order_id, status),
            "type": EVENT_TYPE,
            "source": EVENT_SOURCE,
            # The PERSISTED usr_ id, handed down from the entity by
            # `update_tracking_status`. Never a request value: this path has none.
            "user_id": user_id,
            "order_id": order_id,
            # WHO originated this transition, as opposed to `user_id` above,
            # which is WHO it is about. This event is the reason the distinction
            # exists at all: neither of its two paths has a human author. The
            # carrier is an external system authenticated by an API key, and
            # TestMode progression is a timer with no request behind it — so
            # `user_id` and `cognito_sub` are OMITTED from the author entirely.
            #
            # Omitted, not null and not filled in with the order owner: the
            # owner is the subject and already travels as the envelope's root
            # `user_id`. Repeating it here would assert that they made the
            # change, which is exactly false for a carrier update.
            #
            # `actor` is the same semantic value stamped into
            # `tracking_history.created_by` for this transition, so an event and
            # its history row agree about what produced them.
            #
            # There is no `author.source`: the producing service is already the
            # envelope's root `source` above (see AuthorSchema in
            # functions/events-pipeline/src/domain/envelope.ts). On THIS event
            # that leaves `actor` alone — which is the whole point of the block,
            # since a carrier update has no human to name.
            "author": {
                "actor": actor.value,
            },
            "payload": self._build_payload(
                tracking=tracking,
                previous_status=previous_status,
                user=user,
                email=email,
            ),
        }

        try:
            self._client.send_message(
                QueueUrl=self._queue_url,
                MessageBody=json.dumps(envelope),
                # Duplicated as attributes so the queue can be inspected and
                # filtered without deserializing the body — the same two keys
                # Users and Orders set.
                MessageAttributes={
                    "type": {"DataType": "String", "StringValue": EVENT_TYPE},
                    "source": {"DataType": "String", "StringValue": EVENT_SOURCE},
                },
            )
        except Exception:  # noqa: BLE001 - see the class docstring's policy
            logger.exception(
                "tracking_status_changed_publish_failed",
                extra={
                    "app_event": "tracking_status_changed_publish_failed",
                    "reason": "sqs_send_failed",
                    "order_id": order_id,
                    "user_id": user_id,
                    "status": status,
                    # The hash, NEVER the address — this line goes to
                    # OpenObserve and is retained.
                    "email_hash": hash_email(email),
                },
            )

    @staticmethod
    def _build_payload(
        *,
        tracking: Tracking,
        previous_status: str,
        user: ResolvedUser | None,
        email: str,
    ) -> dict[str, Any]:
        """The `TRACKING_STATUS_CHANGED` payload, field by field.

        Split out of `publish_tracking_status_changed` because it is the part
        that is genuinely a CONTRACT — every key here is read by
        `functions/events-pipeline/src/handlers/tracking-status-changed.ts` and
        rendered by a template, so it is worth reading on its own, without the
        resolution and failure handling around it.

        Each field, and why the email needs it:

        * `status` / `previous_status` — the transition itself. Inverted, the
          email would announce the step the parcel just left.
        * `changed_at` — when it happened. Taken from `tracking.datetime_`, the
          column stamped by this very transition, NOT from `updated_at`, which
          moves on any write.
        * `email` — where to send it. Already resolved by the caller (and the
          reason to bail out entirely when it is missing), so it is passed in
          rather than re-read off `user`.
        * `full_name` — how to address the reader. Off the same `GetUserById`
          response the address came from; no second round trip.
        * `order_id` — displayed in the email body. It is on the envelope root
          too, and the duplication is deliberate: the handler renders from the
          payload, and making a template reach up into the envelope for one
          field would be a second, undocumented data path.
        * `tracking_number` — the shipment number the reader quotes back. Always
          present: the column is NOT NULL and minted at creation.
        * `shipping_address` — where it is going. OMITTED when NULL, never sent
          as null (see the module docstring).
        * `history` — every transition so far, which is what makes the five-step
          delivery timeline renderable at all.
        """
        payload: dict[str, Any] = {
            "status": tracking.status,
            "previous_status": previous_status,
            # ISO-8601. The handler validates it as a non-empty string and the
            # template renders it; a datetime is not JSON-serializable.
            "changed_at": tracking.datetime_.isoformat(),
            # Required by the handler's schema — a payload without it is a
            # PermanentError and no email is ever sent.
            "email": email,
            # `""` rather than a missing key when Users holds no name: proto3
            # sends an absent string as `""`, and the handler's schema takes a
            # string. Unlike `shipping_address` below this is not omitted,
            # because the greeting is unconditional — the template needs
            # something to interpolate, and an empty string degrades to a
            # nameless greeting rather than a `KeyError` mid-render.
            "full_name": user.full_name if user else "",
            # Also on the envelope root; see the docstring.
            "order_id": tracking.order_id,
            "tracking_number": tracking.tracking_number,
            # Ordered by the relationship, loaded with the tracking, no query.
            "history": serialize_history(tracking.history),
        }

        if tracking.shipping_address is not None:
            # Set only when there IS one. Assigning `None` would put
            # `"shipping_address": null` on the wire, which is the one shape the
            # convention rules out — unknown fields are omitted, never nulled.
            payload["shipping_address"] = tracking.shipping_address

        return payload


def _resolve_user_via_users(user_id: str) -> ResolvedUser | None:
    """Ask Users for this internal id's record, through the shared gRPC client.

    `GetUserById` accepts the internal `usr_` id as well as a Cognito sub (the
    .proto says so), and the persisted `tracking.user_id` is the former — so no
    sub is needed, and none is available on the carrier path anyway.

    Returns the whole `ResolvedUser` (email AND full name) rather than just the
    address it used to: both fields ride the same response, so the enriched
    payload costs no extra call.
    """
    return shared_users_client().resolve(user_id)


@lru_cache(maxsize=1)
def _cached_publisher(queue_url: str, endpoint_url: str | None, region: str):
    """One publisher (hence one boto3 client) per process, keyed on PRIMITIVES.

    Keyed on the values rather than on `Settings` for the reason recorded in
    `shared/db/engine.py` and `shared/grpc/users_client.py`: pydantic's
    `BaseSettings` is unhashable, so an `lru_cache` taking a settings object
    raises `TypeError` on its first call.
    """
    # `events_queue_url` defaults to "" so hand-built Settings in the REST test
    # fixtures need not supply a value they do not use. That default is only
    # safe because it fails HERE, at the one call site that actually needs it:
    # without this check boto3 would accept QueueUrl="" and the resulting error
    # would be swallowed by the publisher's log-and-swallow policy, so a
    # misconfigured environment would silently never emit an event.
    if not queue_url:
        raise ValueError(
            "EVENTS_QUEUE_URL is empty. It is generated into .env.local.tracking "
            "by `make env-file`; see docs/shared/conventions/env-files.md."
        )

    client = boto3.client("sqs", endpoint_url=endpoint_url, region_name=region)
    return SqsEventPublisher(
        client=client,
        queue_url=queue_url,
        resolve_user=_resolve_user_via_users,
    )


def shared_event_publisher() -> SqsEventPublisher:
    """The process-wide publisher, built lazily from settings.

    Lazy, not module-level, so importing this module neither constructs a boto3
    client nor requires a valid environment — the same rule
    `shared_users_client()` follows, and what lets the test suite import the
    command under test without an env file.
    """
    settings = get_settings()
    return _cached_publisher(
        settings.events_queue_url,
        settings.aws_endpoint_url,
        settings.aws_region,
    )
