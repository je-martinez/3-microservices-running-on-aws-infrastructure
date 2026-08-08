"""The event-publishing PORT for Tracking (events-pipeline milestone).

The Python counterpart of `EventPublisher`/`NoopEventPublisher` in Users
(`services/users/src/shared/messaging/event-publisher.ts`) and Orders'
`IEventPublisher`/`NoopEventPublisher`. Tracking is the pipeline's THIRD
producer, publishing `TRACKING_STATUS_CHANGED` onto the same shared queue.

## Why a port at all, when there is one implementation

`update_tracking_status` is the shared write path for the carrier webhook AND
TestMode progression, and neither of those should reach for a boto3 client. The
protocol lets the command depend on the verb ("publish this transition") while
the transport stays replaceable — which is what makes `NoopEventPublisher`
possible for the suites that must not emit, and what keeps the publisher's own
tests free of a real queue.

## Wiring: a lazy module-level singleton, not a DI container

`shared/di/` in this service is an empty placeholder — there is no framework
container to register into. The pattern this service already uses for an
outbound dependency is `shared/grpc/users_client.py`'s `@lru_cache`d factory
keyed on primitives, and `shared_event_publisher()` follows it exactly (see
`sqs_event_publisher.py`).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

from src.shared.audit.audit_actor import AuditActor

if TYPE_CHECKING:
    # Type-only: keeps this module importable without pulling the ORM in, which
    # is what lets a test bind a fake publisher with no database configured.
    from src.features.tracking.domain.models import Tracking


class EventPublisher(Protocol):
    """What `update_tracking_status()` depends on.

    Implemented by `SqsEventPublisher` (the real one) and `NoopEventPublisher`
    (tests and any environment that must not emit).

    ## Why this takes the ENTITY rather than a list of scalars

    The port used to take `order_id`, `user_id`, `status`, `changed_at` — one
    keyword per payload field. That stopped scaling the moment the email
    templates needed the shipment's own data (the tracking number, the delivery
    address, the full transition history): the signature would have grown a
    parameter per template field, and every one of those parameters would have
    been read off the same object the command already holds.

    `tracking` IS the persisted row `update_tracking_status` just wrote, and
    passing it whole preserves the property that mattered most about the old
    signature: **every subject-side field comes off the database row and none
    from the request.** The carrier webhook carries no caller identity at all
    (its gateway route has no Cognito authorizer, so there is no `x-user-id`),
    so there is nothing on the request to reach for even if a caller wanted to;
    see `commands/update_status.py`'s module docstring.

    It also makes `history` free. `Tracking.history` is loaded with
    `lazy="selectin"` and ordered by `TrackingHistory.ordering()`, so the
    publisher serializes the whole timeline without issuing a query and without
    re-deriving an order that the relationship already gets right (a bare
    timestamp sort ties on same-second transitions and MySQL then falls back to
    alphabetical PK order — DELIVERED first).

    ## The parameters that are NOT on the entity

    `previous_status` is the status the row held BEFORE this transition, which by
    definition `tracking.status` no longer is — the command is the only thing
    that still knows it, so it stays an explicit parameter.

    `actor` is the envelope's AUTHOR — what originated the transition — and is a
    PARAMETER rather than a constant inside the publisher for a specific reason:
    `update_tracking_status` is the shared write path behind both the carrier
    webhook and TestMode progression, and it already receives the actor that
    distinguishes them. Hardcoding `CARRIER_STATUS_UPDATE` here would label every
    automatic TestMode transition as a real carrier update, which is precisely
    the confusion the semantic actor exists to prevent.

    Note the asymmetry with the tracking's `user_id`: that is the event's SUBJECT
    (the order's owner), while the author of these transitions is never a human
    at all.

    `cognito_sub` is the tracking row's persisted Cognito subject, or None for a
    legacy row that predates the column. It becomes the envelope's optional
    `author.cognito_sub`, which the events-pipeline uses to route the realtime
    WebSocket push. Omitted (never null) from the envelope when None — the
    envelope's AuthorSchema declares the field optional, so writing an explicit
    null would fail validation downstream.

    It travels alongside `user_id` rather than instead of it because the two are
    different values for the same person, and the pipeline needs BOTH: the
    internal `usr_` id to resolve the email, and the sub to query the DynamoDB
    connection index. Handing the index a `usr_` id returns an empty list with no
    error, so the push would silently reach nobody.

    Like `user_id`, it comes off the PERSISTED entity and never off the request:
    the carrier webhook has no caller identity to read.
    """

    def publish_tracking_status_changed(
        self,
        *,
        tracking: Tracking,
        previous_status: str,
        actor: AuditActor,
        cognito_sub: str | None,
    ) -> None: ...


class NoopEventPublisher:
    """Discards every call.

    NOT dead code, and kept for the same reason Users and Orders keep theirs: a
    test (or an environment) that must not emit binds this instead of the SQS
    publisher, rather than the command growing an `if publish_enabled` branch
    that production would then carry forever.

    Deliberately records nothing. A test that needs to ASSERT on what was
    published uses its own recording fake — a Noop that silently swallowed the
    call cannot fail when the call stops happening.
    """

    def publish_tracking_status_changed(
        self,
        *,
        tracking: Tracking,
        previous_status: str,
        actor: AuditActor,
        cognito_sub: str | None,
    ) -> None:
        return None
