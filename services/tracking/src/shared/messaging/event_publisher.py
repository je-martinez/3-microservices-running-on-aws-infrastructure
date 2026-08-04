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

from datetime import datetime
from typing import Protocol

from src.shared.audit.audit_actor import AuditActor


class EventPublisher(Protocol):
    """What `update_tracking_status()` depends on.

    Implemented by `SqsEventPublisher` (the real one) and `NoopEventPublisher`
    (tests and any environment that must not emit).

    `user_id` is the persisted `tracking.user_id` — the internal `usr_` id — and
    NEVER a request-supplied value. The carrier webhook driving this command
    carries no caller identity at all (its gateway route has no Cognito
    authorizer and therefore no `x-user-id`), so there is nothing on the request
    to reach for; see `commands/update_status.py`'s module docstring.

    `actor` is the envelope's AUTHOR — what originated the transition — and is a
    PARAMETER rather than a constant inside the publisher for a specific reason:
    `update_tracking_status` is the shared write path behind both the carrier
    webhook and TestMode progression, and it already receives the actor that
    distinguishes them. Hardcoding `CARRIER_STATUS_UPDATE` here would label every
    automatic TestMode transition as a real carrier update, which is precisely
    the confusion the semantic actor exists to prevent.

    Note the asymmetry with `user_id`: that is the event's SUBJECT (the order's
    owner), while the author of these transitions is never a human at all.
    """

    def publish_tracking_status_changed(
        self,
        *,
        order_id: str,
        user_id: str,
        status: str,
        previous_status: str,
        changed_at: datetime,
        actor: AuditActor,
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
        order_id: str,
        user_id: str,
        status: str,
        previous_status: str,
        changed_at: datetime,
        actor: AuditActor,
    ) -> None:
        return None
