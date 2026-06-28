---
title: 3MRAI Services & Infra Scaffold + Skill Discovery — Design
type: spec
area: shared
status: accepted
created: 2026-06-28
updated: 2026-06-28
tags: [type/spec, area/shared, status/accepted]
related:
  - "[[2026-06-26-implementation-workflow-design]]"
  - "[[2026-06-26-3mrai-docs-vault-design]]"
  - "[[index]]"
  - "[[screaming-architecture]]"
  - "[[cqrs]]"
  - "[[dependency-injection]]"
  - "[[soft-delete]]"
  - "[[nano-id]]"
  - "[[audit-fields]]"
  - "[[versioning]]"
  - "[[db-naming]]"
  - "[[ADR-0008-screaming-arch-di]]"
  - "[[users-service-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[events-pipeline-design]]"
---

# 3MRAI Services & Infra Scaffold + Skill Discovery — Design

## Summary

This milestone creates the physical base of the four microservices (Users, Orders, Tracking, events-pipeline) plus the Terraform/AWS infrastructure, so the already-existing global implementer agents (`users-impl`, `orders-impl`, `tracking-impl`, `events-pipeline-impl`, `infra-impl`) have the nested `services/<svc>/CLAUDE.md` / `infra/CLAUDE.md` they expect to read, plus a screaming-architecture folder skeleton ready to receive code in later milestones. It also produces an initial **suggested-skills catalog** (per service + infra + database layer) and defines a follow-up issue to validate and install them.

This spec realizes the prediction in [[2026-06-26-implementation-workflow-design]] (section "Creation order": nested `CLAUDE.md` is created at the start of each service milestone).

---

## Scope — what this milestone does

- Create `services/{users,orders,tracking,events-pipeline}/` and `infra/`.
- Each service: its nested `CLAUDE.md` (source of truth for the stack — complete: stack, build/test/lint/run-local commands, folder structure, conventions by wikilink, agent rules), a screaming-architecture folder skeleton (empty leaves with `.gitkeep`), and an empty `.claude/` folder reserved for future scoped agents.
- `infra/`: its `CLAUDE.md` + a Terraform module skeleton.
- A root `docker-compose.yml` orchestrator that brings the 4 services up on the same network (`3mrai-network`) with `develop: watch:` (docker-watch) sketched per service, plus a skeleton `Dockerfile` per service.

## Scope — what this milestone does NOT do (YAGNI, user-confirmed)

- Does **not** relocate or duplicate any agent — implementer agents stay global in root `.claude/agents/`.
- Does **not** write real source code, package manifests, or real build config — leaf folders get `.gitkeep` only (no commented entrypoints).
- Does **not** create empty scoped agents — the `.claude/` folder per service is left ready but empty.
- Does **not** install any skill — only catalogs candidates; installation is a separate, confirmation-gated issue.

---

## Key architectural decision — nested agents researched but not used now

> [!info] Nested agents: supported but not the right fit for Phase C
> We confirmed via research that nested `.claude/agents/` ARE supported in Claude Code (discovered by walking up from the cwd; v2.1.178+, closest definition wins). A nested agent at `services/<svc>/.claude/agents/` would be visible ONLY when the cwd is inside that folder.
>
> BUT the Phase C implementation flow (see [[2026-06-26-implementation-workflow-design]]) is orchestrated by the parent from the repo ROOT, where nested agents would NOT be visible. Therefore we keep the implementer agents GLOBAL (so the parent can route to them from the root) and the per-service `.claude/` folder is left as a future extension point.
>
> **User directive:** "do not relocate agents unless necessary." The de-facto scoping already holds: each implementer only touches its own service by name/description and now reads its nested `CLAUDE.md`.

---

## Screaming-architecture skeleton — per service

Conventions applied throughout (linked, never repeated here): [[screaming-architecture]], [[cqrs]], [[dependency-injection]], [[soft-delete]], [[nano-id]], [[audit-fields]], [[versioning]], [[db-naming]], [[ADR-0008-screaming-arch-di]].

### services/users/

Stack: Fastify + Aurora Postgres + Prisma.

```
services/users/
├── CLAUDE.md
├── .claude/
├── Dockerfile
├── src/
│   ├── features/
│   │   └── users/
│   │       ├── commands/      # register, update-me
│   │       ├── queries/       # get-me, get-by-id
│   │       ├── domain/        # User entity, value objects
│   │       └── grpc/          # GetUserById handler
│   └── shared/
│       ├── config/            # env validation
│       ├── db/                # Prisma client, migrations
│       ├── di/                # DI container
│       ├── audit/             # audit-fields middleware
│       └── messaging/         # SQS publisher
├── prisma/
└── tests/
```

