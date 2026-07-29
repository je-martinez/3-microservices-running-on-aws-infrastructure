"""Tracking statuses and the forward-only state machine (JE-89).

PURE domain code: no database, no HTTP, no framework imports. Both callers of the
state machine depend on that purity —

  * `PUT /v1/trackings/{orderId}/status`, the carrier endpoint, which turns a
    rejection into a `400 Bad Request`; and
  * TestMode automatic progression, which runs on a 10s timer with no request
    context at all.

so nothing here may assume an HTTP request, a session, or a caller identity.
"""

from dataclasses import dataclass
from enum import StrEnum
from typing import Final


class TrackingStatus(StrEnum):
    """The four valid delivery statuses.

    A `StrEnum` so the member compares and serializes as its own name — matching
    both the `VARCHAR(50)` storage and the REST surface, which takes and returns it
    as a string. One representation across wire, storage and HTTP.
    """

    SHIPPED = "SHIPPED"
    ON_THE_WAY = "ON_THE_WAY"
    OUT_FOR_DELIVERY = "OUT_FOR_DELIVERY"
    DELIVERED = "DELIVERED"


# The allowed progression, in order. Position in this tuple IS the ordering the
# guards below compare against — `TrackingStatus` is a StrEnum, so its members
# compare alphabetically, NOT in delivery order (`DELIVERED` < `SHIPPED`
# alphabetically). Never order statuses by comparing the enum members directly.
STATUS_ORDER: Final[tuple[TrackingStatus, ...]] = (
    TrackingStatus.SHIPPED,
    TrackingStatus.ON_THE_WAY,
    TrackingStatus.OUT_FOR_DELIVERY,
    TrackingStatus.DELIVERED,
)

#: The status every tracking is created at.
INITIAL_STATUS: Final[TrackingStatus] = STATUS_ORDER[0]

#: Terminal status. Nothing may follow it, and nothing may update a tracking on it.
TERMINAL_STATUS: Final[TrackingStatus] = STATUS_ORDER[-1]


class TransitionRejectionReason(StrEnum):
    """Why a transition was rejected.

    Three distinct members on purpose. A single `new > current` comparison would
    satisfy all three guards at once and collapse them into one indistinguishable
    failure — this enum keeps "already delivered", "went backwards" and "did not
    move" separately identifiable, both for the `reason` field the logging
    convention requires on `*_failed` events and for the tests that must verify
    each guard independently.
    """

    #: Guard 1 — the current status is DELIVERED, which is terminal.
    ALREADY_DELIVERED = "already_delivered"
    #: Guard 2 — the requested status is earlier in the progression.
    BACKWARD_TRANSITION = "backward_transition"
    #: Guard 3 — the requested status equals the current one; not strictly forward.
    NOT_STRICTLY_FORWARD = "not_strictly_forward"


class InvalidTransitionError(Exception):
    """Raised by `assert_can_transition` when a transition is rejected.

    Carries the machine-readable `reason` so the HTTP layer can log it (and, if it
    chooses, surface it) without re-deriving why the transition failed.
    """

    def __init__(
        self,
        current: TrackingStatus,
        requested: TrackingStatus,
        reason: TransitionRejectionReason,
    ) -> None:
        self.current = current
        self.requested = requested
        self.reason = reason
        super().__init__(
            f"cannot transition from {current} to {requested}: {reason}"
        )


@dataclass(frozen=True, slots=True)
class TransitionCheck:
    """Result of evaluating a transition. Falsy-safe via `allowed`."""

    allowed: bool
    reason: TransitionRejectionReason | None = None


def status_index(status: TrackingStatus) -> int:
    """Return `status`'s position in the forward-only progression."""
    return STATUS_ORDER.index(status)


def check_transition(
    current: TrackingStatus, requested: TrackingStatus
) -> TransitionCheck:
    """Evaluate `current -> requested` against the three guards.

    The guards are checked in this order, and the order is load-bearing: a
    `DELIVERED -> SHIPPED` request violates guards 1 and 2 simultaneously, and
    `DELIVERED -> DELIVERED` violates 1 and 3. Terminality is the more specific
    fact about the tracking, so it is reported first.

    1. `DELIVERED` is terminal — ANY update against it is rejected.
    2. No backward transitions — the requested status may not be earlier.
    3. Strictly forward — a status EQUAL to the current one is also rejected.
    """
    # Guard 1: terminal. Checked before the ordering guards so that a tracking
    # already delivered reports "already_delivered" whatever is requested of it,
    # including DELIVERED itself.
    if current is TERMINAL_STATUS:
        return TransitionCheck(False, TransitionRejectionReason.ALREADY_DELIVERED)

    current_index = status_index(current)
    requested_index = status_index(requested)

    # Guard 2: backward.
    if requested_index < current_index:
        return TransitionCheck(False, TransitionRejectionReason.BACKWARD_TRANSITION)

    # Guard 3: strictly forward — equal is not forward. Distinct from guard 2:
    # guard 2 fires on `<`, this one only on `==`, so the two can never both be
    # the reported reason for the same pair.
    if requested_index == current_index:
        return TransitionCheck(False, TransitionRejectionReason.NOT_STRICTLY_FORWARD)

    return TransitionCheck(True)


def can_transition(current: TrackingStatus, requested: TrackingStatus) -> bool:
    """True when `current -> requested` is allowed.

    Thin boolean view of `check_transition`.
    """
    return check_transition(current, requested).allowed


def assert_can_transition(
    current: TrackingStatus, requested: TrackingStatus
) -> None:
    """Raise `InvalidTransitionError` unless `current -> requested` is allowed.

    The form callers use when a rejection is exceptional — the PUT handler maps
    the raised error to `400 Bad Request`.
    """
    result = check_transition(current, requested)
    if not result.allowed:
        # `reason` is always set when `allowed` is False.
        assert result.reason is not None
        raise InvalidTransitionError(current, requested, result.reason)


def next_status(current: TrackingStatus) -> TrackingStatus | None:
    """Return the single status that follows `current`, or None at the terminal one.

    Used by TestMode progression (Phase E) to advance one step every 10 seconds.
    Deliberately returns None rather than raising at `DELIVERED`: reaching the end
    of the progression is the expected way a TestMode run finishes, not an error.
    """
    if current is TERMINAL_STATUS:
        return None
    return STATUS_ORDER[status_index(current) + 1]


def parse_status(value: str) -> TrackingStatus:
    """Parse an external string into a `TrackingStatus`.

    Raises `ValueError` for anything outside the four valid values — the REST
    handler turns that into a `400`. Case-sensitive on purpose: the four values
    are a fixed wire contract shared with the proto, not free-form input.
    """
    try:
        return TrackingStatus(value)
    except ValueError as exc:
        valid = ", ".join(s.value for s in STATUS_ORDER)
        raise ValueError(
            f"invalid tracking status {value!r}; expected one of: {valid}"
        ) from exc
