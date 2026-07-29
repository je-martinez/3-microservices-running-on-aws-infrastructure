"""Read queries behind the two gRPC read RPCs (JE-91).

Both are **UNSCOPED**: they pass no `user_id` to the repository, so any `order_id`
is looked up as-is. That is the deliberate contrast with Phase D's REST reads,
which pass the caller's `user_id` through the same repository methods and so make
another user's tracking indistinguishable from a missing one. The difference is
justified entirely by the caller: gRPC is a trusted inter-service client
authenticated by `x-api-key` (see [[ADR-0003-grpc-inter-service]]), REST is an end
user behind a Cognito JWT.

Transport-free, like the command: they take a `Session` and return domain
entities, leaving proto mapping to `../grpc/`.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy.orm import Session

from src.features.tracking.domain.models import Tracking, TrackingHistory
from src.features.tracking.domain.repository import TrackingRepository


@dataclass(frozen=True, slots=True)
class TrackingWithHistory:
    """A tracking together with its ordered history — what both reads return."""

    tracking: Tracking
    history: list[TrackingHistory]


def _with_history(tracking: Tracking) -> TrackingWithHistory:
    """Pair a tracking with its history, taken off the eager relationship.

    `Tracking.history` is `lazy="selectin"` and ordered by
    `TrackingHistory.ordering()`, so it is already loaded and already correctly
    sorted. Reading it here — rather than calling `repository.get_history(id)` —
    is what keeps the batch read free of an N+1: `selectin` fetches every
    tracking's history in ONE extra query for the whole result set, whereas a
    per-tracking `get_history` call would issue one query per row.
    """
    return TrackingWithHistory(tracking=tracking, history=list(tracking.history))


def get_tracking_by_order_id(
    session: Session, order_id: str
) -> TrackingWithHistory | None:
    """One tracking + its history, or None when no live tracking has that order id.

    None is the honest answer for "not found" — the gRPC handler turns it into
    `NOT_FOUND`. Unscoped: no `user_id` is passed, so a tracking belonging to any
    user is returned.
    """
    tracking = TrackingRepository(session).get_by_order_id(order_id)
    if tracking is None:
        return None
    return _with_history(tracking)


def get_trackings_by_order_ids(
    session: Session, order_ids: Sequence[str]
) -> list[TrackingWithHistory]:
    """Many trackings + each one's history, in a bounded number of queries.

    Two queries total regardless of how many ids are asked for: one `WHERE order_id
    IN (...)` for the trackings, and one `selectin` load for all of their history
    rows. Explicitly NOT a loop over `get_tracking_by_order_id`, which would be
    2N queries and is the obvious way to write this wrong.

    Ids with no live tracking are **omitted** from the result, never reported as an
    error — a caller passing ten ids and matching three gets exactly three, with no
    per-id failure entry. This follows the .proto, whose response is a bare
    `repeated TrackingWithHistory` with no field in which a per-id error could even
    be expressed, and the design's equivalent rule for the batch REST read. It also
    means an all-missing batch is an empty list and a success, not `NOT_FOUND`:
    "none of these exist" is a complete, correct answer to the question asked.
    """
    trackings = TrackingRepository(session).get_by_order_ids(order_ids)
    return [_with_history(tracking) for tracking in trackings]
