---
title: Orders API Gateway Integration Design
type: spec
area: infra
status: draft
created: 2026-07-15
updated: 2026-07-15
tags:
  - type/spec
  - area/infra
  - status/draft
related:
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[ADR-0009-apigw-alb-fargate]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[ADR-0017-floci-local]]"
  - "[[2026-07-11-local-gateway-per-route-integration-design]]"
  - "[[2026-07-11-gap1-nginx-njs-xuserid-design]]"
  - "[[orders-service-design]]"
  - "[[2026-07-14-orders-service-milestone-design]]"
  - "[[versioning]]"
  - "[[local-dev-floci]]"
---

# Orders API Gateway Integration Design

Design for integrating the Orders service into the existing local API Gateway → nginx reverse-proxy chain, so Orders is reachable through the front door (not just its direct `:3001` host port), routed by path prefix alongside Users. This spec also resolves the `/v1/health` collision between Users and Orders at the gateway.

## Summary

Integrate the Orders service into the existing local API Gateway → nginx reverse-proxy so Orders is reachable through the "real" front door (not just its direct `:3001` port), routed by path prefix alongside Users. This resolves a routing gap: today the gateway and nginx are wired exclusively to Users (built in the Users milestone JE-36, before Orders existed), and it resolves the `/v1/health` collision (both services expose `/v1/health`).

## Motivation / current state

- There is one API Gateway and one nginx (module `compute`, see [[ADR-0016-local-apigw-nginx-ecs]] and [[ADR-0009-apigw-alb-fargate]]). `module "compute"` sets `backend_service_name = "users"`, `backend_port = 3000` — a single backend. `nginx.conf` has one `location /` that `proxy_pass`es everything to `http://users:3000`, injecting identity via njs: `js_set $jwt_sub auth.jwtSub` → `proxy_set_header x-user-id $jwt_sub` (the Cognito sub — see [[2026-07-11-gap1-nginx-njs-xuserid-design]]).
- The gateway's route table (`api-gateway/main.tf` `local.routes`) is all Users routes (register/login/refresh/me + `health = { key = "GET /v1/health", path = "/v1/health", auth = false }`). There are no Orders routes.
- Consequence: `GET /v1/health` through the gateway hits Users (nginx proxies to `users:3000`). Orders' `/v1/health` is only reachable directly at `localhost:3001`, not via the gateway. No collision today only because Orders isn't routed at the gateway at all.
- Both services serve `/v1/health` unprefixed internally (Users' `routes.ts`, Orders' `OrderEndpoints.cs` `MapGet("/v1/health")`).

## Section 1 — Routing architecture

One gateway + one nginx (as today), but multi-backend by path prefix:

- nginx gains a `location /v1/orders/` that `proxy_pass`es to `http://orders:8080`, alongside the existing route to `users:3000`. The njs `x-user-id` injection applies to both locations — Orders needs the Cognito sub to resolve identity.
- The `compute` module goes from a single `backend_service_name`/`backend_port` to knowing two backends (`users:3000`, `orders:8080`). Parameterize it with a per-prefix backends structure (minimum viable: the two that exist; extensible to tracking/events later).
- The API Gateway (`api-gateway/main.tf`) adds Orders routes to its `routes` table: `POST /v1/orders`, `GET /v1/orders/my-orders`, `GET /v1/orders/{order_id}`, `GET /v1/orders/health`. Order write/read routes `auth = true` (Cognito); health `auth = false`. This follows the per-route `HTTP_PROXY` integration pattern established in [[2026-07-11-local-gateway-per-route-integration-design]].

## Section 2 — Health by prefix (nginx rewrite) + collision resolved

- The gateway exposes `/v1/users/health` and `/v1/orders/health`; since both services serve `/v1/health` unprefixed internally, nginx rewrites the path — the service is unchanged. `GET /v1/orders/health` at the gateway → HTTP_PROXY to `http://nginx-stable/v1/orders/health` (Floci bakes the path into the URI, like every local route) → nginx `location /v1/orders/` `proxy_pass`es to `http://orders:8080/v1/health`. Symmetric for `/v1/users/health` → `users:3000/v1/health`.
- So there is no shared `/v1/health` at the gateway anymore — the collision is gone. Each service's health is independently verifiable through the front door.
- Important rewrite nuance (to avoid a subtle bug): Orders' functional routes are **not** rewritten — `/v1/orders`, `/v1/orders/my-orders`, `/v1/orders/{id}` are the service's real paths, so nginx proxies them preserving the path. Only health is a special rewrite (`/v1/orders/health` → `/v1/health`), because the service doesn't serve health under its prefix. This must be commented clearly in `nginx.conf` so nobody "fixes" it by mistake.
- The gateway's current `/v1/health` route (which goes to Users today) is removed and replaced by `/v1/users/health`. Honest consequence: anything depending on `GET /v1/health` at the gateway (e.g. a test `.http` file, or a local Floci/ALB healthcheck) must point to `/v1/users/health` — verify at implementation and flag it as a contract change. The direct per-container health at `:3000`/`:3001` (used by ALB/Fargate for the container itself) does not change — that's separate from the gateway.