Domain: register/login/me endpoints; gRPC `GetUserById`; publishes SQS `USER_CREATED`.

### services/orders/

Stack: .NET Core 10 Minimal APIs + Aurora MySQL + EF Core.

```
services/orders/
├── CLAUDE.md
├── .claude/
├── Dockerfile
├── src/
│   ├── Features/
│   │   └── Orders/
│   │       ├── Commands/      # CreateOrder
│   │       ├── Queries/       # GetMyOrders, GetOrderById
│   │       ├── Domain/        # Order, OrderDetail, Product entities
│   │       └── Grpc/          # GetOrderById handler
│   └── Shared/
│       ├── Config/
│       ├── Persistence/       # EF Core DbContext, migrations
│       ├── Audit/
│       └── Messaging/         # SQS publisher
└── tests/
```

Domain: Order/OrderDetail/Product entities; gRPC `GetOrderById`; publishes SQS `ORDER_CREATED`.

### services/tracking/

Stack: FastAPI + Aurora MySQL + SQLAlchemy.

```
services/tracking/
├── CLAUDE.md
├── .claude/
├── Dockerfile
├── src/
│   ├── features/
│   │   └── tracking/
│   │       ├── commands/      # create-tracking, update-status
│   │       ├── queries/       # get-by-order-id, get-by-order-ids
│   │       ├── domain/        # Tracking, Tracking_History entities
│   │       └── grpc/          # GetTrackingByOrderId(s) handler
│   └── shared/
│       ├── config/
│       ├── db/                # SQLAlchemy engine, Alembic
│       ├── di/
│       └── audit/
└── tests/
```

Domain: Tracking/Tracking_History entities; gRPC `GetTrackingByOrderId` and `GetTrackingsByOrderIds`.

### services/events-pipeline/

Stack: SQS → Lambda + DocumentDB. CQRS dispatch by event type.

```
services/events-pipeline/
├── CLAUDE.md
├── .claude/
├── Dockerfile
├── src/
│   ├── handlers/              # type → handler map (e.g. OrderCreatedHandler)
│   ├── pipeline/              # lifecycle: STARTED → IN_PROGRESS → COMPLETED/FAILED
│   ├── domain/                # Event schema (friendlyId, status_history, audit fields)
│   └── shared/
│       ├── config/
│       ├── db/                # DocumentDB client
│       └── di/
└── tests/
```

Domain: Event entity with `friendlyId`, `order_id`, `user_id`, `type`, `source`, `payload`, `status_history`, audit fields. Runs as a worker service locally (documented as Lambda in production in its `CLAUDE.md`).

### infra/

Stack: Terraform + cloudposse/label + AWS.

```
infra/
├── CLAUDE.md
├── modules/
│   ├── label/                 # cloudposse/label naming
│   ├── networking/            # VPC, subnets, ALB, Route 53
│   ├── database/              # Aurora Postgres, Aurora MySQL, DocumentDB
│   ├── messaging/             # SQS queues
│   ├── compute/               # ECS Fargate clusters, Lambda
│   └── api-gateway/
├── environments/
│   ├── local/
│   └── production/
└── README.md
```

---

## Docker (local dev)

Root `docker-compose.yml` orchestrator:

### Ministack — local AWS emulator

> [!info] Ministack is the foundation of the local environment
> `ministack` (`ministackorg/ministack:latest`, port 4566) emulates the AWS services used by all four microservices locally: SQS, Lambda, ECS, RDS, S3, DocumentDB, and more. All local AWS resources are created against it. The four services must not start until Ministack is healthy.

Key configuration details:

- **Port:** `4566` (standard LocalStack-compatible endpoint).
- **Docker socket mount:** Ministack runs Lambda/ECS as real Docker containers, so it mounts `/var/run/docker.sock` from the host.
- **Network alignment:** `LAMBDA_DOCKER_NETWORK=3mrai_3mrai-network` — the real Compose network name is `<project>_<network>` (i.e. `3mrai_3mrai-network`), so Lambda/ECS containers spawned by Ministack join the same network as the services.
- **State persistence:** Ministack persists state and S3 objects under `./data` (git-ignored).

### Services

