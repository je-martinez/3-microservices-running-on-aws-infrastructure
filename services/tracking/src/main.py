"""The application factory and process entrypoint (Phase D).

`uvicorn src.main:app` — the command declared in `services/tracking/CLAUDE.md`.

## gRPC and HTTP in ONE process

Tracking serves two transports: FastAPI over `PORT` and gRPC over `GRPC_PORT`. They
run in the same container, and the seam for that was built in Phase C — see the
module docstring of `shared/grpc/server.py`:

    uvicorn runs the FastAPI app on PORT (it owns the main thread / event loop)
    ^ the gRPC server runs alongside on GRPC_PORT, on its own ThreadPoolExecutor

`serve()` binds, starts and **returns without blocking**, so the lifespan below
starts it, holds the handle, and stops it on shutdown. The blocking variant is the
separately-named `serve_forever()`, used only by `shared/grpc/server.py`'s
standalone `__main__` — it can never be reached from here, which is the whole point
of the two functions being distinct.

The gRPC server is a thread-pool server, not `grpc.aio`, because the database layer
is blocking pymysql — a blocking DBAPI call inside an asyncio servicer would stall
the event loop uvicorn is running on. For the same reason every database-touching
HTTP handler is a plain `def` (FastAPI runs those in a threadpool) rather than
`async def`.

## Three routers, three auth schemes

Registered separately and deliberately: `health_router` declares no auth,
`trackings_router` requires the gateway-injected `x-user-id` per handler, and
`carrier_router` declares the carrier key at the router level. Nothing is
authenticated by a global middleware, so no route can be accidentally exempted by
an allowlist — and, critically, the carrier PUT cannot inherit an `x-user-id`
requirement it must not have.
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from src.features.tracking.api import carrier_router, health_router, trackings_router
from src.features.tracking.api.errors import (
    RejectedStatusUpdate,
    rejected_status_update_handler,
)

logger = logging.getLogger(__name__)

#: Set to "0"/"false" to build the app WITHOUT the gRPC server. Tests use it: the
#: HTTP suite has no business binding a second port (and would fail when one is
#: already taken), and the gRPC surface has its own suite that binds an ephemeral
#: port of its own.
GRPC_ENABLED_ENV = "TRACKING_GRPC_ENABLED"

_FALSEY = {"0", "false", "no", "off"}


def grpc_enabled() -> bool:
    """Whether the lifespan should start the gRPC server. Default: yes."""
    return os.getenv(GRPC_ENABLED_ENV, "1").strip().lower() not in _FALSEY


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Start the gRPC server alongside HTTP, and stop it on shutdown.

    Imported lazily, inside the function, so that merely importing this module does
    not pull in the gRPC stack (and, through settings, require a valid environment).
    That keeps `create_app()` usable in a test process that only wants the HTTP
    surface.

    A failure to bind is NOT swallowed: `serve()` raises when
    `add_insecure_port` returns 0, and letting that propagate out of startup aborts
    the process. A container that serves HTTP while its gRPC port is silently dead
    would pass its health check and fail every call from Orders.
    """
    if not grpc_enabled():
        logger.info(
            "grpc_server_disabled",
            extra={"app_event": "grpc_server_disabled"},
        )
        yield
        return

    from src.shared.grpc.server import serve

    server = serve()
    try:
        yield
    finally:
        # A short grace period lets an in-flight RPC finish rather than being cut
        # mid-write; `stop` returns immediately and the event is waited on.
        server.stop(grace=5).wait()
        logger.info(
            "grpc_server_stopped",
            extra={"app_event": "grpc_server_stopped"},
        )


def create_app() -> FastAPI:
    """Build the FastAPI application.

    A factory rather than a module-level singleton so tests can build an app with
    overridden dependencies (sessions bound to the test engine, a test carrier key)
    without touching the process-wide one.
    """
    app = FastAPI(
        title="Tracking Service API",
        version="1.0.0",
        lifespan=lifespan,
    )

    app.add_exception_handler(RejectedStatusUpdate, rejected_status_update_handler)

    app.include_router(health_router.router)
    # Reads first, then the carrier PUT. They share the `/v1/trackings` prefix but
    # not a single dependency — see each router's docstring.
    app.include_router(trackings_router.router)
    app.include_router(carrier_router.router)

    return app


app = create_app()
