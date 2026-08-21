"""The real SQS publisher for `TRACKING_STATUS_CHANGED`.

The boto3 counterpart of Users' `SqsEventPublisher` (TypeScript) and Orders'
(C#): same envelope shape, same `type`/`source` message attributes, same shared
queue.

## The wire contract, and where it comes from

The AUTHORITY is the consumer, not this file:

* envelope — `functions/events-pipeline/src/domain/envelope.ts`:
  `{ event_id, type, source, user_id, order_id, author, payload }`, all
  snake_case, **every key present** (`order_id` is nullable, not optional; here
  it is always a real order). Inside `author`, only `actor` is required.
  `author.user_id` is OMITTED — there is no human author on this event, ever.
  `author.cognito_sub` is present when the tracking row has one, because the
  pipeline routes the realtime WebSocket push by it; it is OMITTED (never null)
  when the row's nullable column holds NULL. There is no `author.source`: the
  root `source` already names the producer. The root `request_id` is the
  cross-service correlation id and follows the same omitted-never-null rule,
  for the same Zod reason — it is `.optional()` with `.min(1)`.
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
from opentelemetry import propagate, trace
from opentelemetry.trace import SpanKind, Status, StatusCode

from src.shared.audit.audit_actor import AuditActor
from src.shared.config.settings import get_settings
from src.shared.grpc.users_client import ResolvedUser, shared_users_client
from src.shared.logging.log_context import get_log_context

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

#: The PUBLISH span's name, and the reason the send is wrapped at all.
#:
#: Named after WHAT is published, not after where it goes. The boto3sqs
#: auto-instrumentation already contributes a span called
#: `<queue-name> send` — which reads as a distinction and is not one, because
#: all three services publish every event type onto the SAME shared queue. That
#: name therefore identifies the transport and nothing else; a reader looking at
#: a cascade cannot tell a tracking transition from an order confirmation.
#:
#: `sqs.publish tracking_status_changed` is the same shape Orders uses
#: (`sqs.publish order_created`, `SqsEventPublisher.PublishActivityName` in
#: `services/orders/src/Orders.Infrastructure/Messaging/SqsEventPublisher.cs`),
#: so one Jaeger query reads the queue hop across all producers.
PUBLISH_SPAN_NAME = "sqs.publish tracking_status_changed"

#: Separate from `workflow_tracing`'s tracer so this span is identifiable as the
#: queue hop rather than as another business flow. Unlike .NET, the Python SDK
#: needs no registration for a new tracer name — `get_tracer` on the global
#: provider is enough, and outside a configured provider it yields no-op spans
#: that cost nothing.
_tracer = trace.get_tracer("tracking-messaging")

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


def _build_message_attributes() -> dict[str, dict[str, str]]:
    """The SQS message attributes: `type`, `source`, and the trace context.

    ## `type` and `source`

    Duplicated out of the envelope so the queue can be inspected and filtered
    without deserializing the body — the same two keys Users and Orders set.

    ## `traceparent`, and why it rides HERE and not in the envelope

    SQS is where the trace would otherwise end: the pipeline's Lambda is a
    separate process reached through a queue, so nothing links its spans to the
    carrier PUT (or the TestMode tick) that produced the message unless the W3C
    context travels with it. `MessageAttributes` is the transport SQS gives us
    for exactly that — out-of-band metadata, next to `type` and `source`.

    It is deliberately NOT a field of the envelope. The envelope is the DOMAIN
    contract with `events-pipeline` (`functions/events-pipeline/src/domain/envelope.ts`)
    and a transport concern has no business in it; the consumer reads
    `record.messageAttributes.traceparent.stringValue`, which needs no schema
    change at all. `request_id` in the body is a different thing — a business
    correlation id the pipeline logs and stores, not a span context.

    ## It must be called INSIDE the publish span

    `propagate.inject` reads whatever span is ACTIVE at the moment it runs, so
    WHERE this function is called decides which span the consumer parents itself
    to. The single call site is inside `PUBLISH_SPAN_NAME`'s `with` block, and
    that placement is the contract: evaluated one line earlier it would write the
    enclosing WORKFLOW span's id, and the pipeline's spans would hang beside the
    publish rather than under it — a trace that still looks complete. Orders hit
    exactly this and fixed it the same way (see its `BuildMessageAttributes`).

    ## In production boto3sqs overwrites this key, one level deeper

    `opentelemetry-instrumentation-boto3sqs` wraps `send_message`, opens its own
    `<queue> send` PRODUCER span and calls `propagate.inject` on the very dict
    handed to it — unconditionally, so ITS id is what reaches SQS, not the one
    written here. (Verified against the real instrumentation. This is the
    OPPOSITE of .NET's AWS instrumentation, which Orders relies on skipping
    injection when the key already exists.)

    That is harmless, and the reason is structural rather than lucky: that `send`
    span is a direct CHILD of the publish span, so the consumer still lands
    inside the publish subtree — one level below it. What this call site's
    placement actually rules out is the WORKFLOW span winning, which no
    arrangement of the two producer spans can reintroduce. So the injection here
    is the correct floor whether or not the instrumentation is loaded, which is
    what makes it worth doing rather than delegating.

    ## Omitted, never empty

    `propagate.inject` writes NOTHING into the carrier when there is no valid
    active span — which, now that the send is wrapped, means only an
    unconfigured tracer provider (a unit test with no SDK installed, where the
    publish span itself is a non-recording no-op). This loop then adds zero keys
    rather than a blank `traceparent`. That matters: the consumer would treat
    `""` as a malformed-but-present context, which is strictly worse than an
    absent one it can link nothing to. Same "omitted, never null" rule the
    envelope's optional fields follow.

    The propagator is the SDK's globally-configured one, so a `tracestate` (if
    one ever exists) is carried by the same loop without naming it here.
    """
    attributes: dict[str, dict[str, str]] = {
        "type": {"DataType": "String", "StringValue": EVENT_TYPE},
        "source": {"DataType": "String", "StringValue": EVENT_SOURCE},
    }

    carrier: dict[str, str] = {}
    propagate.inject(carrier)
    for key, value in carrier.items():
        attributes[key] = {"DataType": "String", "StringValue": value}

    return attributes


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

    ## The publish span

    The send runs inside a PRODUCER span named `PUBLISH_SPAN_NAME` — the queue
    hop, named after the event rather than the queue (see that constant). It
    does three things at once, and each of them is load-bearing:

    * it PARENTS the trace context that crosses SQS, so the pipeline's work
      hangs under the publish rather than beside it;
    * it is the scope both outcome log lines are written in, so a span-scoped
      "View logs" on it answers;
    * it goes ERROR when the send fails, which is the only place the failure is
      visible in a waterfall — the caller sees nothing, by the policy above.

    The boto3sqs auto-instrumentation span survives underneath it as a child,
    with its own timing.
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
        cognito_sub: str | None,
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

        `cognito_sub` becomes the OPTIONAL `author.cognito_sub`, and is omitted
        rather than nulled when absent — see where the author is built below.
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

        # WHO originated this transition, as opposed to the root `user_id`
        # below, which is WHO it is about. Neither of this command's two paths
        # has a human author — the carrier is an external system authenticated
        # by an API key, and TestMode progression is a timer with no request
        # behind it — so `author.user_id` is OMITTED entirely.
        #
        # Omitted, not null and not filled in with the order owner: the owner is
        # the subject and already travels as the envelope's root `user_id`.
        # Repeating it here would assert that they made the change, which is
        # exactly false for a carrier update.
        #
        # `actor` is the same semantic value stamped into
        # `tracking_history.created_by` for this transition, so an event and its
        # history row agree about what produced them.
        #
        # There is no `author.source`: the producing service is already the
        # envelope's root `source` below (see AuthorSchema in
        # functions/events-pipeline/src/domain/envelope.ts).
        author: dict[str, str] = {"actor": actor.value}

        if cognito_sub:
            # The one identity that DOES belong here, and it is not an author
            # claim — it is the realtime ROUTING key. The pipeline queries a
            # DynamoDB index keyed on the Cognito sub to find this user's open
            # WebSocket connections; the root `user_id` is the internal `usr_`
            # id, a different value, and querying the index with it returns an
            # empty list with NO error, silently pushing to nobody.
            #
            # Set only when truthy, so the key is OMITTED and never null (an
            # empty sub is treated as absent: `""` is normalized to NULL in the
            # schema, and it could match no connection anyway). AuthorSchema
            # declares this field optional, and Zod rejects an explicit null for
            # an optional string — which the handler turns into a
            # PermanentError, consuming the record without retry. A null here
            # would therefore lose the EMAIL too, not merely the socket push, so
            # it is strictly worse than sending nothing.
            author["cognito_sub"] = cognito_sub

        envelope: dict[str, Any] = {
            "event_id": derive_event_id(order_id, status),
            "type": EVENT_TYPE,
            "source": EVENT_SOURCE,
            # The PERSISTED usr_ id, handed down from the entity by
            # `update_tracking_status`. Never a request value: this path has none.
            "user_id": user_id,
            "order_id": order_id,
            # `actor`, plus `cognito_sub` when the row has one. Built above,
            # where the reasoning for each of those two keys lives.
            "author": author,
            # The enriched payload the email templates render from. Split into
            # its own method because it is the part that is genuinely a
            # CONTRACT with the events-pipeline handler.
            "payload": self._build_payload(
                tracking=tracking,
                previous_status=previous_status,
                user=user,
                email=email,
            ),
        }

        # The correlation id for the flow that produced this transition, so the
        # pipeline's own log lines (and the email it sends) join the carrier PUT
        # or TestMode tick that caused them. Read from the ambient context
        # rather than passed in, for the same reason the gRPC client reads it
        # there: no signature change per hop for a value no caller cares about.
        request_id = get_log_context().get("request_id")
        if request_id:
            # OMITTED, never null and never "". The pipeline's EnvelopeSchema
            # declares this field `.optional()` with `.min(1)`, and Zod rejects
            # BOTH an explicit null and an empty string for that shape. The
            # handler turns a validation failure into a `PermanentError`, which
            # consumes the record without retry — so a null here would not
            # merely lose the correlation, it would lose the notification EMAIL.
            # Exactly the trap `author.cognito_sub` above documents.
            envelope["request_id"] = request_id

        # The PUBLISH span. `start_as_current_span` directly rather than
        # `workflow_span`: that helper is deliberately INTERNAL (it names a
        # business flow), and it also sets an OK status and RE-RAISES, both of
        # which contradict this publisher's log-and-swallow policy. Teaching it a
        # `kind` would make one helper answer to two different contracts.
        #
        # Opened OUTSIDE the try, with the try nested in its scope, so BOTH the
        # success and the failure line below are written while this span is
        # current and therefore carry ITS span id. Orders learned this the hard
        # way: with the span started inside the try, the exception ended it on
        # the way out and the failure line landed on the enclosing workflow span,
        # invisible to a span-scoped lookup on the publish — which is exactly
        # where an operator looks after seeing the send go red.
        #
        # The boto3sqs auto-instrumentation span is NOT replaced by this one; it
        # becomes this span's CHILD and keeps its own timing and status.
        with _tracer.start_as_current_span(
            PUBLISH_SPAN_NAME,
            kind=SpanKind.PRODUCER,
            attributes={
                "app_event": "tracking_status_changed_published",
                "messaging.system": "aws_sqs",
                "event_type": EVENT_TYPE,
                "event_id": envelope["event_id"],
                "order_id": order_id,
            },
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            try:
                self._client.send_message(
                    QueueUrl=self._queue_url,
                    MessageBody=json.dumps(envelope),
                    # Built HERE, inside the span, never one line earlier: it is
                    # `propagate.inject` that writes the `traceparent`, and it
                    # reads whatever span is ACTIVE. Evaluated before this `with`
                    # it would name the enclosing workflow span
                    # (`carrier_status_update`, `test_mode_progression`) and the
                    # consumer's spans would hang beside this publish instead of
                    # under it. That is the precise bug fixed in Orders.
                    MessageAttributes=_build_message_attributes(),
                )
            except Exception as exc:  # noqa: BLE001 - see the class docstring
                # ERROR, not OK: a send that failed is the one hop a waterfall
                # must not render as healthy.
                span.record_exception(exc)
                span.set_status(Status(StatusCode.ERROR, str(exc)))
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
            else:
                span.set_status(Status(StatusCode.OK))
                # The span's OWN line, so "View logs" on it in OpenObserve
                # answers instead of coming back empty: that button filters by
                # trace_id AND span_id with no fallback to the trace, so a span
                # nothing logs from can only ever return nothing.
                #
                # It earns its place independently of that. It states that the
                # event was emitted, WHICH event (`event_type` plus `event_id`,
                # the pipeline's idempotency key) and for WHICH tracking and
                # order — which is what makes a missing notification email
                # diagnosable from THIS side of the queue, where the alternative
                # is inferring it from the absence of a pipeline document.
                #
                # NEVER the email, the name or the address (PII): the ids
                # identify the message completely on their own. `email_hash` is
                # not repeated here either — the failure line carries it because
                # a missing email is the thing being investigated there; on the
                # success path the recipient is not in question.
                logger.info(
                    "TRACKING_STATUS_CHANGED published",
                    extra={
                        "app_event": "tracking_status_changed_published",
                        "event_type": EVENT_TYPE,
                        "event_id": envelope["event_id"],
                        "order_id": order_id,
                        "tracking_id": tracking.id,
                        "user_id": user_id,
                        "status": status,
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
