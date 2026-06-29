---
title: Users Service Implementation — Design
type: spec
area: users
status: active
created: 2026-06-28
updated: 2026-06-28
tags:
  - type/spec
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
related:
  - "[[users-service-design]]"
  - "[[2026-06-28-services-infra-scaffold-design]]"
  - "[[aws-resources]]"
  - "[[terraform-modules]]"
  - "[[networking]]"
  - "[[screaming-architecture]]"
  - "[[cqrs]]"
  - "[[dependency-injection]]"
  - "[[soft-delete]]"
  - "[[nano-id]]"
  - "[[audit-fields]]"
  - "[[db-naming]]"
  - "[[versioning]]"
  - "[[ADR-0001-terraform-cloudposse-naming]]"
  - "[[ADR-0006-read-write-replicas]]"
  - "[[ADR-0007-secrets-parameter-store]]"
  - "[[ADR-0009-apigw-alb-fargate]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[ADR-0012-ministack-local]]"
---

# Users Service Implementation — Design

## Summary

This milestone takes the Users service from an empty scaffold to a working end-to-end
slice on the local AWS substrate (Ministack). It provisions the AWS resources the service
needs (Aurora PostgreSQL, Cognito, networking, ECS Fargate, API Gateway + ALB) via the
custom Terraform modules; migrates the repo's JS tooling to **pnpm** (root workspace +
Users service); implements the Prisma schema (including a new `tags text[]` column);
builds the Fastify API (`register`, `login`, `me`, `health`); and establishes two layers
of testing — **Vitest** unit tests inside the service and a root-level **Playwright** E2E
suite that drives the stack through the API Gateway using **Chance** for mock data.

It realizes the contract already described in the canonical service spec
[[users-service-design]] and the infra specs [[aws-resources]] / [[terraform-modules]] /
[[networking]]. Where this implementation spec adds *new* decisions on top of those, they
are called out explicitly below (the `tags` field, the E2E origin marking, pnpm, and the
testing strategy).

---

## Scope

### In scope
- **Infra (Terraform, local/Ministack):** implement and instantiate the `label`,
  `networking`, `rds-aurora`, `cognito`, `compute` (ECS service), and `api-gateway` (+ ALB)
  modules under `environments/local`.
- **Request chain:** API Gateway (Cognito JWT authorizer) → ALB → Fargate (`users`
  container) → Aurora PostgreSQL. This is the full, production-shaped chain emulated
  locally.
- **pnpm migration:** root `pnpm-workspace.yaml` (members: `e2e/`, `services/users`),
  corepack-pinned `packageManager`, and the Users service (`package.json`, lockfile,
  Dockerfile, nested `CLAUDE.md`).
- **Schema + DB:** Prisma `users` model with the new `tags text[]` column; writer/reader
  split; initial migration run against Ministack's Aurora Postgres.
- **API:** Fastify endpoints under `/v1` — `register`, `login`, `me` (GET/PATCH),
  `health`, plus the `GetUserById` gRPC method; E2E origin marking; a flag-gated admin
  cleanup endpoint.
- **Testing:** Vitest unit tests (Users); Playwright E2E suite (root) with Chance mock
  data and tag-based cleanup.

### Out of scope (deferred)
- **SQS `USER_CREATED`:** the emission *point* exists in code as a **no-op**
  `EventPublisher`; the SQS resource is **not** provisioned this milestone.
- **`production` environment:** modules are written to be reusable, but only
  `environments/local` is instantiated.
- **Other Node services** (orders, events-pipeline) joining the pnpm workspace — done in
  their own milestones (YAGNI).
- Real CloudWatch/SigNoz wiring.

---

## Architecture

```
Playwright (root e2e/)
      │ HTTP (API Gateway URL)
      ▼
API Gateway ──(Cognito JWT authorizer)──► ALB ──► Fargate (users container) ──► Aurora Postgres
                                                          │                         (writer / reader)
                                                          └─ register ─► EventPublisher.publishUserCreated()  ← NO-OP
```

- **Auth lives at the edge.** The Cognito JWT authorizer is configured on the **API
  Gateway** (see [[ADR-0009-apigw-alb-fargate]], [[ADR-0010-cognito-auth]]). The service
  does **not** re-validate JWTs for protected routes; it trusts the identity/claims passed
  through by the gateway.
