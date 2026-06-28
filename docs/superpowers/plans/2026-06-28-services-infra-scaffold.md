---
title: 3MRAI Services & Infra Scaffold + Skill Discovery — Plan
type: plan
area: shared
status: active
created: 2026-06-28
updated: 2026-06-28
tags: [type/plan, area/shared, status/active]
related:
  - "[[2026-06-28-services-infra-scaffold-design]]"
  - "[[2026-06-26-implementation-workflow-design]]"
  - "[[index]]"
---

# 3MRAI Services & Infra Scaffold + Skill Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the physical base of the four microservices (Users, Orders, Tracking, events-pipeline) plus the Terraform/AWS infrastructure — folder skeletons, nested `CLAUDE.md` files, per-service `Dockerfile`, and a root `docker-compose.yml` orchestrator — so the existing global implementer agents have the nested context they expect, and catalog the candidate skills for a later, confirmation-gated install.

**Architecture:** Pure scaffolding, no application code. Each service gets a screaming-architecture folder tree (top-level folders name the domain, not the framework) with `.gitkeep` in every leaf, a complete nested `CLAUDE.md` (source of truth for that service's stack, referencing the shared vault conventions by wikilink), an empty `.claude/` extension point, and a skeleton `Dockerfile`. A root `docker-compose.yml` brings the four services up on one network with docker-watch. The five implementer agents stay GLOBAL in root `.claude/agents/` (not relocated — user directive); per-service scoping holds de-facto via agent name/description plus the nested `CLAUDE.md`.

**Tech Stack:** Filesystem scaffolding only. Services target Fastify (Users), .NET Core 10 Minimal APIs (Orders), FastAPI (Tracking), SQS→Lambda/DocumentDB (events-pipeline); infra targets Terraform + cloudposse/label + AWS. Docker Compose for local dev. No package managers run, no code compiled. Source of truth: `docs/superpowers/specs/2026-06-28-services-infra-scaffold-design.md`.

## Global Constraints

- **No real code (YAGNI, from the spec "what this milestone does NOT do"):** leaf folders get `.gitkeep` only — no commented entrypoints, no `package.json`, no real build config. Only `CLAUDE.md`, `Dockerfile`, `docker-compose.yml`, `.gitkeep`, and the `infra/README.md` are real files.
- **Do not relocate or duplicate agents:** implementer agents stay in root `.claude/agents/`. Each service's `.claude/` folder is created EMPTY (it needs a `.gitkeep` so git tracks it) as a future extension point — do NOT put agent files in it.
- **Screaming architecture:** top-level `src/` folders name the domain (e.g. `features/users/`), with CQRS `commands/`+`queries/` split, plus a `shared/` area. Mirror the exact trees in the spec section "Screaming-architecture skeleton — per service".
- **Nested `CLAUDE.md` is complete:** every nested `CLAUDE.md` contains the six required sections from the spec ("Nested CLAUDE.md — required content per file"): (1) Stack & versions, (2) Commands build/test/lint/run-local/migrate, (3) Folder structure tree, (4) Conventions BY REFERENCE via wikilinks (never duplicated), (5) Agent rules (Spanish with user / English in code / code-only, never git or Linear), (6) Pointer to the service's vault spec note.
- **Conventions are referenced, never duplicated:** nested `CLAUDE.md` links the shared vault notes by relative path (e.g. `../../docs/shared/patterns/screaming-architecture.md`) — it does NOT restate the rules. Wikilinks resolve inside the vault; from a nested `CLAUDE.md` use the relative file path so the link is also clickable from the service folder.
- **Language:** all file content in **English**; converse with the user in **Spanish** (repo convention).
- **Date** for any `created`/`updated` frontmatter (the plan/spec notes only — `CLAUDE.md`/Docker files have no frontmatter): **2026-06-28**.
- **Git policy (repo `CLAUDE.md`):** do NOT commit on your own initiative. Each task ends by proposing a Conventional-Commits message and leaving work in the tree; the user confirms; commits are routed through `github-ops`. Implementers never run git.
- **Agent assignment (from the spec "Implementation order"):** Task 1→`users-impl`, Task 2→`orders-impl`, Task 3→`tracking-impl`, Task 4→`events-pipeline-impl`, Task 5→`infra-impl`, Task 6→`infra-impl` or parent, Task 7→parent (skill discovery).
- **Verification model:** this milestone creates structure, not logic — there are no unit tests. Each task's "test" is a structural check: the expected files/folders exist, `.gitkeep` is present in every leaf, and (Task 6) `docker compose config` parses. Run service-relevant checks from the repo root.

---

### Task 1: Users service scaffold + CLAUDE.md (`users-impl`)

**Files:**
- Create: `services/users/CLAUDE.md`
- Create: `services/users/Dockerfile`
- Create: `services/users/.claude/.gitkeep`
- Create (`.gitkeep` in each leaf): `services/users/src/features/users/{commands,queries,domain,grpc}/.gitkeep`, `services/users/src/shared/{config,db,di,audit,messaging}/.gitkeep`, `services/users/prisma/.gitkeep`, `services/users/tests/.gitkeep`

**Interfaces:**
- Consumes: spec section "services/users/" (tree + domain notes); shared conventions in `docs/shared/`.
- Produces: the `services/users/` folder layout and a complete `CLAUDE.md` that `users-impl` will read in future milestones. Establishes the per-service `CLAUDE.md` shape reused by Tasks 2–5.

- [ ] **Step 1: Create the folder skeleton with `.gitkeep` leaves**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p services/users/.claude \
  services/users/src/features/users/{commands,queries,domain,grpc} \
  services/users/src/shared/{config,db,di,audit,messaging} \
  services/users/prisma services/users/tests
touch services/users/.claude/.gitkeep \
  services/users/src/features/users/{commands,queries,domain,grpc}/.gitkeep \
  services/users/src/shared/{config,db,di,audit,messaging}/.gitkeep \
  services/users/prisma/.gitkeep services/users/tests/.gitkeep
```

- [ ] **Step 2: Verify the tree matches the spec**

Run: `find services/users -type f | sort`
Expected: every `.gitkeep` listed above is present (12 `.gitkeep` files: 1 in `.claude/`, 4 feature, 5 shared, prisma, tests), and no extra files yet.

- [ ] **Step 3: Write `services/users/Dockerfile` (skeleton, commented)**

```dockerfile
# Users service — Fastify + Node 24 (pinned via repo .nvmrc).
# Skeleton only: the real build is added in the Users implementation milestone.
# Local dev runs via docker-watch (see root docker-compose.yml `develop.watch`).
FROM node:24-alpine AS base
WORKDIR /app
# COPY package*.json ./
# RUN npm ci
# COPY . .
# EXPOSE 3000
# CMD ["node", "src/server.js"]
```

- [ ] **Step 4: Write `services/users/CLAUDE.md` (complete, 6 required sections)**

```markdown
# CLAUDE.md — Users service

Nested project memory for the **Users** microservice. Source of truth for this
service's stack and conventions. The global `users-impl` agent reads this first,
every time. Cross-cutting rules are **referenced**, never duplicated.

## 1. Stack & versions
- Runtime: Node.js (repo-pinned via `.nvmrc`, currently 24.18.0 — run `nvm use`).
- Framework: Fastify.
- Database: Aurora Postgres (read + write replicas).
- ORM: Prisma.
- Env validation: Zod.

## 2. Commands
- Install: `nvm use && npm ci`
- Build: `npm run build`
- Test: `npm test`
- Lint: `npm run lint`
- Run local (docker-watch): `docker compose up users --watch` (from repo root)
- Migrate: `npx prisma migrate dev`

> These commands are the intended contract; the scripts themselves are created
> in the Users implementation milestone.

## 3. Folder structure (screaming architecture)
\`\`\`
services/users/
├── src/features/users/{commands,queries,domain,grpc}/
├── src/shared/{config,db,di,audit,messaging}/
├── prisma/
└── tests/
\`\`\`

## 4. Conventions (referenced, never duplicated)
- Screaming architecture + DI: [../../docs/shared/patterns/screaming-architecture.md](../../docs/shared/patterns/screaming-architecture.md), [../../docs/shared/patterns/dependency-injection.md](../../docs/shared/patterns/dependency-injection.md)
- CQRS: [../../docs/shared/patterns/cqrs.md](../../docs/shared/patterns/cqrs.md)
- Soft delete only: [../../docs/shared/conventions/soft-delete.md](../../docs/shared/conventions/soft-delete.md)
- Prefixed nano IDs: [../../docs/shared/conventions/nano-id.md](../../docs/shared/conventions/nano-id.md)
- Audit fields: [../../docs/shared/conventions/audit-fields.md](../../docs/shared/conventions/audit-fields.md)
- API versioning: [../../docs/shared/conventions/versioning.md](../../docs/shared/conventions/versioning.md)
- DB naming (snake_case ↔ PascalCase aliases): [../../docs/shared/conventions/db-naming.md](../../docs/shared/conventions/db-naming.md)
- Env validation (Zod): [../../docs/shared/decisions/ADR-0014-env-validation-zod.md](../../docs/shared/decisions/ADR-0014-env-validation-zod.md)

## 5. Agent rules
- Converse with the user in **Spanish**; write code and comments in **English**.
- `users-impl` writes **only source code** — never runs git or touches Linear.
- Leave finished work in the working tree for `github-ops` to commit.
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Service spec (vault): [../../docs/domains/users/specs/users-service-design.md](../../docs/domains/users/specs/users-service-design.md)
- Endpoints: `[POST] /users/register` (emits SQS `USER_CREATED`), `[POST] /users/login`, `[GET/PATCH] /users/me`. gRPC: `GetUserById`.
```

- [ ] **Step 5: Verify and report**

Run: `test -f services/users/CLAUDE.md && test -f services/users/Dockerfile && find services/users -name .gitkeep | wc -l`
Expected: exit 0 and `12`.
Report: files created (paths), the structural-check output, and a proposed commit message:
`feat(users): scaffold Users service skeleton + nested CLAUDE.md`

---

### Task 2: Orders service scaffold + CLAUDE.md (`orders-impl`)

**Files:**
- Create: `services/orders/CLAUDE.md`
- Create: `services/orders/Dockerfile`
- Create: `services/orders/.claude/.gitkeep`
- Create (`.gitkeep` in each leaf): `services/orders/src/Features/Orders/{Commands,Queries,Domain,Grpc}/.gitkeep`, `services/orders/src/Shared/{Config,Persistence,Audit,Messaging}/.gitkeep`, `services/orders/tests/.gitkeep`

**Interfaces:**
- Consumes: spec section "services/orders/"; the `CLAUDE.md` shape from Task 1.
- Produces: `services/orders/` layout + complete `CLAUDE.md`. Note: .NET uses PascalCase folder names (`Features/Orders/Commands`).

- [ ] **Step 1: Create the folder skeleton with `.gitkeep` leaves**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p services/orders/.claude \
  services/orders/src/Features/Orders/{Commands,Queries,Domain,Grpc} \
  services/orders/src/Shared/{Config,Persistence,Audit,Messaging} \
  services/orders/tests
touch services/orders/.claude/.gitkeep \
  services/orders/src/Features/Orders/{Commands,Queries,Domain,Grpc}/.gitkeep \
  services/orders/src/Shared/{Config,Persistence,Audit,Messaging}/.gitkeep \
  services/orders/tests/.gitkeep
```

- [ ] **Step 2: Verify the tree**

Run: `find services/orders -name .gitkeep | wc -l`
Expected: `10` (1 `.claude`, 4 Features, 4 Shared, tests).

- [ ] **Step 3: Write `services/orders/Dockerfile` (skeleton, commented)**

```dockerfile
# Orders service — .NET Core 10 Minimal APIs.
# Skeleton only: the real build is added in the Orders implementation milestone.
# Local dev runs via docker-watch (see root docker-compose.yml `develop.watch`).
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS base
WORKDIR /app
# COPY *.csproj ./
# RUN dotnet restore
# COPY . .
# RUN dotnet build
# EXPOSE 8080
# ENTRYPOINT ["dotnet", "Orders.dll"]
```

- [ ] **Step 4: Write `services/orders/CLAUDE.md` (complete, 6 sections)**

```markdown
# CLAUDE.md — Orders service

Nested project memory for the **Orders** microservice. Source of truth for this
service's stack and conventions. The global `orders-impl` agent reads this
first, every time. Cross-cutting rules are **referenced**, never duplicated.

## 1. Stack & versions
- Framework: .NET Core 10 — Minimal APIs.
- Language: C#.
- Database: Aurora MySQL (read + write replicas).
- ORM: Entity Framework Core.
- Env validation: options + validation (parity with the Zod convention).

## 2. Commands
- Restore: `dotnet restore`
- Build: `dotnet build`
- Test: `dotnet test`
- Lint/format: `dotnet format`
- Run local (docker-watch): `docker compose up orders --watch` (from repo root)
- Migrate: `dotnet ef database update`

> These commands are the intended contract; the project files themselves are
> created in the Orders implementation milestone.

## 3. Folder structure (screaming architecture)
\`\`\`
services/orders/
├── src/Features/Orders/{Commands,Queries,Domain,Grpc}/
├── src/Shared/{Config,Persistence,Audit,Messaging}/
└── tests/
\`\`\`

## 4. Conventions (referenced, never duplicated)
- Screaming architecture + DI: [../../docs/shared/patterns/screaming-architecture.md](../../docs/shared/patterns/screaming-architecture.md), [../../docs/shared/patterns/dependency-injection.md](../../docs/shared/patterns/dependency-injection.md)
- CQRS: [../../docs/shared/patterns/cqrs.md](../../docs/shared/patterns/cqrs.md)
- Soft delete only: [../../docs/shared/conventions/soft-delete.md](../../docs/shared/conventions/soft-delete.md)
- Prefixed nano IDs: [../../docs/shared/conventions/nano-id.md](../../docs/shared/conventions/nano-id.md)
- Audit fields: [../../docs/shared/conventions/audit-fields.md](../../docs/shared/conventions/audit-fields.md)
- API versioning: [../../docs/shared/conventions/versioning.md](../../docs/shared/conventions/versioning.md)
- DB naming (snake_case ↔ PascalCase aliases): [../../docs/shared/conventions/db-naming.md](../../docs/shared/conventions/db-naming.md)

## 5. Agent rules
- Converse with the user in **Spanish**; write code and comments in **English**.
- `orders-impl` writes **only source code** — never runs git or touches Linear.
- Leave finished work in the working tree for `github-ops` to commit.
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Service spec (vault): [../../docs/domains/orders/specs/orders-service-design.md](../../docs/domains/orders/specs/orders-service-design.md)
- Endpoints: `[POST] /orders` (emits SQS `ORDER_CREATED`), `[GET] /orders/my-orders`, `[GET] /orders/{order_id}` (verify ownership). gRPC: `GetOrderById`.
- Entities: Product, Order, OrderDetails.
```

- [ ] **Step 5: Verify and report**

Run: `test -f services/orders/CLAUDE.md && test -f services/orders/Dockerfile && find services/orders -name .gitkeep | wc -l`
Expected: exit 0 and `10`.
Proposed commit: `feat(orders): scaffold Orders service skeleton + nested CLAUDE.md`

---

### Task 3: Tracking service scaffold + CLAUDE.md (`tracking-impl`)

**Files:**
- Create: `services/tracking/CLAUDE.md`
- Create: `services/tracking/Dockerfile`
- Create: `services/tracking/.claude/.gitkeep`
- Create (`.gitkeep` in each leaf): `services/tracking/src/features/tracking/{commands,queries,domain,grpc}/.gitkeep`, `services/tracking/src/shared/{config,db,di,audit}/.gitkeep`, `services/tracking/tests/.gitkeep`

**Interfaces:**
- Consumes: spec section "services/tracking/"; the `CLAUDE.md` shape from Task 1.
- Produces: `services/tracking/` layout + complete `CLAUDE.md`.

- [ ] **Step 1: Create the folder skeleton with `.gitkeep` leaves**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p services/tracking/.claude \
  services/tracking/src/features/tracking/{commands,queries,domain,grpc} \
  services/tracking/src/shared/{config,db,di,audit} \
  services/tracking/tests
touch services/tracking/.claude/.gitkeep \
  services/tracking/src/features/tracking/{commands,queries,domain,grpc}/.gitkeep \
  services/tracking/src/shared/{config,db,di,audit}/.gitkeep \
  services/tracking/tests/.gitkeep
```

- [ ] **Step 2: Verify the tree**

Run: `find services/tracking -name .gitkeep | wc -l`
Expected: `10` (1 `.claude`, 4 feature, 4 shared, tests).

- [ ] **Step 3: Write `services/tracking/Dockerfile` (skeleton, commented)**

```dockerfile
# Tracking service — FastAPI + Python.
# Skeleton only: the real build is added in the Tracking implementation milestone.
# Local dev runs via docker-watch (see root docker-compose.yml `develop.watch`).
FROM python:3.12-slim AS base
WORKDIR /app
# COPY requirements.txt ./
# RUN pip install -r requirements.txt
# COPY . .
# EXPOSE 8000
# CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 4: Write `services/tracking/CLAUDE.md` (complete, 6 sections)**

```markdown
# CLAUDE.md — Tracking service

Nested project memory for the **Tracking** microservice. Source of truth for
this service's stack and conventions. The global `tracking-impl` agent reads
this first, every time. Cross-cutting rules are **referenced**, never duplicated.

## 1. Stack & versions
- Framework: FastAPI (Python 3.12+).
- Database: Aurora MySQL (read + write replicas).
- ORM: SQLAlchemy (migrations via Alembic).
- Env validation: Pydantic settings (parity with the Zod convention).

## 2. Commands
- Install: `pip install -r requirements.txt`
- Run/build: `uvicorn src.main:app`
- Test: `pytest`
- Lint: `ruff check .`
- Run local (docker-watch): `docker compose up tracking --watch` (from repo root)
- Migrate: `alembic upgrade head`

> These commands are the intended contract; the project files themselves are
> created in the Tracking implementation milestone.

## 3. Folder structure (screaming architecture)
\`\`\`
services/tracking/
├── src/features/tracking/{commands,queries,domain,grpc}/
├── src/shared/{config,db,di,audit}/
└── tests/
\`\`\`

## 4. Conventions (referenced, never duplicated)
- Screaming architecture + DI: [../../docs/shared/patterns/screaming-architecture.md](../../docs/shared/patterns/screaming-architecture.md), [../../docs/shared/patterns/dependency-injection.md](../../docs/shared/patterns/dependency-injection.md)
- CQRS: [../../docs/shared/patterns/cqrs.md](../../docs/shared/patterns/cqrs.md)
- Soft delete only: [../../docs/shared/conventions/soft-delete.md](../../docs/shared/conventions/soft-delete.md)
- Prefixed nano IDs: [../../docs/shared/conventions/nano-id.md](../../docs/shared/conventions/nano-id.md)
- Audit fields: [../../docs/shared/conventions/audit-fields.md](../../docs/shared/conventions/audit-fields.md)
- API versioning: [../../docs/shared/conventions/versioning.md](../../docs/shared/conventions/versioning.md)
- DB naming (snake_case ↔ PascalCase aliases): [../../docs/shared/conventions/db-naming.md](../../docs/shared/conventions/db-naming.md)

## 5. Agent rules
- Converse with the user in **Spanish**; write code and comments in **English**.
- `tracking-impl` writes **only source code** — never runs git or touches Linear.
- Leave finished work in the working tree for `github-ops` to commit.
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Service spec (vault): [../../docs/domains/tracking/specs/tracking-service-design.md](../../docs/domains/tracking/specs/tracking-service-design.md)
- Endpoints: `[POST] /trackings`, `[PUT] /trackings/{order_id}/status`. gRPC: `GetTrackingByOrderId`, `GetTrackingsByOrderIds`.
- Entities: Tracking, Tracking_History.
```

- [ ] **Step 5: Verify and report**

Run: `test -f services/tracking/CLAUDE.md && test -f services/tracking/Dockerfile && find services/tracking -name .gitkeep | wc -l`
Expected: exit 0 and `10`.
Proposed commit: `feat(tracking): scaffold Tracking service skeleton + nested CLAUDE.md`

---

### Task 4: events-pipeline scaffold + CLAUDE.md (`events-pipeline-impl`)

**Files:**
- Create: `services/events-pipeline/CLAUDE.md`
- Create: `services/events-pipeline/Dockerfile`
- Create: `services/events-pipeline/.claude/.gitkeep`
- Create (`.gitkeep` in each leaf): `services/events-pipeline/src/{handlers,pipeline,domain}/.gitkeep`, `services/events-pipeline/src/shared/{config,db,di}/.gitkeep`, `services/events-pipeline/tests/.gitkeep`

**Interfaces:**
- Consumes: spec section "services/events-pipeline/"; the `CLAUDE.md` shape from Task 1.
- Produces: `services/events-pipeline/` layout + complete `CLAUDE.md`. Note: this is the CQRS-dispatch Lambda; it has no `features/` tree — its domain folders are `handlers/`, `pipeline/`, `domain/`.

- [ ] **Step 1: Create the folder skeleton with `.gitkeep` leaves**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p services/events-pipeline/.claude \
  services/events-pipeline/src/{handlers,pipeline,domain} \
  services/events-pipeline/src/shared/{config,db,di} \
  services/events-pipeline/tests
touch services/events-pipeline/.claude/.gitkeep \
  services/events-pipeline/src/{handlers,pipeline,domain}/.gitkeep \
  services/events-pipeline/src/shared/{config,db,di}/.gitkeep \
  services/events-pipeline/tests/.gitkeep
```

- [ ] **Step 2: Verify the tree**

Run: `find services/events-pipeline -name .gitkeep | wc -l`
Expected: `8` (1 `.claude`, 3 src top-level, 3 shared, tests).

- [ ] **Step 3: Write `services/events-pipeline/Dockerfile` (skeleton, commented)**

```dockerfile
# events-pipeline — SQS → Lambda handler (DocumentDB). Runs as a worker locally.
# Skeleton only: the real build is added in the events-pipeline milestone.
# Production target is AWS Lambda; this image is the local docker-watch worker.
FROM node:24-alpine AS base
WORKDIR /app
# COPY package*.json ./
# RUN npm ci
# COPY . .
# CMD ["node", "src/index.js"]
```

- [ ] **Step 4: Write `services/events-pipeline/CLAUDE.md` (complete, 6 sections)**

```markdown
# CLAUDE.md — events-pipeline

Nested project memory for the **events-pipeline** (SQS → Lambda). Source of
truth for its stack and conventions. The global `events-pipeline-impl` agent
reads this first, every time. Cross-cutting rules are **referenced**, never
duplicated.

## 1. Stack & versions
- Trigger: SQS message → single Lambda (CQRS dispatch by event `type`).
- Runtime: Node.js (repo-pinned via `.nvmrc` — run `nvm use`).
- Database: DocumentDB (document model + schema).
- Production: AWS Lambda. Local: a worker service via docker-watch.

## 2. Commands
- Install: `nvm use && npm ci`
- Build: `npm run build`
- Test: `npm test`
- Lint: `npm run lint`
- Run local (docker-watch): `docker compose up events-pipeline --watch` (from repo root)

> These commands are the intended contract; the scripts themselves are created
> in the events-pipeline implementation milestone.

## 3. Folder structure
\`\`\`
services/events-pipeline/
├── src/handlers/      # type → handler map (e.g. OrderCreatedHandler)
├── src/pipeline/      # lifecycle: STARTED → IN_PROGRESS → COMPLETED/FAILED
├── src/domain/        # Event schema (friendlyId, status_history, audit fields)
├── src/shared/{config,db,di}/
└── tests/
\`\`\`

## 4. Conventions (referenced, never duplicated)
- CQRS dispatch: [../../docs/shared/patterns/cqrs.md](../../docs/shared/patterns/cqrs.md)
- Dependency injection: [../../docs/shared/patterns/dependency-injection.md](../../docs/shared/patterns/dependency-injection.md)
- Prefixed nano IDs (`friendlyId`): [../../docs/shared/conventions/nano-id.md](../../docs/shared/conventions/nano-id.md)
- Audit fields: [../../docs/shared/conventions/audit-fields.md](../../docs/shared/conventions/audit-fields.md)
- Env validation: [../../docs/shared/decisions/ADR-0014-env-validation-zod.md](../../docs/shared/decisions/ADR-0014-env-validation-zod.md)

## 5. Agent rules
- Converse with the user in **Spanish**; write code and comments in **English**.
- `events-pipeline-impl` writes **only source code** — never runs git or Linear.
- Leave finished work in the working tree for `github-ops` to commit.
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Service spec (vault): [../../docs/domains/events-pipeline/specs/events-pipeline-design.md](../../docs/domains/events-pipeline/specs/events-pipeline-design.md)
- Lifecycle: message saved as `STARTED` → `IN_PROGRESS` (to handler) → `COMPLETED`, or `FAILED` (error saved).
- Event fields: `friendlyId`, `order_id`, `user_id`, `type`, `source`, `payload`, `status_history`, audit fields.
```

- [ ] **Step 5: Verify and report**

Run: `test -f services/events-pipeline/CLAUDE.md && test -f services/events-pipeline/Dockerfile && find services/events-pipeline -name .gitkeep | wc -l`
Expected: exit 0 and `8`.
Proposed commit: `feat(events-pipeline): scaffold events-pipeline skeleton + nested CLAUDE.md`

---

### Task 5: infra scaffold + CLAUDE.md (`infra-impl`)

**Files:**
- Create: `infra/CLAUDE.md`
- Create: `infra/README.md`
- Create (`.gitkeep` in each leaf): `infra/modules/{label,networking,database,messaging,compute,api-gateway}/.gitkeep`, `infra/environments/{local,production}/.gitkeep`

**Interfaces:**
- Consumes: spec section "infra/"; shared infra decisions in `docs/shared/decisions/` (ADR-0001 cloudposse naming, ADR-0006 replicas, ADR-0007 secrets, ADR-0009 apigw-alb-fargate, ADR-0010 cognito, ADR-0012 ministack).
- Produces: `infra/` module + environment skeleton and a complete `CLAUDE.md`. Note: `infra/` lives at repo root, so wikilink-relative paths use `../docs/...` (one level up), not `../../`.

- [ ] **Step 1: Create the folder skeleton with `.gitkeep` leaves**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p infra/modules/{label,networking,database,messaging,compute,api-gateway} \
  infra/environments/{local,production}
touch infra/modules/{label,networking,database,messaging,compute,api-gateway}/.gitkeep \
  infra/environments/{local,production}/.gitkeep
```

- [ ] **Step 2: Verify the tree**

Run: `find infra -name .gitkeep | wc -l`
Expected: `8` (6 modules, 2 environments).

- [ ] **Step 3: Write `infra/README.md` (brief orientation)**

```markdown
# infra/

Terraform infrastructure for 3MRAI. AWS resources use custom modules named with
the cloudposse/label convention. Local development runs on Ministack.

- `modules/` — own reusable modules (label, networking, database, messaging, compute, api-gateway).
- `environments/` — `local` (Ministack) and `production` (AWS) compositions.

See `CLAUDE.md` for stack, commands, and conventions.
```

- [ ] **Step 4: Write `infra/CLAUDE.md` (complete, 6 sections — note `../docs/` relative paths)**

```markdown
# CLAUDE.md — infrastructure

Nested project memory for the **Terraform/AWS infrastructure**. Source of truth
for the infra stack and conventions. The global `infra-impl` agent reads this
first, every time. Cross-cutting rules are **referenced**, never duplicated.

## 1. Stack & versions
- IaC: Terraform (own modules; no flat resources).
- Naming: cloudposse/label/null module.
- Cloud: AWS (ECS Fargate + ECR, SQS + Lambda, API Gateway + ALB, Cognito, Route 53, Secrets Manager, Parameter Store, DocumentDB, Aurora Postgres/MySQL).
- Local: Ministack.

## 2. Commands
- Init: `terraform init`
- Validate: `terraform validate`
- Format: `terraform fmt -recursive`
- Plan: `terraform plan`
- Apply: `terraform apply`

> These run per environment under `environments/<env>/`; the configurations
> themselves are created in the infrastructure implementation milestone.

## 3. Folder structure
\`\`\`
infra/
├── modules/{label,networking,database,messaging,compute,api-gateway}/
└── environments/{local,production}/
\`\`\`

## 4. Conventions (referenced, never duplicated)
- cloudposse/label naming: [../docs/shared/decisions/ADR-0001-terraform-cloudposse-naming.md](../docs/shared/decisions/ADR-0001-terraform-cloudposse-naming.md)
- Read/write replicas: [../docs/shared/decisions/ADR-0006-read-write-replicas.md](../docs/shared/decisions/ADR-0006-read-write-replicas.md)
- Secrets & Parameter Store: [../docs/shared/decisions/ADR-0007-secrets-parameter-store.md](../docs/shared/decisions/ADR-0007-secrets-parameter-store.md)
- API GW → ALB → Fargate: [../docs/shared/decisions/ADR-0009-apigw-alb-fargate.md](../docs/shared/decisions/ADR-0009-apigw-alb-fargate.md)
- Cognito auth: [../docs/shared/decisions/ADR-0010-cognito-auth.md](../docs/shared/decisions/ADR-0010-cognito-auth.md)
- Observability (SigNoz): [../docs/shared/decisions/ADR-0011-observability-signoz.md](../docs/shared/decisions/ADR-0011-observability-signoz.md)
- Ministack local: [../docs/shared/decisions/ADR-0012-ministack-local.md](../docs/shared/decisions/ADR-0012-ministack-local.md)

## 5. Agent rules
- Converse with the user in **Spanish**; write config and comments in **English**.
- `infra-impl` writes **only Terraform/config** — never runs git or touches Linear.
- Leave finished work in the working tree for `github-ops` to commit.
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Infra specs (vault): [../docs/infrastructure/specs/](../docs/infrastructure/specs/)
- Scaffold design: [../docs/superpowers/specs/2026-06-28-services-infra-scaffold-design.md](../docs/superpowers/specs/2026-06-28-services-infra-scaffold-design.md)
```

- [ ] **Step 5: Verify and report**

Run: `test -f infra/CLAUDE.md && test -f infra/README.md && find infra -name .gitkeep | wc -l`
Expected: exit 0 and `8`.
Proposed commit: `feat(infra): scaffold Terraform module + environment skeleton + CLAUDE.md`

---

### Task 6: Root docker-compose orchestrator (`infra-impl` or parent)

**Files:**
- Create: `docker-compose.yml` (repo root)

**Interfaces:**
- Consumes: the four service `Dockerfile`s from Tasks 1–4 (so all `build:` contexts exist) and spec section "Docker (local dev)".
- Produces: a root compose file that brings the four services up on one network with docker-watch. Runs LAST so every `build:` context resolves.

- [ ] **Step 1: Write `docker-compose.yml` (repo root)**

```yaml
# 3MRAI local development orchestrator.
# Brings the four services up on one network with docker-watch (live reload).
# Skeleton: build contexts point to per-service skeleton Dockerfiles; real
# service config (ports, env, depends_on, healthchecks) is filled in per
# service milestone.
name: 3mrai

networks:
  3mrai-network:
    driver: bridge

services:
  users:
    build: ./services/users
    networks: [3mrai-network]
    develop:
      watch:
        - action: sync
          path: ./services/users/src
          target: /app/src

  orders:
    build: ./services/orders
    networks: [3mrai-network]
    develop:
      watch:
        - action: sync
          path: ./services/orders/src
          target: /app/src

  tracking:
    build: ./services/tracking
    networks: [3mrai-network]
    develop:
      watch:
        - action: sync
          path: ./services/tracking/src
          target: /app/src

  events-pipeline:
    build: ./services/events-pipeline
    networks: [3mrai-network]
    develop:
      watch:
        - action: sync
          path: ./services/events-pipeline/src
          target: /app/src
```

- [ ] **Step 2: Verify the compose file parses**

Run: `docker compose config -q`
Expected: exit 0, no output (valid). If Docker is unavailable in the environment, instead run `python3 -c "import yaml,sys; yaml.safe_load(open('docker-compose.yml')); print('yaml ok')"` and expect `yaml ok`, and report that `docker compose config` could not be run.

- [ ] **Step 3: Report**

Report: file created, the validation output, and a proposed commit message:
`feat(infra): add root docker-compose orchestrator with docker-watch`

---

### Task 7: Skill discovery & install (parent)

**Files:**
- None created by default. If the user approves recording the outcome, propose a vault note `docs/shared/conventions/skills-catalog.md` (created via the `obsidian-vault` agent) — do NOT create it without confirmation.

**Interfaces:**
- Consumes: the spec sections "Suggested-skills catalog" and "Appendix — where to search for skills".
- Produces: a validated install proposal for the user. No skill is installed without explicit confirmation.

- [ ] **Step 1: Re-validate the catalog candidates**

For each candidate in the spec's catalog, check current status from its source (prefer official: aws-samples, HashiCorp, MongoDB, Prisma, mcollina, Microsoft, anthropics; then skillsmp.com / marketplaces). Record: license, last-update/maintenance signal, install command, and any DocumentDB/Aurora caveats (e.g. MongoDB Atlas-only skills do NOT apply to DocumentDB).

- [ ] **Step 2: Produce a prioritized install proposal**

Group by service + infra + cross-cutting DB. Lead with the official sources. For each proposed skill give: exact install command, source, why, and reliability. Flag anything unverified (e.g. the SkillsMP `mysql-patterns` "219.4k ★" anomaly) and exclude it from the recommended set.

- [ ] **Step 3: Present to the user and STOP**

Present the proposal and wait for explicit confirmation before installing anything. Installation (e.g. `/plugin marketplace add ...` + `/plugin install ...` or `npx skills add ...`) is performed by the user or, if delegated, only after per-skill confirmation. No auto-install.

- [ ] **Step 4: (Optional, if approved) Record the outcome**

If the user wants it recorded, route to `obsidian-vault` to create `docs/shared/conventions/skills-catalog.md` capturing the installed/approved set, then propose the commit `docs(vault): record approved skills catalog`.

### Actual outcome (JE-23 + JE-24)

Task 7 was executed as two Linear issues:

- **JE-23** — Catalog & validate: enumerated candidates, verified sources, flagged anomalies (e.g. SkillsMP `mysql-patterns` star-count spike), produced the prioritized install proposal.
- **JE-24** — Install + preload: installed approved skills and wired them into each implementer agent's frontmatter `skills:` field.

**Two install mechanisms were used:**

- `npx agent-skills add <skill>` — for plain skills; version-controlled via `.claude/skills/` + `skills-lock.json`.
- `/plugin` — for packages that bundle an MCP server or agent definitions (mongodb, aws-dev-toolkit); these are installed as plugins, not plain skills.

**Domain skills preloaded per implementer agent (frontmatter `skills:` field):**

| Agent | Preloaded skills |
|---|---|
| `users-impl` | fastify-best-practices, prisma-postgres, prisma-postgres-setup, database-designer |
| `orders-impl` | efcore-patterns, database-performance, mysql, database-designer |
| `tracking-impl` | fastapi-expert, mysql, database-designer |
| `events-pipeline-impl` | mongodb-schema-design, mongodb-query-optimizer, database-designer, lambda, messaging |
| `infra-impl` | terraform-skill |

The approved catalog is recorded in [[skills-catalog]] (`docs/shared/conventions/skills-catalog.md`).

---

## Self-Review

**Spec coverage:**
- Scaffold of 4 services + infra → Tasks 1–5. ✔
- Screaming-architecture trees (exact per spec) → Tasks 1–5 Step 1. ✔
- Nested `CLAUDE.md` (6 required sections) → Tasks 1–5 Step 4. ✔
- Per-service `Dockerfile` skeleton → Tasks 1–4 Step 3. ✔
- Root `docker-compose.yml` orchestrator on one network + docker-watch → Task 6. ✔
- `.gitkeep`-only leaves, no real code → all tasks (only `CLAUDE.md`/`Dockerfile`/compose/`README`/`.gitkeep`). ✔
- Empty `.claude/` extension point (not relocating agents) → Tasks 1–4 create `.claude/.gitkeep`. ✔ (infra has no `.claude/` per spec tree.)
- Suggested-skills catalog + discovery/install → Task 7. ✔
- Implementation order + agent assignment → mirrored in task order + Global Constraints. ✔

**Placeholder scan:** No "TBD/TODO/handle edge cases". Every file's full content is shown. ✔ (The `CLAUDE.md` "intended contract" notes are deliberate, not placeholders — commands exist as the contract; scripts come later by design.)

**Type/path consistency:** `.gitkeep` counts match each tree (Users 12, Orders 10, Tracking 10, events-pipeline 8, infra 8). Orders uses PascalCase folders (.NET); others lowercase. infra uses `../docs/` (root level); services use `../../docs/` (two levels deep). Network name `3mrai-network` consistent between spec and Task 6. ✔

**Note on TDD deviation:** the writing-plans skill defaults to TDD steps; this milestone creates structure with no logic to unit-test, so each task's verification is a structural check (file/folder existence, `.gitkeep` counts, `docker compose config`). This is the faithful adaptation — inventing unit tests for empty scaffolding would be a placeholder anti-pattern.

## Related

- [[2026-06-28-services-infra-scaffold-design]]
- [[2026-06-26-implementation-workflow-design]]
- [[index]]
