---
title: 3MRAI — Index
type: spec
area: shared
status: active
created: 2026-06-26
updated: 2026-08-18
tags:
  - type/spec
  - area/shared
  - status/active
related:
  - "[[testing]]"
  - "[[2026-07-17-testing-layers-and-e2e-gateway-design]]"
  - "[[scripting-language]]"
  - "[[env-files]]"
  - "[[doc-propagation]]"
  - "[[local-dev-floci]]"
  - "[[package-manager]]"
  - "[[architecture]]"
  - "[[system-context]]"
  - "[[glossary]]"
  - "[[users-service-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[2026-06-26-3mrai-docs-vault-design]]"
  - "[[2026-06-26-implementation-workflow-design]]"
  - "[[2026-06-28-services-infra-scaffold-design]]"
  - "[[2026-06-28-users-service-design]]"
  - "[[2026-07-10-signoz-logs-observability-design]]"
  - "[[2026-07-10-openobserve-migration-design]]"
  - "[[2026-06-27-milestone-plan-convention-design]]"
  - "[[2026-06-29-floci-local-emulator-spike-design]]"
  - "[[2026-07-03-git-workflow-decentralization-design]]"
  - "[[2026-07-03-local-dev-tooling-design]]"
  - "[[2026-07-04-je36-local-env-compose-design]]"
  - "[[2026-07-09-users-cognito-webhook-design]]"
  - "[[2026-07-10-users-openapi-autogen-design]]"
  - "[[2026-07-11-auth-error-mapping-design]]"
  - "[[2026-07-11-authenticated-identity-resolution-design]]"
  - "[[2026-07-11-gap1-nginx-njs-xuserid-design]]"
  - "[[2026-07-11-local-gateway-per-route-integration-design]]"
  - "[[2026-07-11-refresh-token-endpoint-design]]"
  - "[[2026-07-12-app-user-id-token-claim-design]]"
  - "[[2026-07-12-audit-actor-enum-design]]"
  - "[[2026-07-14-orders-service-milestone-design]]"
  - "[[2026-07-15-orders-rds-mysql-design]]"
  - "[[2026-07-15-two-phase-post-effects-design]]"
  - "[[2026-07-15-orders-gateway-integration-design]]"
  - "[[2026-07-16-orders-for-update-interceptor-design]]"
  - "[[2026-07-16-structured-logging-and-dashboards-design]]"
  - "[[2026-07-16-scoped-current-user-context-design]]"
  - "[[2026-07-16-orders-list-products-endpoint-design]]"
  - "[[2026-07-17-terraform-remote-state-backend-design]]"
  - "[[2026-07-19-scripts-to-python-migration-design]]"
  - "[[2026-07-19-logging-context-and-tracing-design]]"
  - "[[2026-07-20-env-file-generation-design]]"
  - "[[2026-07-30-post-infra-root-design]]"
  - "[[ADR-0015-drawio-diagrams]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[logging-context]]"
  - "[[ministack-auth-chain-spike-findings]]"
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[floci-rds-apigw-limits]]"
  - "[[2026-07-12-prisma-lazy-promise-als]]"
  - "[[drawio-diagram-legibility]]"
  - "[[cognito-pre-token-lambda]]"
  - "[[awscli-fallback-for-floci]]"
  - "[[execution-log-for-provisioning-scripts]]"
  - "[[2026-08-05-realtime-tracking-events-websocket-design]]"
  - "[[2026-08-05-realtime-tracking-events-websocket]]"
  - "[[floci-sqs-lambda-docdb-support]]"
  - "[[floci-websocket-apigw-dynamodb-support]]"
  - "[[2026-08-06-multi-provider-agent-config-sync-design]]"
  - "[[2026-08-06-multi-provider-agent-config-sync]]"
  - "[[ADR-0020-self-owned-password-reset]]"
  - "[[self-owned-password-reset-codes-in-redis]]"
  - "[[password-policy-checklist-gap]]"
  - "[[redis-elasticache-replication-group-floci]]"
  - "[[floci-elasticache-two-ports-and-provider-panic]]"
  - "[[2026-08-10-product-catalogue-image-categories-design]]"
  - "[[2026-08-15-request-id-correlation-design]]"
  - "[[pencil-design-extraction]]"
  - "[[2026-08-17-web-app-foundation-design]]"
