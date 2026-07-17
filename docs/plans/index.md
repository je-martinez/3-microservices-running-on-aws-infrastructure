---
title: 3MRAI Plans — Index
type: spec
area: shared
status: active
created: 2026-06-26
updated: 2026-07-16
tags: [type/spec, area/shared, status/active]
related:
  - "[[2026-06-26-implementation-workflow]]"
  - "[[2026-06-26-3mrai-docs-vault]]"
  - "[[documentation-vault-milestone]]"
  - "[[2026-06-28-services-infra-scaffold]]"
  - "[[services-infra-scaffold-milestone]]"
  - "[[2026-06-28-users-service]]"
  - "[[users-service-milestone]]"
  - "[[2026-07-09-users-cognito-webhook]]"
  - "[[2026-07-10-signoz-logs-observability]]"
  - "[[2026-07-10-openobserve-migration]]"
  - "[[2026-06-29-floci-local-emulator-spike]]"
  - "[[2026-07-03-git-workflow-decentralization]]"
  - "[[2026-07-03-local-dev-tooling]]"
  - "[[2026-07-04-je36-local-env-compose]]"
  - "[[2026-07-10-users-openapi-autogen]]"
  - "[[2026-07-11-auth-error-mapping]]"
  - "[[2026-07-11-byidorcognitosub]]"
  - "[[2026-07-11-gap1-nginx-njs-xuserid]]"
  - "[[2026-07-11-local-gateway-per-route-integration]]"
  - "[[2026-07-11-refresh-token-endpoint]]"
  - "[[2026-07-12-app-user-id-token-claim]]"
  - "[[2026-07-14-orders-service-milestone]]"
  - "[[orders-service-milestone]]"
  - "[[2026-07-15-orders-rds-mysql]]"
  - "[[2026-07-15-two-phase-post-effects]]"
  - "[[2026-07-15-orders-gateway-integration]]"
  - "[[2026-07-16-orders-for-update-interceptor]]"
---

# 3MRAI Plans — Index

Map of Content for implementation plans in the **3 Microservices Running on AWS Infrastructure (3MRAI)** vault. Plans are produced through `writing-plans` and kept under `docs/superpowers/plans/` (the plugin reads from there); they are normalized to vault conventions and indexed here.

## Plans

