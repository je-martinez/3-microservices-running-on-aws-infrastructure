---
title: "Users Service — Milestone Plan"
type: plan
area: users
status: active
created: 2026-06-28
updated: 2026-07-12
tags:
  - type/plan
  - area/users
  - status/active
  - milestone/users-service
  - issue/JE-25
  - issue/JE-26
  - issue/JE-27
  - issue/JE-28
  - issue/JE-29
  - issue/JE-30
  - issue/JE-31
  - issue/JE-32
  - issue/JE-33
  - issue/JE-34
  - issue/JE-35
  - issue/JE-36
  - issue/JE-37
  - issue/JE-38
  - issue/JE-39
  - issue/JE-40
related:
  - "[[milestone-plan]]"
  - "[[linear-references]]"
  - "[[2026-06-28-users-service-design]]"
  - "[[2026-06-28-users-service]]"
  - "[[ADR-0015-drawio-diagrams]]"
  - "[[2026-07-09-users-cognito-webhook-design]]"
  - "[[2026-07-10-users-openapi-autogen-design]]"
  - "[[2026-07-11-refresh-token-endpoint-design]]"
  - "[[2026-07-11-auth-error-mapping-design]]"
  - "[[2026-07-11-authenticated-identity-resolution-design]]"
  - "[[2026-07-11-gap1-nginx-njs-xuserid-design]]"
  - "[[2026-07-12-app-user-id-token-claim-design]]"
  - "[[2026-07-12-audit-actor-enum-design]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[cognito-pre-token-lambda]]"
---

# Users Service — Milestone Plan

