"""The FastAPI seams for the cache: the gateway, and the kill switch.

A dependency purely so tests can override it
(`app.dependency_overrides[get_cache_gateway]`) with a gateway over an in-process
fake — the same seam `get_read_session` / `get_write_session` / `get_users_client`
give the database and Users.

Plain `def`, not `async def`, and that is the correct choice here even though
`stamp_caller_user_id` next door is `async def` for the opposite reason. The rule
at `log_identity.py` is about the LOG CONTEXT: a `def` dependency runs in
FastAPI's threadpool, which gets a COPY of the request's context, so a
`merge_log_context` inside one is discarded on return. This dependency merges
nothing — it returns an object. The handlers that consume it are themselves plain
`def` (pymysql is a blocking driver), so they run in that same threadpool and a
blocking Redis call inside them cannot stall the event loop.

The routes DO merge `cache_result` into the log context, and they do it from
inside the handler rather than from here, for exactly the reason above.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import Depends, Request

from src.shared.cache.gateway import CacheGateway, NullCacheGateway
from src.shared.cache.redis_client import shared_cache_gateway
from src.shared.config.settings import get_settings

logger = logging.getLogger(__name__)


def get_cache_gateway() -> CacheGateway | NullCacheGateway:
    """The process-wide gateway, or the null object when one cannot be built.

    Resolved lazily, inside the function body, so importing this module neither
    opens a socket nor requires a valid environment — the same rule
    `get_users_client` follows.

    **The construction failure is swallowed**, exactly as
    `log_identity.get_optional_users_client` swallows its own, and for the same
    reason made concrete by the same kind of breakage. `shared_cache_gateway`
    reads the module-level `get_settings()`, which raises `ValidationError` on an
    incomplete environment — and it CANNOT see `app.dependency_overrides[
    get_settings]`, because that table is consulted by FastAPI when resolving a
    declared dependency, not by a plain function call inside one. So an app built
    with overridden settings and a real-but-empty process environment would get a
    `500` on every cached read, from a cache that is documented to fail open. 13
    tests found exactly that.

    A `NullCacheGateway` is the right degradation and not merely the safe one: it
    is the same object `CACHE_ENABLED=false` binds, so an unbuildable cache
    behaves precisely like a disabled one — the read is served from MySQL and
    nothing is written.
    """
    try:
        return shared_cache_gateway()
    except Exception:  # noqa: BLE001 - the cache never fails a read
        logger.debug("cache_gateway_unavailable", exc_info=True)
        return NullCacheGateway()


CacheGatewayDep = Annotated[
    CacheGateway | NullCacheGateway, Depends(get_cache_gateway)
]


def cache_is_enabled(request: Request) -> bool:
    """The `CACHE_ENABLED` kill switch, read so it can never fail a read.

    Not `Annotated[Settings, Depends(get_settings)]`, which is what the routes
    would otherwise declare, and the difference is not cosmetic. `get_settings()`
    raises `ValidationError` on an incomplete environment, and several suites
    build the app deliberately without the DB/gRPC/carrier variables — a
    `Settings` dependency on a cached READ therefore turns a `200` this service
    serves fine into a `500`, which is precisely what a fail-open cache must
    never do. `settings.metrics_enabled` and `e2e_testing_enabled` avoid the same
    trap in the same way, by not going through the model on a path that must
    tolerate a partial environment.

    The override table is consulted EXPLICITLY, exactly as
    `log_identity.get_optional_users_client` consults it and for the same two
    reasons: `app.dependency_overrides[get_settings]` must keep working (it is
    how the kill switch is exercised without touching the process environment),
    and declaring `get_settings` as an ordinary sub-dependency would put its
    failure UPSTREAM of the guard here, back at the `500` this exists to avoid.

    An unreadable environment answers `False` — the cache is off. That is the
    conservative direction: a read is served from MySQL and nothing is cached,
    versus keying entries off settings nobody could parse.
    """
    build = request.app.dependency_overrides.get(get_settings, get_settings)
    try:
        return bool(build().cache_enabled)
    except Exception:  # noqa: BLE001 - the kill switch never fails a read
        logger.debug("cache_settings_unavailable", exc_info=True)
        return False


#: Whether the response cache is on for this request. A dependency rather than a
#: direct call so a test can override `get_settings` and have it honoured.
CacheEnabledDep = Annotated[bool, Depends(cache_is_enabled)]