- [[2026-06-26-implementation-workflow]] — stand up the implementation-time agent topology (`solutions-architect` planner + five code-only implementers) and document the two-layer flow in the root `CLAUDE.md`.
- [[2026-06-26-3mrai-docs-vault]] — build the Obsidian documentation vault under `docs/` (folder skeleton, templates, cross-cutting notes, ADRs, service specs, infrastructure docs, Bases).
- [[documentation-vault-milestone]] — logical execution plan for the Documentation Vault milestone: task sequence, phases, and blocking dependency graph for JE-5 through JE-15.
- [[2026-06-28-services-infra-scaffold]] — scaffold the four microservices (Users, Orders, Tracking, events-pipeline) and Terraform/AWS infrastructure: folder skeletons, nested `CLAUDE.md` files, per-service `Dockerfile`, root `docker-compose.yml`, and skill discovery.
- [[services-infra-scaffold-milestone]] — logical execution plan for the Services & Infra Scaffold milestone: task sequence, phases, and blocking dependency graph for JE-17 through JE-23.
- [[2026-06-28-users-service]] — implementation plan for the Users Service milestone: pnpm tooling, Prisma schema, Fastify API, Terraform modules, and Playwright E2E suite.
- [[users-service-milestone]] — logical execution plan for the Users Service milestone: task sequence, phases, and blocking dependency graph for JE-25 through JE-37.
- [[2026-07-09-users-cognito-webhook]] — implementation plan for JE-38: Cognito identity webhook + identity tables (`UsersCognitoData`, `UsersCognitoEvent`), reachable via `POST /v1/webhooks/cognito` and in-process from `register()`.
- [[2026-07-10-signoz-logs-observability]] — implementation plan for SigNoz log observability: an OTel collector fed by Docker's fluentd driver (compose services) and the aws_cloudwatch receiver (ECS/RDS on Floci), exported to a self-hosted SigNoz, opt-in via the `observability` compose profile.
- [[2026-07-10-openobserve-migration]] — implementation plan to replace the blocked SigNoz backend with a self-hosted OpenObserve: one new compose service and a repointed OTel collector exporter (`otlp_http`/OpenObserve), log-capture pipeline unchanged.
- [[2026-06-29-floci-local-emulator-spike]] — implementation plan for the Floci local-emulator spike: a parallel Terraform stack + compose file validating the local auth chain and DNS service discovery on Floci, A/B against Ministack, no commits until a positive result is approved.
- [[2026-07-03-git-workflow-decentralization]] — implementation plan letting the main session run git directly instead of routing every write through `github-ops`, per [[git-workflow]].
- [[2026-07-03-local-dev-tooling]] — implementation plan for the root `Makefile` (local dev lifecycle orchestration) and `.http` files for exercising service endpoints.
- [[2026-07-04-je36-local-env-compose]] — implementation plan for JE-36: compose `environments/local` and applying the Users chain on Floci, including the Revision 2 emulation-gap fixes and least-privilege application DB user.
- [[2026-07-10-users-openapi-autogen]] — implementation plan to generate `services/users/openapi.yaml` from live Fastify routes via `@fastify/swagger` + Zod (`fastify-type-provider-zod`), with Zod imports migrated to the `zod/v4` subpath.
- [[2026-07-11-auth-error-mapping]] — implementation plan mapping Cognito auth exceptions to typed `AuthError`s (401 invalid credentials, 409 duplicate email) via a global `setErrorHandler`, without regressing existing 400/404 behavior.
- [[2026-07-11-byidorcognitosub]] — implementation plan for the shared `byIdOrCognitoSub` helper, used by `getMe`, gRPC `getUserById`, and `updateProfile` to resolve a user by either identifier; `PATCH /v1/users/me` now 404s on no match.
- [[2026-07-11-gap1-nginx-njs-xuserid]] — implementation plan for the local nginx+njs `x-user-id` injection: `auth.js` + `nginx.conf` bind-mounted into the local nginx ECS task via Terraform, local-only.
- [[2026-07-11-local-gateway-per-route-integration]] — implementation plan making the local API Gateway module data-driven (`local.routes` + `for_each`) with per-route `HTTP_PROXY` integrations on Floci, prod unchanged.
- [[2026-07-11-refresh-token-endpoint]] — implementation plan for `POST /v1/users/refresh`: `AuthProvider.refresh` → `RefreshTokenCommand` → public route, reusing the existing 401 error mapping.
- [[2026-07-12-app-user-id-token-claim]] — implementation plan adding the `custom:app_user_id` Cognito attribute, setting it at sign-up, and copying it into the `app_user_id` token claim via the repo's first Lambda (Pre-Token-Generation V2), without touching identity resolution.
- [[2026-07-14-orders-service-milestone]] — implementation plan for the Orders Service milestone: Users gRPC gate (shared .proto + @grpc/grpc-js server with x-api-key interceptor), then the Orders Clean Architecture .NET solution (EF Core/MySQL, money-in-cents, ownership-by-filter, transactional stock decrement) and its gRPC identity client.
- [[orders-service-milestone]] — logical execution plan for the Orders Service milestone: task sequence, phases, and blocking dependency graph for Phase A (Users gRPC gate), Phase B (Orders service), and Phase C (gRPC client + transactional POST).
- [[2026-07-15-orders-rds-mysql]] — implementation plan for the Orders MySQL database in the local Floci environment: a second engine-agnostic rds-aurora instantiation (engine=mysql), least-privilege orders_app user via bootstrap.sh (no DELETE), new outputs + ORDERS_DATABASE_URL in .env, and Orders booting against the real cluster.
- [[2026-07-15-two-phase-post-effects]] — implementation plan for the two-phase post-effects Terraform apply: a new environments/local/post/ root that reads phase-1 state + the master secret by ARN, waits for the DB, and creates least-privilege app-users via a new engine-parameterized db-app-user module (postgres locally, mysql prod-only), migrating users_app off bootstrap.sh.
- [[2026-07-15-orders-gateway-integration]] — implementation plan for routing the Orders service through the local API Gateway → nginx front door by path prefix (/v1/orders → orders:8080 with x-user-id injection), and resolving the /v1/health collision via per-service health (/v1/users/health, /v1/orders/health) with nginx rewrite.
- [[2026-07-16-orders-for-update-interceptor]] — implementation plan replacing the raw `FromSqlInterpolated(... FOR UPDATE)` product lock in Orders with a pure LINQ query tagged for a `DbCommandInterceptor` that appends `FOR UPDATE`, so EF Core's global soft-delete query filter applies automatically (ADR-0004).

> [!note] No plan note for the AuditActor enum
> [[2026-07-12-audit-actor-enum-design]] was implemented directly from the spec — there is no separate `writing-plans` plan for it.

## Related

- [[2026-06-26-implementation-workflow]]
- [[2026-06-26-3mrai-docs-vault]]
- [[documentation-vault-milestone]]
- [[2026-06-28-services-infra-scaffold]]
- [[services-infra-scaffold-milestone]]
- [[2026-06-28-users-service]]
- [[users-service-milestone]]
- [[2026-07-09-users-cognito-webhook]]
- [[2026-07-10-signoz-logs-observability]]
- [[2026-07-10-openobserve-migration]]
- [[2026-06-29-floci-local-emulator-spike]]
- [[2026-07-03-git-workflow-decentralization]]
- [[2026-07-03-local-dev-tooling]]
- [[2026-07-04-je36-local-env-compose]]
- [[2026-07-10-users-openapi-autogen]]
- [[2026-07-11-auth-error-mapping]]
- [[2026-07-11-byidorcognitosub]]
- [[2026-07-11-gap1-nginx-njs-xuserid]]
- [[2026-07-11-local-gateway-per-route-integration]]
- [[2026-07-11-refresh-token-endpoint]]
- [[2026-07-12-app-user-id-token-claim]]
- [[2026-07-14-orders-service-milestone]]
- [[orders-service-milestone]]
- [[2026-07-15-orders-rds-mysql]]
- [[2026-07-15-two-phase-post-effects]]
- [[2026-07-15-orders-gateway-integration]]
- [[2026-07-16-orders-for-update-interceptor]]