---

# 3MRAI — Index

Root Map of Content for the **3 Microservices Running on AWS Infrastructure (3MRAI)** documentation vault. This is the entry point: navigate from here to every service spec, ADR, convention, pattern, runbook, and design spec in the project.

> [!tip] Navigation
> Use `Ctrl/Cmd + Click` on any wikilink to open the note. Use the graph view to explore connections between notes.

---

## Overview

- [[architecture]] — System architecture: API Gateway, ALB, ECS Fargate, gRPC, SQS/Lambda, DocumentDB, SigNoz.
- [[system-context]] — C4 Level-1 (system context) and Level-2 (containers) diagrams.
- [[glossary]] — Definitions of key terms used across the project.

---

## Services

| Note | Description |
|---|---|
| [[users-service-design]] | Users service: Cognito auth, nano-id, soft-delete, CQRS, MongoDB |
| [[orders-service-design]] | Orders service: order lifecycle, gRPC to tracking, CQRS |
| [[tracking-service-design]] | Tracking service: location events, gRPC receiver, SQS consumer |
| [[events-pipeline-design]] | Events pipeline: one shared SQS queue, Lambda CQRS dispatch, DocumentDB event store, react-email/SES notification emails |

---

## Infrastructure

### Specs

- [[terraform-modules]] — Terraform module layout using CloudPosse naming convention.
- [[networking]] — VPC, subnets, security groups, ALB configuration.
- [[aws-resources]] — ECS Fargate clusters, DocumentDB clusters, SQS queues, Parameter Store.
- [[cognito-pre-token-lambda]] — Cognito `custom:app_user_id` attribute + the repo's first Lambda (Pre-Token-Generation V2) copying it into an `app_user_id` token claim.

### Runbooks

- [[local-dev-floci]] — Running the full stack locally with Floci (Docker Compose + Terraform), from `make bootstrap` through verification.
- [[local-dev-ministack]] — Superseded by [[local-dev-floci]]; kept for historical reference.
- [[secret-rotation]] — Rotating secrets in AWS Parameter Store without downtime.

---

## Architecture Decisions (ADRs)

All ADRs use continuous global numbering and live in `docs/shared/decisions/`.

### Infrastructure & Deployment

- [[ADR-0001-terraform-cloudposse-naming]] — Terraform resource naming via CloudPosse label module.
- [[ADR-0009-apigw-alb-fargate]] — API Gateway + ALB + ECS Fargate as the compute layer.
- [[ADR-0012-ministack-local]] — Ministack (Docker Compose) for local development.

### Auth & Security

- [[ADR-0010-cognito-auth]] — Amazon Cognito for authentication and JWT issuing.
- [[ADR-0007-secrets-parameter-store]] — AWS Parameter Store for secrets management.
- [[ADR-0020-self-owned-password-reset]] — Self-owned password reset (Users mints/stores/emails
  the code and applies it via `AdminSetUserPassword`), not Cognito's `ForgotPassword` — measured
  evidence that Cognito's `CustomMessage` trigger never fires on Floci and only Cognito's own
  code passes `ConfirmForgotPassword`.

### Data & Persistence

- [[ADR-0002-cqrs]] — CQRS pattern: separate write (DocumentDB) and read (replica) paths.
- [[ADR-0006-read-write-replicas]] — Read/write replica topology per service.
- [[ADR-0004-soft-delete-only]] — Soft-delete as the only deletion strategy.
- [[ADR-0005-nano-id-prefixed]] — Prefixed nano-ids as primary identifiers.

### Communication

- [[ADR-0003-grpc-inter-service]] — gRPC for synchronous inter-service communication.

### Application Architecture

