---
title: X-Cache Response Header
type: convention
area: shared
status: draft
created: 2026-08-25
updated: 2026-08-27
tags:
  - type/convention
  - area/shared
  - status/draft
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

> [!warning] Corrected 2026-08-26 — a corrupt entry is classified differently per service
> This rule reads as uniform ("respond `BYPASS`" on any failure), but a corrupt/unparseable
> cache entry is treated three different ways as shipped: Tracking answers `MISS` (not
> `BYPASS`) and logs `app_event=cache_entry_unreadable`
> (`services/tracking-go/internal/adapter/redis/gateway.go`); Users answers `BYPASS`
> (`services/users/src/shared/cache/cache-gateway.ts:87-93`); Orders answers `MISS` for a
> deserialized `null` but `BYPASS` for a thrown deserialization error
> (`services/orders/src/Orders.Infrastructure/Caching/CacheGateway.cs:73-97`). All three are
> individually defensible under fail-open, but a dashboard assuming one classification will
> misattribute corrupt-entry noise. Full detail:
> [[2026-08-25-response-caching-layer-design#Observability]].

## Kill switch

`CACHE_ENABLED`, per service, sourced from the generated env file (see [[env-files]]). When
`false` the interceptor is skipped entirely and no `X-Cache` header is emitted.

## Cacheability rules

- Only `GET` routes are ever cached; `POST`/`PUT`/`PATCH`/`DELETE` never are.
- Only `200` responses populate the cache.
- Every key carries an identity segment and `user_id` unless the resource has no owner (e.g.
  the product catalog), following [[current-caller-context]]. **The identity segment is the
  raw `x-user-id` header value, not necessarily a canonical `cognito_sub`** — see the danger
  callout above and [[2026-08-26-cache-keys-built-from-a-raw-identity-header]].
- `/v1/health` and every `e2e-*` endpoint are excluded from caching.

## Identity-mapping cache (Orders and Tracking only)

Because response keys carry `user_id`, the `cognito_sub -> user_id` resolution has to run
**before** the response key can be built — including on what would otherwise be a fast cache
hit. Orders and Tracking (not Users, which needs no resolution) also cache that mapping itself
under its own key prefix, consulted before the response key is built:

| Key | TTL | Invalidation |
|---|---|---|
| `identity:sub-to-user:v1:{identity}` | 1 h | TTL, plus explicit invalidation on account deletion. See below. |

> [!warning] Corrected 2026-08-26 — no longer TTL-only
> When this convention was written, no account-deletion flow existed anywhere in the repo, so
> TTL was the only bound (reasoning preserved below). It shipped from the account-deletion
> milestone and now invalidates this key explicitly:
> `services/tracking-go/internal/adapter/redis/user_invalidator.go` (`UserInvalidator.InvalidateUser`,
> called from `internal/app/delete_by_user.go`) and
> `services/orders/src/Orders.Infrastructure/Caching/CacheInvalidator.cs:92-93`
> (`InvalidateDeletedUserAsync`, called from `InternalEndpoints.cs:296`) both delete
> `CacheKeys.identity(...)` for the deleted account, for **both** the caller's raw-header
> identity and their resolved `user_id` — sweeping only the canonical identity was tried first
> and missed keys written under the other alias; see
> [[2026-08-26-cache-keys-built-from-a-raw-identity-header]]. TTL remains the fallback for
> everything that isn't a deletion.

**Originally: invalidated by TTL only** (superseded above). No event in this repo needed
to trigger an early invalidation for a *non-deleted* account: Users' Cognito webhook accepts
only `PostConfirmation_ConfirmSignUp`/`PostConfirmation_ConfirmForgotPassword`
(`services/users/src/features/users/webhooks/cognito-payload.ts:18-21`), and — at the time —
no account-deletion flow existed anywhere in the repo outside the E2E-only
`E2eCleanupCommand` (`services/users/src/features/users/http/e2e-cleanup.ts:7`). Because the
mapping is effectively immutable, a stale entry cannot serve a *wrong* answer for an existing
account, only a momentarily-late one; the 1h TTL still bounds every case except deletion, which
is now covered explicitly rather than waiting out the hour. Full rationale, the account-deletion
cascade as shipped, and the raw-identity-header trap it fell into:
[[2026-08-25-response-caching-layer-design]].

Same fail-open contract as the response cache (50ms timeout, fall back to gRPC/DB on miss or
error). Its hit-rate reports under its own `KeyPrefix` dimension
(`identity:sub-to-user:v1`) on `cache_requests_total` and must never be averaged together with
response-cache hit-rates — the two measure different things.

## Per-user key index

Orders and Tracking each keep a Redis SET of a caller's live response-cache keys, so an
invalidation with a variable-suffix key (`t0`/`t1`, an `order_ids` hash) can be swept without
`KEYS`/`SCAN`. TTL is 1h — longer than every response TTL it guards, so the index cannot expire
before an entry it points at.

| Service | Key shape | TTL |
|---|---|---|
| Orders | `orders:index:v1:{sub}` (one segment) | 1 h |
| Tracking | `tracking:index:v1:{sub}:{user_id}` (two segments) | 1 h |

Users has no index: it caches exactly one route (`GET /v1/users/me`), so a single explicit key
invalidation is enough. **This index was required by the design from the start but was missing
from this convention's key tables — added 2026-08-26.** Full rationale:
[[2026-08-25-response-caching-layer-design]].

## Metrics

Published via each service's existing CloudWatch metrics publisher (Orders'
`IMetricsPublisher`, Users' `MetricsPublisher`, Tracking's `MetricsPublisher` Protocol) under
the shared `3MRAI` namespace — **not** an OTel metrics pipeline; none of the three services
runs one today (`OTEL_METRICS_EXPORTER=none` in every generated env). `cache_requests_total`
carries CloudWatch dimensions `Service`, `KeyPrefix` (prefix only — never a full key, which
would explode cardinality and leak `cognito_sub`/`user_id`), `Result`; `cache_operation_duration_ms`
carries `Service`, `Operation`, unit `Milliseconds`. These publishers must not throw — a
metrics failure must never break a cached read. Full rationale:
[[2026-08-25-response-caching-layer-design]].

> [!warning] Corrected 2026-08-26 — dimension VALUES diverge per service
> `Result` and `Operation` are not shared enums across the three services, and
> `cache_requests_total` is not published on every operation in every service. Users publishes
> `Result: "del"` on invalidation and `Result: "bypass"` on write failure; Tracking publishes
> `invalidate`/`invalidate_index` as `Operation` values and never emits `cache_requests_total`
> on a write (`result=None`); Orders publishes `cache_requests_total` on `get` only, and
> `Operation` values `get`\|`set`\|`invalidate`\|`index` on duration. **The documented
> `hit / (hit + miss)` formula therefore has a different denominator per service** — do not
> average or directly compare the three services' hit-rates without accounting for this. Full
> per-service vocabulary (also covering the `reason` field, which likewise does not match
> across services) and the fifth `X-Cache` state this also uncovered (an unkeyable caller,
> reported as `MISS` in Tracking and as no header at all in Orders/Users):
> [[2026-08-25-response-caching-layer-design#Observability]].

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
