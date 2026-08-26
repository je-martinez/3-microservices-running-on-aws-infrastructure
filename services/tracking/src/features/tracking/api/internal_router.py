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
from src.shared.logging import merge_log_context
from src.shared.observability import workflow_span

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/trackings", tags=["internal"])

#: `reason` for a database fault while stamping the rows. The cascade's caller
#: (Users) retries the leg, so the token names what failed rather than which
#: driver raised — the exception text carries that, and only on the span.
DB_ERROR_REASON = "db_error"


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
    # NOTE: this docstring is the endpoint's `description` in the generated
    # `openapi.yaml` — a consumer-facing contract, not a place for internal
    # mechanics. Anything about logging or context belongs in a comment like this
    # one, which the generator never reads.
    #
    # Both identities go into the ambient log context rather than onto each
    # `extra=`: they are shared-context fields (both are in `_ALLOWED_KEYS`, see
    # `shared/logging/log_context.py`), so every line emitted below carries them,
    # not just the ones that name them. This route is the one place they arrive in
    # the BODY instead of the `x-user-id` header, so nothing upstream in the
    # request pipeline can seed them.
    #
    # `merge`, not `set`: `set_log_context` REPLACES the context, which would drop
    # the `request_id` the middleware seeded — the field the whole cross-service
    # correlation hangs on.
    #
    # `deleted_count` deliberately does NOT travel this way: `_clean` silently
    # drops every key outside `_ALLOWED_KEYS`, so a count merged into the context
    # would vanish with no error. It stays on the log call's own `extra=`.
    #
    # The merge is visible to the lines below because a sync handler and its own
    # logging run on the same threadpool worker. It does NOT reach uvicorn's
    # access line (the threadpool gets a COPY of the request context — see
    # `shared/http/log_identity.py`), which is the accepted limit here: the
    # cascade's caller is a service, not a user session, and the flow lines this
    # handler writes are the ones an operator reads.
    merge_log_context(cognito_sub=body.cognito_sub, user_id=body.user_id)

    # One INTERNAL span for the flow, carrying the same fields its log lines do.
    # The `reason` on the failure branch is set beside the log call, with the SAME
    # token, so the two cannot drift.
    with workflow_span(
        "internal_delete_by_user",
        app_event="internal_delete_by_user_started",
        cognito_sub=body.cognito_sub,
        user_id=body.user_id,
    ) as span:
        logger.info(
            "internal_delete_by_user_started",
            extra={"app_event": "internal_delete_by_user_started"},
        )

        try:
            deleted = delete_by_user(
                session, cognito_sub=body.cognito_sub, user_id=body.user_id
            )
        except Exception:
            # A fault here aborts the whole deletion: Users calls both cascade legs
            # BEFORE touching the account, so a 500 from us leaves the caller's
            # account alive and their Orders data already swept — recoverable only
            # because a retry re-runs Orders as a no-op. Without this branch the
            # 500 carried no `*_failed`, no reason and no span attribute at all —
            # the one outcome that most needs to be findable was the only silent
            # one. Re-raised untouched, so the HTTP contract is unchanged.
            span.set_attribute("reason", DB_ERROR_REASON)
            logger.warning(
                "internal_delete_by_user_failed",
                extra={
                    "app_event": "internal_delete_by_user_failed",
                    "reason": DB_ERROR_REASON,
                },
            )
            raise

        span.set_attribute("app_event", "internal_delete_by_user_succeeded")
        span.set_attribute("deleted_count", deleted)

        logger.info(
            "internal_delete_by_user_succeeded",
            extra={
                "app_event": "internal_delete_by_user_succeeded",
                "deleted_count": deleted,
            },
        )
        return InternalDeleteByUserResponse(deleted=deleted)