- `POST /users/register` and `POST /users/login` talk to **Cognito directly** (create
  user, authenticate via `USER_PASSWORD_AUTH`, return tokens). `GET/PATCH /users/me` sit
  behind the authorizer.
- **Local = production in shape.** The same chain runs locally against Ministack
  ([[ADR-0012-ministack-local]]).

### Ministack risk + mitigation
The Cognito JWT authorizer on API Gateway and the ALB→Fargate hop are the most fragile
emulated pieces. Ministack is documented to support Cognito (incl. `USER_PASSWORD_AUTH` /
`ADMIN_USER_PASSWORD_AUTH`), API Gateway v1/v2 HTTP forwarding, JWT/JWKS, and real
Postgres RDS — but the *authorizer end-to-end* is unverified.

**Mitigation — Ministack spike first.** The milestone's first work item is a minimal
Terraform stack (API GW + Cognito authorizer + ALB → a trivial "hello" Fargate container)
plus a smoke test proving a Cognito-issued JWT traverses the full chain. **If the spike
fails, stop and escalate to the user** — do not silently fall back to a different
topology.

---

## Component detail

### 1. Infra / Terraform modules (local)

Implements the empty module folders and instantiates them in `environments/local`. All
naming via `cloudposse/label/null` (`module.label.id`, e.g. `3mrai-local-users`) per
[[ADR-0001-terraform-cloudposse-naming]] and [[terraform-modules]].

| Module | Provisions (local) | Notes |
|---|---|---|
| `modules/label` | `cloudposse/label/null` context | Naming/tagging root |
| `modules/networking` | VPC, subnets, security groups | Network for ALB/Fargate; see [[networking]] |
| `modules/rds-aurora` | Aurora Postgres cluster: **writer + reader** endpoints | [[ADR-0006-read-write-replicas]]; DB user has **no `DELETE`** privilege ([[soft-delete]]) |
| `modules/cognito` | User Pool + App Client (`USER_PASSWORD_AUTH`) | [[ADR-0010-cognito-auth]]; issues the JWT the authorizer validates |
| `modules/compute` (ecs-service) | Fargate cluster + service + task def for `users` | Health check target `GET /v1/health` |
| `modules/api-gateway` | API Gateway + **Cognito JWT authorizer** + integration → ALB → target group → Fargate | [[ADR-0009-apigw-alb-fargate]]; the authorizer is what the spike validates |

- Every module exposes `name` / `arn` / `tags`; sensitive outputs marked `sensitive`.
- DB credentials live in **Secret Manager** ([[ADR-0007-secrets-parameter-store]]),
  injected into the container at start — never in plaintext task-def env. Local secrets
  may be test values.
- **Validation:** `terraform fmt -recursive`, `terraform validate`, `terraform apply`
  against Ministack in `environments/local`.
- **SQS is not provisioned** (emission is no-op in code).

### 2. pnpm migration

- **Root:** `pnpm-workspace.yaml` with members `e2e/` and `services/users`. Other Node
  services join in their own milestones.
- **Version pinning:** `packageManager: "pnpm@<version>"` in the root `package.json`
  (corepack). `.nvmrc` (Node 24.18.0) unchanged.
- **Users service:** `package.json` scripts (`build`, `test`, `lint`, `prisma migrate`)
  via pnpm; `pnpm-lock.yaml`; **Dockerfile** switched to `corepack enable` +
  `pnpm install --frozen-lockfile`, multi-stage, compatible with compose `--watch`.
- **docker-compose.yml:** adjust only the `users` service build as needed for pnpm; other
  services untouched.
- **`services/users/CLAUDE.md`:** update the Commands section (`npm ci` →
  `pnpm install --frozen-lockfile`, `npx prisma` → `pnpm prisma`, etc.).

> **Process note.** `services/users/CLAUDE.md` and `infra/CLAUDE.md` are repo
> project-memory, **not** vault notes under `docs/`, so they do **not** route through the
> `obsidian-vault` agent — they are edited by the relevant implementer / parent.

