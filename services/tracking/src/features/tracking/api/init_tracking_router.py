"""`POST /v1/trackings/init-tracking` — tracking creation (JE-105).

**The** way a tracking comes into existence. It replaced a gRPC `CreateTracking`
RPC, which was removed in JE-108; both called the SAME command handler
(`commands/create_tracking.create_tracking`), which is why the transport could be
swapped out without touching what creation means.

## Its own router, like the carrier PUT

A third router under `/v1/trackings`, for the reason the carrier PUT has a second:
it does not share a dependency set with anything else on that prefix. This and the
reads both take `IdentifiedCaller` (a sub AND the resolved `usr_` id, one gRPC
call), but they part company on what a failed resolution means — on a read it is
ignorable enrichment, here it is a `404` — and the carrier PUT must never acquire
any identity dependency at all. Keeping the three apart means none of them can
inherit a dependency by being edited next to code that has one.

The resolution itself now happens in `stamp_caller_user_id`
(`shared/http/log_identity.py`), before this handler runs, so that every log line
of the request carries `user_id` rather than only the ones emitted after the
handler resolved it. That dependency swallows failures — it is enrichment — so
this handler still calls `resolve_internal_user_id()` itself, off the cached
result, and still turns `UnknownUserError` into the `404` below.

## Identity: the header, never the body

The body carries `order_id` and `shipping_address` — no identity at all (see
`InitTrackingRequest`). The caller comes from `x-user-id`, which the gateway sets
from a verified Cognito JWT, and the handler persists BOTH identities:

* `cognito_sub` — the header value verbatim, and **the ownership key** the REST
  reads filter by (`services/tracking/CLAUDE.md` §5b).
* `user_id` — the internal `usr_` id, resolved from that sub through Users over
  gRPC (`Caller.resolve_internal_user_id()`).

Persisting only one would break something silently: without `cognito_sub` the
tracking is unreadable by its own owner; without `user_id` it is missing the
reporting/join key every other row has, on a NOT NULL column.

The removed gRPC path took `user_id` on the wire instead, which was sound there —
its caller was Orders behind an `x-api-key`, asserting an id it had already
resolved. Here the caller is an end user, so the service resolves it itself; a
`user_id` the client supplied would be an unauthenticated claim.

## The `x-e2e-source` header

A second harness header alongside `x-test-mode`, and it does something different:
`x-test-mode` drives a runtime behaviour, this one LABELS the row. A request
sending `x-e2e-source: true` **to a service with `E2E_TESTING_ENABLED` on** creates
its tracking tagged `"E2E Source"`, which is the exact predicate `DELETE
/v1/trackings/e2e-cleanup` deletes by.

The conjunction is the security half and is evaluated inside the dependency, not
here: without it any client could tag its own rows by sending one header, enlisting
them for deletion by somebody else's teardown. Orders forwards this header the same
way it already forwards `x-test-mode`, so a fixture created through the Orders flow
is tagged too.

## Status codes

| Outcome | Code | Why |
|---|---|---|
| Created | 201 | With the tracking at `PLACED` and its one history row |
| Missing/empty `x-user-id` | 401 | No credential at all — inherited from `CallerSub` |
| Users does not know the sub | 404 | See below |
| Already has a tracking | 409 | One tracking per order; the existing one is untouched |
| Malformed body | 422 | FastAPI/Pydantic, before the handler runs |

### Why an unresolvable sub is `404` and not `401` or `422`

The sub is a **verified** credential by the time it reaches here: the gateway
validated the JWT's signature and issuer, so the caller has authenticated
successfully. What failed is a lookup — Users has no record for a person Cognito
vouches for. `401` would tell the client to re-authenticate, which cannot help:
the same valid token will produce the same missing record forever, so the client
would loop.

`422` is wrong for a different reason: nothing about the request is malformed. The
body validated, the header was present and well-formed. `422` would point the
client at input it cannot fix — the failing value is not even in the request it
sent.

`404` says the accurate thing: a resource this operation depends on — the user —
does not exist. That is also exactly how Orders answers the identical situation on
`POST /v1/orders` (`UnknownUserException` → `Results.NotFound(new { error =
"unknown_user" })`), and the two services facing the same condition should not
teach clients two different codes. The body carries `reason: "unknown_user"` so it
is distinguishable from any other `404`.

Worth being precise about who this affects: the caller is a real, authenticated end
user (or Orders propagating one), so in practice this fires when Users' record was
deleted or never created — a genuine data gap, not an attack. And it is `NOT_FOUND`
specifically: `users_client.resolve` maps ONLY that status to `None`, so a Users
outage propagates as an `RpcError` and a `500`, never as "this user doesn't exist".
A `404` here can never be an outage in disguise.

## The handler is `async def` — the exception on this surface

Every other DB-touching handler in this service is a plain `def` run in FastAPI's
threadpool, because pymysql blocks. This one is `async def` with the blocking work
pushed into `asyncio.to_thread`, which is the same net effect (the blocking call
happens on a worker thread, the loop stays free) reached from the other direction.

The reason to reach it from this direction is TestMode. Progression is an asyncio
task, and scheduling it needs a running loop. A `def` handler has none — it IS a
threadpool worker — which is exactly why the old gRPC creation path needed a
`run_coroutine_threadsafe` bridge onto a loop published at startup. An `async def`
handler is already ON that loop, so `asyncio.create_task` works directly: no
registration, no cross-thread handoff, no "no loop registered" failure mode. That
bridge was deleted with the gRPC server (JE-108) — this is the only creation path
left, and it never needed one.

The one subtlety is *when* to start it: not inline in the handler, but from
Starlette's background-task hook, which runs after the response and therefore after
the write session has committed. The handler body explains what goes wrong
otherwise — it is a race the progression always loses.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy.orm import Session

from src.features.tracking.api.schemas import (
    ErrorResponse,
    InitTrackingRequest,
    InitTrackingResponse,
    TrackingResponse,
)
from src.features.tracking.commands.create_tracking import (
    CreateTrackingCommand,
    TrackingAlreadyExistsError,
    create_tracking,
)
from src.features.tracking.commands.test_mode_progression import (
    DEFAULT_INTERVAL_SECONDS,
    SessionFactory,
    run_progression,
)
from src.shared.db.engine import write_session
from src.shared.http.caller import CurrentCaller, UnknownUserError
from src.shared.http.dependencies import WriteSession
from src.shared.http.e2e_source import E2eSource
from src.shared.http.log_identity import IdentifiedCaller
from src.shared.http.test_mode import TestMode
from src.shared.logging import merge_log_context

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/trackings", tags=["trackings"])


@dataclass(frozen=True, slots=True)
class ProgressionConfig:
    """How a TestMode run started from this endpoint is configured.

    Two reasons this is injectable at all:

    * **The interval must be injectable.** Production runs the design's 10s cadence;
      a test that actually waited 40 seconds for a five-status run would be deleted
      or skipped, and either way the feature would stop being covered. Tests
      override this with a near-zero value.
    * **The progression needs its OWN session factory.** Each transition fires long
      after the creating request's session is closed, so it opens a session per step
      — which means the test suite has to be able to point those at the test engine,
      exactly as it does for the request's own session.

    A dependency rather than parameters on the router because a router is
    constructed at import time, before any test can reach it, while a dependency is
    overridable per app (`app.dependency_overrides`) — the seam every other
    test-visible piece of this service already uses.
    """

    interval: float = DEFAULT_INTERVAL_SECONDS
    writer: SessionFactory = write_session


def get_progression_config() -> ProgressionConfig:
    """Production defaults: the design's 10s cadence on the real writer engine."""
    return ProgressionConfig()


