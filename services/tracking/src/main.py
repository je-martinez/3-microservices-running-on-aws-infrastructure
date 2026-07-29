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

## Four routers, three auth schemes

Registered separately and deliberately: `health_router` declares no auth,
`trackings_router` requires the gateway-injected `x-user-id` per handler,
`init_tracking_router` requires it too AND resolves the caller through Users, and
`carrier_router` declares the carrier key at the router level. Nothing is
authenticated by a global middleware, so no route can be accidentally exempted by
an allowlist — and, critically, the carrier PUT cannot inherit an `x-user-id`
requirement it must not have.

Creation lives in its own router rather than beside the reads because it needs a
strictly larger dependency set (`Caller`, which can make a gRPC call, versus
`CallerSub`, which never touches the network). Keeping them apart is what stops a
read from silently acquiring a per-request call to Users.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI

from src.features.tracking.api import (
    carrier_router,
    health_router,
    init_tracking_router,
    trackings_router,
)
from src.features.tracking.api.errors import (
    RejectedStatusUpdate,
    rejected_status_update_handler,
)

logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    """Build the FastAPI application.

    A factory rather than a module-level singleton so tests can build an app with
    overridden dependencies (sessions bound to the test engine, a test carrier key)
    without touching the process-wide one.

    No `lifespan`: there is nothing to start or stop. The gRPC server that used to
    be bound at startup is gone (JE-108), and with it the event-loop registration it
    needed — TestMode progression is now scheduled from an `async` handler that is
    already on uvicorn's loop, so nothing has to be published to it in advance.
    """
    app = FastAPI(
        title="Tracking Service API",
        version="1.0.0",
    )

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
    app.include_router(init_tracking_router.router)
    app.include_router(trackings_router.router)
    app.include_router(carrier_router.router)

    return app


app = create_app()
