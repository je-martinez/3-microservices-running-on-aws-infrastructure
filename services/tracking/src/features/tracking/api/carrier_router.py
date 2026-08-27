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

from fastapi import APIRouter, BackgroundTasks, HTTPException, Path, status

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
from src.shared.cache.invalidation import invalidate_tracking
from src.shared.http.cache_dependencies import CacheEnabledDep, CacheGatewayDep
from src.shared.http.carrier_auth import CarrierAuth
from src.shared.http.dependencies import WriteSession
from src.shared.observability import workflow_span

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
    background: BackgroundTasks,
    cache: CacheGatewayDep,
    cache_enabled: CacheEnabledDep,
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

    # One INTERNAL span for the flow, carrying the same fields its log lines do.
    # This is a plain `def` handler, so it runs on FastAPI's threadpool — the
    # span is created and closed on that same worker thread, which is what keeps
    # the SQLAlchemy spans of the update parented to it. The `reason` on each
    # failure branch is set beside the log call, with the SAME token, so the two
    # cannot drift.
    with workflow_span(
        "carrier_status_update",
        app_event="carrier_status_update_started",
        order_id=order_id,
    ) as span:
        try:
            tracking = update_tracking_status(session, command)
        except ValueError as exc:
            # `parse_status` rejected the value: not one of the five. Raised before
            # anything was read, so nothing was written.
            span.set_attribute("reason", INVALID_STATUS_REASON)
            _log_failure(order_id, INVALID_STATUS_REASON)
            raise _rejected(str(exc), INVALID_STATUS_REASON) from exc
        except TrackingNotFoundError as exc:
            # No ownership dimension here — nothing was filtered out by identity, so
            # this genuinely means the order has no tracking.
            span.set_attribute("reason", "not_found")
            _log_failure(order_id, "not_found")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="tracking not found",
            ) from exc
        except InvalidTransitionError as exc:
            # The state machine's own reason: already_delivered / backward_transition /
            # not_strictly_forward.
            span.set_attribute("reason", exc.reason.value)
            _log_failure(order_id, exc.reason.value)
            raise _rejected(str(exc), exc.reason.value) from exc

        span.set_attribute("app_event", "carrier_status_update_succeeded")
        span.set_attribute("tracking_id", tracking.id)
        span.set_attribute("status", tracking.status)

        # ---------------------------------------------------------------
        # Invalidation is SCHEDULED, not executed here — and the ordering is
        # the whole point.
        #
        # This handler does not own the transaction. `get_write_session`
        # (shared/http/dependencies.py) is a GENERATOR dependency over
        # `write_session()` (shared/db/engine.py), whose body is
        # `yield session; session.commit()`. FastAPI resumes a generator
        # dependency only after the handler has returned and the response has
        # been produced. So at THIS line the update is written but not
        # committed.
        #
        # Deleting the key now would open exactly the window the design
        # forbids: between the DELETE and the COMMIT, a concurrent read
        # misses, queries MySQL, reads the PRE-update row (its transaction
        # cannot see an uncommitted change), and writes that stale body back
        # under the key just cleared — where it then serves a superseded
        # status for a full 60s TTL. Invalidating before the write lands is
        # worse than not invalidating at all, because it looks correct.
        #
        # A BackgroundTask runs after the response is sent, which is after
        # every dependency teardown, which is after `session.commit()`. That
        # ordering is a property of the ASGI response cycle, not a timing
        # hope.
        #
        # The identities come off the PERSISTED entity, never the request —
        # the carrier sends none (no `x-user-id`; the gateway route is
        # `auth = false`). They are read HERE, as arguments to `add_task`, so
        # they are plain strings by the time the session is gone. Passing the
        # `Tracking` entity itself would be the bug: `write_session` closes
        # the session in its `finally`, and touching a detached instance
        # afterwards is a bet on `expire_on_commit=False` that two strings
        # make unnecessary.
        #
        # None of the three failure branches above needs a guard: each raises
        # out of the handler, so this line is never reached and no task is
        # scheduled, while `write_session` rolls back. Structural, rather than
        # a status check somebody can forget to update.
        if cache_enabled:
            background.add_task(
                invalidate_tracking,
                cache,
                order_id=order_id,
                cognito_sub=tracking.cognito_sub,
                user_id=tracking.user_id,
            )

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
