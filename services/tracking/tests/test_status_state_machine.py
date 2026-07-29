"""Tests for the forward-only state machine (JE-89).

Pure — no database, no HTTP, no fixtures. That the whole file runs without either
is itself the property under test: the state machine must be usable from the PUT
handler (Phase D) and from TestMode progression (Phase E), which has no request.

The three guards are verified as THREE DISTINCT cases. A single `new > current`
comparison would make all the rejection tests pass while collapsing the reasons
into one, so every rejection asserts its specific `TransitionRejectionReason`, not
merely that something was rejected.
"""

import pytest

from src.features.tracking.domain.status import (
    INITIAL_STATUS,
    STATUS_ORDER,
    TERMINAL_STATUS,
    InvalidTransitionError,
    TrackingStatus,
    TransitionRejectionReason,
    assert_can_transition,
    can_transition,
    check_transition,
    next_status,
    parse_status,
    status_index,
)

# Every status that is not the terminal one — the set that can still move.
NON_TERMINAL = [s for s in STATUS_ORDER if s is not TERMINAL_STATUS]


class TestProgressionShape:
    """The progression itself, before any guard."""

    def test_exactly_four_statuses(self) -> None:
        assert len(STATUS_ORDER) == 4

    def test_order_is_the_documented_progression(self) -> None:
        assert STATUS_ORDER == (
            TrackingStatus.SHIPPED,
            TrackingStatus.ON_THE_WAY,
            TrackingStatus.OUT_FOR_DELIVERY,
            TrackingStatus.DELIVERED,
        )

    def test_initial_is_shipped_and_terminal_is_delivered(self) -> None:
        assert INITIAL_STATUS is TrackingStatus.SHIPPED
        assert TERMINAL_STATUS is TrackingStatus.DELIVERED

    def test_alphabetical_ordering_would_be_wrong(self) -> None:
        """Guards the trap that `StrEnum` members sort alphabetically.

        `DELIVERED` < `SHIPPED` as strings, so any implementation that ordered
        statuses by comparing the enum members directly — rather than by position
        in STATUS_ORDER — would treat the terminal status as the earliest one.
        """
        assert TrackingStatus.DELIVERED < TrackingStatus.SHIPPED  # string compare
        assert status_index(TrackingStatus.DELIVERED) > status_index(
            TrackingStatus.SHIPPED
        )


class TestGuardOneDeliveredIsTerminal:
    """Guard 1 — DELIVERED is terminal: ANY update against it is rejected."""

    @pytest.mark.parametrize("requested", list(STATUS_ORDER))
    def test_every_status_is_rejected_against_delivered(
        self, requested: TrackingStatus
    ) -> None:
        result = check_transition(TrackingStatus.DELIVERED, requested)
        assert result.allowed is False

    @pytest.mark.parametrize("requested", list(STATUS_ORDER))
    def test_reason_is_always_already_delivered(
        self, requested: TrackingStatus
    ) -> None:
        """Terminality outranks the ordering guards.

        `DELIVERED -> SHIPPED` also violates guard 2 and `DELIVERED -> DELIVERED`
        also violates guard 3; the terminal fact is the more specific one and is
        what gets reported.
        """
        result = check_transition(TrackingStatus.DELIVERED, requested)
        assert result.reason is TransitionRejectionReason.ALREADY_DELIVERED

    def test_next_status_of_delivered_is_none_not_an_error(self) -> None:
        """Reaching the end is how a TestMode run finishes, not a failure."""
        assert next_status(TrackingStatus.DELIVERED) is None


class TestGuardTwoNoBackwardTransitions:
    """Guard 2 — a tracking may not move to an earlier status."""

    @pytest.mark.parametrize(
        ("current", "requested"),
        [
            (current, requested)
            for current in STATUS_ORDER
            for requested in STATUS_ORDER
            # Backward pairs only, and excluding those starting at the terminal
            # status, which guard 1 claims first.
            if STATUS_ORDER.index(requested) < STATUS_ORDER.index(current)
            and current is not TERMINAL_STATUS
        ],
    )
    def test_backward_is_rejected_with_its_own_reason(
        self, current: TrackingStatus, requested: TrackingStatus
    ) -> None:
        result = check_transition(current, requested)
        assert result.allowed is False
        assert result.reason is TransitionRejectionReason.BACKWARD_TRANSITION

    def test_a_multi_step_jump_backwards_is_rejected(self) -> None:
        result = check_transition(
            TrackingStatus.OUT_FOR_DELIVERY, TrackingStatus.SHIPPED
        )
        assert result.reason is TransitionRejectionReason.BACKWARD_TRANSITION


