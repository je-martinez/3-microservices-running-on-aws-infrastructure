---
title: Current-Caller Context
type: pattern
area: shared
status: active
created: 2026-07-28
updated: 2026-07-28
tags:
  - type/pattern
  - area/shared
  - status/active
  - issue/JE-83
related:
  - "[[2026-07-16-scoped-current-user-context-design]]"
  - "[[2026-07-16-scoped-current-user-context]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[dependency-injection]]"
  - "[[audit-fields]]"
  - "[[ADR-0003-grpc-inter-service]]"
  - "[[logging-context]]"
---

# Current-Caller Context

## Pattern

Resolve the authenticated caller **once per request, in a middleware**, and expose it through a
request-scoped context — instead of re-reading the identity header and re-resolving the user ad
hoc in every command/query/endpoint.

The context has two parts:

- **`identity`** — the raw caller identity (the Cognito sub from `x-user-id`), populated
  unconditionally by the middleware for every request that passes the auth gate. Cheap, always
  available.
- **`resolveUser()` / `ResolveInternalUserIdAsync()`** — **lazy** full-user resolution, called only
  by the handlers that actually need it, and **cached in the request scope** so repeated calls
  within one request do not repeat the lookup (a local DB query, or a network call such as gRPC).

## Middleware enforces auth against a centralized allowlist

The middleware itself enforces authentication: it rejects with `401` when the identity header is
missing, **unless** the route is in a centralized, explicit public-route allowlist (one per
service). Matching is exact (method+path) for fixed public routes, with a prefix match reserved
only for a narrow, well-known case (e.g. `/v1/webhooks/*`) — an over-broad prefix must never
accidentally exempt a protected route. Past the gate, endpoints consume the caller from the
context with no auth check of their own.

## Why lazy resolution matters

Not every request needs the fully-resolved user — some only need the raw identity (e.g. filtering
reads by the caller's own sub). Eagerly resolving on every request would add an unconditional
lookup (a DB hit, or worse, a network call) to paths that never use it. Lazy + cached resolution
preserves the cheaper existing behavior (e.g. a read path that never triggers a network call) while
still centralizing the resolution logic and its caching in one place, instead of leaving it
duplicated per use-case.

## Relationship to audit context

This pattern is deliberately **separate** from any actor/audit context (e.g. an AsyncLocalStorage
store that stamps audit columns) — they solve different problems. The audit context exists because
some persistence clients (e.g. a singleton ORM client) cannot reach a per-request DI scope and need
an ambient carrier instead. The current-caller context is DI-scoped and exists to remove duplicated
identity resolution from handlers. See [[audit-fields]] for the audit-column contract this pattern
does not change.

## Per-service instantiation

The concrete shape (a DI-scoped registration vs. a `Scoped` service; a local DB lookup vs. a gRPC
call for full-user resolution) is service-specific and documented in each service's own spec — this
note defines the reusable shape, not the per-service wiring. See
[[2026-07-16-scoped-current-user-context-design]] for the first two implementations (Users,
Fastify/Awilix; Orders, .NET Minimal APIs), which this pattern generalizes from.

## Related

- [[2026-07-16-scoped-current-user-context-design]]
- [[2026-07-16-scoped-current-user-context]]
- [[ADR-0010-cognito-auth]]
- [[dependency-injection]]
- [[audit-fields]]
- [[ADR-0003-grpc-inter-service]]
- [[logging-context]] — the request-scoped caller this pattern resolves is the same identity that flows into the shared log context.