Progression = Annotated[ProgressionConfig, Depends(get_progression_config)]

#: `reason` for the `404` produced by a sub Users has no record for. The same token
#: Orders returns for the identical condition on `POST /v1/orders`.
UNKNOWN_USER_REASON = "unknown_user"

#: `reason` for the `409`. Names the RULE, not the mechanism — a caller should not
#: have to know a unique index is involved.
ALREADY_EXISTS_REASON = "tracking_already_exists"


@router.post(
    "/init-tracking",
    status_code=status.HTTP_201_CREATED,
    summary="Create the tracking for one of the caller's orders",
    responses={
        401: {"description": "Missing or empty x-user-id"},
        404: {"model": ErrorResponse, "description": "Users has no such user"},
        409: {
            "model": ErrorResponse,
            "description": "The order already has a tracking",
        },
    },
)
async def init_tracking(
    caller: IdentifiedCaller,
    session: WriteSession,
    payload: InitTrackingRequest,
    test_mode: TestMode,
    e2e_source: E2eSource,
    progression: Progression,
    background: BackgroundTasks,
) -> InitTrackingResponse:
    """Create a tracking at `PLACED` with its first history row, in one transaction.

    The whole blocking part — the Users gRPC resolution and both INSERTs — runs in
    one `asyncio.to_thread` call rather than two. Splitting them would hop threads
    twice for no benefit, and would put the resolution outside the block the write
    session covers.

    Never logs `payload.shipping_address`: it is PII ([[logging-context]]). The
    success line carries `order_id`, `user_id`, `cognito_sub` and `tracking_id`,
    all of which are shared-context fields.
    """
    # Into the ambient context so every later line of this request carries it,
    # including uvicorn's access line and anything logged deeper in the stack.
    merge_log_context(order_id=payload.order_id)

    try:
        tracking, user_id = await asyncio.to_thread(
            _resolve_and_create, caller, session, payload, e2e_source
        )
        # Merged HERE, after the await, not inside `_resolve_and_create`:
        # asyncio.to_thread COPIES the context, so a merge in that thread would
        # be discarded on return. The resolved values come back as values, which
        # is what makes this the correct place. Same class of trap as Prisma's
        # lazy promises in Users ([[prisma-lazy-promise-breaks-als]]).
        #
        # `user_id` is already in context (`IdentifiedCaller` put it there before
        # this handler ran, which is what gets it onto the EARLIER lines too);
        # re-merging the identical value is a no-op kept for the case where that
        # resolution failed quietly and this one — off the same cache — did not.
        # `tracking_id` genuinely only exists here.
        merge_log_context(user_id=user_id, tracking_id=tracking.id)
    except UnknownUserError as exc:
        # Authenticated, but Users has no record. See the module docstring for why
        # this is a 404 rather than a 401 or a 422.
        _log_failure(payload.order_id, UNKNOWN_USER_REASON, caller.cognito_sub)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_error(str(exc), UNKNOWN_USER_REASON),
        ) from exc
    except TrackingAlreadyExistsError as exc:
        # Either the pre-check found one or the unique index rejected a racing
        # INSERT — the command raises the same exception for both, which is what
        # keeps a lost race a 409 instead of a 500. The existing tracking is
        # untouched either way: this request wrote nothing that survived.
        _log_failure(payload.order_id, ALREADY_EXISTS_REASON, caller.cognito_sub)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_error(str(exc), ALREADY_EXISTS_REASON),
        ) from exc

    logger.info(
        "init_tracking_succeeded",
        extra={
            "app_event": "init_tracking_succeeded",
            "order_id": payload.order_id,
            "tracking_id": tracking.id,
            "user_id": user_id,
            "cognito_sub": caller.cognito_sub,
            "test_mode": test_mode,
        },
    )

    if test_mode:
        # Handed to Starlette's background-task hook rather than started here, and
        # the ordering is the whole reason.
        #
        # At this point the tracking is written but NOT committed: `get_write_session`
        # is a generator dependency, so its commit runs during teardown — after this
        # handler returns. Starting the progression here would race that commit, and
        # the progression would lose: its first step opens its OWN session, and a
        # session that begins before the creating transaction commits sees no
        # tracking, so `advance_once` returns None and the run ends immediately at
        # PLACED. Verified, not theoretical — it is exactly what happened while this
        # endpoint scheduled with a bare `create_task`, and it is invisible unless a
        # test asserts the tracking actually advanced.
        #
        # A background task, by contract, runs after the response is sent, which is
        # after dependency teardown — so the row is committed before the first tick.
        #
        # !! KNOWN LIMITATION, EXPLICITLY ACCEPTED !!
        # In-process asyncio task: a process restart mid-progression loses it and
        # the tracking freezes at whatever status it reached, with no recovery and
        # no error. Expected, not a bug — full reasoning in
        # `commands/test_mode_progression.py`.
        background.add_task(_schedule_progression, payload.order_id, progression)

    return InitTrackingResponse(
        tracking=TrackingResponse.from_entity(tracking, tracking.history)
    )


