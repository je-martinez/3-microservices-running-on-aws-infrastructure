"""Pydantic v2 response schemas for the REST surface (JE-92/93/94).

## Why these are hand-mapped and not `from_attributes`

The ORM rows carry audit and soft-delete columns (`created_by`, `deleted_at`, …)
that are internal and must never leave the service, so the mapping is explicit —
field by field. The response contract and the table are two different things that
only happen to overlap.

## Timestamps

`datetime` is emitted as an **ISO-8601 string with an explicit `Z`** by `iso()`
below. The columns are naive (MySQL `DATETIME` carries no zone) but hold UTC;
`isoformat()` alone would emit no offset and leave the client guessing.

Serialized as `str`, not as a Pydantic `datetime`: Pydantic would render the naive
value without an offset and silently drop the `Z`.

## Shipping address

Deliberately **absent** from every schema here. It is PII, it is not needed to
render a shipment's status, and the narrowest surface that answers the question is
the one that cannot leak it. It is stored (Orders' snapshot, forwarded at creation)
but never read back out on any surface this service serves.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime as _datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from src.features.tracking.domain.models import ID_LENGTH, Tracking, TrackingHistory


def iso(moment: _datetime | None) -> str:
    """Render a DATETIME column as an ISO-8601 string with an explicit `Z`.

    The columns are naive (MySQL DATETIME carries no zone) but hold UTC — the
    repository writes `datetime.now(UTC)` stripped of its tzinfo. `isoformat()` on
    a naive value emits no offset, which would leave the consumer to guess the
    zone, so the `Z` is appended explicitly.

    `None` renders as `""` rather than `null`: every timestamp on this surface is
    NOT NULL in practice, and a string-typed field that can also be null would make
    every client branch on a case that never occurs.
    """
    if moment is None:
        return ""
    return f"{moment.isoformat()}Z"


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
    `Tracking_History`" for the single read and for the batch read alike.
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


class InitTrackingRequest(BaseModel):
    """Body of `POST /v1/trackings/init-tracking` (JE-105).

    ## Two fields, and deliberately no identity

    `order_id` and `shipping_address`, nothing else. The caller's identity is NOT
    in the body and must never be: it arrives as the gateway-injected `x-user-id`
    header, which the gateway derives from a verified Cognito JWT. A `user_id` (or
    `cognito_sub`) field here would be an unauthenticated string a client chooses,
    so anyone could create a tracking attributed to anyone — the body is client
    input, the header is a gateway assertion. The service resolves the internal
    `usr_` id itself, through Users, rather than believing a claim it was handed.

    ## `test_mode` is not here either

    It travels as the `x-test-mode` header — see the router's docstring for why.

    `model_config` forbids extra fields: a client sending `user_id` gets a `422`
    naming the field, rather than having it silently ignored and later wondering
    why the tracking belongs to someone else.
    """

    model_config = ConfigDict(extra="forbid")

    order_id: str = Field(
        min_length=1,
        max_length=ID_LENGTH,
        description="The order this tracking follows.",
    )

    #: The delivery address snapshot, free-form JSON. PII — never logged.
    #:
    #: Typed as a permissive mapping rather than a strict `Address` model on
    #: purpose: this column is a point-in-time SNAPSHOT whose shape is owned by the
    #: caller that resolved it (Orders, from Users' `Address` message), and the
    #: service neither reads it back nor renders it on any surface. A strict model
    #: here would make Tracking reject an address the moment Users adds a field,
    #: turning an additive upstream change into a creation outage — for data this
    #: service only stores. Empty/None is accepted: an order whose address the
    #: caller could not resolve must still be trackable.
    shipping_address: dict[str, Any] | None = Field(
        default=None,
        description="Point-in-time delivery address snapshot. Never logged (PII).",
    )


class InitTrackingResponse(BaseModel):
    """`201` payload: the created tracking, at `PLACED`, with its first history row.

    Reuses `TrackingResponse`'s shape rather than declaring a leaner one, so the
    body a client gets from creating a tracking is identical to the one it gets
    from reading it back — including the deliberate omissions (`shipping_address`
    and `cognito_sub` are PII/identity and appear on neither).
    """

    tracking: TrackingResponse


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


class E2eCleanupResponse(BaseModel):
    """`200` payload of `DELETE /v1/trackings/e2e-cleanup`.

    One field, and it earns its place: "the suite still sees its fixtures" and
    "the cleanup matched nothing" look identical from the harness's side, so a
    bodiless `204` would leave it unable to tell a teardown that worked from one
    that silently selected zero rows without reading this service's logs. Users'
    cleanup returns its `count` for the same reason.

    Named `deleted` rather than `count` because it says what was counted.
    """

    deleted: int


class ErrorResponse(BaseModel):
    """Failure payload.

    `reason` is the machine-readable `TransitionRejectionReason`
    (`already_delivered` / `backward_transition` / `not_strictly_forward`) or a
    comparable code — the same value the `*_failed` log line carries, so a caller
    debugging a rejection and an operator reading the logs see the same token.
    """

    detail: str
    reason: str
