"""The cache transport: Redis, JSON, the timeout budget, and telemetry.

Everything that touches Redis in this service goes through here, and every method
here obeys one rule: **it never raises.** A `get` that fails answers a bypassed
`CacheEntry`; a `set` or an `invalidate` that fails logs and returns. A cache is
an optimization, and an optimization that can fail a request is a liability.

## Why manual spans and not an instrumentation package

`opentelemetry-instrumentation-redis` exists, and it is deliberately NOT
installed. `requirements-runtime.txt` records why: every `-instrumentation-*`
package lives on the 0.x train and hard-pins its siblings, so adding one drags
the whole train and can only move in lockstep with the 1.x SDK. The spans this
class emits by hand carry more than the auto-instrumentation would anyway —
`cache.result` and `cache.ttl_remaining` are business facts, not transport facts,
and no instrumentation can know them.

## Why the full key never leaves this module

Every response key embeds `cognito_sub` and `user_id`. A span attribute, a
CloudWatch dimension value and a log field are all export destinations, so all
three receive `CacheKeys.prefix_of(key)` and nothing more. The rule is enforced
by there being exactly one place — this file — that holds both the key and a
telemetry call.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Protocol

from opentelemetry import trace
from opentelemetry.trace import SpanKind

from src.shared.cache.keys import CacheKeys
from src.shared.metrics.cloudwatch_metrics import (
    SERVICE_DIMENSION,
    MetricsPublisher,
)

logger = logging.getLogger(__name__)

#: Own tracer, named for its area — the same convention as
#: `shared/observability/workflow_tracing.py`'s `tracking-workflow` and
#: `shared/metrics/cloudwatch_metrics.py`'s `tracking-metrics`.
_tracer = trace.get_tracer("tracking-cache")

REQUESTS_METRIC = "cache_requests_total"
DURATION_METRIC = "cache_operation_duration_ms"

RESULT_HIT = "hit"
RESULT_MISS = "miss"
RESULT_BYPASS = "bypass"

#: How long a per-user index SET lives. Longer than any entry it tracks (the
#: longest response TTL here is 60s) so the index can never expire out from under
#: keys it is the only way to reach; short enough that a user who stops reading
#: does not leave a SET behind forever.
INDEX_TTL_SECONDS = 3600


class RedisLike(Protocol):
    """The subset of the `redis` client API this gateway uses.

    A Protocol rather than the concrete `redis.Redis` so `fakeredis` (and the
    deliberately-broken double in the tests) satisfy it without inheritance.
    """

    def get(self, name: str) -> Any: ...
    def setex(self, name: str, time: int, value: str) -> Any: ...
    def delete(self, *names: str) -> Any: ...
    def ttl(self, name: str) -> Any: ...
    def sadd(self, name: str, *values: str) -> Any: ...
    def smembers(self, name: str) -> Any: ...


@dataclass(frozen=True, slots=True)
class CacheEntry:
    """The outcome of a `get`.

    Three states, and `bypassed` is why there are three rather than two: a MISS
    means "Redis answered, and had nothing", a BYPASS means "Redis did not
    answer". Collapsing them would make an outage read as a poor hit rate on the
    dashboard, which is the one reading that would send an operator to look at
    the wrong system.
    """

    hit: bool
    value: Any | None = None
    ttl_remaining: int | None = None
    bypassed: bool = False


class CacheGateway:
    """Reads, writes and invalidates cache entries. Never raises."""

    def __init__(self, *, client: RedisLike, metrics: MetricsPublisher) -> None:
        self._client = client
        self._metrics = metrics

    # ------------------------------------------------------------------ read
    def get(self, key: str) -> CacheEntry:
        """Look up `key`. Returns a MISS, a HIT, or a BYPASS — never raises."""
        prefix = CacheKeys.prefix_of(key)
        started = time.perf_counter()
        with _tracer.start_as_current_span(
            "cache.get",
            kind=SpanKind.CLIENT,
            attributes={"cache.key_prefix": prefix},
        ) as span:
            try:
                raw = self._client.get(key)
                if raw is None:
                    span.set_attribute("cache.result", RESULT_MISS)
                    self._record(RESULT_MISS, prefix, "get", started)
                    return CacheEntry(hit=False)
                value = json.loads(raw)
                ttl = self._read_ttl(key)
                span.set_attribute("cache.result", RESULT_HIT)
                if ttl is not None:
                    span.set_attribute("cache.ttl_remaining", ttl)
                self._record(RESULT_HIT, prefix, "get", started)
                return CacheEntry(hit=True, value=value, ttl_remaining=ttl)
            except (ValueError, TypeError):
                # A payload Redis returned but JSON could not parse: a truncated
                # write, a key someone else wrote, a shape from a version that
                # predates a `v1` bump. Treated as a MISS, not a BYPASS — Redis
                # is fine, the ENTRY is not, so the right answer is to recompute
                # and overwrite it.
                span.set_attribute("cache.result", RESULT_MISS)
                logger.warning(
                    "cache_entry_unreadable",
                    extra={
                        "app_event": "cache_entry_unreadable",
                        "reason": "malformed_payload",
                        "cache_key_prefix": prefix,
                    },
                )
                self._record(RESULT_MISS, prefix, "get", started)
                return CacheEntry(hit=False)
            except Exception:  # noqa: BLE001 - the cache never fails a read
                span.set_attribute("cache.result", RESULT_BYPASS)
                self._warn_unavailable("get", prefix)
                self._record(RESULT_BYPASS, prefix, "get", started)
                return CacheEntry(hit=False, bypassed=True)

    # ----------------------------------------------------------------- write
    def set(
        self,
        key: str,
        value: Any,
        ttl_seconds: int,
        *,
        index_key: str | None = None,
    ) -> None:
        """Store `value` under `key` for `ttl_seconds`. Never raises.

        `index_key`, when given, names the per-user SET this key is recorded in,
        so a later invalidation can find it without `KEYS`/`SCAN`. The SET is
        given a TTL of its own, comfortably longer than the entries it tracks, so
        an index for a user who stops reading expires instead of accumulating
        forever.
        """
        prefix = CacheKeys.prefix_of(key)
        started = time.perf_counter()
        with _tracer.start_as_current_span(
            "cache.set",
            kind=SpanKind.CLIENT,
            attributes={
                "cache.key_prefix": prefix,
                "cache.ttl_remaining": ttl_seconds,
            },
        ):
            try:
                self._client.setex(key, ttl_seconds, json.dumps(value))
                if index_key is not None:
                    self._client.sadd(index_key, key)
                    # Deliberately longer than any entry it indexes: an index
                    # that expired FIRST would leave orphaned entries no
                    # invalidation could ever reach, and they would then serve
                    # stale data for the remainder of their own TTL.
                    self._expire(index_key, INDEX_TTL_SECONDS)
            except Exception:  # noqa: BLE001 - a write failure is invisible
                self._warn_unavailable("set", prefix)
            finally:
                self._record(None, prefix, "set", started)

    def invalidate(self, *keys: str) -> None:
        """Delete `keys`. Never raises; deleting an absent key is fine."""
        if not keys:
            return
        prefix = CacheKeys.prefix_of(keys[0])
        started = time.perf_counter()
        with _tracer.start_as_current_span(
            "cache.invalidate",
            kind=SpanKind.CLIENT,
            attributes={
                "cache.key_prefix": prefix,
                "cache.key_count": len(keys),
            },
        ):
            try:
                self._client.delete(*keys)
            except Exception:  # noqa: BLE001 - see the module docstring
                self._warn_unavailable("invalidate", prefix)
            finally:
                self._record(None, prefix, "invalidate", started)

    def invalidate_index(self, index_key: str) -> None:
        """Delete every key the index names, then the index itself.

        This is the answer to "the list key embeds a hash I cannot reconstruct".
        `KEYS`/`SCAN` would be the other answer and is the wrong one: both are
        O(N) over the entire keyspace, `KEYS` blocks the server for the duration,
        and neither is acceptable on a write path.
        """
        prefix = CacheKeys.prefix_of(index_key)
        started = time.perf_counter()
        with _tracer.start_as_current_span(
            "cache.invalidate_index",
            kind=SpanKind.CLIENT,
            attributes={"cache.key_prefix": prefix},
        ) as span:
            try:
                members = self._client.smembers(index_key) or set()
                span.set_attribute("cache.key_count", len(members))
                if members:
                    self._client.delete(*members)
                self._client.delete(index_key)
            except Exception:  # noqa: BLE001 - see the module docstring
                self._warn_unavailable("invalidate_index", prefix)
            finally:
                self._record(None, prefix, "invalidate_index", started)

    # ------------------------------------------------------------- internals
    def _read_ttl(self, key: str) -> int | None:
        """Seconds left on `key`, or None when Redis will not say.

        Redis answers `-1` for a key with no expiry and `-2` for one that no
        longer exists; neither is a duration, so both become None and the caller
        simply omits `X-Cache-TTL`.
        """
        try:
            ttl = int(self._client.ttl(key))
        except Exception:  # noqa: BLE001 - the TTL is decoration on a HIT
            return None
        return ttl if ttl > 0 else None

    def _expire(self, key: str, seconds: int) -> None:
        """Refresh an index's own lifetime, tolerating a client without it."""
        expire = getattr(self._client, "expire", None)
        if expire is not None:
            expire(key, seconds)

    def _warn_unavailable(self, operation: str, prefix: str) -> None:
        """One WARN per failed operation, with a machine-readable reason.

        `app_event=cache_unavailable` is the token the shared design names, and
        it is what a dashboard alerts on. `exc_info` is deliberately off: a Redis
        outage produces one of these per request, and a stack trace per request
        buries every other signal in the stream.
        """
        logger.warning(
            "cache_unavailable",
            extra={
                "app_event": "cache_unavailable",
                "reason": "redis_unavailable",
                "cache_operation": operation,
                "cache_key_prefix": prefix,
            },
        )

    def _record(
        self, result: str | None, prefix: str, operation: str, started: float
    ) -> None:
        """Publish the two metrics for one operation.

        Goes through the CloudWatch publisher, not an OTel `Meter`: this service
        runs no OTel metrics pipeline (`OTEL_METRICS_EXPORTER=none` in the
        generated env), and standing one up across three runtimes is its own
        milestone. The publisher's contract is that it NEVER raises, so there is
        no try/except here — adding one would duplicate a guarantee the Protocol
        already makes.
        """
        elapsed_ms = (time.perf_counter() - started) * 1000
        if result is not None:
            self._metrics.publish(
                REQUESTS_METRIC,
                1,
                {
                    "Service": SERVICE_DIMENSION,
                    "KeyPrefix": prefix,
                    "Result": result,
                },
            )
        self._metrics.publish(
            DURATION_METRIC,
            elapsed_ms,
            {"Service": SERVICE_DIMENSION, "Operation": operation},
        )


class NullCacheGateway:
    """The binding used when `CACHE_ENABLED=false`.

    Not a gateway with a flag inside it: a null object means the routes have
    exactly one code path, and "the cache is off" is expressed by which object is
    bound rather than by a branch in every handler. Its `get` returns a plain
    MISS with `bypassed=False`, and the routes read `cache_enabled` to decide
    whether to emit a header at all — so a disabled cache emits NO `X-Cache`
    header, never `MISS` and never `BYPASS`.
    """

    def get(self, key: str) -> CacheEntry:
        return CacheEntry(hit=False)

    def set(
        self,
        key: str,
        value: Any,
        ttl_seconds: int,
        *,
        index_key: str | None = None,
    ) -> None:
        return None

    def invalidate(self, *keys: str) -> None:
        return None

    def invalidate_index(self, index_key: str) -> None:
        return None