class TestGuardThreeStrictlyForward:
    """Guard 3 — a status EQUAL to the current one is also rejected."""

    @pytest.mark.parametrize("status", NON_TERMINAL)
    def test_same_status_is_rejected(self, status: TrackingStatus) -> None:
        result = check_transition(status, status)
        assert result.allowed is False
        assert result.reason is TransitionRejectionReason.NOT_STRICTLY_FORWARD

    def test_not_strictly_forward_is_distinct_from_backward(self) -> None:
        """The two ordering guards must never report the same reason.

        This is the assertion a naive `new > current` implementation fails: it
        would reject both cases, but be unable to tell them apart.
        """
        same = check_transition(TrackingStatus.ON_THE_WAY, TrackingStatus.ON_THE_WAY)
        backward = check_transition(
            TrackingStatus.ON_THE_WAY, TrackingStatus.SHIPPED
        )
        assert same.reason is not backward.reason

    def test_all_three_reasons_are_reachable_and_distinct(self) -> None:
        """End-to-end proof the three guards are three separate cases."""
        reasons = {
            check_transition(
                TrackingStatus.DELIVERED, TrackingStatus.SHIPPED
            ).reason,
            check_transition(
                TrackingStatus.ON_THE_WAY, TrackingStatus.SHIPPED
            ).reason,
            check_transition(
                TrackingStatus.ON_THE_WAY, TrackingStatus.ON_THE_WAY
            ).reason,
        }
        assert reasons == {
            TransitionRejectionReason.ALREADY_DELIVERED,
            TransitionRejectionReason.BACKWARD_TRANSITION,
            TransitionRejectionReason.NOT_STRICTLY_FORWARD,
        }


class TestAllowedTransitions:
    """The positive path: strictly-forward moves are allowed."""

    @pytest.mark.parametrize(
        ("current", "requested"),
        [
            (STATUS_ORDER[i], STATUS_ORDER[j])
            for i in range(len(STATUS_ORDER))
            for j in range(len(STATUS_ORDER))
            if j > i
        ],
    )
    def test_any_strictly_forward_move_is_allowed(
        self, current: TrackingStatus, requested: TrackingStatus
    ) -> None:
        assert can_transition(current, requested) is True

    def test_skipping_a_status_is_allowed(self) -> None:
        """SHIPPED -> DELIVERED skips two steps but is still forward.

        The spec's guards reject backward and equal moves; nothing requires a
        transition to be adjacent. A carrier reporting a delivery without having
        reported the intermediate scans is realistic, not a violation.
        """
        assert can_transition(TrackingStatus.SHIPPED, TrackingStatus.DELIVERED)

    def test_the_full_happy_path_walks_end_to_end(self) -> None:
        current = INITIAL_STATUS
        visited = [current]
        while (upcoming := next_status(current)) is not None:
            assert can_transition(current, upcoming)
            current = upcoming
            visited.append(current)
        assert visited == list(STATUS_ORDER)
        assert current is TERMINAL_STATUS


class TestAssertCanTransition:
    """The raising form used by the PUT handler."""

    def test_allowed_transition_does_not_raise(self) -> None:
        assert_can_transition(TrackingStatus.SHIPPED, TrackingStatus.ON_THE_WAY)

    @pytest.mark.parametrize(
        ("current", "requested", "expected_reason"),
        [
            (
                TrackingStatus.DELIVERED,
                TrackingStatus.SHIPPED,
                TransitionRejectionReason.ALREADY_DELIVERED,
            ),
            (
                TrackingStatus.OUT_FOR_DELIVERY,
                TrackingStatus.ON_THE_WAY,
                TransitionRejectionReason.BACKWARD_TRANSITION,
            ),
            (
                TrackingStatus.SHIPPED,
                TrackingStatus.SHIPPED,
                TransitionRejectionReason.NOT_STRICTLY_FORWARD,
            ),
        ],
    )
    def test_rejection_raises_carrying_the_reason(
        self,
        current: TrackingStatus,
        requested: TrackingStatus,
        expected_reason: TransitionRejectionReason,
    ) -> None:
        with pytest.raises(InvalidTransitionError) as exc_info:
            assert_can_transition(current, requested)
        assert exc_info.value.reason is expected_reason
        assert exc_info.value.current is current
        assert exc_info.value.requested is requested


class TestNextStatus:
    """TestMode progression's stepper."""

    @pytest.mark.parametrize(
        ("current", "expected"),
        [
            (TrackingStatus.SHIPPED, TrackingStatus.ON_THE_WAY),
            (TrackingStatus.ON_THE_WAY, TrackingStatus.OUT_FOR_DELIVERY),
            (TrackingStatus.OUT_FOR_DELIVERY, TrackingStatus.DELIVERED),
            (TrackingStatus.DELIVERED, None),
        ],
    )
    def test_advances_exactly_one_step(
        self, current: TrackingStatus, expected: TrackingStatus | None
    ) -> None:
        assert next_status(current) is expected

    def test_progression_reaches_delivered_in_three_steps(self) -> None:
        """Matches the design's TestMode table: t=0 SHIPPED … t=30s DELIVERED."""
        steps = 0
        current = INITIAL_STATUS
        while (upcoming := next_status(current)) is not None:
            current = upcoming
            steps += 1
        assert steps == 3


class TestParseStatus:
    """External strings crossing into the domain."""

    @pytest.mark.parametrize("status", list(STATUS_ORDER))
    def test_round_trips_every_valid_value(self, status: TrackingStatus) -> None:
        assert parse_status(status.value) is status

    @pytest.mark.parametrize(
        "value", ["delivered", "Delivered", "IN_TRANSIT", "", "SHIPPED "]
    )
    def test_rejects_anything_else(self, value: str) -> None:
        with pytest.raises(ValueError, match="invalid tracking status"):
            parse_status(value)

    def test_status_serializes_as_its_wire_value(self) -> None:
        """StrEnum: one representation across wire, storage and HTTP."""
        assert f"{TrackingStatus.OUT_FOR_DELIVERY}" == "OUT_FOR_DELIVERY"
        assert TrackingStatus.OUT_FOR_DELIVERY == "OUT_FOR_DELIVERY"
