"""The bridge from a SYNC gRPC handler to the process's async event loop (JE-95).

## The problem this solves

`CreateTracking` runs on a `grpc.server` **thread pool** — Phase C chose threads
over `grpc.aio` because pymysql is a blocking driver. TestMode progression, by
contrast, is an `asyncio` task (the mechanism chosen for JE-95). So a thread with no
event loop has to start a coroutine, and the two obvious moves both fail:

* `asyncio.create_task(...)` → `RuntimeError: no running event loop`. There is no
  loop in a gRPC worker thread.
* `asyncio.run(...)` → creates a loop and **blocks the worker for 30 seconds**,
  holding the RPC open while a test shipment is "delivered". Orders would time out.

## The solution

There already IS a loop in this process: uvicorn's, running the FastAPI app in the
main thread (see `src/main.py` — gRPC and HTTP share one container by design).
`asyncio.run_coroutine_threadsafe` is the stdlib API written for exactly this
situation: submit a coroutine to a loop owned by **another** thread, thread-safely,
returning immediately.

The loop cannot be discovered from the gRPC thread — `asyncio.get_event_loop()`
there does not find uvicorn's — so it is **registered** at FastAPI startup by the
lifespan and read back here. That also makes the dependency explicit and testable:
a test registers its own loop, or none at all.

## No loop registered = a logged no-op

Three real situations have no FastAPI loop: the standalone gRPC entrypoint
(`shared/grpc/server.py`'s `__main__`), a unit test constructing a servicer
directly, and the window before startup finishes. In all of them scheduling is
skipped with a `*_failed` log line carrying a `reason`, and **creation still
succeeds**. A tracking must never fail to be created because a test-only fixture
could not be started.

## Fire-and-forget, deliberately

The returned `concurrent.futures.Future` is dropped. Nothing awaits the
progression: the RPC has already answered Orders, and there is no caller left to
report to. `run_progression` is written so that no exception can escape it, which is
what makes discarding the future safe — see its docstring.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

logger = logging.getLogger(__name__)

#: The FastAPI/uvicorn event loop, registered at startup. Module-level rather than
#: passed around because the gRPC servicer is constructed before the loop exists —
#: `build_server()` runs at import/startup time, the loop only once uvicorn is up.
_loop: asyncio.AbstractEventLoop | None = None


def set_event_loop(loop: asyncio.AbstractEventLoop | None) -> None:
    """Register (or clear) the loop background work is submitted to.

    Called by the FastAPI lifespan: with the running loop on startup, and with
    `None` on shutdown so a late `CreateTracking` cannot submit to a closed loop.
    """
    global _loop
    _loop = loop


def get_event_loop() -> asyncio.AbstractEventLoop | None:
    """The registered loop, or None when the app is not running one."""
    return _loop


def spawn(coro: Coroutine[Any, Any, Any], *, app_event: str) -> bool:
    """Submit `coro` to the registered loop from ANY thread. Never raises.

    Returns True when the work was handed off, False when there was no usable loop
    (and the coroutine was closed, so it does not leak as a "never awaited"
    warning).

    `app_event` names the flow for the `*_failed` log line the logging convention
    requires on a failure — this helper is generic, so the caller supplies it.
    """
    loop = _loop
    if loop is None or loop.is_closed():
        # Close the coroutine explicitly: an un-awaited coroutine object emits a
        # RuntimeWarning at GC time, which `filterwarnings = error` would turn into
        # a confusing failure somewhere unrelated.
        coro.close()
        logger.info(
            f"{app_event}_failed",
            extra={"app_event": f"{app_event}_failed", "reason": "no_event_loop"},
        )
        return False

    try:
        # THE bridge — see the module docstring. Thread-safe by contract, returns
        # immediately, and the future is deliberately discarded.
        asyncio.run_coroutine_threadsafe(coro, loop)
    except RuntimeError:
        # The loop was closed between the check above and here (shutdown racing a
        # request). Nothing to do but record it; creation must still succeed.
        coro.close()
        logger.info(
            f"{app_event}_failed",
            extra={"app_event": f"{app_event}_failed", "reason": "loop_closed"},
        )
        return False

    return True
