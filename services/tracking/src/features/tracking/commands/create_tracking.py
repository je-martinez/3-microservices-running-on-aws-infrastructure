"""The tracking-creation command handler (JE-90, extended by JE-105).

ONE function is the whole meaning of "create a tracking" — the initial status, the
opening history row, the uniqueness rule. It was reached by two transports for a
while (a gRPC `CreateTracking` RPC from Orders, and `POST
/v1/trackings/init-tracking` from an end user behind the Cognito authorizer); the
RPC was removed in JE-108 and this handler outlived it unchanged, which is exactly
what having one implementation was for.

Transport-free on purpose: it takes a plain dataclass and returns the persisted
entity, so the endpoint's handler is a thin translation and this logic stays
testable (and reusable) without a server.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from src.features.tracking.domain.models import E2E_SOURCE_TAG, Tracking
from src.features.tracking.domain.repository import TrackingRepository
from src.features.tracking.domain.status import INITIAL_STATUS
from src.shared.audit.audit_actor import AuditActor


class TrackingAlreadyExistsError(Exception):
    """A live tracking already exists for this `order_id`.

    Its own type rather than an `HTTPException` or a bare `IntegrityError`, for the
    same reason `UnknownUserError` is: this layer is transport-free, so it states
    the domain fact and each transport decides what that becomes (JE-105's REST
    endpoint: `409`).

    Raised from BOTH the explicit pre-check and the unique-constraint violation
    that a concurrent duplicate produces — see `create_tracking`. A caller
    therefore handles exactly one exception whether it lost a race or simply asked
    twice, which is what keeps a race from surfacing as a `500`.
    """

    def __init__(self, order_id: str) -> None:
        self.order_id = order_id
        super().__init__(f"a tracking already exists for order_id {order_id}")


@dataclass(frozen=True, slots=True)
class CreateTrackingCommand:
    """Input to the create flow.

    `shipping_address` arrives already shaped as the JSON to persist — this layer
    stores the mapping it is handed and never reshapes it.
    """

    order_id: str
    #: The internal `usr_` id, resolved through Users by the endpoint's `Caller`.
    user_id: str
    #: The caller's Cognito `sub`, and the ONLY identity the user-scoped REST reads
    #: can filter by (the gateway injects it as `x-user-id`). Still `| None` for the
    #: rows written before the column existed — such a tracking matches nobody, so
    #: it is unreachable over those reads rather than mis-attributed.
    cognito_sub: str | None = None
    shipping_address: dict | None = None
    #: Whether this tracking is an E2E fixture, and should therefore be tagged
    #: `"E2E Source"` — the tag `DELETE /v1/trackings/e2e-cleanup` deletes by.
    #:
    #: Unlike `test_mode` this one IS persisted, and the difference is what each
    #: describes. `test_mode` is true for the instant of creation and meaningless
    #: afterwards, so it is returned rather than stored. Whether a row is a
    #: harness fixture is a durable fact about the row itself — the teardown asks
    #: it minutes later, long after the creating request is gone — so it has
    #: nowhere to live except the row.
    #:
    #: A `bool` here, not the tag string: this layer states the fact and
    #: `_persist` maps it to the literal, so no caller can write a near-miss
    #: spelling the cleanup would never match.
    e2e_source: bool = False
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
    reader (the REST reads, the carrier webhook) would inherit a column it has no
    business interpreting. The design's Data Model table lists no such column
    either.

    So the flag is *recorded* by being **returned**. That is everything a 10s timer
    needs — an id and a boolean — with no schema change and no rows to clean up
    when a run is abandoned.

    The REST endpoint does not actually consume it from here: it passes
    `test_mode=False` and schedules the progression itself from the `x-test-mode`
    header, because it is already on the event loop and knows whether the write
    committed. The field stays on the contract so a caller that DOES want the
    command to carry the flag is not forced to invent a second channel for it.

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

    ## One tracking per order, guarded twice (JE-105)

    Creation is only valid for an order that has NO tracking yet. The rule is
    enforced in two places, and both are needed for different reasons:

    1. **An explicit pre-check** (`get_by_order_id`). This is what produces a
       meaningful answer: a caller asking twice gets `TrackingAlreadyExistsError`,
       which the REST endpoint renders as `409`, from a plain SELECT — no failed
       INSERT, no aborted transaction, no driver-specific error string to parse.
       Relying only on catching the constraint would mean the ordinary,
       entirely-expected "already exists" path ran through an exception raised by
       MySQL, and would couple this handler to which constraint happened to fire.
    2. **The `uq_tracking_order_id` constraint**, caught below. The pre-check
       cannot be airtight: two concurrent requests for the same order can both
       SELECT nothing before either INSERTs. The database is the only thing that
       can adjudicate that, and it does — one INSERT wins, the other violates the
       unique index. Catching it and raising the SAME exception is what makes the
       loser answer `409` (the truthful answer: someone else created it) instead of
       a `500` on a leaked `IntegrityError`.

    The `flush()` inside `repository.create` is what makes catching possible here:
    it sends the INSERT now, so the violation surfaces inside this function rather
    than at the caller's commit, where the transport handler has already returned a
    response and there is nothing left to convert.

    Note `get_by_order_id` excludes soft-deleted rows, so "no existing tracking"
    means no LIVE one. A soft-deleted tracking still holds the `order_id` in the
    unique index, so that case falls to guard 2 and is also a `409` — correct: the
    order's tracking exists, it is simply not visible.
    """
    repository = TrackingRepository(session)

    # Guard 1 — the expected path for a duplicate request. See the docstring.
    if repository.get_by_order_id(command.order_id) is not None:
        raise TrackingAlreadyExistsError(command.order_id)

    try:
        return _persist(repository, command)
    except IntegrityError as exc:
        # Guard 2 — a genuine race, or a soft-deleted row still holding the id.
        # Rolled back so the session is usable again: MySQL aborts the statement,
        # not the transaction, but SQLAlchemy marks the session as needing a
        # rollback and every later statement on it would raise
        # `PendingRollbackError` instead of the error the caller expects.
        session.rollback()
        raise TrackingAlreadyExistsError(command.order_id) from exc


def _persist(
    repository: TrackingRepository, command: CreateTrackingCommand
) -> CreateTrackingResult:
    """Write the tracking and its opening history row. Separated only so the
    `IntegrityError` handling above reads as one decision rather than wrapping the
    whole body in a `try`."""
    tracking = repository.create(
        order_id=command.order_id,
        user_id=command.user_id,
        cognito_sub=command.cognito_sub,
        shipping_address=command.shipping_address,
        # The ONE place the tag literal is written. Everything upstream carries a
        # boolean, so a spelling the cleanup does not select on cannot be
        # introduced at a call site.
        tags=[E2E_SOURCE_TAG] if command.e2e_source else [],
        # The initial status is not a parameter of this flow — every tracking
        # starts at SHIPPED, per the state machine, whether or not TestMode is on.
        status=INITIAL_STATUS,
        actor=AuditActor.CREATE_TRACKING,
    )
    return CreateTrackingResult(tracking=tracking, test_mode=command.test_mode)
