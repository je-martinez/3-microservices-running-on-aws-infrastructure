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
  root `source` already names the producer.
* payload — `functions/events-pipeline/src/handlers/tracking-status-changed.ts`:
  `{ status, previous_status, changed_at, email }`. `status` is an enum of the
  four progression values.

A missing or misnamed field is NOT a loud failure: the handler rejects it as a
`PermanentError`, the record is consumed rather than retried, and the user never
gets an email. Nothing upstream notices. That is why the payload below is built
literally against those two schemas.

## Why this publisher resolves the email itself

The handler requires `email`, and Tracking persists none — `tracking` stores
`user_id` and `cognito_sub`, never an address. Users holds it, and Tracking
already has an outbound client to Users (`shared/grpc/users_client.py`) whose
`GetUserById` response carries `email` on the wire.

Resolution happens HERE rather than in `update_tracking_status` on purpose: the
command's job is the state transition, and threading a gRPC call plus a PII
field through it would make every caller (the carrier PUT, TestMode) handle a
Users outage in the middle of a database write. Behind the port, a failed
resolution degrades exactly like a failed send — see the failure policy below.

## PII

`email` travels in the payload because the pipeline needs somewhere to send the
mail, and NOWHERE else. It is never logged: failure lines carry `email_hash`
(the cross-service SHA-256/16 contract from [[logging-context]]) plus `user_id`
and `order_id`, never the address itself.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Callable
from datetime import datetime
from functools import lru_cache
from typing import Any

import boto3

from src.shared.audit.audit_actor import AuditActor
from src.shared.config.settings import get_settings
from src.shared.grpc.users_client import shared_users_client

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

#: Resolves an internal `usr_` id to that user's email, or None when unknown.
EmailResolver = Callable[[str], str | None]


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

    This matters most under TestMode, which walks all four statuses in ~30
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
        resolve_email: EmailResolver,
    ) -> None:
        self._client = client
        self._queue_url = queue_url
        self._resolve_email = resolve_email

    def publish_tracking_status_changed(
        self,
        *,
        order_id: str,
        user_id: str,
        status: str,
        previous_status: str,
        changed_at: datetime,
        actor: AuditActor,
        cognito_sub: str | None,
    ) -> None:
        """Emit one transition. Never raises — see the class docstring.

        `actor` becomes the envelope's `author.actor`. It is handed down from
        `update_tracking_status` rather than fixed here: the carrier PUT and
        TestMode progression share this publisher, and a constant would mislabel
        one of them (see the port's docstring).

        `cognito_sub` becomes the OPTIONAL `author.cognito_sub`, and is omitted
        rather than nulled when absent — see where the author is built below.
        """
        try:
            email = self._resolve_email(user_id)
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

        if not email:
            # Users answered NOT_FOUND, or holds no address for this user. The
            # pipeline would reject the payload as a PermanentError anyway, so
            # publishing it would only manufacture a FAILED document; better to
            # stop here where the reason is still legible.
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

        envelope = {
            "event_id": derive_event_id(order_id, status),
            "type": EVENT_TYPE,
            "source": EVENT_SOURCE,
            # The PERSISTED usr_ id, handed down from the entity by
            # `update_tracking_status`. Never a request value: this path has none.
            "user_id": user_id,
            "order_id": order_id,
            # `actor`, plus `cognito_sub` when the row has one. Built above.
            "author": author,
            "payload": {
                "status": status,
                "previous_status": previous_status,
                # ISO-8601. The handler validates it as a non-empty string and
                # the template renders it; a datetime is not JSON-serializable.
                "changed_at": changed_at.isoformat(),
                # Required by the handler's schema — a payload without it is a
                # PermanentError and no email is ever sent.
                "email": email,
            },
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


def _resolve_email_via_users(user_id: str) -> str | None:
    """Ask Users for this internal id's email, through the shared gRPC client.

    `GetUserById` accepts the internal `usr_` id as well as a Cognito sub (the
    .proto says so), and the persisted `tracking.user_id` is the former — so no
    sub is needed, and none is available on the carrier path anyway.
    """
    resolved = shared_users_client().resolve(user_id)
    return resolved.email if resolved else None


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
        resolve_email=_resolve_email_via_users,
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