## Section 3 — Auth/identity of Orders routes + testing

**(a) Per-route auth (Cognito JWT):** `POST /v1/orders` auth=true; `GET /v1/orders/my-orders` auth=true; `GET /v1/orders/{order_id}` auth=true; `GET /v1/orders/health` auth=false. In prod, auth=true wires the Cognito JWT authorizer the `api-gateway` module already defines (see [[ADR-0010-cognito-auth]]). Locally Floci's authorizer doesn't truly validate (known limit — see [[ADR-0017-floci-local]]), but the flag is kept for prod parity.

**(b) Identity — the x-user-id:** nginx already injects `x-user-id = $jwt_sub` (Cognito sub, via njs) on everything it proxies (see [[2026-07-11-gap1-nginx-njs-xuserid-design]]). The new `location /v1/orders/` gets the same injection — Orders receives the Cognito sub in `x-user-id`, exactly what its `CallerIdentity` / gRPC resolution expects (see [[orders-service-design]], [[2026-07-14-orders-service-milestone-design]]). No change needed in the Orders service — the header it already consumes appears through the front door just as it did in the direct tests. This validates that Orders' identity design and the Users nginx pattern fit without friction.

**(c) Testing/validation:** static `terraform fmt/validate` on `compute` + `api-gateway` + `environments/local`. E2E (bootstrap + curl via gateway):
1. `GET /v1/users/health` via gateway → `{"status":"ok"}` (Users, after rewrite).
2. `GET /v1/orders/health` via gateway → `{"status":"ok"}` (Orders, after rewrite — proves the new backend route).
3. `POST /v1/orders` via gateway with a JWT → reaches Orders with `x-user-id` injected, creates the order (end-to-end front door + identity + gRPC to Users).
4. Users routes still work (no regression).

Update `.http` files that hit the old gateway `/v1/health` → `/v1/users/health`, add Orders-via-gateway ones (see [[local-dev-floci]]).

Honest limit: locally Floci's JWT authorizer doesn't truly validate (known quirk), so `x-user-id` locally comes from njs decoding the token without signature verification — real authorizer validation is prod-only, same as Users today. Not a regression; the current local stack state.

> [!note] Related lesson not yet in the vault
> A prior finding (`floci-no-claim-header-injection`, tracked in agent memory, not yet a vault note) documents that Floci's API GW never maps JWT/authorizer claims to a header across six local POCs, which is why nginx+njs decoding is the working local pattern (vs. relying on the gateway authorizer to inject claims). This spec assumes that finding; if/when it is written up as a vault note, link it here.

## Open questions

- Exact shape of the `compute` module's multi-backend variable (list of `{path_prefix, service, port}` vs a map) — decide at implementation.
- Whether the njs `x-user-id` injection should differ per-backend or stay identical — leaning identical (both need the Cognito sub); confirm.
- Whether removing the gateway's bare `/v1/health` breaks any existing local healthcheck (Floci/ALB/compose) — verify at implementation; if it does, keep a bare `/v1/health` alias too or repoint the checker.
- Orders' container port is 8080 (`ASPNETCORE_URLS`) — confirm at implementation that nginx targets `orders:8080` (not `3001`, which is the host-published port).

## Related

- [[ADR-0016-local-apigw-nginx-ecs]]
- [[ADR-0009-apigw-alb-fargate]]
- [[ADR-0010-cognito-auth]]
- [[ADR-0017-floci-local]]
- [[2026-07-11-local-gateway-per-route-integration-design]]
- [[2026-07-11-gap1-nginx-njs-xuserid-design]]
- [[orders-service-design]]
- [[2026-07-14-orders-service-milestone-design]]
- [[versioning]]
- [[local-dev-floci]]
