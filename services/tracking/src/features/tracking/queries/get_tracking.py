"""The shared read shape: a tracking paired with its ordered history.

Both REST reads return the same thing — a tracking "+ its `Tracking_History`" —
and both build it here, so the pairing (and therefore the history's order) cannot
differ between the single read and the batch read.

## What used to be here

Two UNSCOPED query functions, `get_tracking_by_order_id` and
`get_trackings_by_order_ids`, backing the gRPC read RPCs (JE-91). They passed no
identity to the repository, which was safe only because their caller was a trusted
internal service behind an `x-api-key`. Both went away with the gRPC surface
(JE-108). Everything served now goes through the **scoped** wrappers in
`get_my_trackings.py`, which require a `cognito_sub`.

Do not reintroduce an unscoped read here. `TrackingRepository.get_by_order_id`
still accepts an omitted `cognito_sub` — that is a one-argument difference from a
scoped call, and a query module offering both is how a REST handler ends up calling
the wrong one.

Transport-free, like the command: takes domain entities, returns domain entities.
"""

from __future__ import annotations

from dataclasses import dataclass

from src.features.tracking.domain.models import Tracking, TrackingHistory


@dataclass(frozen=True, slots=True)
class TrackingWithHistory:
    """A tracking together with its ordered history — what both reads return."""

    tracking: Tracking
    history: list[TrackingHistory]


def with_history(tracking: Tracking) -> TrackingWithHistory:
    """Pair a tracking with its history, taken off the eager relationship.

    `Tracking.history` is `lazy="selectin"` and ordered by
    `TrackingHistory.ordering()`, so it is already loaded and already correctly
    sorted. Reading it here — rather than calling `repository.get_history(id)` —
    is what keeps the batch read free of an N+1: `selectin` fetches every
    tracking's history in ONE extra query for the whole result set, whereas a
    per-tracking `get_history` call would issue one query per row.

    Shared by both read surfaces in `get_my_trackings.py`, so the same row cannot
    come back with differently-ordered history depending on which endpoint asked.
    """
    return TrackingWithHistory(tracking=tracking, history=list(tracking.history))
