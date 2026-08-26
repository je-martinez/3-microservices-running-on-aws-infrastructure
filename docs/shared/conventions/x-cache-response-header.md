---
title: X-Cache Response Header
type: convention
area: shared
status: draft
created: 2026-08-25
updated: 2026-08-25
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

`BYPASS` is deliberately distinct from `MISS` so a Redis outage does not read as a poor
hit-rate in the metrics — it is excluded from the hit-rate denominator
(`hit / (hit + miss)`).

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

## Kill switch

`CACHE_ENABLED`, per service, sourced from the generated env file (see [[env-files]]). When
`false` the interceptor is skipped entirely and no `X-Cache` header is emitted.

## Cacheability rules

- Only `GET` routes are ever cached; `POST`/`PUT`/`PATCH`/`DELETE` never are.
- Only `200` responses populate the cache.
- Every key carries `cognito_sub` and `user_id` unless the resource has no owner (e.g. the
  product catalog), following [[current-caller-context]].
- `/v1/health` and every `e2e-*` endpoint are excluded from caching.

## Identity-mapping cache (Orders and Tracking only)

Because response keys carry `user_id`, the `cognito_sub -> user_id` resolution has to run
**before** the response key can be built — including on what would otherwise be a fast cache
hit. Orders and Tracking (not Users, which needs no resolution) also cache that mapping itself
under its own key prefix, consulted before the response key is built:

| Key | TTL | Invalidation |
|---|---|---|
| `identity:sub-to-user:v1:{cognito_sub}` | 1 h | None — TTL only. See below. |

**Invalidated by TTL only, and that is correct, not a gap.** No event in this repo would need
to trigger an early invalidation: Users' Cognito webhook accepts only
`PostConfirmation_ConfirmSignUp`/`PostConfirmation_ConfirmForgotPassword`
(`services/users/src/features/users/webhooks/cognito-payload.ts:18-21`), and no
account-deletion flow exists anywhere in the repo outside the E2E-only `E2eCleanupCommand`
(`services/users/src/features/users/http/e2e-cleanup.ts:7`). Because the mapping is
effectively immutable, a stale entry cannot serve a *wrong* answer, only a momentarily-late
one; the 1h TTL bounds the one real case — an account that stops existing. When an
account-deletion endpoint eventually exists, it must delete this key and the user's
response-cache entries (via the per-user key index) as part of its own cascade. Full rationale
and the "out of scope" note: [[2026-08-25-response-caching-layer-design]].

Same fail-open contract as the response cache (50ms timeout, fall back to gRPC/DB on miss or
error). Its hit-rate reports under its own `KeyPrefix` dimension
(`identity:sub-to-user:v1`) on `cache_requests_total` and must never be averaged together with
response-cache hit-rates — the two measure different things.

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
