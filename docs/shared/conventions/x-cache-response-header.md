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
| `identity:sub-to-user:v1:{cognito_sub}` | 1 h | Cognito webhook, and user deletion (soft-delete) |

Same fail-open contract as the response cache (50ms timeout, fall back to gRPC/DB on miss or
error). Its hit-rate reports under its own `key_prefix` on `cache_requests_total` and must
never be averaged together with response-cache hit-rates — the two measure different things.
Full rationale: [[2026-08-25-response-caching-layer-design]].

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
