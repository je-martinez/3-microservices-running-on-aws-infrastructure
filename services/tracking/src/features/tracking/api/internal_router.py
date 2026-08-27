"""Internal service-to-service routes.

Not published on the API Gateway and never reached by an end user: the only caller
is Users' `DELETE /v1/users/me`, authenticating with the shared internal key.

Registered BEFORE `trackings_router` in `main.py` because `/by-user` is a literal
segment sitting exactly where that router's `/{order_id}` path parameter also
matches. Starlette matches in declaration order, so the literal must be declared
first — the same reasoning that governs `/init-tracking` and `/e2e-cleanup`.

`def`, not `async def`: pymysql blocks, so a sync handler runs in the threadpool
instead of stalling the event loop.

Besides the rows, the deletion clears the user's cache footprint — every response
entry of theirs plus their `cognito_sub -> user_id` identity mapping — scheduled
as a `BackgroundTask` so it can only run once the write has committed. See the
comment on that line, and `shared/cache/invalidation.invalidate_user`.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks

from src.features.tracking.api.schemas import (
    InternalDeleteByUserRequest,
    InternalDeleteByUserResponse,
)
from src.features.tracking.commands.delete_by_user import delete_by_user
from src.shared.cache.invalidation import invalidate_user
from src.shared.http.cache_dependencies import CacheEnabledDep, CacheGatewayDep
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
    background: BackgroundTasks,
    cache: CacheGatewayDep,
    cache_enabled: CacheEnabledDep,
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

        # ---------------------------------------------------------------
        # Cache eviction is SCHEDULED, not executed here — the same ordering
        # problem the carrier webhook has, solved the same way rather than with
        # a second pattern for one problem.
        #
        # This handler does not own the transaction: `WriteSession` is a
        # GENERATOR dependency over `write_session()`, whose body commits in its
        # TEARDOWN, after the handler has returned. Evicting at this line would
        # therefore run BEFORE the commit, opening the stale-repopulation window
        # the design forbids: a concurrent read misses, queries MySQL, still sees
        # the not-yet-deleted rows (its transaction cannot see an uncommitted
        # change), and writes that soon-to-be-wrong body back under the key just
        # cleared. A `BackgroundTask` runs after the response is sent, which is
        # after every dependency teardown, which is after `session.commit()`.
        #
        # The identities are read HERE, as `add_task` ARGUMENTS, so they are
        # plain strings by the time the session is gone — the webhook's rule
        # about never handing a detached ORM entity to a background task. They
        # come off the request BODY on this route (§5b: it is the one place the
        # two identities arrive in the body rather than the `x-user-id` header),
        # which is the same pair the cache keys embed.
        #
        # The failure branch above raises out of the handler, so this line is
        # unreachable on a fault and no eviction is scheduled for a deletion that
        # never landed — structural, rather than a status check to keep in sync.
        #
        # `invalidate_user` never raises, and that is load-bearing rather than
        # merely tidy: the deletion has already COMMITTED, so a Redis outage that
        # failed the response would tell Users the cascade did not happen when it
        # did, and fail the whole account deletion for the person.
        if cache_enabled:
            background.add_task(
                invalidate_user,
                cache,
                cognito_sub=body.cognito_sub,
                user_id=body.user_id,
            )

        logger.info(
            "internal_delete_by_user_succeeded",
            extra={
                "app_event": "internal_delete_by_user_succeeded",
                "deleted_count": deleted,
            },
        )
        return InternalDeleteByUserResponse(deleted=deleted)