- All 4 services share the same network `3mrai-network`.
- Each service declares `depends_on: ministack: condition: service_healthy` so they wait for Ministack's health-check before starting.
- Each service sets `AWS_ENDPOINT_URL=http://ministack:4566` in its environment so the AWS SDK routes all calls to the local emulator (in-network hostname).
- `develop: watch:` block sketched per service (docker-watch for live reload).
- `build:` pointing to each `services/<svc>/Dockerfile`.
- events-pipeline runs as a worker service locally (Lambda in production).

### Dockerfiles

- Skeleton `Dockerfile` per service: minimal, commented, no real build steps.

---

## Nested CLAUDE.md — required content per file

Each nested `CLAUDE.md` must contain all of the following:

1. **Stack & versions** — framework, language runtime, ORM, database engine, exact versions.
2. **Commands** — `build`, `test`, `lint`, `run-local` (via docker-watch), `migrate`.
3. **Folder structure** — the screaming-architecture skeleton as a tree (copy from above).
4. **Conventions by reference** — wikilinks to the shared notes: [[cqrs]], [[dependency-injection]], [[screaming-architecture]], [[soft-delete]], [[nano-id]], [[audit-fields]], [[versioning]], [[db-naming]], [[env-validation-zod]] where applicable, plus the service's ORM convention.
5. **Agent rules** — converse with the user in Spanish; write code in English; implementer writes only source code, never git or Linear; leave work in the working tree for `github-ops`.
6. **Pointer to the vault spec note** — e.g. `[[users-service-design]]`, `[[orders-service-design]]`, `[[tracking-service-design]]`, `[[events-pipeline-design]]`.

---

## Suggested-skills catalog

> [!warning] Nothing is installed without user confirmation
> This catalog is for discovery only. A follow-up "Skill discovery & install" issue validates license, maintenance status, and security before any skill is installed. The parent must propose each install and wait for explicit confirmation.

### Already available — no install needed

superpowers, context7, obsidian-*, frontend-design, code-review, code-simplifier, skill-creator, commit-commands, claude-md-management, linear, github, codex.

### Per service

#### Users — Fastify / Aurora Postgres / Prisma

| Skill | Source | Reliability |
|---|---|---|
| `fastify-best-practices` | mcollina/skills (Fastify author) | Official — top candidate |
| `fastify-typescript` | Mindrally | Community-popular |
| `nodejs-backend-patterns` | wshobson | Community |
| `prisma-postgres` | prisma/skills | **Official** (Prisma) |
| `prisma-postgres-setup` | prisma/skills | **Official** (Prisma) |
| `planetscale/database-skills --skill postgres` | PlanetScale | Official |
| `postgresql-prisma-design-specialist` | mcpmarket | Community |
| context7 | Anthropic | Available |

#### Orders — .NET Core 10 Minimal APIs / Aurora MySQL / EF Core

