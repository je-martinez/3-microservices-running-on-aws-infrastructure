"""The process-wide Redis client and the gateway built on it.

Lazy, not module-level, so importing this module neither opens a socket nor
requires a valid environment — the same rule `users_client.py`, `db/engine.py`
and `cloudwatch_metrics.py` all follow.

The `lru_cache` is keyed on PRIMITIVES, never on `Settings`. Pydantic's
`BaseSettings` is unhashable, so an `lru_cache` taking a settings object raises
`TypeError` on its first call — and that failure is invisible to a suite that
injects its own double everywhere. This repo has been bitten by it in three
separate modules; see `_cached_client(target, api_key)` in
`shared/grpc/users_client.py`, `_engines(writer_url, reader_url, echo)` in
`shared/db/engine.py`, and `_cached_publisher(endpoint_url, region)` in
`shared/metrics/cloudwatch_metrics.py`.
"""

from __future__ import annotations

from functools import lru_cache

import redis

from src.shared.cache.gateway import CacheGateway, NullCacheGateway
from src.shared.config.settings import get_settings
from src.shared.metrics.cloudwatch_metrics import shared_metrics_publisher


@lru_cache(maxsize=1)
def _cached_client(host: str, port: int, timeout_ms: int) -> redis.Redis:
    """One client (hence one connection pool) per process, keyed on values.

    `decode_responses=True` so `get` hands back `str` and `json.loads` needs no
    decode step. Both timeouts are the SAME budget: a connect that takes longer
    than the operation is allowed to take has already blown it, so there is no
    reason to give the two different numbers.

    `retry_on_timeout=False` is load-bearing rather than a default worth
    restating: a retry would spend the 50ms budget twice, turning the fail-open
    guarantee into a 100ms one on exactly the path the cache exists to speed up.
    """
    seconds = timeout_ms / 1000
    return redis.Redis(
        host=host,
        port=port,
        decode_responses=True,
        socket_timeout=seconds,
        socket_connect_timeout=seconds,
        retry_on_timeout=False,
    )


def shared_cache_gateway() -> CacheGateway | NullCacheGateway:
    """The process-wide gateway, or the null object when the cache is off.

    The kill switch is applied HERE, at construction, rather than inside the
    gateway: with the cache disabled nothing should build a Redis client at all,
    so a service running with `CACHE_ENABLED=false` needs no reachable Redis to
    start.
    """
    settings = get_settings()
    if not settings.cache_enabled:
        return NullCacheGateway()
    client = _cached_client(
        settings.redis_host, settings.redis_port, settings.cache_timeout_ms
    )
    return CacheGateway(client=client, metrics=shared_metrics_publisher())
