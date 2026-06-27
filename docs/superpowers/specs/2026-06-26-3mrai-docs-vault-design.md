---
title: 3MRAI Documentation Vault — Design
type: spec
area: shared
status: accepted
created: 2026-06-26
updated: 2026-06-26
tags: [type/spec, area/shared, status/accepted]
---

# 3MRAI Documentation Vault — Design

Design for the Obsidian documentation vault that organizes the **3 Microservices Running on AWS Infrastructure (3MRAI)** project: Users, Orders, Tracking, plus the SQS→Lambda events pipeline, infrastructure, and cross-cutting concerns.

This spec is the **design of the documentation system itself** — folder layout, conventions, and the initial content to seed. It is the deliverable of this brainstorming session. Implementing the microservices is out of scope here; each service gets its own spec → plan → implementation cycle later.

## Goals

- Give the project a navigable, scalable knowledge base that holds the decisions already made in `first-prompt-en.md`.
- Avoid duplication: each cross-cutting rule (soft-delete, nano-id, CQRS, audit fields…) is defined **once** in `shared/` and referenced from service specs via wikilinks.
- Scale per-service: adding a new microservice means adding one folder under `domains/`, not reshuffling.
- Make the vault queryable via frontmatter (Obsidian Bases) and the graph (wikilinks).

## Non-Goals

- No application code, Terraform, or scaffolding in this session.
- No Linear changes in this session (deferred to the implementation-planning phase).
- No exhaustive ADR alternative analysis — ADRs are concise (decision / context / consequences).

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Vault location | `docs/` (existing Obsidian vault root) |
| Organization | **Hybrid: domain + type** — one folder per domain, type folders nested inside; global note types at root |
| ADR granularity | One ADR per key decision (~14), all global ADRs in `shared/decisions/` |
| Content language | English |
| Navigation | Maps of Content (MOC) + wikilinks + Obsidian Bases (`.base`) |
| Content depth | Service specs fully developed; ADRs/conventions concise |

## Vault Structure

```
docs/
├── 00-overview/                      # Entry point
│   ├── index.md                      # Root MOC — links everything
│   ├── architecture.md               # Global architecture (Mermaid)
│   ├── system-context.md             # C4 context + container (Mermaid)
│   └── glossary.md                   # nano-id, soft-delete, audit fields, CQRS…
│
├── domains/
│   ├── users/{specs,decisions,runbooks,testing}/
│   ├── orders/{specs,decisions,runbooks,testing}/
│   ├── tracking/{specs,decisions,runbooks,testing}/
│   └── events-pipeline/{specs,decisions,runbooks,testing}/
│
├── infrastructure/
│   ├── specs/        # terraform-modules, networking, aws-resources
│   ├── decisions/
│   └── runbooks/     # local-dev-ministack, secret-rotation
│
├── shared/
│   ├── decisions/    # ← all global ADRs (ADR-NNNN)
│   ├── patterns/     # cqrs, screaming-architecture, dependency-injection
│   ├── conventions/  # audit-fields, nano-id, soft-delete, db-naming, versioning
│   └── observability/# signoz-cloudwatch
│
├── lessons/          # durable lessons (dated)
├── retros/           # retrospectives (dated)
├── ideas/            # loose notes
├── plans/            # active plans (+ plans/archive/)
├── templates/        # one template per note type
└── README.md         # vault navigation guide
```

**Rationale:**
- Global ADRs live in `shared/decisions/` because nearly all decisions are cross-cutting. Per-domain `decisions/` folders hold service-specific ADRs that arise later.
- `shared/conventions/` and `shared/patterns/` are evergreen notes; service specs reference them with wikilinks instead of repeating.
- `events-pipeline/` is the fourth "domain" (SQS→Lambda→DocumentDB) — it has its own database and CQRS-by-event-type logic.

## Conventions

**Wikilinks:** `[[note-name]]` for all internal cross-references. Service specs link cross-cutting rules instead of repeating them. Each note ends with a `## Related` section listing outgoing links.

**Tags (folder-style facets):**
- Domain: `#area/users`, `#area/orders`, `#area/tracking`, `#area/events-pipeline`, `#area/infra`, `#area/shared`
- Type: `#type/spec`, `#type/adr`, `#type/runbook`, `#type/convention`, `#type/pattern`, `#type/lesson`, `#type/retro`
- Status: `#status/draft`, `#status/active`, `#status/accepted`, `#status/superseded`
- Plus `#severity/<low|medium|high>` (lessons) and `#phase/<n>` (implementation phases)

**Filenames:**
- Evergreen notes (specs, conventions, patterns): `kebab-case.md`, no date.
- ADRs: `ADR-NNNN-title-kebab.md`, continuous global numbering in `shared/decisions/`.
- Dated notes (lessons, retros, archived plans): `YYYY-MM-DD-short-title.md`.

