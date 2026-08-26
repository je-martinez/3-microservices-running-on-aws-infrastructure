"""Internal service-to-service routes.

Not published on the API Gateway and never reached by an end user: the only caller
is Users' `DELETE /v1/users/me`, authenticating with the shared internal key.

Registered BEFORE `trackings_router` in `main.py` because `/by-user` is a literal
segment sitting exactly where that router's `/{order_id}` path parameter also
matches. Starlette matches in declaration order, so the literal must be declared
first — the same reasoning that governs `/init-tracking` and `/e2e-cleanup`.

`def`, not `async def`: pymysql blocks, so a sync handler runs in the threadpool
instead of stalling the event loop.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter

from src.features.tracking.api.schemas import (
    InternalDeleteByUserRequest,
    InternalDeleteByUserResponse,
)
from src.features.tracking.commands.delete_by_user import delete_by_user
from src.shared.http.dependencies import WriteSession
from src.shared.http.internal_auth import InternalAuth

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/trackings", tags=["internal"])


@router.delete(
    "/by-user",
    dependencies=[InternalAuth],
    summary="[Internal] Soft-delete every tracking belonging to a user",
    responses={
        200: {"description": "The user's trackings and their history are soft-deleted"},
        # Declared explicitly: FastAPI cannot infer a status raised inside a
        # dependency, so without this line the 401 would be missing from the
        # generated document.
        401: {"description": "Missing or invalid internal API key"},
    },
)
def delete_trackings_by_user(
    body: InternalDeleteByUserRequest,
    session: WriteSession,
) -> InternalDeleteByUserResponse:
    """Soft-delete the user's trackings and, through the FK, their history."""
    deleted = delete_by_user(
        session, cognito_sub=body.cognito_sub, user_id=body.user_id
    )

    logger.info(
        "internal_delete_by_user_succeeded",
        extra={
            "app_event": "internal_delete_by_user_succeeded",
            "deleted_count": deleted,
        },
    )
    return InternalDeleteByUserResponse(deleted=deleted)
