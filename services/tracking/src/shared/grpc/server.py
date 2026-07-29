"""The gRPC server: build it, bind it, run it.

Counterpart of Users' `src/shared/grpc/server.ts`, with one structural difference
forced by the language: Users loads `proto/users.proto` at runtime with
`@grpc/proto-loader`, so its server reads the .proto file itself. Python needs
codegen, so this module imports the committed stubs instead and never touches the
.proto at runtime (see `scripts/generate_grpc_stubs.py`).

## Running gRPC and HTTP in one process (the Phase D seam)

This service will also serve FastAPI over HTTP (Phase D: the health check, the two
user-scoped reads, the carrier status PUT). Both surfaces have to live in the same
container, and the shape that supports it is already here:

`serve()` binds and **returns** without blocking, and `grpc.server()` is given its
own `ThreadPoolExecutor`. So the composition Phase D needs is:

    uvicorn runs the FastAPI app on PORT (it owns the main thread / event loop)
    ^ the gRPC server runs alongside on GRPC_PORT, on its own thread pool

with `serve()` called from the FastAPI **lifespan** startup and the returned
server stopped on shutdown — the same lifecycle hook Users uses when it starts its
gRPC server next to Fastify. Nothing here assumes it owns the process:
`serve_forever()` (which does block) is a separate, explicitly-named function used
only by the standalone `__main__` entrypoint below, so it can never be reached
accidentally from inside a web process.

The gRPC server is deliberately NOT built on asyncio (`grpc.aio`): the database
layer is sync `pymysql` (see `shared/db/engine.py`), and a blocking DBAPI call
inside an asyncio servicer would stall the event loop. A thread-pool server matches
the driver.
"""

from __future__ import annotations

import logging
from concurrent import futures

import grpc

from src.features.tracking.grpc.service import TrackingServicer
from src.shared.config.settings import get_settings
from src.shared.grpc.api_key_interceptor import ApiKeyInterceptor
from src.shared.grpc.generated import tracking_pb2_grpc

logger = logging.getLogger(__name__)

#: Worker threads for RPC handlers. Sized against the DB pool, not the CPU: every
#: handler's real work is a blocking pymysql round trip, and `_build_engine` gives
#: each engine pool_size=5 + max_overflow=5. More workers than connections would
#: only queue threads on the pool.
DEFAULT_MAX_WORKERS = 10


def build_server(
    *,
    api_key: str,
    max_workers: int = DEFAULT_MAX_WORKERS,
    servicer: TrackingServicer | None = None,
) -> grpc.Server:
    """Build a server with the auth interceptor installed and the servicer added.

    The interceptor is passed to the constructor, so it applies to EVERY RPC on
    this server — including any added later. Guarding per-method would make a new
    RPC unauthenticated by default, which is the wrong direction for a mistake to
    fall in.

    Does not bind a port: `serve()` does that, and tests bind an ephemeral one.
    """
    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=max_workers),
        interceptors=[ApiKeyInterceptor(api_key)],
    )
    tracking_pb2_grpc.add_TrackingServicer_to_server(
        servicer or TrackingServicer(), server
    )
    return server


def serve(port: int | None = None, *, api_key: str | None = None) -> grpc.Server:
    """Build, bind and START the server, returning it without blocking.

    Non-blocking by design — see the module docstring: Phase D calls this from the
    FastAPI lifespan and keeps the returned handle to stop on shutdown.

    Binds `0.0.0.0` (not `127.0.0.1`): in a container the caller is another
    container, so a loopback bind would refuse every real connection while looking
    perfectly healthy from inside.
    """
    settings = get_settings()
    resolved_port = settings.grpc_port if port is None else port
    server = build_server(api_key=api_key or settings.grpc_api_key)
    bound = server.add_insecure_port(f"0.0.0.0:{resolved_port}")
    if bound == 0:
        # add_insecure_port reports failure by returning 0, not by raising — an
        # unchecked call here means a server that "started" and listens nowhere.
        raise RuntimeError(f"failed to bind gRPC port {resolved_port}")
    server.start()
    logger.info(
        "grpc_server_started",
        extra={"app_event": "grpc_server_started", "port": bound},
    )
    return server


def serve_forever() -> None:
    """Serve until terminated. Only for the standalone entrypoint below.

    Kept separate from `serve()` so that the blocking wait can never be entered by
    a caller that also needs to run an HTTP server in the same process.
    """
    serve().wait_for_termination()


if __name__ == "__main__":  # pragma: no cover - process entrypoint
    logging.basicConfig(level=logging.INFO)
    serve_forever()