### 3. Schema + DB (Prisma)

Table `users`, columns in `snake_case` with PascalCase app aliases ([[db-naming]]):

| Column | Postgres type | Prisma | Notes |
|---|---|---|---|
| `id` | `varchar` | `String @id` | prefixed nano ID `usr_…` ([[nano-id]]) |
| `email` | `varchar` | `String @unique` | not null |
| `full_name` | `varchar` | `String` | → `fullName` |
| `address` | `jsonb` | `Json?` | structured address object |
| `phone_number` | `varchar` | `String?` | |
| **`tags`** | **`text[]`** | **`String[]`** | **NEW**; default `[]`; carries `"E2E Source"` when applicable |
| `created_by` / `created_at` | `varchar` / `timestamptz` | audit | [[audit-fields]] |
| `updated_by` / `updated_at` | `varchar` / `timestamptz` | audit | |
| `deleted_by` / `deleted_at` | `varchar` / `timestamptz` | audit | `deleted_at` null = active ([[soft-delete]]) |

- **`tags`** defaults to `[]` and is written **only** by the persistence layer / endpoint,
  never by the client directly. The `"E2E Source"` mark is injected server-side (see
  component 4).
- **Read/write split ([[ADR-0006-read-write-replicas]]):** two PrismaClients (writer,
  reader) in `shared/db`, injected via DI. Commands → writer; queries → reader.
- **Soft-delete only:** no `DELETE`; `deletedAt`/`deletedBy` + computed `isDeleted`.
- **Migration:** `prisma migrate` produces the initial migration (table `users` incl.
  `tags`), run against Ministack's Aurora Postgres.
- **Vault update:** add the `tags` row to the Data Model table in [[users-service-design]]
  (via the `obsidian-vault` agent, keeping frontmatter/wikilinks/validation intact).

### 4. API (Fastify)

Screaming architecture + CQRS + DI ([[screaming-architecture]], [[cqrs]],
[[dependency-injection]]), under `src/features/users/`:

- `commands/` → `register`, `login`, `update-profile` (writer)
- `queries/` → `get-me`, `GetUserById` (gRPC) (reader)
- `domain/` → `User` entity, value objects, db-naming mapping
- `grpc/` → `GetUserById`
- `shared/` → `config` (Zod), `db` (writer/reader), `di`, `audit`, `messaging`
  (`EventPublisher` no-op)

