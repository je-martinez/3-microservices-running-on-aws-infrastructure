"""`CreateTracking` command handler (JE-90).

The ONLY way a tracking is created — there is no REST POST. The caller is Orders,
confirming an order, over gRPC.

Transport-free on purpose: it takes a plain dataclass and returns the persisted
entity, so the gRPC handler in `../grpc/` is a thin translation and this logic
stays testable (and reusable) without a server.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from src.features.tracking.domain.models import Tracking
from src.features.tracking.domain.repository import TrackingRepository
from src.features.tracking.domain.status import INITIAL_STATUS
from src.shared.audit.audit_actor import AuditActor


@dataclass(frozen=True, slots=True)
class CreateTrackingCommand:
    """Input to the create flow.

    `shipping_address` is already mapped to the JSON to persist (see
    `../grpc/address_mapper.py`) — this layer never touches a proto message.
    """

    order_id: str
    #: The internal `usr_` id Orders resolved through Users.
    user_id: str
    #: The caller's Cognito `sub`, and the ONLY identity the user-scoped REST reads
    #: can filter by (the gateway injects it as `x-user-id`). `None` when the
    #: caller predates the wire field — the tracking is still created, and is
    #: simply unreachable over those reads rather than mis-attributed.
    cognito_sub: str | None = None
    shipping_address: dict | None = None
    #: Recorded, not acted upon here — see `CreateTrackingResult.test_mode`.
    test_mode: bool = False


@dataclass(frozen=True, slots=True)
class CreateTrackingResult:
    """The created tracking, plus the TestMode hand-off.

    ## Why `test_mode` comes back out instead of being persisted

    `test_mode` is NOT a column on `tracking`, and deliberately so. It is not a
    fact about the shipment — it is a fact about **how this one request was made**,
    true only for the instant of creation and meaningless afterwards. Persisting it
    would put a test-harness flag into the domain's data model, and every later
    reader (the REST reads, the carrier webhook, the .NET client) would inherit a
    column it has no business interpreting. The design's Data Model table lists no
    such column either.

    So the flag is *recorded* by being **returned**, and Phase E's automatic
    progression consumes it from here: the scheduler it adds reads
    `result.test_mode` and, when true, schedules the tracking's advance from
    `result.tracking.id`. That is everything a 10s timer needs — an id and a
    boolean — with no schema change and no rows to clean up when a run is
    abandoned.

    The audit trail does not lose the information either: every automatic
    transition is stamped `AuditActor.TEST_MODE_PROGRESSION`, so a completed
    TestMode run is identifiable after the fact from `tracking_history.created_by`
    alone, which is where "how did this row come to exist" belongs.
    """

    tracking: Tracking
    test_mode: bool


def create_tracking(
    session: Session, command: CreateTrackingCommand
) -> CreateTrackingResult:
    """Persist a new tracking at `SHIPPED` plus its first history row.

    Both rows are written through `TrackingRepository.create`, which adds them to
    the SAME session without committing — the caller's `write_session` owns the
    transaction, so the tracking and its opening transition commit together or not
    at all. A tracking that exists with no history would be a record whose own
    creation left no trace in the immutable log.

    Never logs `command.shipping_address`: it is PII (see [[logging-context]]).
    """
    repository = TrackingRepository(session)
    tracking = repository.create(
        order_id=command.order_id,
        user_id=command.user_id,
        cognito_sub=command.cognito_sub,
        shipping_address=command.shipping_address,
        # The initial status is not a parameter of this flow — every tracking
        # starts at SHIPPED, per the state machine, whether or not TestMode is on.
        status=INITIAL_STATUS,
        actor=AuditActor.CREATE_TRACKING,
    )
    return CreateTrackingResult(tracking=tracking, test_mode=command.test_mode)