| Skill | Source | Reliability |
|---|---|---|
| `.NET Claude Kit` (47 skills, .NET 10 / C# 14) | codewithmukesh | Community-popular |
| `dotnet-skills` | Aaronontheweb / nathanlemma | Community-popular |
| `dotnet-efcore-patterns` | Community | Community |
| `dotnet-ef-migrations` | Community | Community |
| `dotnet-ef-core-configuration` | Community | Community |
| `planetscale/database-skills --skill mysql` | PlanetScale (509 ★) | Official |

#### Tracking — FastAPI / Aurora MySQL / SQLAlchemy

| Skill | Source | Reliability |
|---|---|---|
| `fastapi-pro` | Community (SQLAlchemy 2.0 + Pydantic v2) | Community-popular |
| `fastapi-router-py` | Microsoft | Official |
| `fastapi-python` | Mindrally | Community-popular |
| `planetscale/database-skills --skill mysql` | PlanetScale | Official |

SQLAlchemy and Alembic are covered by the FastAPI skills + context7.

#### events-pipeline — SQS → Lambda / DocumentDB

| Skill | Source | Reliability |
|---|---|---|
| `lambda` | aws-samples | **Official** (AWS) |
| `messaging` | aws-samples | **Official** (AWS) |
| `aws-serverless-skill` | a-pavithraa | Community |
| `mongodb` plugin — Schema Design + Query Optimizer only | MongoDB | **Official** (MongoDB) |
| `mongodb-schema-design` | fcakyon | Community alt |

> [!warning] DocumentDB caveat
> Atlas-specific MongoDB skills (Stream Processing, Atlas Search) do **not** apply to DocumentDB. Use only the Schema Design and Query Optimizer capabilities of the MongoDB official plugin.

#### infra — Terraform / cloudposse / AWS

| Skill | Source | Reliability |
|---|---|---|
| `terraform-skill` | Anton Babenko (AWS Hero) | Official/de-facto |
| `hashicorp/terraform-style-guide` | HashiCorp | **Official** |
| `aws-dev-toolkit` (iac-scaffold, aws-architect, security-review, cost-check, ecs, api-gateway, well-architected) | aws-samples | **Official** (AWS) |
| `TerraShark` | LukasNiessen/terrashark | Community-popular |
| `terraform-aws-modules` | Community | Community |
| `terraform-engineer` | Community | Community |

#### Cross-cutting — Database & schema

| Skill | Source | Reliability |
|---|---|---|
| `database-designer` | alirezarezvani | Community |
| SQL Expert | mcpmarket | Community |

Covers: schema design, normalization, indexes for performance, soft-delete, read/write replicas, expand-contract / zero-downtime migrations, `EXPLAIN` analysis.

### Caveat — SkillsMP signal quality

SkillsMP is a massive aggregator (~1.8 M entries) with many low-signal and personal duplicates. One entry (`mysql-patterns` showing "219.4k ★") is almost certainly a page error — flagged as **UNVERIFIED**; do not recommend without independent review.

---

## Appendix — where to search for skills (for the discovery issue)

**Official sources:**
- aws-samples/sample-claude-code-plugins-for-startups
- HashiCorp Agent Skills
- mongodb/agent-skills (+ docs)
- Microsoft .NET Skills (.NET blog)
- anthropics/claude-plugins-official
- code.claude.com/docs/en/skills
- prisma/skills
- mcollina/skills

**Marketplaces / directories:**
- skillsmp.com (REST API + MCP server, 50/day anon · 500 auth)
- claudemarketplaces.com
- crossaitools.com
- mcpmarket.com
- awesomeskill.ai
- awesome-skills.com
- lobehub.com/skills
- claudedirectory.org
- claudepluginhub.com

**Awesome lists / repos:**
- VoltAgent/awesome-agent-skills
- wshobson/agents
- antonbabenko/terraform-skill
- LukasNiessen/terrashark
- a-pavithraa/aws-serverless-skill
- lgbarn/devops-skills
- Aaronontheweb/dotnet-skills
- alirezarezvani/claude-skills
- 0xfurai/claude-code-subagents
- ComposioHQ/awesome-claude-skills
- rohitg00/awesome-claude-code-toolkit
- sickn33/antigravity-awesome-skills
- codewithmukesh .NET Claude Kit

---

## Implementation order

One issue per unit. Each implementer writes **only code/config** and leaves work in the working tree for `github-ops`. The root `docker-compose.yml` is cross-cutting and goes to the parent or `infra-impl`.

| # | Issue | Agent |
|---|---|---|
| 1 | Scaffold + CLAUDE.md — Users | `users-impl` |
| 2 | Scaffold + CLAUDE.md — Orders | `orders-impl` |
| 3 | Scaffold + CLAUDE.md — Tracking | `tracking-impl` |
| 4 | Scaffold + CLAUDE.md — events-pipeline | `events-pipeline-impl` |
| 5 | Scaffold + CLAUDE.md — infra | `infra-impl` |
| 6 | Root `docker-compose.yml` orchestrator | parent or `infra-impl` — last, once all Dockerfiles exist |
| 7 | Skill discovery & install | validate catalog (license / maintenance / security), propose installs — user confirmation required |

---

## Design decisions

| Topic | Decision |
|---|---|
| Agent location | Keep implementers global in root `.claude/agents/`; do not relocate (user directive). |
| Nested `.claude/` per service | Created empty as a future extension point; not populated now. |
| Scaffold depth | Structure + complete `CLAUDE.md` + screaming skeleton; `.gitkeep` leaves; no real code. |
| Docker | Root orchestrator compose on one network + Ministack (local AWS emulator, port 4566) + per-service Dockerfile skeleton. Services depend on Ministack health and point their AWS SDKs at `http://ministack:4566`. |
| Skills | Catalog now; install gated to a separate confirmation-required issue. |

---

## Related

- [[2026-06-26-implementation-workflow-design]]
- [[2026-06-26-3mrai-docs-vault-design]]
- [[index]]
- [[screaming-architecture]]
- [[cqrs]]
- [[dependency-injection]]
- [[soft-delete]]
- [[nano-id]]
- [[audit-fields]]
- [[versioning]]
- [[db-naming]]
- [[ADR-0008-screaming-arch-di]]
- [[users-service-design]]
- [[orders-service-design]]
- [[tracking-service-design]]
- [[events-pipeline-design]]
