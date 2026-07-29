"""The `tracking.v1.Tracking` gRPC servicer (JE-90 + JE-91).

Thin: each RPC maps proto -> command/query input, calls the transport-free handler
in `../commands/` or `../queries/`, and maps the result back to proto. No business
rule lives here.

Session strategy follows ADR-0006 — `CreateTracking` opens a **writer** session
(which owns the transaction: the tracking and its first history row commit
together), the two reads open a **reader** session. The session factories are
injected rather than imported so tests can bind them to the test engine.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager

import grpc
from sqlalchemy.orm import Session

from src.features.tracking.commands.create_tracking import (
    CreateTrackingCommand,
    create_tracking,
)
from src.features.tracking.grpc.address_mapper import request_address_to_dict
from src.features.tracking.grpc.mappers import (
    tracking_to_proto,
    tracking_with_history_to_proto,
)
from src.features.tracking.queries.get_tracking import (
    get_tracking_by_order_id,
    get_trackings_by_order_ids,
)
from src.shared.db.engine import read_session, write_session
from src.shared.grpc.generated import tracking_pb2, tracking_pb2_grpc

logger = logging.getLogger(__name__)

#: A `with`-able session factory, e.g. `shared.db.engine.write_session`.
SessionFactory = Callable[[], AbstractContextManager[Session] | Iterator[Session]]


class TrackingServicer(tracking_pb2_grpc.TrackingServicer):
    """Implements the three RPCs in `proto/tracking.proto`.

    Every method here is already authenticated: `ApiKeyInterceptor` rejects a call
    with a missing or wrong `x-api-key` before the servicer is ever reached, so no
    method re-checks the key.
    """

    def __init__(
        self,
        *,
        writer: SessionFactory = write_session,
        reader: SessionFactory = read_session,
    ) -> None:
        self._writer = writer
        self._reader = reader

    # ---------------------------------------------------------------- commands

    def CreateTracking(  # noqa: N802 - the name is fixed by the .proto
        self,
        request: tracking_pb2.CreateTrackingRequest,
        context: grpc.ServicerContext,
    ) -> tracking_pb2.TrackingResponse:
        """Create a tracking at SHIPPED plus its opening history row.

        `order_id` and `user_id` are validated as present here rather than deeper
        down: proto3 gives them `""` when omitted, and `""` would otherwise be
        persisted as a perfectly valid-looking identifier that matches nothing.
        """
        for field in ("order_id", "user_id"):
            if not getattr(request, field):
                context.abort(
                    grpc.StatusCode.INVALID_ARGUMENT, f"{field} is required"
                )

        command = CreateTrackingCommand(
            order_id=request.order_id,
            user_id=request.user_id,
            # Mapped field by field, empty strings dropped — see address_mapper.
            shipping_address=request_address_to_dict(request),
            test_mode=request.test_mode,
        )

        with self._writer() as session:
            result = create_tracking(session, command)
            # Render inside the session: the entity's attributes must still be
            # loadable, and `write_session` commits on exit.
            response = tracking_pb2.TrackingResponse(
                tracking=tracking_to_proto(result.tracking)
            )

        # NEVER log the address (PII, see [[logging-context]]). Unknown fields are
        # omitted, never null — hence no `tracking_id: None` on a failure path.
        logger.info(
            "create_tracking_succeeded",
            extra={
                "app_event": "create_tracking_succeeded",
                "order_id": command.order_id,
                "user_id": command.user_id,
                "tracking_id": result.tracking.id,
                "test_mode": result.test_mode,
            },
        )
        # `result.test_mode` is the hand-off point for Phase E's automatic
        # progression — see CreateTrackingResult's docstring for why the flag is
        # returned rather than stored. Nothing schedules anything yet.
        return response

    # ----------------------------------------------------------------- queries

    def GetTrackingByOrderId(  # noqa: N802 - the name is fixed by the .proto
        self,
        request: tracking_pb2.GetTrackingByOrderIdRequest,
        context: grpc.ServicerContext,
    ) -> tracking_pb2.TrackingWithHistoryResponse:
        """One tracking with its history. UNSCOPED — no `user_id` filter.

        A missing tracking is `NOT_FOUND`: the request names exactly one resource,
        so its absence is a failure to answer, unlike the batch read below where an
        unmatched id is simply one fewer element. This is also the read whose REST
        sibling (Phase D) answers 404 for another user's tracking; here there is no
        ownership check at all — the caller is a trusted service.
        """
        with self._reader() as session:
            found = get_tracking_by_order_id(session, request.order_id)
            if found is None:
                context.abort(
                    grpc.StatusCode.NOT_FOUND,
                    f"no tracking for order_id {request.order_id}",
                )
            return tracking_pb2.TrackingWithHistoryResponse(
                tracking=tracking_with_history_to_proto(found.tracking, found.history)
            )

    def GetTrackingsByOrderIds(  # noqa: N802 - the name is fixed by the .proto
        self,
        request: tracking_pb2.GetTrackingsByOrderIdsRequest,
        context: grpc.ServicerContext,
    ) -> tracking_pb2.TrackingsWithHistoryResponse:
        """Many trackings, each with its history. UNSCOPED, and never NOT_FOUND.

        Ids with no live tracking are omitted from `trackings` — the .proto's
        response carries no per-id error field, so omission is the only semantics
        it can express, and it matches the batch REST read's rule. An empty
        `order_ids`, or one where nothing matches, returns an empty list with an OK
        status: a complete answer, not a failure.
        """
        with self._reader() as session:
            found = get_trackings_by_order_ids(session, list(request.order_ids))
            return tracking_pb2.TrackingsWithHistoryResponse(
                trackings=[
                    tracking_with_history_to_proto(item.tracking, item.history)
                    for item in found
                ]
            )
