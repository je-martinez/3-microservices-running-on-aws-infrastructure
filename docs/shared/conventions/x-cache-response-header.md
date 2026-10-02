---
title: X-Cache Response Header
type: convention
area: shared
status: active
created: 2026-08-25
updated: 2026-10-02
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[2026-08-25-response-caching-layer-design]]"
  - "[[logging-context]]"
  - "[[current-caller-context]]"
  - "[[env-files]]"
  - "[[testing]]"
  - "[[users-service-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[2026-08-26-cache-keys-built-from-a-raw-identity-header]]"
---

# X-Cache Response Header

## Rule

Every cacheable read endpoint in Users, Orders, and Tracking reports its cache outcome via an
`X-Cache` response header ([http.dev/x-cache](https://http.dev/x-cache)), emitted by a single
per-service HTTP-layer interceptor rather than by individual handlers. Full design and
rationale: [[2026-08-25-response-caching-layer-design]].

| Value | Meaning | Companion header |
|---|---|---|
| `X-Cache: HIT` | Served from Redis; the handler did not execute. | `X-Cache-TTL: <seconds remaining>` |
| `X-Cache: MISS` | Not in Redis; the handler executed and (on a `200`) populated the cache. | none |
| `X-Cache: BYPASS` | Redis was unavailable (timeout/error); fell through to the database. | none |
| *(no header)* | `CACHE_ENABLED=false` — the interceptor is skipped entirely. | none |

`BYPASS` is deliberately distinct from `MISS` so a Redis outage does not read as a poor
hit-rate in the metrics — it is excluded from the hit-rate denominator
(`hit / (hit + miss)`).

> [!warning] A fifth, undocumented state — the unkeyable caller (corrected 2026-08-26)
> When a caller's `user_id` cannot be resolved, no response-cache key can be built, and the
> three services disagree on what to report — none of them fit the four rows above cleanly:
> Tracking stamps `X-Cache: MISS`
> (`services/tracking-go/internal/adapter/http/handler_reads.go`, `serveCached`); Orders emits
> **no header**, colliding on the wire with the "cache disabled" row above
> (`services/orders/src/Orders.Api/Caching/CachedReadFilter.cs:73-77`); Users likewise emits
> **no header** (`services/users/src/features/users/http/cache-hooks.ts:81-86`). Record this as
> a known three-way divergence, not an oversight to silently paper over: a dashboard built on
> "no header always means disabled" will misclassify an Orders/Users unkeyable-caller request.
> Full detail: [[2026-08-25-response-caching-layer-design#Observability]].

> [!danger] Trap: keys built from a raw identity header cannot be invalidated by a canonical identity
> Per-user keys are built from the raw `x-user-id` header value, which can legitimately be
> either a Cognito sub or a `usr_` internal id (`GetUserById` resolves either). A deletion
> cascade invalidating by the **canonical** sub/user_id pair will silently miss keys written
> under the other alias, leaving a deleted account's data live until TTL expiry. Full incident,
> root cause, and the accepted trade-off (invalidate-by-both-aliases, not normalize-at-write):
> [[2026-08-26-cache-keys-built-from-a-raw-identity-header]].

## Backing store

The shared, already-deployed Redis/ElastiCache instance (`infra/modules/redis`) — the same
one Users already uses for password-reset codes. Not in-memory (does not propagate across
Fargate replicas) and not edge/nginx cache (no workable explicit-purge story in nginx OSS or
real AWS API Gateway).

## Failure mode

Fail open, 50ms timeout per Redis operation. On timeout/error: fall through to the database,
respond `BYPASS`, log `WARN` with `app_event=cache_unavailable` and a machine-readable
`reason` per [[logging-context]]. A cache-write failure never affects the response. The cache
may never break or degrade a read.

> [!warning] Corrected 2026-08-26, re-checked 2026-10-02 — dimension VALUES and units diverge per service
> `Result` and `Operation` are not shared enums across the three services, and
> `cache_requests_total` is not published on every operation in every service.
>
> - **Users** (`services/users/src/shared/cache/cache-gateway.ts`) publishes `Result` as `hit`,
>   `miss` or `bypass` only; it never publishes `Result: "del"`. A successful `set` publishes
>   only a duration; a successful invalidation publishes nothing. A failed `get`, `set` or `del`
>   goes through `reportUnavailable` (l.186-209) and counts as `Result: bypass`. Its duration
>   `Operation` values are `get`, `set` and `del`, but the `del` series is published only on
>   failure, with a hard-coded 0 ms (l.125), so it does not measure latency.
> - **Tracking** (`services/tracking-go/internal/adapter/redis/gateway.go`) publishes
>   `cache_requests_total` on `get` only (`hit`, `miss`, `bypass`); `set`, `invalidate` and
>   `invalidate_index` call `record` with an empty result (l.194, 233, 256), so only a duration
>   goes out (`record`, l.308). Its `Operation` values are `get`, `set`, `invalidate` and
>   `invalidate_index`.
> - **Orders** (`services/orders/src/Orders.Infrastructure/Caching/CacheGateway.cs`) publishes
>   `cache_requests_total` on `get` only. Its duration `Operation` values are `get` and `set`
>   only (l.109 for `set`; `Record` for `get`, l.193-223). `InvalidateAsync`, `TrackKeyAsync` and
>   `InvalidateUserKeysAsync` log a failure (l.135, 151, 170) and publish no metric.
> - **The documented `hit / (hit + miss)` formula therefore has a different denominator per
>   service.** Users' `bypass` count includes write-path failures that Tracking and Orders never
>   contribute, so do not average or directly compare the three services' hit-rates without
>   accounting for this.
> - **Duration units differ.** Users publishes `cache_operation_duration_ms` with unit
>   `Milliseconds` (`reportDuration`, l.177-183). Orders (`CloudWatchMetricsPublisher.cs`, l.67)
>   and Tracking (`cloudwatch/publisher.go`, l.115) publish it with unit `Count`; the values are
>   milliseconds in all three. A query or dashboard filtering on the unit sees Users apart from
>   the other two.
>
> The code was re-checked against the three gateways on 2026-10-02. Full per-service vocabulary
> (also covering the `reason` field, which likewise does not match across services) and the fifth
> `X-Cache` state this also uncovered (an unkeyable caller, reported as `MISS` in Tracking and as
> no header at all in Orders/Users): [[2026-08-25-response-caching-layer-design#Observability]].

## Testing

Per [[testing]]: verify at all three layers, per cached endpoint — unit/integration (hit,
miss, TTL expiry, invalidation, fail-open, cross-user isolation), internal E2E, and gateway
E2E with a real Cognito JWT confirming `X-Cache` survives the API Gateway and nginx (a gateway
can silently strip an unknown response header).

## Related

- [[2026-08-25-response-caching-layer-design]]
- [[logging-context]]
- [[current-caller-context]]
- [[env-files]]
- [[testing]]
- [[users-service-design]]
- [[orders-service-design]]
- [[tracking-service-design]]
- [[2026-08-26-cache-keys-built-from-a-raw-identity-header]] — the raw-identity-header
  invalidation trap this cache design fell into; read before trusting a comment that claims a
  key is "keyed on X alone."
