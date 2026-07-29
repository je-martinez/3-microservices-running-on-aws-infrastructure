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
    """
    requested: TrackingStatus = parse_status(command.status)

    repository = TrackingRepository(session)
    # user_id is NOT passed: unscoped by design — see the module docstring.
    tracking = repository.get_by_order_id(command.order_id)
    if tracking is None:
        raise TrackingNotFoundError(command.order_id)

    current = parse_status(tracking.status)
    assert_can_transition(current, requested)

    return repository.update_status(
        tracking=tracking,
        status=requested,
        actor=actor,
    )