This plan documents the logical execution order and blocking relationships for the **Users Service** milestone: taking the Users service from an empty scaffold to a working end-to-end slice, originally on Ministack and now on Floci (see [[ADR-0017-floci-local]]). The milestone covers pnpm workspace tooling, a Prisma schema with a new `tags` column, a Fastify API (`register`, `login`, `me`, `health`) behind a Cognito JWT authorizer on API Gateway, Terraform modules for the full AWS resource chain (Aurora Postgres, Cognito, networking, ECS Fargate, API Gateway + ALB/Nginx), and two layers of testing — Vitest unit tests inside the service and a root-level Playwright E2E suite that drives the stack through API Gateway using Chance for mock data. Live issue state is the source of truth in Linear — see the [3MRAI project](https://linear.app/je-martinez/project/3mrai-company-da39253a1d6f) for current milestone status. Individual issues are linked in the task sequence below. This note documents only structural design knowledge: task order and blocking relationships.

> [!warning] Hard dependency gate
> JE-25 (local emulator auth-chain spike) must pass before any infra module work (JE-28 onward) begins. If the spike fails, stop and escalate to the user — do not silently change topology.

This plan follows the [[milestone-plan]] convention. Detailed task content lives in the implementation plan [[2026-06-28-users-service]] and the design spec [[2026-06-28-users-service-design]].

> [!info] 2026-07-12 sync — scope grew past JE-25…JE-37
> This note originally tracked only JE-25 through JE-37 (frozen at 2026-06-28). The branch has since
> delivered three more Linear issues (JE-38, JE-39, JE-40) and a sizeable body of **post-JE-40 work
> that has no Linear issue at all** — typed auth errors, the refresh endpoint, OpenAPI autogen,
> identity resolution, the `app_user_id` claim, and the `AuditActor` enum. See
> "Phase — post-JE-37 (JE-38…JE-40)" and "Phase — post-JE-40 (no Linear issue)" below for what
> actually shipped.

## Logical phases

| Phase | Issues | Description |
|---|---|---|
| Spike | JE-25 | Local emulator auth-chain validation (API GW + Cognito authorizer + ALB→Fargate; originally Ministack, later re-verified on Floci). Hard gate. |
| pnpm tooling | JE-26, JE-27 | pnpm workspace root + Users pnpm package (`@3mrai/users`) with TypeScript + Vitest config |
| Domain logic | JE-29, JE-31, JE-33 | Prisma schema + Zod env + primitives; auth + domain entity + commands/queries; Fastify routes + DI + gRPC |
| Infra modules | JE-28, JE-30 | Terraform modules: label/networking/rds-aurora/cognito; compute (ECS Fargate) + api-gateway |
| Service packaging | JE-35 | pnpm Dockerfile + docker-compose wiring + `services/users/CLAUDE.md` update |
| Apply | JE-36 | `environments/local` composition + `terraform apply` (migrated Ministack → Floci mid-milestone, see [[ADR-0017-floci-local]]) + DB migration |
| Testing | JE-32, JE-37 | Playwright E2E harness (chancejs factory, setup/teardown); E2E specs (users flows through API Gateway) |
| Docs | JE-34 | Vault tags sync: add `tags` column to canonical users-service-design spec |
| Cognito identity webhook | JE-38 | Identity tables + `POST /v1/webhooks/cognito` + `CaptureCognitoIdentityCommand`; `cognitoSub` added to `User`. See [[2026-07-09-users-cognito-webhook-design]]. |
| Code-quality refactor | JE-39 | DI via Awilix, Prisma v7 client-extension pattern, TS module boundaries. Single branch, one PR (see [[2026-06-28-users-service-design]]). |
| JE-39 follow-up debt | JE-40 | Cleanup items identified during the JE-39 refactor review. |
| Post-JE-40 (no Linear issue) | — | `POST /v1/users/refresh`; typed auth errors + `setErrorHandler` (401/409); OpenAPI autogen from Zod route schemas; `byIdOrCognitoSub` identity resolution; nginx+njs `x-user-id` injection (Gap 1); `custom:app_user_id` claim + Pre-Token-Generation V2 Lambda; `AuditActor` enum + lazy-PrismaPromise/ALS fix. See the design specs listed in the phase detail below. |

## Task sequence

| # | Issue | Task | Deliverable | Spec note |
|---|---|---|---|---|
| 1 | [JE-25](https://linear.app/je-martinez/issue/JE-25) | Ministack auth-chain spike | Throwaway spike stack + smoke test (HARD GATE) | [[2026-06-28-users-service-design]] |
| 2 | [JE-26](https://linear.app/je-martinez/issue/JE-26) | pnpm workspace root | `package.json` + `pnpm-workspace.yaml` | [[2026-06-28-users-service-design]] |
| 3 | [JE-27](https://linear.app/je-martinez/issue/JE-27) | Users pnpm package | `@3mrai/users` (`tsconfig`, `vitest`) | [[2026-06-28-users-service-design]] |
| 4 | [JE-29](https://linear.app/je-martinez/issue/JE-29) | Prisma schema + Zod env + writer/reader + primitives | `schema.prisma`, env, db clients, nano-id / audit / `EventPublisher` | [[2026-06-28-users-service-design]] |
| 5 | [JE-31](https://linear.app/je-martinez/issue/JE-31) | Auth + domain + commands/queries | `CognitoAuthProvider`, `User` entity, `register` / `login` / `update-profile` / `get-me` / `get-user-by-id` | [[2026-06-28-users-service-design]] |
| 6 | [JE-33](https://linear.app/je-martinez/issue/JE-33) | Fastify routes + DI + server + e2e-cleanup + gRPC | `buildApp`, DI container, `server.ts`, `GetUserById` | [[2026-06-28-users-service-design]] |
| 7 | [JE-35](https://linear.app/je-martinez/issue/JE-35) | pnpm Dockerfile + compose + CLAUDE.md | `Dockerfile`, `docker-compose.yml` users wiring | [[2026-06-28-users-service-design]] |
| 8 | [JE-28](https://linear.app/je-martinez/issue/JE-28) | Terraform modules label/networking/rds-aurora/cognito | `infra/modules/*` (label, networking, rds-aurora, cognito) | [[2026-06-28-users-service-design]] |
| 9 | [JE-30](https://linear.app/je-martinez/issue/JE-30) | Terraform modules compute + api-gateway | `infra/modules/compute`, `infra/modules/api-gateway` | [[2026-06-28-users-service-design]] |
| 10 | [JE-36](https://linear.app/je-martinez/issue/JE-36) | environments/local + apply + migrate | `infra/environments/local`, applied chain + DB migration | [[2026-06-28-users-service-design]] |
| 11 | [JE-32](https://linear.app/je-martinez/issue/JE-32) | Playwright harness | `e2e/` package + chancejs factory + setup/teardown | [[2026-06-28-users-service-design]] |
| 12 | [JE-37](https://linear.app/je-martinez/issue/JE-37) | E2E specs | `e2e/tests/users.spec.ts` | [[2026-06-28-users-service-design]] |
| 13 | [JE-34](https://linear.app/je-martinez/issue/JE-34) | Vault tags sync | `docs/domains/users/specs/users-service-design.md` | [[2026-06-28-users-service-design]] |

## Dependencies

### Dependency table

| Task | Blocked by |
|---|---|
| JE-25 | — |
| JE-26 | — |
| JE-27 | JE-26 |
| JE-29 | JE-27 |
| JE-31 | JE-29 |
| JE-33 | JE-31 |
| JE-35 | JE-33 |
| JE-28 | JE-25 |
| JE-30 | JE-28 |
| JE-36 | JE-35, JE-30, JE-29 |
| JE-32 | JE-26 |
| JE-37 | JE-36, JE-32 |
| JE-34 | JE-29 |

### Dependency diagram

![[users-service-deps.drawio.svg]]

JE-25 (Ministack spike) is the hard escalation gate for the infra chain: JE-28 cannot start until the spike passes. The pnpm toolchain (JE-26 → JE-27) and the spike run in parallel. The domain logic chain (JE-27 → JE-29 → JE-31 → JE-33 → JE-35) feeds into JE-36 (apply), which also requires the infra modules chain (JE-28 → JE-30) and JE-29 (for the DB migration URL). The Playwright harness (JE-32) can start right after JE-26 is done and joins JE-37 only after JE-36 applies the full stack. JE-34 (vault tags sync) is an independent docs task that only needs JE-29 for the schema definition.

## Related

- [[milestone-plan]] — convention this plan follows.
- [[linear-references]] — Linear reference convention.
- [[2026-06-28-users-service-design]] — the design spec specifying each deliverable.
- [[2026-06-28-users-service]] — the implementation plan with detailed task steps.
- [[ADR-0015-drawio-diagrams]] — governs the `.drawio.svg` diagram format.
