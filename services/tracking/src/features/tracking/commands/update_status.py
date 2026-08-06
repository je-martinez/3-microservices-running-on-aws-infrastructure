"""`PUT /v1/trackings/{order_id}/status` command handler (JE-94).

The carrier webhook's write path. Transport-free like `create_tracking`: it takes a
plain dataclass and returns the persisted entity, so the FastAPI handler is a thin
translation and this logic is testable without a server.

## Why the lookup here is UNSCOPED

The caller is an external carrier authenticated by an API key, not a user behind a
Cognito JWT — its gateway route carries no authorizer, so there is no
`x-user-id` on the request at all and no identity to scope by. The repository is
therefore called with `user_id=None`, the same unscoped mode the gRPC reads use.

This is the single most confusable thing in Phase D: the two REST *reads* sitting
beside this command DO scope by `user_id`, and reusing their filter here would make
every carrier update return 404 — the endpoint would look implemented and never
work. The design calls this out explicitly ("An implementer who assumes
`x-user-id` is present here will write broken code").

## Why the guards are applied here and not in the repository

`assert_can_transition` lives in `domain/status.py` as a pure function, and
`TrackingRepository.update_status` deliberately does not validate. This layer is
where the decision is made, so the same guards stay reusable by TestMode
progression (Phase E), which has no request and no HTTP status code to map to.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy.orm import Session

from src.features.tracking.domain.models import Tracking
from src.features.tracking.domain.repository import TrackingRepository
from src.features.tracking.domain.status import (
    TrackingStatus,
    assert_can_transition,
    parse_status,
)
from src.shared.audit.audit_actor import AuditActor
from src.shared.messaging.event_publisher import EventPublisher

logger = logging.getLogger(__name__)


class TrackingNotFoundError(Exception):
    """No live tracking exists for the given `order_id`.

    Distinct from a rejected transition: the handler maps this to `404` and
    `InvalidTransitionError` to `400`. Note there is no ownership dimension here —
    unlike the reads, a 404 from this endpoint means the order genuinely has no
    tracking, because nothing was filtered out by identity.
    """

    def __init__(self, order_id: str) -> None:
        self.order_id = order_id
        super().__init__(f"no tracking for order_id {order_id}")


@dataclass(frozen=True, slots=True)
class UpdateTrackingStatusCommand:
    """Input to the carrier status update.

    Carries no `user_id` — there is none on this request. See the module docstring.
    """

    order_id: str
    #: The raw string off the request body; parsed (and rejected) below.
    status: str


def update_tracking_status(
    session: Session,
    command: UpdateTrackingStatusCommand,
    *,
    actor: AuditActor = AuditActor.CARRIER_STATUS_UPDATE,
    publisher: EventPublisher | None = None,
) -> Tracking:
    """Advance a tracking to `command.status`, appending a history row.

    `actor` is the ONLY thing that differs between this function's two callers.
    The carrier PUT takes the default; TestMode progression (Phase E) passes
    `AuditActor.TEST_MODE_PROGRESSION` so an automatic run stays identifiable from
    `tracking_history.created_by` after the fact. Everything else — the parse, the
    lookup, the guards, the persistence — is deliberately shared: a second
    implementation for the automatic path is how the two would start disagreeing
    about what a transition means.

    Order of operations is load-bearing:

    1. **Parse** the status. An unknown value raises `ValueError` before anything
       is read, so garbage never reaches the state machine.
    2. **Find** the tracking, unscoped by `order_id` alone. Missing → 404.
    3. **Guard** the transition. A rejection raises `InvalidTransitionError`
       carrying its machine-readable reason → 400, and nothing is written.
    4. **Persist**, which updates the status and appends the transition in one unit
       of work. The caller's `write_session` owns the commit, so the status change
       and its history row land together or not at all.

    Steps 2 and 3 are separate so a rejected transition on an existing tracking
    cannot be confused with a missing one — different status codes, different
    causes.

    ## 5. Emit `TRACKING_STATUS_CHANGED` (events-pipeline milestone)

    Every successful transition publishes one event, `DELIVERED` included —
    there is no suppression, so a TestMode run produces four: creation writes
    `PLACED` without emitting, and the four steps that follow each emit one.

    Emission lives HERE, and only here, for the same reason the guards do: this
    is the single write path behind BOTH the carrier PUT and TestMode
    progression, so one call site covers both callers. A second emission point
    beside either of them is how the two would start disagreeing about which
    transitions notify.

    **The event is built from the PERSISTED ENTITY, and could not come from
    anywhere else.** This request has no caller identity at all (see "Why the
    lookup here is UNSCOPED" above): the carrier presents an API key, its
    gateway route has no Cognito authorizer, and no `x-user-id` reaches the
    service. So `updated` — the row this function just wrote — is the only
    source of an owner for the event, and it is handed to the publisher whole
    rather than decomposed into keyword arguments here.

    Passing the entity is what lets the payload carry the shipment's own data:
    the tracking number, the delivery address and the FULL transition history
    that makes the email's five-step timeline renderable. `Tracking.history` is
    `lazy="selectin"` and ordered by the relationship, so the publisher neither
    issues an N+1 nor re-derives an ordering that is already correct. Note that
    `repository.update_status` EXPIRES that collection after appending, so the
    publisher's read of it reloads — which is the point: the timeline it
    serializes contains the transition being announced, rather than the stale
    pre-update list.

    `cognito_sub` is deliberately not the envelope's `user_id` — that is the
    ownership key the REST reads filter by, and Users is keyed by the internal
    `usr_` id, so a sub would resolve to no email and the notification would be
    dropped as `no_email_for_user`.

    **The envelope's `author` is this function's `actor`, and carries no human.**
    `user_id` above says who the event is ABOUT; `author` says what ORIGINATED
    it, and on both of this command's paths that is a system: an external carrier
    or a TestMode timer. So the author's own `user_id`/`cognito_sub` are omitted
    rather than backfilled with the order's owner — attributing a carrier's
    status update to the buyer would be plainly false, and it is the reason the
    two fields are separate. `actor` is passed down (never fixed in the
    publisher) so the two paths stay distinguishable on the wire exactly as they
    already are in `tracking_history.created_by`.

    `publisher` defaults to the real shared SQS publisher, so the carrier and
    TestMode paths need no call-site change; tests inject a recording fake, or
    `NoopEventPublisher` when they must not emit. The default is resolved
    LAZILY, inside the call rather than in the signature, so importing this
    module never constructs a boto3 client nor requires a valid environment.

    Publishing cannot fail this command: `SqsEventPublisher` logs and swallows
    its own failures (the reasoning is in its class docstring — the transition is
    already committed, and a 500 would make the carrier retry a status change we
    actually recorded, which the forward-only guard then rejects as a 400).
    """
    requested: TrackingStatus = parse_status(command.status)

    repository = TrackingRepository(session)
    # user_id is NOT passed: unscoped by design — see the module docstring.
    tracking = repository.get_by_order_id(command.order_id)
    if tracking is None:
        raise TrackingNotFoundError(command.order_id)

    current = parse_status(tracking.status)
    assert_can_transition(current, requested)

    updated = repository.update_status(
        tracking=tracking,
        status=requested,
        actor=actor,
    )

    _emit_status_changed(
        publisher,
        # The PERSISTED row this function just wrote — never a request value.
        # Everything the event says about the shipment (its owner, its order,
        # its number, its address, its whole history) is read off this entity by
        # the publisher; see the docstring's section 5.
        tracking=updated,
        # The one fact the entity no longer holds: `updated.status` is already
        # the NEW status.
        previous_status=current.value,
        # THIS function's `actor` — the one already distinguishing the carrier
        # PUT from TestMode progression — travels onto the envelope as its
        # author. Passed down rather than fixed in the publisher, or a TestMode
        # run would be published as a carrier update; see the docstring's
        # section 5.
        actor=actor,
    )

    return updated


def _emit_status_changed(
    publisher: EventPublisher | None,
    *,
    tracking: Tracking,
    previous_status: str,
    actor: AuditActor,
) -> None:
    """Publish the transition, and never let doing so break the transition.

    ## Why building the publisher is inside the try, not just publishing

    `shared_event_publisher()` calls `get_settings()`, which constructs a
    pydantic `Settings` and raises `ValidationError` on an incomplete
    environment. **`ValidationError` is a subclass of `ValueError`** — and the
    carrier router catches `ValueError` to mean "`parse_status` rejected the
    status", mapping it to `400 invalid_status`.

    So a misconfigured environment (or a test app built without a full one, which
    is exactly how this suite builds its app) would surface as *"the carrier sent
    an invalid status"*: a 400 blaming the caller for a transition that was
    already written to the database, with a `reason` naming the wrong cause
    entirely. That is a genuinely misleading failure, and it is not
    hypothetical — it is what this function was written in response to.

    Catching here rather than widening the router's `except` keeps the rule where
    it belongs: publishing is a secondary effect, so NOTHING about it — not the
    send, not the client construction, not reading settings — may change the
    outcome of a transition that already succeeded.

    `SqsEventPublisher` swallows its own send/resolution failures (see its class
    docstring). This guard covers the layer beneath that: obtaining the publisher
    at all.
    """
    try:
        if publisher is None:
            # Imported here, not at module scope: the import itself pulls in
            # boto3 and the call reads settings, so a test injecting a fake
            # publisher touches neither.
            from src.shared.messaging.sqs_event_publisher import (
                shared_event_publisher,
            )

            publisher = shared_event_publisher()

        publisher.publish_tracking_status_changed(
            tracking=tracking,
            previous_status=previous_status,
            actor=actor,
        )
    except Exception:  # noqa: BLE001 - a notification must not fail a write
        logger.exception(
            "tracking_status_changed_publish_failed",
            extra={
                "app_event": "tracking_status_changed_publish_failed",
                "reason": "publisher_unavailable",
                # Read off the entity, like everything else on this path. These
                # three fields and no more: the line names WHICH notification
                # was lost, never what it would have contained — no address, no
                # name, no history. See [[logging-context]].
                "order_id": tracking.order_id,
                "user_id": tracking.user_id,
                "status": tracking.status,
            },
        )
