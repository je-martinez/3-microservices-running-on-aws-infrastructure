"""TestMode automatic progression (JE-95).

When `POST /v1/trackings/init-tracking` is called with `x-test-mode: true`, the new
tracking advances one status every 10 seconds until it is `DELIVERED`:

    t=0s   PLACED            (written by the create itself)
    t=10s  PROCESSING
    t=20s  SHIPPED
    t=30s  OUT_FOR_DELIVERY
    t=40s  DELIVERED

leaving five `tracking_history` rows in total, per the design's table.

## !! KNOWN LIMITATION — progression does NOT survive a process restart !!

This is an **in-process `asyncio` task**, chosen deliberately over a persistent
scheduler (APScheduler/Celery/a database queue). The trade-off was accepted
explicitly, and it is this:

    If the process restarts mid-progression — a docker-watch rebuild, a redeploy,
    a crash, a container reschedule — the pending task is LOST. The tracking stays
    frozen at whatever status it had reached, forever. Nothing retries it, nothing
    resumes it, and no error is reported anywhere.

A tracking stuck at `PROCESSING` after a rebuild is therefore **expected
behaviour**, not a bug to investigate. The only recovery is to create a new
TestMode tracking, or to drive the remaining transitions by hand through
`PUT /v1/trackings/{orderId}/status`.

This is acceptable because TestMode exists solely to exercise the delivery flow in
E2E tests: the whole progression lasts 40 seconds, nothing downstream depends on it
completing, and a real carrier's updates arrive through the PUT endpoint, which is
persistent. Paying for a durable scheduler — a new dependency, a new table, a
poller, its own failure modes — to make a 40-second test fixture restart-proof is
not a trade this service wants.

## Who starts it, and from where

`api/init_tracking_router.py`, from Starlette's background-task hook — after the
response, and therefore after the creating write session has committed. That
handler is `async def`, so it is already ON uvicorn's event loop and can
`asyncio.create_task` this coroutine directly.

That directness is recent. Creation used to be a gRPC RPC running on a
`grpc.server` **thread pool** (threads, not `grpc.aio`, because pymysql blocks), and
a thread-pool worker has no running event loop: `asyncio.create_task` there raised
`RuntimeError: no running event loop`, and `asyncio.run()` would have blocked the
RPC for the full 40 seconds. That needed a bridge —
`asyncio.run_coroutine_threadsafe` onto a loop published at FastAPI startup — plus
the "no loop registered" failure mode that came with it. JE-108 removed the gRPC
server, and the bridge went with it: there is now exactly one caller, and it is
already on the loop.

## Each transition reuses the PUT endpoint's path

`advance_once` calls `update_tracking_status`, the very same command handler behind
`PUT /v1/trackings/{orderId}/status`. Not a parallel implementation: the state
machine's guards, the history row, the `datetime_` bump and the `expire(history)`
fix all live there, and a second copy is how the two paths start disagreeing about
what a transition means. The only difference is the audit actor
(`TEST_MODE_PROGRESSION` vs `CARRIER_STATUS_UPDATE`), which is what makes an
automatic run identifiable from `tracking_history.created_by` after the fact.

Each step opens its **own** write session. The creating request's session was
committed and closed long before t=10s, so it cannot be reused; holding one open
across 40 seconds of sleeping would pin a pooled connection for the whole run.

`advance_once` reads the tracking **unscoped** — no `cognito_sub`. That is correct
here and only here: there is no caller to scope by, and the order id came from a
tracking this process just created rather than from a request.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager

from sqlalchemy.orm import Session

from src.features.tracking.commands.update_status import (
    TrackingNotFoundError,
    UpdateTrackingStatusCommand,
    update_tracking_status,
)
from src.features.tracking.domain.repository import TrackingRepository
from src.features.tracking.domain.status import (
    InvalidTransitionError,
    next_status,
    parse_status,
)
from src.shared.audit.audit_actor import AuditActor
from src.shared.db.engine import write_session

logger = logging.getLogger(__name__)

#: Seconds between automatic transitions. The design's table is explicit: t=10s,
#: t=20s, t=30s, t=40s. Tests override it via the `interval` parameter rather than
#: monkeypatching this, so the suite runs in milliseconds while production keeps
#: the real cadence.
DEFAULT_INTERVAL_SECONDS = 10.0

#: A `with`-able session factory, e.g. `shared.db.engine.write_session`.
SessionFactory = Callable[[], AbstractContextManager[Session] | Iterator[Session]]


def advance_once(
    session: Session, order_id: str
) -> str | None:
    """Advance one tracking by exactly one status. Returns the new status, or None.

    `None` means **stop the progression**, and it covers every reason a run should
    end — reaching `DELIVERED`, the tracking having been deleted, or another writer
    having already moved it somewhere this step may not follow. The caller does not
    need to distinguish them, which is what keeps the loop below simple.

    The transition itself goes through `update_tracking_status`, exactly as the
    carrier PUT does; only the audit actor differs.
    """
    tracking = TrackingRepository(session).get_by_order_id(order_id)
    if tracking is None:
        # Soft-deleted (or never there) between two ticks. Not an error: the
        # progression is a fixture, and the row it was animating is gone.
        return None

    upcoming = next_status(parse_status(tracking.status))
    if upcoming is None:
        # Already terminal — either this run finished, or a carrier PUT delivered
        # it first. Either way there is nothing left to do.
        return None

    update_tracking_status(
        session,
        UpdateTrackingStatusCommand(order_id=order_id, status=upcoming.value),
        actor=AuditActor.TEST_MODE_PROGRESSION,
    )
    return upcoming.value


async def run_progression(
    order_id: str,
    *,
    interval: float = DEFAULT_INTERVAL_SECONDS,
    writer: SessionFactory = write_session,
    sleep: Callable[[float], object] = asyncio.sleep,
) -> None:
    """Sleep-then-advance until the tracking is delivered or the run must stop.

    Runs on the FastAPI event loop. The database work inside each step is BLOCKING
    (pymysql), so it is pushed to a worker thread with `asyncio.to_thread` — doing
    it inline would stall the loop, and therefore the health check and every REST
    handler, for the duration of the write.

    ## Why nothing here can escape

    The body is wrapped so that no exception ever propagates out of the background
    task. An unretrieved exception in a fire-and-forget `asyncio` task surfaces only
    as a "Task exception was never retrieved" warning at garbage-collection time —
    detached from the request that caused it and trivially missed. Every ending is
    therefore an explicit, logged one:

    * **`InvalidTransitionError`** — a carrier PUT (or anything else) moved the
      tracking while this run was sleeping, and the step is no longer legal. The
      state machine is the authority; the progression yields to it and stops. It
      does NOT retry: retrying a rejected forward-only transition can only be
      rejected again, forever.
    * **`TrackingNotFoundError`** — the tracking was deleted mid-run. Stop.
    * **`asyncio.CancelledError`** — re-raised, never swallowed: shutdown must
      remain able to cancel this task.
    * **Anything else** — logged as `*_failed` with a `reason`, then the run ends.
      A TestMode fixture must not be able to take a handler thread or the loop down
      with it.
    """
    logger.info(
        "test_mode_progression_started",
        extra={
            "app_event": "test_mode_progression_started",
            "order_id": order_id,
            "interval_seconds": interval,
        },
    )
    try:
        while True:
            await sleep(interval)

            def step() -> str | None:
                # A fresh session per transition: the creating request's session
                # is long closed, and holding one across the sleeps would pin a
                # pooled connection for the whole run.
                with writer() as session:
                    return advance_once(session, order_id)

            status = await asyncio.to_thread(step)
            if status is None:
                logger.info(
                    "test_mode_progression_succeeded",
                    extra={
                        "app_event": "test_mode_progression_succeeded",
                        "order_id": order_id,
                    },
                )
                return

            logger.info(
                "test_mode_progression_advanced",
                extra={
                    "app_event": "test_mode_progression_advanced",
                    "order_id": order_id,
                    "status": status,
                },
            )
    except asyncio.CancelledError:
        # Shutdown. Re-raised so cancellation keeps working; the tracking simply
        # stays where it is — see the KNOWN LIMITATION above.
        logger.info(
            "test_mode_progression_failed",
            extra={
                "app_event": "test_mode_progression_failed",
                "reason": "cancelled",
                "order_id": order_id,
            },
        )
        raise
    except (InvalidTransitionError, TrackingNotFoundError) as exc:
        reason = (
            exc.reason.value
            if isinstance(exc, InvalidTransitionError)
            else "tracking_not_found"
        )
        logger.info(
            "test_mode_progression_failed",
            extra={
                "app_event": "test_mode_progression_failed",
                "reason": reason,
                "order_id": order_id,
            },
        )
    except Exception:  # noqa: BLE001 - a background task must never die silently
        logger.exception(
            "test_mode_progression_failed",
            extra={
                "app_event": "test_mode_progression_failed",
                "reason": "unexpected_error",
                "order_id": order_id,
            },
        )