**Frontmatter (every note, from a template):**
```yaml
---
title: Users Service Design
type: spec              # spec | adr | runbook | convention | pattern | lesson | retro | plan | reference
area: users             # users | orders | tracking | events-pipeline | infra | shared
status: draft           # draft | active | accepted | superseded
created: 2026-06-26
updated: 2026-06-26
tags: [area/users, type/spec, status/draft]
related: ["[[soft-delete]]", "[[nano-id]]", "[[cqrs]]"]
---
```
ADRs add `id`, `deciders`, `supersedes`/`superseded-by`. Integration runbooks add `integration-status`, `verified-on`, `verified-by`. `reference` = raw source/origin material (the original prompt, early notes) kept under `docs/00-overview/sources/` — a starting point, not the source of truth.

## Seeded Content

### 00-overview
`index.md` (root MOC), `architecture.md` (API Gateway → ALB → ECS Fargate, gRPC, SQS→Lambda, read/write replicas, Cognito, SigNoz — Mermaid), `system-context.md` (C4 levels 1–2, Mermaid), `glossary.md`.

### shared/decisions — ADRs (one per key decision)

| ADR | Title |
|---|---|
| ADR-0001 | Terraform modules with cloudposse/label naming |
| ADR-0002 | CQRS pattern across all services |
| ADR-0003 | gRPC for inter-service communication |
| ADR-0004 | Soft-delete only (DB user without DELETE privilege) |
| ADR-0005 | nano-id with Stripe-style prefixes for entity IDs |
| ADR-0006 | Read replica + write replica per database |
| ADR-0007 | Secrets in Secret Manager, config in Parameter Store |
| ADR-0008 | Screaming architecture + dependency injection |
| ADR-0009 | API Gateway → ALB → ECS Fargate (prod) / Docker Watch (local) |
| ADR-0010 | AWS Cognito for authN/authZ |
| ADR-0011 | Observability: CloudWatch → SigNoz |
| ADR-0012 | Ministack for local AWS emulation |
| ADR-0013 | API versioning across all services |
| ADR-0014 | Env validation with Zod-style schemas |

### shared/conventions + shared/patterns + shared/observability
Concise evergreen notes: `audit-fields.md`, `nano-id.md`, `soft-delete.md`, `db-naming.md`, `versioning.md`; `cqrs.md`, `screaming-architecture.md`, `dependency-injection.md`; `signoz-cloudwatch.md`.

### domains — one fully-developed service spec each
- `users/specs/users-service-design.md` — Fastify, Aurora Postgres. Endpoints: register (emits `USER_CREATED`), login, GET/PATCH me. gRPC: GetUserById. DB: Users(id, email, fullName, address JSONB, phone_number, audit fields).
- `orders/specs/orders-service-design.md` — .NET Core 10 Minimal APIs, Aurora MySQL. Endpoints: POST /orders (emits `ORDER_CREATED`), GET /orders/my-orders, GET /orders/{id} (ownership check). gRPC: GetOrderById. DB: Product, Order, OrderDetails.
- `tracking/specs/tracking-service-design.md` — FastAPI, Aurora MySQL. Endpoints: POST /trackings, PUT /trackings/{order_id}/status. gRPC: GetTrackingByOrderId, GetTrackingsByOrderIds. DB: Tracking, Tracking_History.
- `events-pipeline/specs/events-pipeline-design.md` — SQS→Lambda, DocumentDB. CQRS dispatch by event type (e.g. `ORDER_CREATED => OrderCreatedHandler`). Status machine: STARTED → IN_PROGRESS → COMPLETED/FAILED. DB: Events(friendlyId, order_id, user_id, type, source, payload, status_history, audit fields).

### infrastructure
`specs/`: `terraform-modules.md`, `networking.md` (API Gateway, ALB, Route 53, VPC), `aws-resources.md` (ECS/ECR/RDS Aurora/SQS/Lambda/DocumentDB/Cognito/Secret Manager/Parameter Store). `runbooks/`: `local-dev-ministack.md`, `secret-rotation.md`.

### templates
One per note type: `spec-template.md`, `adr-template.md`, `runbook-template.md`, `convention-template.md`, `pattern-template.md`, `lesson-template.md`, `retro-template.md`, `plan-template.md`.

### Bases (.base)
In `00-overview/`: `adrs.base` (ADRs grouped by status), `specs.base` (specs by area), `runbooks.base` (integration runbooks).

## Cleanup

- Delete the default `docs/Welcome.md`.
- Replace the root `README.md` with a vault navigation guide.

## Content Depth

Service specs are fully developed (endpoints, DB schemas with audit fields, emitted events, gRPC methods). ADRs follow a concise decision/context/consequences format. Conventions and patterns are short reference notes that specs link to.

## Success Criteria

- `docs/` opens in Obsidian with a working graph and no broken wikilinks among seeded notes.
- Every seeded note has valid frontmatter from its template.
- The 4 service specs each link their cross-cutting rules (no rule defined twice).
- The 14 ADRs exist in `shared/decisions/` with continuous numbering.
- The 3 Bases load and group notes by their frontmatter.

## Related

- [[index]]
- [[architecture]]
- Source requirements: `first-prompt-en.md`
