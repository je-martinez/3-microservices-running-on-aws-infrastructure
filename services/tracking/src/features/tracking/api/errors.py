"""The rejected-status-update error and its response handler (JE-94).

## Why not just `HTTPException`

FastAPI's built-in handler renders an `HTTPException` as `{"detail": <detail>}`.
The design requires the `400` from a rejected transition to carry the state
machine's **machine-readable reason** (`already_delivered`, `backward_transition`,
`not_strictly_forward`), and putting an object in `detail` would nest it as
`{"detail": {"detail": ..., "reason": ...}}` — a shape a client has to know a
FastAPI implementation detail to read.

So the router raises this exception and the app factory registers the handler
below, which emits `ErrorResponse` flat: `reason` is a top-level field, matching
the token on the corresponding `*_failed` log line. A caller debugging a rejection
and an operator reading the logs see the same string.
"""

from __future__ import annotations

from fastapi import Request, status
from fastapi.responses import JSONResponse

from src.features.tracking.api.schemas import ErrorResponse


class RejectedStatusUpdate(Exception):
    """A status update the service refused: unknown value, or a guard rejected it.

    Both cases are `400` and both carry a `reason`, so one exception covers them;
    the distinction lives in the `reason` string, which is exactly the granularity
    a client needs.
    """

    def __init__(self, detail: str, reason: str) -> None:
        self.detail = detail
        self.reason = reason
        super().__init__(detail)


async def rejected_status_update_handler(
    request: Request, exc: Exception
) -> JSONResponse:
    """Render `RejectedStatusUpdate` as a flat `400` `ErrorResponse`.

    Typed as `Exception` because that is the signature Starlette's exception-handler
    registry declares; the narrowing is done by the registration key.
    """
    assert isinstance(exc, RejectedStatusUpdate)
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content=ErrorResponse(detail=exc.detail, reason=exc.reason).model_dump(),
    )
