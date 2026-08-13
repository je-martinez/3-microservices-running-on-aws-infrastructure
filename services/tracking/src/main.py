"""The application factory and process entrypoint (Phase D).

`uvicorn src.main:app` — the command declared in `services/tracking/CLAUDE.md`.

## One transport: HTTP

Tracking serves FastAPI over `PORT` and nothing else. It used to run a gRPC server
alongside on `GRPC_PORT`; that surface was removed in JE-108 once creation moved to
`POST /v1/trackings/init-tracking` and the two unscoped reads were replaced by the
user-scoped REST ones. The one gRPC left in the service points the other way — the
OUTBOUND client to Users (`shared/grpc/users_client.py`), which needs no server and
no lifespan hook.

Every database-touching HTTP handler is a plain `def` rather than `async def`,
because the database layer is blocking pymysql and FastAPI runs `def` handlers in a
threadpool. `POST /init-tracking` is the deliberate exception — see its router.

## Five routers, three auth schemes — and one of them is conditional

Registered separately and deliberately: `health_router` declares no auth,
`trackings_router` and `init_tracking_router` both require the gateway-injected
`x-user-id` per handler and resolve the caller through Users, and `carrier_router`
declares the carrier key at the router level. Nothing is authenticated by a global
middleware, so no route can be accidentally exempted by an allowlist — and,
critically, the carrier PUT cannot inherit an `x-user-id` requirement it must not
have, nor the outbound call to Users that comes with one.

The fifth, `e2e_router`, is included **only** when `E2E_TESTING_ENABLED` — the same
flag and the same shape Users and Orders use for their own cleanup routes. In a
production runtime the route is not registered, so it 404s like any path that was
never written. It is the one route under `/v1/trackings` that requires **no**
caller identity, deliberately: the harness's teardown runs globally with no user
session, and what it deletes is selected by the `"E2E Source"` tag rather than by
an owner (see that router).

Creation lives in its own router rather than beside the reads because it treats a
failed resolution differently: for a read the `usr_` id is log enrichment and its
absence is ignorable, while creation cannot persist a row without it and answers
`404`. Keeping them apart is what stops one of those two meanings leaking into the
other.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI

from src.features.tracking.api import (
    carrier_router,
    e2e_router,
    health_router,
    init_tracking_router,
    trackings_router,
)
from src.features.tracking.api.errors import (
    RejectedStatusUpdate,
    rejected_status_update_handler,
)
from src.features.tracking.commands.publish_metrics import run_metrics_publisher
from src.shared.config.settings import (
    e2e_testing_enabled,
    metrics_enabled,
    metrics_interval_seconds,
)
from src.shared.http.log_context_middleware import LogContextMiddleware
from src.shared.logging import configure_logging

logger = logging.getLogger(__name__)


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Run the periodic metrics publisher for the lifetime of the process.

    GATED on `METRICS_ENABLED`, and that gate is load-bearing: `create_app()` is
    also called by `tests/conftest.py` for every REST test, and `TestClient`
    enters the lifespan — an ungated task would open a real database session and
    reach for CloudWatch on every test run. The suite sets `METRICS_ENABLED=false`
    process-wide.

    The flag and the interval are read straight from the environment rather than
    through `get_settings()`, for the same reason `e2e_testing_enabled()` is:
    `Settings()` raises on an incomplete environment, and the test suite builds
    the app without the DB/gRPC/carrier variables. Making startup depend on a
    fully-valid environment because of an observability task would be the tail
    wagging the dog.

    Cancelled on shutdown and awaited, so the task is actually finished before
    the process exits rather than left to surface as a "Task was destroyed but it
    is pending" warning.
    """
    task: asyncio.Task[None] | None = None

    if metrics_enabled():
        task = asyncio.create_task(
            run_metrics_publisher(interval=metrics_interval_seconds())
        )

    try:
        yield
    finally:
        if task is not None:
            task.cancel()
            # The loop re-raises CancelledError by design; awaiting it here is
            # what retrieves that outcome so it is never reported as an
            # unretrieved task exception.
            with suppress(asyncio.CancelledError):
                await task


def create_app() -> FastAPI:
    """Build the FastAPI application.

    A factory rather than a module-level singleton so tests can build an app with
    overridden dependencies (sessions bound to the test engine, a test carrier key)
    without touching the process-wide one.

    The `lifespan` starts exactly ONE thing: the periodic metrics publisher (see
    `_lifespan`). It is not a general startup hook — the gRPC server that used to
    be bound at startup is gone (JE-108), and with it the event-loop registration
    it needed, so TestMode progression is scheduled from an `async` handler that
    is already on uvicorn's loop and needs nothing published in advance.
    """
    # Before anything else, so no line escapes in uvicorn's plain-text default.
    # Structured JSON is what makes `order_id` / `user_id` filterable in the
    # dashboard: logs reach OpenObserve through Docker's fluentd driver, and a
    # line with no fields is a line no query can select on. See
    # shared/logging/json_formatter.py and [[logging-context]].
    # Read straight from the environment rather than through get_settings():
    # logging must not make app construction depend on a fully-valid Settings.
    # Tests build the app without the DB/Cognito variables, and failing to log
    # is never a reason to fail to start. Same default as Settings.
    configure_logging(
        service_name="tracking",
        deployment_environment=os.environ.get("DEPLOYMENT_ENVIRONMENT", "local"),
    )

    app = FastAPI(
        title="Tracking Service API",
        version="1.0.0",
        lifespan=_lifespan,
    )

    # Outermost: seeds the per-request log context so EVERY line of the request
    # carries the caller's identity, including lines emitted deep in a
    # repository that never sees the request. Pure ASGI, not
    # BaseHTTPMiddleware — see the module docstring for why that distinction
    # decides whether a mid-request merge is visible.
    app.add_middleware(LogContextMiddleware)

    app.add_exception_handler(RejectedStatusUpdate, rejected_status_update_handler)

    app.include_router(health_router.router)
    # Creation first, then the reads, then the carrier PUT. All three share the
    # `/v1/trackings` prefix and not a single dependency — see each router's
    # docstring.
    #
    # Creation is registered BEFORE the reads because `/init-tracking` is a literal
    # segment sitting where `trackings_router`'s `/{order_id}` path parameter also
    # matches. They do not actually collide today (different methods: POST vs GET),
    # but Starlette matches in declaration order, and declaring the literal first is
    # the habit that keeps that from mattering if either surface ever grows a method
    # the other already has.
    # The E2E teardown, BEFORE the reads for the same declaration-order reason as
    # creation: `/e2e-cleanup` is a literal segment where `/{order_id}` also
    # matches. Registered here — inside the `if` — rather than always-registered
    # and guarded per request, because a route that exists and answers 403 is
    # still a route: it appears in the OpenAPI document, it is probeable, and it
    # is one edited condition away from being live. Not existing is the stronger
    # guarantee, and it is what Orders and Users both do.
    #
    # The flag is read from the environment rather than through `get_settings()`:
    # constructing the app must not require a fully-valid environment (see
    # `e2e_testing_enabled`).
    if e2e_testing_enabled():
        # WARNING at startup, not INFO: in a deployed environment this line means
        # a mass soft-delete surface is live and someone should see it.
        logger.warning(
            "e2e_routes_enabled",
            extra={
                "app_event": "e2e_routes_enabled",
                "reason": "E2E_TESTING_ENABLED",
            },
        )
        app.include_router(e2e_router.router)

    app.include_router(init_tracking_router.router)
    app.include_router(trackings_router.router)
    app.include_router(carrier_router.router)

    return app


app = create_app()
