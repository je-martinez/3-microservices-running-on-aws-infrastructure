"""`PUT /v1/trackings/{order_id}/status` — the carrier webhook (JE-94).

Simulates a third-party carrier notifying us of a delivery status change.

## Separate router from the reads, on purpose

This endpoint shares a path prefix with the two reads in `trackings_router.py` and
almost nothing else: different caller, different credential, different scoping.
Keeping it in its own router means the reads' `CallerId` dependency is nowhere near
it, so it cannot acquire an `x-user-id` requirement by being edited next to code
that has one. The auth is declared at the ROUTER level (`dependencies=[CarrierAuth]`),
so a second carrier endpoint added here is authenticated by default rather than
open by default.

## No `x-user-id`, and no ownership filter

The gateway route is declared `auth = false` — no Cognito authorizer, therefore no
gateway-injected `x-user-id` on this request at all. The handler identifies the
tracking by `order_id` **alone** and calls the repository unscoped
(`user_id=None`); see `commands/update_status.py`. Reusing the reads' ownership
filter here would make every carrier call 404: the endpoint would look implemented
and never work once.

## Status codes

| Outcome | Code | Why |
|---|---|---|
| Updated | 200 | Returns the updated tracking with its history |
| Missing/invalid carrier key | 401 | No principal established — see `carrier_auth` |
| Unknown status value | 400 | With `reason: invalid_status` |
| Rejected transition | 400 | With the state machine's own `reason` |
| Unknown `order_id` | 404 | No live tracking for that order |
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, status

from src.features.tracking.api.errors import RejectedStatusUpdate
from src.features.tracking.api.schemas import (
    ErrorResponse,
    TrackingResponse,
    UpdateStatusRequest,
)
from src.features.tracking.commands.update_status import (
    TrackingNotFoundError,
    UpdateTrackingStatusCommand,
    update_tracking_status,
)
from src.features.tracking.domain.status import InvalidTransitionError
from src.shared.http.carrier_auth import CarrierAuth
from src.shared.http.dependencies import WriteSession

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/v1/trackings",
    tags=["carrier"],
    # Router-level, so every endpoint added here is authenticated by default.
    dependencies=[CarrierAuth],
)

#: `reason` for a status string outside the five valid values. Sits alongside the
#: three `TransitionRejectionReason` members in the same response field, so a
#: client handles one vocabulary of rejection codes, not two.
INVALID_STATUS_REASON = "invalid_status"


@router.put(
    "/{order_id}/status",
    status_code=status.HTTP_200_OK,
    summary="Carrier status update (API-key authenticated)",
    responses={
        400: {"model": ErrorResponse, "description": "Rejected status transition"},
        401: {"description": "Missing or invalid carrier API key"},
        404: {"description": "No tracking for that order id"},
    },
)
def update_status(
    session: WriteSession,
    payload: UpdateStatusRequest,
    order_id: Annotated[str, Path(description="The order's id")],
) -> TrackingResponse:
    """Advance a tracking's status and append the transition to its history.

    The three failure modes map to distinct codes so a carrier can tell them apart
    without parsing prose: `404` means the order has no tracking (retrying will not
    help until one exists), while `400` means the tracking is there and refused the
    move (retrying with the SAME status will never help — the state machine is
    forward-only).

    Both `400` paths carry a machine-readable `reason`, and both log a
    `*_failed` event with that same token, per the logging convention. The
    shipping address is never touched or logged here — it is PII and a status
    update has no business with it.
    """
    command = UpdateTrackingStatusCommand(order_id=order_id, status=payload.status)

    try:
        tracking = update_tracking_status(session, command)
    except ValueError as exc:
        # `parse_status` rejected the value: not one of the five. Raised before
        # anything was read, so nothing was written.
        _log_failure(order_id, INVALID_STATUS_REASON)
        raise _rejected(str(exc), INVALID_STATUS_REASON) from exc
    except TrackingNotFoundError as exc:
        # No ownership dimension here — nothing was filtered out by identity, so
        # this genuinely means the order has no tracking.
        _log_failure(order_id, "not_found")
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="tracking not found",
        ) from exc
    except InvalidTransitionError as exc:
        # The state machine's own reason: already_delivered / backward_transition /
        # not_strictly_forward.
        _log_failure(order_id, exc.reason.value)
        raise _rejected(str(exc), exc.reason.value) from exc

    logger.info(
        "carrier_status_update_succeeded",
        extra={
            "app_event": "carrier_status_update_succeeded",
            "order_id": order_id,
            "tracking_id": tracking.id,
            "status": tracking.status,
        },
    )
    # Rendered inside the request, while the session is still open: the history
    # relationship must still be loadable.
    return TrackingResponse.from_entity(tracking, tracking.history)


def _rejected(detail: str, reason: str) -> RejectedStatusUpdate:
    """Build the `400` for a rejected status change.

    A dedicated exception rather than `HTTPException`, because FastAPI's default
    handler renders the body as `{"detail": <detail>}` — nesting an object there
    would give clients `{"detail": {"detail": ..., "reason": ...}}`. The app
    factory registers a handler that emits `ErrorResponse` flat, so `reason` is a
    top-level field where a client can actually reach it.
    """
    return RejectedStatusUpdate(detail=detail, reason=reason)


def _log_failure(order_id: str, reason: str) -> None:
    """Emit the `*_failed` event with its machine-readable reason.

    No `user_id` field — this request has no user identity, and the convention is
    that unknown fields are OMITTED, never null.
    """
    logger.warning(
        "carrier_status_update_failed",
        extra={
            "app_event": "carrier_status_update_failed",
            "reason": reason,
            "order_id": order_id,
        },
    )
