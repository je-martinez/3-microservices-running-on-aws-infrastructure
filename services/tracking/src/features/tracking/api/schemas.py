"""Pydantic v2 response schemas for the REST surface (JE-92/93/94).

## Why these are hand-mapped and not `from_attributes`

The ORM rows carry audit and soft-delete columns (`created_by`, `deleted_at`, …)
that are internal and must never leave the service, so the mapping is explicit —
field by field — exactly like `grpc/mappers.py` does for the proto surface. The
two surfaces are two contracts that only happen to overlap with the table.

## Timestamps

`datetime` is emitted as an **ISO-8601 string with an explicit `Z`**, matching what
`grpc/mappers.iso()` puts on the wire, so the same row reads identically over REST
and over gRPC. The columns are naive (MySQL `DATETIME` carries no zone) but hold
UTC; `isoformat()` alone would emit no offset and leave the client guessing. That
function is imported rather than reimplemented — a second copy is how the two
surfaces start disagreeing about what time a shipment moved.

Serialized as `str`, not as a Pydantic `datetime`: Pydantic would render the naive
value without an offset and silently drop the `Z`.

## Shipping address

Deliberately **absent** from every schema here. It is PII, it is not needed to
render a shipment's status, and the narrowest surface that answers the question is
the one that cannot leak it. gRPC carries it because Orders (a trusted internal
caller) forwards the snapshot it already owns; an end user's status view does not.
"""

from __future__ import annotations

from collections.abc import Iterable

from pydantic import BaseModel, Field

from src.features.tracking.domain.models import Tracking, TrackingHistory
from src.features.tracking.grpc.mappers import iso


class HealthResponse(BaseModel):
    """`GET /v1/health` — the exact body the design specifies."""

    status: str = "ok"


class TrackingHistoryEntryResponse(BaseModel):
    """One immutable status transition.

    Carries no `shipping_address` — the address is fixed for a tracking's
    lifetime, so only the tracking itself would hold it (and this surface does not
    expose it at all).
    """

    tracking_id: str
    user_id: str
    order_id: str
    status: str
    datetime: str = Field(description="ISO-8601 UTC timestamp of this transition")

    @classmethod
    def from_entity(cls, entry: TrackingHistory) -> TrackingHistoryEntryResponse:
        return cls(
            tracking_id=entry.tracking_id,
            user_id=entry.user_id,
            order_id=entry.order_id,
            status=entry.status,
            datetime=iso(entry.datetime_),
        )


class TrackingResponse(BaseModel):
    """A tracking together with its ordered history.

    History is part of the payload rather than a separate endpoint because every
    caller of these reads wants both — the design specifies the tracking "+ its
    `Tracking_History`" for the single read, the batch read, and both gRPC reads.
    """

    id: str
    user_id: str
    order_id: str
    status: str
    datetime: str = Field(description="ISO-8601 UTC timestamp of the current status")
    history: list[TrackingHistoryEntryResponse]

    @classmethod
    def from_entity(
        cls, tracking: Tracking, history: Iterable[TrackingHistory]
    ) -> TrackingResponse:
        """Map a row plus its history.

        `history` is passed in rather than read off `tracking.history` for the same
        reason `tracking_with_history_to_proto` does it: the caller stays in charge
        of where the ordering came from. Both callers hand over the relationship,
        which sorts by `TrackingHistory.ordering()` — timestamp, then progression
        position. A bare timestamp sort ties on same-second transitions and MySQL
        then falls back to PK order, which is alphabetical and puts DELIVERED first.
        """
        return cls(
            id=tracking.id,
            user_id=tracking.user_id,
            order_id=tracking.order_id,
            status=tracking.status,
            datetime=iso(tracking.datetime_),
            history=[
                TrackingHistoryEntryResponse.from_entity(entry) for entry in history
            ],
        )


class TrackingListResponse(BaseModel):
    """The batch read's payload.

    An object with a `trackings` list rather than a bare top-level array: a bare
    array is not extensible (there is nowhere to add a field later without a
    breaking change) and is the shape most REST clients handle worst.

    There is no `total`, and no per-id error entry. Non-owned and unknown ids are
    silently omitted per the design's ownership rule, so a count of what came back
    is exactly `len(trackings)` and anything more would start describing what the
    caller does NOT own.
    """

    trackings: list[TrackingResponse]


class UpdateStatusRequest(BaseModel):
    """Body of `PUT /v1/trackings/{order_id}/status`.

    `status` is validated as a *string* here and parsed into `TrackingStatus` in
    the handler via `parse_status`. Declaring it as the enum would let Pydantic
    reject an unknown value with a 422 before the handler ran — but the design
    specifies `400` for a rejected status, and routing invalid-value handling
    through one place keeps the four failure reasons (unknown value plus the three
    transition guards) answering with the same status code and shape.
    """

    status: str


class ErrorResponse(BaseModel):
    """Failure payload.

    `reason` is the machine-readable `TransitionRejectionReason`
    (`already_delivered` / `backward_transition` / `not_strictly_forward`) or a
    comparable code — the same value the `*_failed` log line carries, so a caller
    debugging a rejection and an operator reading the logs see the same token.
    """

    detail: str
    reason: str
