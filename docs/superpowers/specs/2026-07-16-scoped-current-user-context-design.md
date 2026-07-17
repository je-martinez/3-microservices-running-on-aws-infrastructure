---
title: Scoped Current-User Context (Middleware) Design
type: spec
area: shared
status: draft
created: 2026-07-16
updated: 2026-07-16
tags:
  - type/spec
  - area/shared
  - status/draft
related:
  - "[[ADR-0010-cognito-auth]]"
  - "[[dependency-injection]]"
  - "[[audit-fields]]"
  - "[[ADR-0003-grpc-inter-service]]"
---

# Scoped Current-User Context (Middleware) Design

## Summary

Resolve the authenticated caller **once per request, in a middleware**, and expose it through a
request-scoped context — instead of re-reading the `x-user-id` header and re-resolving the user ad
hoc in each command/query. Both services do this resolution in a scattered, duplicated way today:
`users` reads the header once but re-runs `findByIdOrCognitoSub` in every use-case; `orders` reads
the header ad hoc in four endpoints (each with a duplicated `if (sub is null) return
Unauthorized()`) and resolves the internal id via gRPC deep inside `CreateOrderService`. This design
introduces a scoped current-caller abstraction per service, populated by a middleware that also
enforces authentication (401 on a missing header) against a centralized public-route allowlist.

The caller's full resolution stays **lazy**: the context always carries the raw identity (the
Cognito sub from the header), and resolves the full user only on demand — a local Postgres lookup in
`users`, a gRPC call to the Users service in `orders` — cached in the request scope. This preserves
the current behavior where `orders` reads do NOT incur a gRPC call.

## Goals

- One place per service reads `x-user-id` and enforces auth (middleware), not every endpoint.
- A request-scoped current-caller context exposing the raw identity always, and a lazy, cached
  full-user resolution on demand.
- Remove the duplicated auth checks (`orders`: 4× `Unauthorized`; `users`: in-handler 404) and the
  duplicated `findByIdOrCognitoSub` resolution across `users` use-cases.
- Preserve `orders` read paths' current behavior: no gRPC call for reads (filter by `cognito_sub`).

## Non-Goals

- Changing the identity model: `x-user-id` still carries the Cognito sub (or the `usr_` id in
  `users`). This does NOT introduce JWT parsing or change how the gateway injects the header (see
  [[ADR-0010-cognito-auth]]).