def _resolve_and_create(
    caller: CurrentCaller,
    session: Session,
    payload: InitTrackingRequest,
    e2e_source: bool,
) -> tuple[object, str]:
    """The blocking half: resolve the caller, then write. Runs on a worker thread.

    Order matters. The resolution happens FIRST, so an unknown user costs no write
    at all — attempting the INSERT first would leave the pre-check and the unique
    index consumed by a request that was always going to fail.

    Returns the tracking together with the resolved `usr_` id so the caller can log
    it without re-reading `caller.resolved_internal_user_id` (which would be
    correct here, but only by luck of ordering).
    """
    # THE network call on this path, and the only one. Raises `UnknownUserError`
    # for a sub Users does not know; anything else (Users down, deadline) escapes
    # as an RpcError -> 500, deliberately: an outage must never read as
    # "this user doesn't exist" and write a row attributed to nobody.
    user_id = caller.resolve_internal_user_id()

    result = create_tracking(
        session,
        CreateTrackingCommand(
            order_id=payload.order_id,
            user_id=user_id,
            # The header value verbatim — the ownership key for every user-scoped
            # read. Non-empty by construction: `CallerSub` 401s on "" (nginx sends
            # that for a missing/malformed token), so this can never store the
            # empty string a stray caller could later match on.
            cognito_sub=caller.cognito_sub,
            shipping_address=payload.shipping_address or None,
            # Already the AND of the header and `E2E_TESTING_ENABLED` — the
            # dependency evaluates both, so this handler cannot tag a row on the
            # header alone. See `shared/http/e2e_source.py`.
            e2e_source=e2e_source,
            # Not consumed here — the handler schedules the progression itself, on
            # the loop it is already running on. Passed so the command's contract
            # is identical on both transports.
            test_mode=False,
        ),
    )
    # Touch the history inside the session, while the entity is still attached and
    # loadable: the response is rendered after this thread returns, and by then the
    # write session may be committed.
    _ = result.tracking.history
    return result.tracking, user_id