- [[ADR-0008-screaming-arch-di]] — Screaming architecture with dependency injection.
- [[ADR-0013-api-versioning]] — API versioning strategy.
- [[ADR-0014-env-validation-zod]] — Environment variable validation with Zod at startup.

### Observability

- [[ADR-0011-observability-signoz]] — SigNoz (via CloudWatch) as the observability backend. Superseded by [[ADR-0018-observability-openobserve]].
- [[ADR-0018-observability-openobserve]] — OpenObserve (via CloudWatch) as the observability backend, superseding SigNoz.
- [[ADR-0019-distributed-tracing-opentelemetry]] — OpenTelemetry SDK in both services for distributed tracing; traces go to Jaeger while logs stay in OpenObserve, re-evaluating the tracing/logs-only stance of [[ADR-0018-observability-openobserve]] after OpenObserve's trace ingest rejected the collector's OTLP batches.

### Documentation & Diagrams

- [[ADR-0015-drawio-diagrams]] — draw.io (`.drawio.svg`) as the vault diagram format, replacing Mermaid.

---

## Conventions

Coding and data conventions defined once in `shared/` and referenced project-wide.

- [[nano-id]] — Prefixed nano-id generation and format.
- [[soft-delete]] — Soft-delete implementation (isDeleted flag + deletedAt timestamp).
- [[audit-fields]] — Standard audit fields (createdAt, updatedAt, createdBy, updatedBy).
- [[db-naming]] — Database collection and field naming rules.
- [[versioning]] — API and package versioning conventions.
- [[linear-references]] — How the vault references Linear issues (tags + links, no mirroring).
- [[milestone-plan]] — Structure and required sections for every milestone plan note in `docs/plans/`.
- [[phase-c-review-flow]] — Phase C execution cadence: chain issues, batch PRs, stop at dependency gates, user merges every PR.
- [[git-workflow]] — Who may run git, commit/branch conventions, and the A/B/C/D/E confirmation menu.
- [[local-dev]] — Running the stack locally (Makefile) and testing endpoints with `.http` files.
- [[testing]] — Three-layer testing convention: unit/integration, internal E2E, and gateway E2E (real Cognito JWT) — an endpoint missing gateway E2E is an incomplete change.
- [[scripting-language]] — Scripting-language decision tree for the repo: Python first, JavaScript second, Bash last with a documented reason.
- [[package-manager]] — pnpm as the default and only Node package manager for every package in the repo, including new sub-projects joining `pnpm-workspace.yaml`.
- [[skills-catalog]] — Claude Code skills evaluated and approved for the 3MRAI agents (deliverable of [JE-23](https://linear.app/je-martinez/issue/JE-23)).
- [[logging-context]] — Shared cross-service log context (trace/span id, hashed/masked email, domain ids), PII masking rules, flow-log pattern, and the OTel environment-variable configuration rules that fixed three silent exporter failures.
- [[env-files]] — Env files are generated by `make env-file` from Terraform outputs, never hand-maintained; per-consumer file split, the AUTO/CUSTOM editing rule, and four silent traps (`environment:` vs `env_file:`, empty-string interpolation, no interpolation inside env files, dropped variables).
- [[doc-propagation]] — Superpowers specs/plans are where decisions are made; the organized vault is where they live. New specs/plans must declare `propagates-to:` (or an explicit `none — reason` opt-out), enforced by a validator gate; the 63 historical notes predating the rule are tracked as debt, not errors.
- [[pencil-design-extraction]] — How a Pencil `.pen` design becomes code: the three derived artefacts (`DESIGN.md`, HTML exports, synced images), tokens from `GetVariables()` never from an export's hex classes, the "stop and report a gap, never substitute" rule (the scrim finding), the shared web/email design system, and the desktop-only MCP bridge quirk.

---

## Patterns

Architectural patterns documented once and linked from service specs.

- [[cqrs]] — CQRS pattern: command/query segregation, handler structure.
- [[screaming-architecture]] — Screaming architecture: folder structure by feature/domain.
- [[dependency-injection]] — DI container setup and usage across services.
- [[awscli-fallback-for-floci]] — `terraform_data` + idempotent awscli script fallback for native Terraform resources/provider blocks that cannot apply against Floci.
- [[execution-log-for-provisioning-scripts]] — DynamoDB-backed log (record-never-skip, fail-open) tracing what `local-exec` provisioning scripts actually did.

---

## Observability

- [[openobserve-cloudwatch]] — OpenObserve setup, CloudWatch integration, and log-querying conventions.
- [[openobserve-runbook]] — Local runbook: start/stop the OpenObserve stack, query logs, verified gotchas.

---

## Design Specs (Superpowers Output)

Specs produced through the planning phase, normalized to vault conventions.

- [[2026-06-26-3mrai-docs-vault-design]] — Design of this documentation vault (structure, conventions, seeded content).
- [[2026-06-26-implementation-workflow-design]] — Implementation workflow and agent topology (two layers, Phase A–D flow).
- [[2026-06-28-services-infra-scaffold-design]] — Services & infra scaffold + skill discovery: screaming-architecture skeletons, nested CLAUDE.md per service, Docker orchestrator, and suggested-skills catalog.
- [[2026-06-28-users-service-design]] — Users Service implementation design: pnpm workspace, Prisma schema with `tags` column, Fastify API, Cognito JWT authorizer, Terraform modules, and Playwright E2E suite on Ministack.
- [[2026-07-10-signoz-logs-observability-design]] — Logs-only implementation of [[ADR-0011-observability-signoz]]: otel-collector-contrib bridging Docker `fluentd` log-driver output and Floci CloudWatch into a self-hosted SigNoz, with zero service source-code changes. Backend superseded by [[2026-07-10-openobserve-migration-design]].
- [[2026-07-10-openobserve-migration-design]] — Migration of the observability backend from SigNoz to OpenObserve: the collector exporter change, OpenObserve compose service, and verified facts, per [[ADR-0018-observability-openobserve]].
- [[2026-06-27-milestone-plan-convention-design]] — Design of the reusable [[milestone-plan]] vault convention: task sequence, phases, and dependency graph as a first-class artifact distinct from live Linear issue state.
- [[2026-06-29-floci-local-emulator-spike-design]] — Design of the Floci local-emulator spike (A/B against Ministack on the real local auth chain) and the `infra-impl` skill; empirical basis for [[ADR-0017-floci-local]].
- [[2026-07-03-git-workflow-decentralization-design]] — Design for letting the main session run git directly (not exclusively through `github-ops`), with the A/B/C/D/E confirmation menu; see [[git-workflow]].
- [[2026-07-03-local-dev-tooling-design]] — Design of the root `Makefile` (local dev lifecycle across compose + Terraform) and `.http` files for exercising endpoints; see [[local-dev]].
- [[2026-07-04-je36-local-env-compose-design]] — Design for compose `environments/local` and applying the Users chain on Floci, including Revision 2's Floci emulation gaps and a least-privilege application DB user.
- [[2026-07-09-users-cognito-webhook-design]] — Design of the Cognito identity webhook + identity tables (`UsersCognitoData`, `UsersCognitoEvent`), reachable via `POST /v1/webhooks/cognito` and in-process from `register()`.
- [[2026-07-10-users-openapi-autogen-design]] — Design for generating `services/users/openapi.yaml` from live Fastify routes via `@fastify/swagger` + Zod, replacing hand-maintained OpenAPI.
- [[2026-07-11-auth-error-mapping-design]] — Design mapping Cognito auth exceptions (bad credentials, duplicate email) to 401/409 HTTP responses instead of 500s, via typed domain errors and a global error handler.
- [[2026-07-11-authenticated-identity-resolution-design]] — Design of `byIdOrCognitoSub`, resolving users by either their `usr_` id or Cognito `sub` across `getMe`, gRPC `getUserById`, and `updateProfile`.
- [[2026-07-11-gap1-nginx-njs-xuserid-design]] — Design for the local nginx+njs reverse proxy decoding the JWT and injecting `x-user-id` before proxying to the users service.
- [[2026-07-11-local-gateway-per-route-integration-design]] — Design fixing local API Gateway path forwarding on Floci via per-route `HTTP_PROXY` integrations, keeping prod on a single shared integration.
- [[2026-07-11-refresh-token-endpoint-design]] — Design of `POST /v1/users/refresh`, exchanging a Cognito refresh token for new id + access tokens via `REFRESH_TOKEN_AUTH`.
- [[2026-07-12-app-user-id-token-claim-design]] — Design adding an `app_user_id` token claim sourced from a new `custom:app_user_id` Cognito attribute, copied in by the repo's first Lambda (Pre-Token-Generation V2 trigger).
- [[2026-07-12-audit-actor-enum-design]] — Design of the semantic `AuditActor` enum used to stamp `createdBy`/`updatedBy` on system-originated writes (e.g. self-registration); see [[audit-fields]].
- [[2026-07-14-orders-service-milestone-design]] — Design of the Orders service first delivery milestone: .NET Core 10 Minimal APIs + EF Core on MySQL via Floci, Stripe-style cents money model, double-identity (`user_id` + `cognito_sub`), Clean Architecture with 5 Class Library projects, and the Users gRPC gate (Issue A) with `x-api-key` inter-service auth.
- [[2026-07-15-orders-rds-mysql-design]] — Design for provisioning Orders' MySQL in the local (Floci) Terraform environment at parity with Users' Postgres: a second `rds-aurora` module instantiation (`engine = "mysql"`), a least-privilege `orders_app` user via `bootstrap.sh`, and `.env`/compose wiring off the current placeholder port.
- [[2026-07-15-two-phase-post-effects-design]] — Design for a second Terraform apply phase (`environments/local/post/`, own state) that creates least-privilege DB app-users natively once phase-1 infra is live, replacing `bootstrap.sh`'s Postgres app-user bash step; MySQL app-user creation stays gated off locally (Floci's mysql provider hangs).
- [[2026-07-15-orders-gateway-integration-design]] — Design integrating Orders into the local API Gateway → nginx chain via multi-backend path-prefix routing, resolving the `/v1/health` collision with Users via per-service health rewrites (`/v1/users/health`, `/v1/orders/health`) and extending the njs `x-user-id` injection to Orders.
- [[2026-07-16-orders-for-update-interceptor-design]] — Design replacing Orders' raw `FromSqlInterpolated FOR UPDATE` pessimistic-lock query with pure LINQ + a `TagWith`-driven EF Core command interceptor, letting the global soft-delete query filter apply automatically per [[ADR-0004-soft-delete-only]].
- [[2026-07-16-structured-logging-and-dashboards-design]] — Design standardizing structured application logging (OTel-aligned, `snake_case` JSON) across all four services, collector-side JSON parsing into queryable columns, and versioned OpenObserve "golden signals" dashboards per service plus a cross-service overview; logs-only scope per [[ADR-0018-observability-openobserve]].
- [[2026-07-16-scoped-current-user-context-design]] — Design of a request-scoped current-caller context, resolved once per request by a middleware against a centralized public-route allowlist, replacing duplicated header reads and identity resolution in `users` (Fastify/Awilix) and `orders` (.NET); see [[ADR-0010-cognito-auth]], [[dependency-injection]], [[audit-fields]], [[ADR-0003-grpc-inter-service]].
- [[2026-07-16-orders-list-products-endpoint-design]] — Design of a new authenticated `GET /v1/products` read endpoint for Orders, mirroring the existing `OrderReadService`/`OrderDto`/`OrderEndpoints` pattern; gated by the `CallerContextMiddleware`, excludes soft-deleted rows via the global query filter, per [[cqrs]], [[soft-delete]], [[versioning]].
- [[2026-07-17-terraform-remote-state-backend-design]] — Design moving Terraform state off local files onto a remote S3 + DynamoDB backend (Floci locally, real AWS in prod), created once via a self-excluding `tf-backend` module/root to resolve the backend chicken-and-egg, ending TF↔Floci state drift; named per [[ADR-0001-terraform-cloudposse-naming]], built on [[ADR-0017-floci-local]], mindful of [[floci-rds-apigw-limits]].
- [[2026-07-17-testing-layers-and-e2e-gateway-design]] — Design of a three-layer testing convention (unit/integration, internal E2E, gateway E2E with a real Cognito JWT) plus a Playwright `gateway` project alongside the existing `internal` one, per [[ADR-0010-cognito-auth]], [[ADR-0016-local-apigw-nginx-ecs]], [[local-dev]], [[versioning]].
- [[2026-07-19-scripts-to-python-migration-design]] — Design for migrating the repo's 5 remaining bash scripts to Python (shared `lib3mrai` package, venv-pinned Terraform `local-exec` interpreter, boto3 over the `aws` CLI) and establishing a Python-first/JavaScript-second/Bash-last scripting-language convention; block 1 of 3 of the Developer Experience milestone, per [[2026-07-15-two-phase-post-effects-design]], [[awscli-fallback-for-floci]], [[testing]].
- [[2026-07-19-logging-context-and-tracing-design]] — Design for a shared cross-service log context (trace/span id, hashed email, domain ids), flow-level logs for register/login/create-order, and real OpenTelemetry distributed tracing across the gRPC boundary into the existing OpenObserve collector; block 2 of 3 of the Developer Experience milestone, per [[2026-07-16-structured-logging-and-dashboards-design]], [[ADR-0018-observability-openobserve]], [[2026-07-12-prisma-lazy-promise-als]].
- [[2026-07-20-env-file-generation-design]] — Design for auto-generating every env file that derives from Terraform discovery, split per consumer (root `.env` for compose interpolation, `.env.local.infra`, per-service `.env.local.<svc>`, and a host-debug file), replacing the Makefile's inline awk/printf and moving compose from inline `environment:` to `env_file:`; block 3 of 3 of the Developer Experience milestone, per [[2026-07-19-scripts-to-python-migration-design]], [[scripting-language]], [[testing]].
- [[2026-07-30-post-infra-root-design]] — Design splitting `make bootstrap` (ends usable: services up, seeded, connecting as the cluster superuser) from a new `make post-infra` (hardens it: moved MySQL provider GRANTs + the existing phase-2 least-privilege app-user apply), plus a DynamoDB execution log — declared in `tf-backend` — that records, but never uses to skip, the outcome of the four post-resource provisioning scripts; per [[two-phase-terraform-apply]], [[scripting-language]], [[env-files]].
- [[2026-08-05-realtime-tracking-events-websocket-design]] — Design for pushing `TRACKING_STATUS_CHANGED` to connected clients over an AWS API Gateway WebSocket API alongside the existing email notification: fan-out from the existing events-pipeline Lambda, a new `functions/realtime-events/` connection-lifecycle package, a DynamoDB connections table keyed by `cognito_sub` (not `user_id`), and a new `infra/modules/api-gateway-ws/` module; per [[events-pipeline-design]], [[tracking-service-design]], [[user-id-vs-cognito-sub-ownership-key]].
- [[2026-08-06-multi-provider-agent-config-sync-design]] — Design of `ai-config-sync`, a subagent keeping this repo's agent configuration consistent across AI coding providers (Codex, Cursor, Copilot, Gemini CLI, OpenCode, Windsurf) via [lnai](https://lnai.sh/): `.claude/` stays source of truth and always real, `.ai/` is derived and disposable, subagents are projected into an `AGENTS.md` roles appendix since lnai has no subagent concept, and every non-portable element is reported explicitly in a loss report; see [[skills-catalog]] for the skill-sharing allowlist.
- [[2026-08-06-multi-provider-agent-config-sync]] — Implementation plan for the sync pipeline: the frontmatter normalizer, lnai initialization with Claude Code disabled as a sync target, the `ai-config-sync` subagent and projection manifest, `make ai-sync`/`make ai-sync-check`, and vault propagation.
- [[2026-08-10-product-catalogue-image-categories-design]] — Design replacing the Orders placeholder catalogue (`Widget`/`Gadget`/`Gizmo`) with the web-app design's eight real products, adding a nullable `ProductImage` value object (relative bucket key, dimensions, blurhash) and an uppercase `Categories` array, both stored as MySQL `json` columns following the `Order.Tags` converter/comparer pattern; per [[orders-service-design]], [[db-naming]], [[soft-delete]], [[env-files]], [[testing]], [[nano-id]].
- [[2026-08-15-request-id-correlation-design]] — Design of a cross-service `request_id` correlation field (`req_`+nanoid), covering the gap `trace_id` leaves in the events-pipeline and realtime Lambdas (no OTel SDK, JE-138): validated inbound `x-request-id`, per-service context propagation reusing each service's existing logging mechanism, and an optional envelope root field so in-flight SQS messages don't fail schema validation; per [[logging-context]], [[nano-id]], [[events-pipeline-design]], [[ADR-0019-distributed-tracing-opentelemetry]].
- [[2026-08-17-web-app-foundation-design]] — Design of `apps/web/`: an Angular 21 + NgRx + Tailwind 4 web app laying out all 18 designed screens (36 responsive frames) from `assets/web-app/web-app.pen`, the `pencil-design-extraction` skill/agent that mines it, and typed phase-1 fixtures derived from the three services' `openapi.yaml` with no gateway calls yet; see [[pencil-design-extraction]] for the extraction convention this design established.

---

## Lessons

Durable empirical findings from spikes, incidents, and experiments.

- [[ministack-auth-chain-spike-findings]] — Empirical findings from the JE-25 Ministack spike: proven local auth chain topology, DNS quirks, provider pins, and ECS workarounds.
- [[floci-vs-ministack-spike-findings]] — A/B comparison of Floci vs Ministack on the same auth chain: gate results, comparison table, and key findings. No migration decision — ADR-0012 unchanged.
- [[floci-rds-apigw-limits]] — Empirical limits of Floci discovered during JE-36 (RDS/Aurora + API Gateway chain): tag-update bugs on RDS/API GW resources, and API Gateway v2 HTTP_PROXY path-forwarding not working.
- [[floci-storage-modes-and-tmp-corruption]] — Floci storage-mode durability testing (README's `hybrid` recommendation is wrong for 3MRAI; `persistent` is correct and already in use) and a truncated-`.tmp` state-file corruption pattern (rare, not mode-specific, root cause unproven).
- [[signoz-selfhost-migrator-blocker]] — Task 3 of the SigNoz logs plan is blocked: the self-hosted SigNoz schema-migrator hangs and never creates the `signoz_*` ClickHouse database. Diagnosis and resume options recorded for the next session.
- [[2026-07-12-prisma-lazy-promise-als]] — Prisma's lazy `PrismaPromise` silently broke `AsyncLocalStorage`-scoped audit actors: a non-awaited wrapper exited the ALS scope before the query (and its actor read) ran, stamping the wrong `createdBy`/`updatedBy`. Mocked tests could not catch it.
- [[drawio-diagram-legibility]] — draw.io diagrams must use verified text/fill contrast and a canvas-fitting layout, checked by rendering to PNG — XML validity alone does not guarantee a legible diagram.
- [[floci-sqs-lambda-docdb-support]] — Empirical probe of Floci's SQS, Lambda (SQS event source mapping), and DocumentDB support ahead of the events-pipeline milestone: all viable as designed, with three local-only findings (no multi-document DocumentDB transactions, a non-stable DocumentDB endpoint, and a silently-dropped `update-event-source-mapping` field).
- [[floci-websocket-apigw-dynamodb-support]] — Empirical probe of Floci's WebSocket API Gateway + DynamoDB support for the realtime-events feature: the REQUEST authorizer's context genuinely propagates (unlike the HTTP API's claim-mapping gap), two undocumented local-only URL shapes, a Cognito JWT verifier issuer-from-configuration requirement, and an unresolved gateway E2E gap.
- [[floci-elasticache-two-ports-and-provider-panic]] — Floci backs ElastiCache with a real Valkey container; the pinned AWS provider panics reading `NodeGroups[0]` on `CreateReplicationGroup`; no subnet-group API at all; and the container's own port (6379) disagrees with the host-side proxy port ElastiCache reports, requiring a moved proxy range (6479-6499) to coexist with a developer's local Redis.

---

## Source Material

Origin materials the project grew from — kept for reference only, not the source of truth.

- [[sources/index|Source Material Index]] — Original prompt and early vault notes.

---

## Related

- [[testing]]
- [[2026-07-17-testing-layers-and-e2e-gateway-design]]
- [[scripting-language]]
- [[env-files]]
- [[doc-propagation]]
- [[local-dev-floci]]
- [[package-manager]]
- [[architecture]]
- [[system-context]]
- [[glossary]]
- [[users-service-design]]
- [[orders-service-design]]
- [[tracking-service-design]]
- [[events-pipeline-design]]
- [[2026-06-26-3mrai-docs-vault-design]]
- [[2026-06-26-implementation-workflow-design]]
- [[2026-06-28-services-infra-scaffold-design]]
- [[2026-06-28-users-service-design]]
- [[2026-07-10-signoz-logs-observability-design]]
- [[2026-07-10-openobserve-migration-design]]
- [[2026-06-27-milestone-plan-convention-design]]
- [[2026-06-29-floci-local-emulator-spike-design]]
- [[2026-07-03-git-workflow-decentralization-design]]
- [[2026-07-03-local-dev-tooling-design]]
- [[2026-07-04-je36-local-env-compose-design]]
- [[2026-07-09-users-cognito-webhook-design]]
- [[2026-07-10-users-openapi-autogen-design]]
- [[2026-07-11-auth-error-mapping-design]]
- [[2026-07-11-authenticated-identity-resolution-design]]
- [[2026-07-11-gap1-nginx-njs-xuserid-design]]
- [[2026-07-11-local-gateway-per-route-integration-design]]
- [[2026-07-11-refresh-token-endpoint-design]]
- [[2026-07-12-app-user-id-token-claim-design]]
- [[2026-07-12-audit-actor-enum-design]]
- [[2026-07-14-orders-service-milestone-design]]
- [[2026-07-15-orders-rds-mysql-design]]
- [[2026-07-15-two-phase-post-effects-design]]
- [[2026-07-15-orders-gateway-integration-design]]
- [[2026-07-16-orders-for-update-interceptor-design]]
- [[2026-07-16-structured-logging-and-dashboards-design]]
- [[2026-07-16-scoped-current-user-context-design]]
- [[2026-07-16-orders-list-products-endpoint-design]]
- [[2026-07-17-terraform-remote-state-backend-design]]
- [[2026-07-19-scripts-to-python-migration-design]]
- [[2026-07-19-logging-context-and-tracing-design]]
- [[2026-07-20-env-file-generation-design]]
- [[2026-07-30-post-infra-root-design]]
- [[ADR-0015-drawio-diagrams]]
- [[ADR-0019-distributed-tracing-opentelemetry]]
- [[logging-context]]
- [[ministack-auth-chain-spike-findings]]
- [[floci-vs-ministack-spike-findings]]
- [[floci-rds-apigw-limits]]
- [[floci-storage-modes-and-tmp-corruption]]
- [[2026-07-12-prisma-lazy-promise-als]]
- [[drawio-diagram-legibility]]
- [[cognito-pre-token-lambda]]
- [[awscli-fallback-for-floci]]
- [[execution-log-for-provisioning-scripts]]
- [[2026-08-05-realtime-tracking-events-websocket-design]]
- [[2026-08-05-realtime-tracking-events-websocket]]
- [[floci-sqs-lambda-docdb-support]]
- [[floci-websocket-apigw-dynamodb-support]]
- [[2026-08-06-multi-provider-agent-config-sync-design]]
- [[2026-08-06-multi-provider-agent-config-sync]]
- [[2026-08-10-product-catalogue-image-categories-design]]
- [[pencil-design-extraction]]
- [[2026-08-17-web-app-foundation-design]]
