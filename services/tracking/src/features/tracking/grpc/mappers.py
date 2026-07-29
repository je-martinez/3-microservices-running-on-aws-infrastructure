"""Domain entity -> proto message mapping for the gRPC surface.

Separated from the handlers so both reads and the create path render a
`TrackingRecord` identically — a divergence there would mean the same row looked
different depending on which RPC returned it.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime

from src.features.tracking.domain.models import Tracking, TrackingHistory
from src.features.tracking.grpc.address_mapper import dict_to_address
from src.shared.grpc.generated import tracking_pb2


def iso(moment: datetime | None) -> str:
    """Render a DATETIME column as the ISO-8601 string the .proto declares.

    The columns are naive (MySQL DATETIME carries no zone) but hold UTC — the
    repository writes `datetime.now(UTC)` stripped of its tzinfo. `isoformat()` on
    a naive value emits no offset, which would leave the consumer to guess the
    zone, so the `Z` is appended explicitly: the wire value is unambiguous and the
    .NET client parses it as UTC rather than as local time.
    """
    if moment is None:
        return ""
    return f"{moment.isoformat()}Z"


def tracking_to_proto(tracking: Tracking) -> tracking_pb2.TrackingRecord:
    """Map a `Tracking` row onto the wire message.

    Field by field, deliberately: the column set and the message's field set are
    two different contracts that only happen to overlap (the row also carries audit
    and soft-delete columns, which are internal and must never leave the service).
    """
    return tracking_pb2.TrackingRecord(
        id=tracking.id,
        user_id=tracking.user_id,
        # NULL becomes "" — proto3 scalars have no null, and "" is how this file
        # already renders every other absent value (see `iso`). The consumer reads
        # "" as "not provided", per the .proto's Address note.
        cognito_sub=tracking.cognito_sub or "",
        order_id=tracking.order_id,
        status=tracking.status,
        datetime=iso(tracking.datetime_),
        shipping_address=dict_to_address(tracking.shipping_address),
    )


def history_entry_to_proto(
    entry: TrackingHistory,
) -> tracking_pb2.TrackingHistoryEntry:
    """Map one `TrackingHistory` row onto the wire message.

    Carries no address — the .proto is explicit that only `TrackingRecord` holds
    it, because the address is bulky PII that says nothing about a transition. It
    does carry `cognito_sub`, which is ownership context and sits alongside the
    `user_id`/`order_id` this row already denormalizes.
    """
    return tracking_pb2.TrackingHistoryEntry(
        tracking_id=entry.tracking_id,
        user_id=entry.user_id,
        cognito_sub=entry.cognito_sub or "",
        order_id=entry.order_id,
        status=entry.status,
        datetime=iso(entry.datetime_),
    )


def tracking_with_history_to_proto(
    tracking: Tracking, history: Iterable[TrackingHistory]
) -> tracking_pb2.TrackingWithHistory:
    """Map a tracking plus its history — what both read RPCs return.

    `history` is passed in rather than read off `tracking.history` so the caller
    stays in charge of WHERE the ordering came from. Both callers hand over the
    relationship, which sorts by `TrackingHistory.ordering()` (timestamp, then
    progression position); a bare timestamp sort is not deterministic and would put
    DELIVERED first on tied timestamps.
    """
    return tracking_pb2.TrackingWithHistory(
        tracking=tracking_to_proto(tracking),
        history=[history_entry_to_proto(entry) for entry in history],
    )