- Touching the `users` audit system: the `actorContext` (AsyncLocalStorage) + `runAsActor` that
  stamp Prisma audit columns are left INTACT — they solve a different problem (the singleton Prisma
  client can't reach the per-request Awilix scope). See [[audit-fields]].
- Changing any HTTP route or request/response shape — so neither service's `openapi.yaml` changes.
- Metrics/tracing or any observability change.

## Common Concept (both services)

A **request-scoped current-caller context** resolved once per request:

- **`identity`** — the raw Cognito sub from `x-user-id`, populated by the middleware. Always
  available once past the auth gate. Cheap.
- **`resolveUser()`** (lazy) — resolves the full user on first call and caches the result in the
  request scope, so multiple consumers in one request don't repeat the lookup:
  - `users`: local `db.user.findByIdOrCognitoSub(identity)`.
  - `orders`: gRPC `IUserDirectory.ResolveInternalUserIdAsync(sub)` → internal `usr_` id.

### Middleware enforces auth; centralized allowlist

The middleware **rejects with 401 when `x-user-id` is missing**, UNLESS the route is in a
**centralized, explicit public-route allowlist** (one per service). Matching is **exact
(method+path)** for fixed public routes, with a **prefix match only for `/v1/webhooks/*`** — so an
over-broad prefix can never accidentally exempt a protected route.

- **users** public routes: `GET /v1/health`, `POST /v1/users/login`, `POST /v1/users/register`,
  `POST /v1/users/refresh`, and `POST /v1/webhooks/*` (prefix). E2E routes when
  `E2E_TESTING_ENABLED`.
- **orders** public routes: `GET /v1/health`. E2E routes when `E2E_TESTING_ENABLED`.

Protected routes: the middleware has already guaranteed identity, so endpoints consume the caller
from the context with **no auth check of their own**. An endpoint calls `resolveUser()` only when it
actually needs the resolved user (e.g. the internal `usr_` id).

The allowlist lives as a single named constant/module per service. Adding a public route means
adding it there (documented) — the trade for removing per-endpoint checks.

## users — Fastify + Awilix

Current state: the `onRequest` hook (`routes.ts:182`) reads `x-user-id` once and stores it as a raw
string in `req.diScope.currentActor` and the `actorContext` ALS. Resolution
(`findByIdOrCognitoSub`) is deferred and duplicated in `get-me`, `getUserById`, and `update-profile`
— each re-runs the lookup from the string.

Changes:

- **Middleware:** extend the existing `onRequest` hook. It still populates `currentActor` and
  `actorContext` (audit untouched). It now additionally: checks the public-route allowlist against
  `req.routerPath`/`req.method`; if the route is not public and `x-user-id` is absent, it replies
  `401` and stops; otherwise it populates the new scoped context.
- **Scoped context:** a new request-scoped Awilix registration (e.g. `currentUser` on
  `req.diScope`) exposing `identity` (the raw sub) and `resolveUser()` — which calls
  `db.user.findByIdOrCognitoSub(identity)` once and caches the row in the scope.
- **Use-case refactor:** `getMe`, `getUserById`, and `update-profile` stop receiving the raw string
  and stop each re-running `findByIdOrCognitoSub`; they consume the resolved user from the scoped
  context (injected via Awilix). This removes the duplicated resolution across the three use-cases.
- **Audit intact:** `actorContext` (ALS) + `runAsActor` are unchanged; the hook keeps populating
  them from the same single header read.
- **Allowlist:** a constant in one module (e.g. `shared/http/public-routes.ts`).

Fastify note: `onRequest` runs before the route is fully resolved; the allowlist match uses
`req.routerPath` (the route template) + method. Verified during implementation.

## orders — .NET 10 Minimal APIs

Current state: no middleware/filter; `CallerIdentity.CognitoSub(ctx)` (a static helper) is called ad
hoc in four endpoints, each with its own `if (sub is null) return Results.Unauthorized()`. gRPC
resolution (sub → `usr_` id) happens only in the write path, inside `CreateOrderService`
(Infrastructure). No `IHttpContextAccessor`, no scoped caller abstraction.

Changes:

- **Middleware:** a new pipeline component in `Program.cs`, placed after
  `UseSerilogRequestLogging`. It checks the public-route allowlist; if the route is not public and
  `x-user-id` is missing, it short-circuits with `401`. Otherwise it sets the raw sub on the scoped
  caller. This removes the four duplicated `Unauthorized` checks.
- **Scoped context:** a new `Scoped` service `ICurrentCaller` / `CurrentCaller` with:
  - `CognitoSub` — the raw sub (always present past the gate).
  - `ResolveInternalUserIdAsync()` — **lazy**: calls `IUserDirectory.ResolveInternalUserIdAsync(sub)`
    once and caches the `usr_` id in the scope; throws `UnknownUserException` if the user doesn't
    exist (same as today).
  - **Populated by the middleware**, which resolves `ICurrentCaller` from
    `context.RequestServices` and sets the sub on it. No `IHttpContextAccessor` needed — explicit,
    traceable, testable in isolation.
- **Endpoint/service refactor:**
  - Write (`CreateOrderEndpoint` → `CreateOrderService`): the service consumes `ICurrentCaller` and
    calls `ResolveInternalUserIdAsync()` instead of receiving the sub as a string parameter and
    resolving gRPC internally. gRPC resolution still happens ONLY on the write path (lazy).
  - Reads (`OrderEndpoints` my-orders / by-id → `OrderReadService`): consume `CognitoSub` from the
    context (no gRPC, as today) instead of reading the header ad hoc.
  - `CallerIdentity` (static helper) is retired; its header read is absorbed into the
    middleware/context. The `e2e-cleanup` route that reads the header directly also goes through the
    context.
- **Clean Architecture preserved:** `ICurrentCaller` is an Api-layer (composition-root) abstraction;
  the `IUserDirectory` port stays in Application; the gRPC implementation stays in Infrastructure
  (see [[ADR-0003-grpc-inter-service]]). Dependency direction is unchanged.
- **GOLDEN RULE:** no route or request/response shape changes, so `orders/openapi.yaml` must NOT
  change — verified during implementation.

## Testing & Verification

### users (vitest)

- Extended hook: protected route without `x-user-id` → 401; public route (login, health) without
  header → passes; protected route with header → context populated.
- `resolveUser()` lazy: resolves once and caches (does not re-run `findByIdOrCognitoSub`).
- Regression: the current suite (140) stays green; audit (`actorContext`) still stamps identically.

### orders (xUnit + `OrdersApiFactory`)

- Middleware: protected endpoint without header → 401; `GET /v1/health` without header → 200; with
  header → resolves.
- `CurrentCaller.ResolveInternalUserIdAsync()` lazy: gRPC called once, cached; `UnknownUserException`
  when the user doesn't exist.
- Reads do not trigger gRPC: assert the `IUserDirectory` mock is NOT invoked for my-orders / by-id.
- Regression: the current suite (35) stays green; `openapi.yaml` unchanged (GOLDEN RULE).

### E2E

Both services start; an authenticated request flows end to end (create-order resolves the `usr_` id
via gRPC once; a read filters by `cognito_sub` with no gRPC); a request with no header returns 401.

## Risks & Open Points

- **users allowlist match key** — `onRequest` runs pre-routing; confirm `req.routerPath` yields the
  route template for the allowlist match (fallback: match on `req.url` path prefix carefully).
- **orders middleware ordering** — must run after Serilog request logging but before endpoint
  execution; confirm the scoped `ICurrentCaller` is resolvable from `context.RequestServices` at
  that point.
- **Lazy cache correctness** — `resolveUser()` / `ResolveInternalUserIdAsync()` must cache the
  first result (including a resolved-null vs thrown distinction) so repeat calls in one request
  don't re-hit the DB/gRPC.
- **E2E routes** — ensure flag-gated e2e routes are handled by the allowlist consistently with how
  they're mapped.

## Related

- [[ADR-0010-cognito-auth]]
- [[dependency-injection]]
- [[audit-fields]]
- [[ADR-0003-grpc-inter-service]]