async def _schedule_progression(order_id: str, config: ProgressionConfig) -> None:
    """Start TestMode progression on the CURRENT event loop.

    ## Why this is `async def` and does almost nothing

    Starlette decides where a background task runs by inspecting it: an `async def`
    is awaited **on the event loop**, while a plain `def` is pushed to a worker
    thread. A `def` here would therefore land somewhere with no running loop and
    `asyncio.create_task` would raise `RuntimeError: no running event loop` — the
    same wall the removed gRPC servicer hit, arrived at from a different direction.
    So this is `async def` purely to be on the loop.

    And it must not `await run_progression` itself: Starlette runs background tasks
    *before* the connection is released, so awaiting would hold that connection open
    for the whole 40-second run. `create_task` hands the coroutine to the loop and
    returns immediately, which is the behaviour a fixture that outlives its request
    needs.

    No cross-thread scheduling helper in sight, either. One existed for the gRPC
    servicer, to reach uvicorn's loop from a thread pool that had none; here the
    loop is the one we are standing on, so such a handoff would be a detour carrying
    a failure mode ("no loop registered") that cannot occur on this path. It was
    deleted along with the servicer (JE-108) — do not reintroduce it.

    The task reference is deliberately dropped. `run_progression` is written so
    nothing escapes it, which is what makes that safe — see its docstring.
    """
    asyncio.create_task(  # noqa: RUF006 - fire-and-forget by design; see above
        run_progression(order_id, interval=config.interval, writer=config.writer)
    )


def _error(detail: str, reason: str) -> dict[str, str]:
    """Build the failure body.

    Emitted through `HTTPException(detail=...)`, so FastAPI renders it as
    `{"detail": {"detail": ..., "reason": ...}}` — nested, unlike the carrier PUT's
    flat `ErrorResponse`. Kept that way on purpose: flattening would mean a second
    custom exception + handler pair, and the nesting is what FastAPI's own
    `HTTPException` contract produces for a structured detail. The `reason` token
    is the point, and it is reachable either way.
    """
    return ErrorResponse(detail=detail, reason=reason).model_dump()


def _log_failure(order_id: str, reason: str, cognito_sub: str) -> None:
    """Emit the `*_failed` event with its machine-readable reason.

    No `user_id`: on both failure paths it is either unresolvable or irrelevant,
    and the convention omits unknown fields rather than logging null. Never logs
    the shipping address.
    """
    logger.warning(
        "init_tracking_failed",
        extra={
            "app_event": "init_tracking_failed",
            "reason": reason,
            "order_id": order_id,
            "cognito_sub": cognito_sub,
        },
    )
