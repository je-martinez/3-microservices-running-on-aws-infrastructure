---
title: "Users Service — Milestone Plan"
type: plan
area: users
status: active
created: 2026-06-28
updated: 2026-07-02
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
related:
  - "[[milestone-plan]]"
  - "[[linear-references]]"
  - "[[2026-06-28-users-service-design]]"
  - "[[2026-06-28-users-service]]"
  - "[[2026-06-29-users-cognito-webhook-design]]"
  - "[[ADR-0015-drawio-diagrams]]"
---

# Users Service — Milestone Plan

This plan documents the logical execution order and blocking relationships for the **Users Service** milestone: taking the Users service from an empty scaffold to a working end-to-end slice on Ministack. The milestone covers pnpm workspace tooling, a Prisma schema with a new `tags` column, a Fastify API (`register`, `login`, `me`, `health`) behind a Cognito JWT authorizer on API Gateway, Terraform modules for the full AWS resource chain (Aurora Postgres, Cognito, networking, ECS Fargate, API Gateway + ALB), and two layers of testing — Vitest unit tests inside the service and a root-level Playwright E2E suite that drives the stack through API Gateway using Chance for mock data. Live issue state is the source of truth in Linear — see the [3MRAI project](https://linear.app/je-martinez/project/3mrai-company-da39253a1d6f) for current milestone status. Individual issues are linked in the task sequence below. This note documents only structural design knowledge: task order and blocking relationships.

> [!warning] Hard dependency gate
> JE-25 (Ministack spike) must pass before any infra module work (JE-28 onward) begins. If the spike fails, stop and escalate to the user — do not silently change topology.

This plan follows the [[milestone-plan]] convention. Detailed task content lives in the implementation plan [[2026-06-28-users-service]] and the design spec [[2026-06-28-users-service-design]].

## Logical phases

| Phase | Issues | Description |
|---|---|---|
| Spike | JE-25 | Ministack auth-chain validation (API GW + Cognito authorizer + ALB→Fargate). Hard gate. |
| pnpm tooling | JE-26, JE-27 | pnpm workspace root + Users pnpm package (`@3mrai/users`) with TypeScript + Vitest config |
| Domain logic | JE-29, JE-31, JE-33 | Prisma schema + Zod env + primitives; auth + domain entity + commands/queries; Fastify routes + DI + gRPC |
| Infra modules | JE-28, JE-30 | Terraform modules: label/networking/rds-aurora/cognito; compute (ECS Fargate) + api-gateway |
| Service packaging | JE-35 | pnpm Dockerfile + docker-compose wiring + `services/users/CLAUDE.md` update |
| Apply | JE-36 | `environments/local` composition + `terraform apply` against Ministack + DB migration |
| Testing | JE-32, JE-37 | Playwright E2E harness (chancejs factory, setup/teardown); E2E specs (users flows through API Gateway) |
| Docs | JE-34 | Vault tags sync: add `tags` column to canonical users-service-design spec |

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
| 14 | [JE-38](https://linear.app/je-martinez/issue/JE-38) | Cognito identity webhook + identity tables | `POST /v1/webhooks/cognito` + `users_cognito_data` / `users_cognito_events` tables (Prisma migration) | [[2026-06-29-users-cognito-webhook-design]] |

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
| JE-37 | JE-36, JE-32, JE-38 |
| JE-34 | JE-29 |
| JE-38 | JE-29 |

### Dependency diagram

![[users-service-deps.drawio.svg]]

*Diagram not yet updated for JE-38 — will be out of sync until regenerated.*

JE-25 (Ministack spike) is the hard escalation gate for the infra chain: JE-28 cannot start until the spike passes. The pnpm toolchain (JE-26 → JE-27) and the spike run in parallel. The domain logic chain (JE-27 → JE-29 → JE-31 → JE-33 → JE-35) feeds into JE-36 (apply), which also requires the infra modules chain (JE-28 → JE-30) and JE-29 (for the DB migration URL). The Playwright harness (JE-32) can start right after JE-26 is done and joins JE-37 only after JE-36 applies the full stack. JE-34 (vault tags sync) is an independent docs task that only needs JE-29 for the schema definition. JE-38 (Cognito identity webhook) was inserted after the original milestone design: it depends on JE-29 (Prisma schema) and now blocks JE-37, since the E2E suite is being reworked to verify webhook persistence instead of merging the original PR.

## Related

- [[milestone-plan]] — convention this plan follows.
- [[linear-references]] — Linear reference convention.
- [[2026-06-28-users-service-design]] — the design spec specifying each deliverable.
- [[2026-06-28-users-service]] — the implementation plan with detailed task steps.
- [[2026-06-29-users-cognito-webhook-design]] — design spec for JE-38 (Cognito identity webhook + identity tables).
- [[ADR-0015-drawio-diagrams]] — governs the `.drawio.svg` diagram format.