Endpoints (all under `/v1`, see [[versioning]]):

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/users/register` | public | creates in Cognito + DB; `EventPublisher.publishUserCreated()` **no-op**; applies E2E origin marking |
| `POST` | `/users/login` | public | Cognito `USER_PASSWORD_AUTH`; returns tokens |
| `GET` | `/users/me` | gateway authorizer | reads claims from the gateway-passed JWT |
| `PATCH` | `/users/me` | gateway authorizer | updates profile |
| `GET` | `/health` | public | `{ "status": "ok" }` for ALB/Fargate health check |
| `DELETE` | `/users/e2e-cleanup` | flag-gated | **only exists/responds when `E2E_TESTING_ENABLED=true`**; soft-deletes all users tagged `"E2E Source"` (see component 5) |

gRPC: `GetUserById({ id }) → User` for inter-service lookups.

**E2E origin marking.** On `register`, if request header `X-E2E-Source: true` **and** env
`E2E_TESTING_ENABLED=true` (Zod-validated; **off in production**), the server appends
`"E2E Source"` to `tags`. If the flag is off, the header is ignored. The client never
writes `tags` directly.

**Auth.** The service does not validate JWTs itself on `/me`; it trusts the API Gateway
authorizer and reads claims. `login`/`register` call Cognito directly.

### 5. Testing

#### 5a. Unit — Vitest (in `services/users`)
- Vitest runner; pnpm scripts (`pnpm test`, `pnpm test:watch`); `vitest.config.ts`.
- Covers (no real network/DB): domain entity/value objects + db-naming mapping +
  `isDeleted` derivation; commands/queries with DI-mocked dependencies (writer/reader,
  auth/Cognito, no-op `EventPublisher`); Zod env config (incl. `E2E_TESTING_ENABLED`).
- Key behaviors asserted: `register` adds `"E2E Source"` **only** when header + flag are
  both active; ignores the header when the flag is off; `publishUserCreated` is invoked
  but does nothing.
- Out of unit scope: real Cognito, real DB, real network (covered by E2E).

#### 5b. E2E — Playwright (root `e2e/`)
- `e2e/` is a pnpm workspace package; `playwright.config.ts` at its root.
- **Startup:** `globalSetup` runs `docker compose up`, waits for health (Ministack healthy
  + service `GET /v1/health`); specs hit the **API Gateway URL** (not the container
  directly).
- **Mock data:** the **`chance`** npm package (chancejs,
  <https://www.npmjs.com/package/chance>) generates users (email, name, phone, address);
  Chance seeded per run for reproducibility; emails made unique (timestamp/uuid) to avoid
  cross-run collisions.
- **E2E marking:** each user is created with `X-E2E-Source: true` against an environment
  where `E2E_TESTING_ENABLED=true`, so it receives tag `"E2E Source"`.
- **Specs (Users scope):** `register` → 201, persisted with `E2E Source`; `login` → valid
  Cognito tokens; `me` (GET/PATCH) **through the API Gateway with a real JWT** (this
  exercises the authorizer end-to-end — enabled by the infra spike); `health` → 200.
- **Teardown:** `globalTeardown` calls `DELETE /v1/users/e2e-cleanup`, which soft-deletes
  (`deletedAt`/`deletedBy`) every user tagged `"E2E Source"`. Goes through the real API,
  respects soft-delete-only, and keeps Playwright decoupled from the DB schema/credentials.

---

## Sequencing & dependency gates

Per [[phase-c-review-flow]], work is chained without per-merge prompts and stops at
dependency gates for batch review.

1. **Ministack spike** (infra) — validate API GW + Cognito authorizer + ALB→Fargate.
   **Hard gate / stop point:** if it fails, escalate to the user before continuing.
2. **pnpm migration** (root + Users) — independent of the API; can proceed in parallel
   with infra once the spike passes.
3. **Infra modules** (rds-aurora, cognito, networking, compute, api-gateway) instantiated
   in `environments/local`. Depends on the spike's findings.
4. **Schema + DB** (Prisma, migration). Depends on rds-aurora being provisioned.
5. **API** (Fastify endpoints, E2E marking, cleanup endpoint, no-op EventPublisher).
   Depends on schema + cognito.
6. **Unit tests** (Vitest) — alongside the API.
7. **E2E tests** (Playwright) — last; depends on the full chain (infra + API + DB).

---

## Cross-cutting rules (referenced, not duplicated)

| Rule | Reference |
|---|---|
| cloudposse/label naming | [[ADR-0001-terraform-cloudposse-naming]] |
| Read/write replicas | [[ADR-0006-read-write-replicas]] |
| Secrets vs Parameter Store | [[ADR-0007-secrets-parameter-store]] |
| API GW → ALB → Fargate | [[ADR-0009-apigw-alb-fargate]] |
| Cognito auth | [[ADR-0010-cognito-auth]] |
| Ministack local substrate | [[ADR-0012-ministack-local]] |
| Soft delete only | [[soft-delete]] |
| Prefixed nano IDs | [[nano-id]] |
| Audit fields | [[audit-fields]] |
| snake_case ↔ PascalCase | [[db-naming]] |
| CQRS | [[cqrs]] |
| Screaming architecture + DI | [[screaming-architecture]], [[dependency-injection]] |
| API versioning | [[versioning]] |

## Open questions / risks

- **Ministack authorizer fidelity** — primary risk; gated by the spike.
- **ALB→Fargate emulation** — validated together with the authorizer in the spike.
- **pnpm + docker-compose `--watch`** — confirm the multi-stage pnpm Dockerfile plays well
  with sync-based live reload.

## Related

- [[users-service-design]]
- [[2026-06-28-services-infra-scaffold-design]]
- [[aws-resources]]
- [[terraform-modules]]
- [[networking]]
- [[phase-c-review-flow]]
- [[ADR-0009-apigw-alb-fargate]]
- [[ADR-0010-cognito-auth]]
- [[ADR-0012-ministack-local]]
