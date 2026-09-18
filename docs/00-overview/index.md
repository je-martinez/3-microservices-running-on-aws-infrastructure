---
title: 3MRAI — Index
type: spec
area: shared
status: active
created: 2026-06-26
updated: 2026-09-10
tags:
  - type/spec
  - area/shared
  - status/active
related:
  - "[[testing]]"
  - "[[2026-07-17-testing-layers-and-e2e-gateway-design]]"
  - "[[scripting-language]]"
  - "[[env-files]]"
  - "[[code-comments]]"
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
  - "[[2026-08-18-distributed-tracing-spans-design]]"
  - "[[2026-08-25-response-caching-layer-design]]"
  - "[[x-cache-response-header]]"
  - "[[2026-08-25-account-deletion-design]]"
  - "[[2026-08-27-tracking-go-migration-design]]"
  - "[[ADR-0021-tracking-go-gin-sqlc-stack]]"
  - "[[pencil-design-extraction]]"
  - "[[2026-08-17-web-app-foundation-design]]"
  - "[[angular-component-authoring]]"
  - "[[2026-09-04-web-gateway-integration-design]]"
  - "[[web-gateway-integration-milestone]]"
  - "[[2026-09-04-a-retrying-url-assertion-passes-mid-redirect]]"
  - "[[2026-09-04-a-concurrency-test-can-fail-by-starvation]]"
  - "[[2026-09-04-a-build-time-env-var-absent-at-build-time-is-a-live-lookup]]"
  - "[[2026-09-06-address-geocoding-proxy-design]]"
  - "[[web-app-foundation-milestone]]"
  - "[[2026-07-31-contextvars-lost-across-task-boundaries]]"
  - "[[2026-07-31-exit-code-should-reflect-this-steps-work]]"
  - "[[2026-07-31-python-logging-extra-silently-dropped]]"
  - "[[2026-08-12-server-error-middleware-outside-pure-asgi-middleware]]"
  - "[[2026-08-14-counter-metrics-need-a-clock-and-a-window]]"
  - "[[2026-08-16-cloudwatch-lambda-log-prefix-defeats-json-parse]]"
  - "[[2026-08-21-asgi-instrumentation-double-spans-every-response]]"
  - "[[2026-08-21-verify-in-the-viewer-not-the-api]]"
  - "[[2026-08-25-cart-innodb-generated-column-fk-restriction]]"
  - "[[2026-08-25-preview-must-mirror-charging-roundings-application-point]]"
  - "[[2026-08-25-reads-are-not-exempt-from-observability]]"
  - "[[2026-08-25-route-works-in-process-but-404s-at-gateway]]"
  - "[[2026-08-26-cache-keys-built-from-a-raw-identity-header]]"
  - "[[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]"
  - "[[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]]"
  - "[[2026-08-27-a-librarys-defaults-encode-assumptions-about-a-generic-service]]"
  - "[[2026-08-27-a-producer-side-test-proves-nothing-about-what-the-consumer-accepts]]"
  - "[[2026-08-27-accumulated-local-state-degrades-the-stack-silently]]"
  - "[[2026-08-29-the-emulator-was-the-ceiling-not-the-code]]"
  - "[[2026-08-30-a-global-teardown-cannot-be-scoped]]"
  - "[[2026-08-30-a-script-on-stdin-has-no-package-json]]"
  - "[[2026-09-03-animation-clock-sampling-beats-style-and-class-probes]]"
  - "[[2026-09-03-cart-drawer-first-open-flicker]]"
  - "[[2026-09-03-cart-drawer-scrim-lead-flicker]]"
  - "[[2026-09-03-unstyled-custom-element-host-is-inline]]"
  - "[[2026-09-04-angular-http-testing-traps]]"
  - "[[2026-09-04-instanceof-across-a-structured-clone-realm]]"
  - "[[2026-09-07-a-dead-path-is-not-fail-closed-against-an-external-host]]"
  - "[[2026-09-07-dev-form-autofill]]"
  - "[[2026-09-08-put-cart-takes-five-seconds]]"
  - "[[2026-09-09-a-rejected-message-is-not-a-retried-one]]"
  - "[[2026-09-09-makefile-orchestration-invariants]]"
  - "[[2026-09-09-migration-version-tables-lie-about-schema]]"
  - "[[2026-09-10-formfield-owns-its-control-bindings-ng8022]]"
  - "[[2026-09-10-formfield-reads-the-raw-dom-value]]"
  - "[[2026-09-10-signal-forms-required-accepts-whitespace]]"
  - "[[floci-recreate-destroys-backing-containers]]"
  - "[[floci-storage-modes-and-tmp-corruption]]"
  - "[[grpc-context-activate-at-dispatch]]"
  - "[[mocks-hide-schema-bugs]]"
  - "[[signoz-selfhost-migrator-blocker]]"
  - "[[tightened-schemas-need-producer-first-deploys]]"
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
- [[ADR-0019-distributed-tracing-opentelemetry]] — OpenTelemetry SDK in all services for distributed tracing, re-evaluating the tracing/logs-only stance of [[ADR-0018-observability-openobserve]] after OpenObserve's trace ingest initially rejected the collector's OTLP batches (traces went to Jaeger meanwhile). That ingest rejection no longer reproduces on OpenObserve v0.91.1; Jaeger was removed 2026-08-21 and OpenObserve is now the single backend for both logs and traces — see the ADR's Amendment.

### Documentation & Diagrams

- [[ADR-0015-drawio-diagrams]] — draw.io (`.drawio.svg`) as the vault diagram format, replacing Mermaid.

### Runtimes & Languages

- [[ADR-0021-tracking-go-gin-sqlc-stack]] — Tracking's Go port uses Gin (HTTP), sqlc +
  `database/sql` (data access), golang-migrate (schema migrations), and goenv (`.go-version`
  pinning), extracted from [[2026-08-27-tracking-go-migration-design]].

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
- [[code-comments]] — Five-tag comment convention (`CONTRACT:`, `WORKAROUND(<scope>):`, `WHY:`, `WARNING:`, `TODO(JE-<id>):`), present-tense invariants with `See [[vault-id]]` references, and a >12-line hard error — comments describe the final state, not debugging history.
- [[doc-propagation]] — Superpowers specs/plans are where decisions are made; the organized vault is where they live. New specs/plans must declare `propagates-to:` (or an explicit `none — reason` opt-out), enforced by a validator gate; the 63 historical notes predating the rule are tracked as debt, not errors.
- [[x-cache-response-header]] — `X-Cache: HIT|MISS|BYPASS` contract for the shared-Redis response cache across Users/Orders/Tracking: header semantics, fail-open behaviour, the `CACHE_ENABLED` kill switch, and cacheability rules.
- [[pencil-design-extraction]] — How a Pencil `.pen` design becomes code: the three derived artefacts (`DESIGN.md`, HTML exports, synced images), tokens from `GetVariables()` never from an export's hex classes, the "stop and report a gap, never substitute" rule (the scrim finding), the shared web/email design system, and the desktop-only MCP bridge quirk.
- [[angular-component-authoring]] — Two Angular component rules: templates/styles live in a sibling `.html`/CSS file via `templateUrl` (never inline `template:` backticks, sidestepping the `${{ }}` parse trap), and sizing values use `rem` not `px` (the design isn't on a 4px grid, so convert by ÷16 rather than rounding to Tailwind's scale) — borders stay in `px` as the one exception. Extends [[pencil-design-extraction]]'s "translate, not transcribe" rule from colour tokens to units and file structure.

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
- [[2026-08-18-distributed-tracing-spans-design]] — Design for manual OpenTelemetry spans on top of the existing SDKs: a workflow-span pattern (`withWorkflowSpan`/`IWorkflowTracer`/decorator) covering the 12 flows with a full `app_event` triad, span links (not parent-child) across the SQS hop via `traceparent` in `MessageAttributes`, per-record instrumentation inside events-pipeline closing JE-138, extending the SDK into the three realtime-events Lambdas, and new Prisma/AWS-SDK auto-instrumentation; rejects a custom `x-trace-id` header and a Tracking HTTP-client instrumentation (Tracking makes no outbound HTTP calls); per [[ADR-0019-distributed-tracing-opentelemetry]], [[logging-context]], [[ADR-0003-grpc-inter-service]], [[events-pipeline-design]].
- [[2026-08-25-response-caching-layer-design]] — Design for a shared-Redis, HTTP-layer response cache across Users/Orders/Tracking reporting `X-Cache: HIT|MISS|BYPASS` via a per-service interceptor (no handler-level cache-aside, no edge/nginx caching), fail-open with a 50ms timeout, explicit post-write invalidation, and a `CACHE_ENABLED` kill switch; reuses the existing `infra/modules/redis` deployment. New shared convention: [[x-cache-response-header]]. Per [[current-caller-context]], [[logging-context]], [[env-files]], [[testing]], [[ADR-0019-distributed-tracing-opentelemetry]].
- [[2026-08-25-account-deletion-design]] — Design for self-service account deletion (`DELETE /v1/users/me`): synchronous internal-HTTP cascade to Orders and Tracking keyed on `cognito_sub` (with a `user_id` fallback in Tracking for pre-migration rows), a partial unique index freeing the email for re-registration, `AdminDeleteUser` as the point-of-no-return that frees the email in Cognito, and a deliberate decision **not** to publish a `USER_DELETED` event; per [[ADR-0004-soft-delete-only]], [[soft-delete]], [[users-service-design]], [[orders-service-design]], [[tracking-service-design]].
- [[2026-08-27-tracking-go-migration-design]] — Design for migrating Tracking from Python/FastAPI to Go/Gin: a faithful layer-by-layer port (Gin + sqlc + golang-migrate, see [[ADR-0021-tracking-go-gin-sqlc-stack]]) run alongside the untouched Python service against the same database, a `tracking-go-impl` agent fanned out across 4 waves (foundations, platform, endpoints, a standalone TestMode wave fixing a request-context-cancellation bug invisible to line-by-line translation), OTel instrumentation moving from Python's zero-code auto-instrumentation into explicit Go code, and a four-part closing gate (three test layers, empty `openapi.yaml` diff, measured Gatling comparison, observability parity) before the Python folder is deleted; per [[tracking-service-design]], [[testmode-in-process-no-durable-scheduler]], [[user-id-vs-cognito-sub-ownership-key]], [[two-api-keys-two-trust-domains]], [[ADR-0019-distributed-tracing-opentelemetry]].
- [[2026-08-17-web-app-foundation-design]] — Design of `apps/web/`: an Angular 21 + NgRx + Tailwind 4 web app laying out all 18 designed screens (36 responsive frames) from `assets/web-app/web-app.pen`, the `pencil-design-extraction` skill/agent that mines it, and typed phase-1 fixtures derived from the three services' `openapi.yaml` with no gateway calls yet; see [[pencil-design-extraction]] for the extraction convention this design established.
- [[2026-09-04-web-gateway-integration-design]] — Design for phase 2 of `apps/web/`: replacing the phase-1 fixtures with real gateway calls via same-origin nginx/`ng serve` proxying (not CORS, which neither the gateway nor nginx configures), an encrypted-IndexedDB token store with a non-extractable `CryptoKey`, a shared/deduped refresh interceptor, and a server-backed cart; per [[2026-08-17-web-app-foundation-design]], [[money-representation]], [[env-files]], [[testing]], [[git-workflow]]. Milestone plan: [[web-gateway-integration-milestone]].
- [[2026-09-06-address-geocoding-proxy-design]] — Design for a same-origin Geoapify geocoding proxy in `apps/web/nginx.conf` (JE-252): the API key stays server-side and is appended by nginx, the proxy fails CLOSED with a 503 when the key is unset (Geoapify answers 401 and still burns a free-tier request), and `NG_APP_GEOCODE_ENABLED`/`GEOAPIFY_API_KEY` are separate build-time/runtime switches that must both be on. Selective `/geocode/`-only access logging meters the 3,000/day free tier and surfaced a stack-wide OpenObserve ingestion gap (JE-253); per [[2026-09-04-web-gateway-integration-design]], [[env-files]], [[openobserve-cloudwatch]].
- [[2026-09-10-in-app-notifications-design]] — Design for an in-app notification inbox (bell/panel, full-page list, live toasts): SNS fan-out ahead of the shared events queue so Users can add a competing `sqs-consumer` without starving the events-pipeline Lambda (SQS is point-to-point), a Postgres `Notification` table in Users keyed by the internal `user_id` (not DynamoDB, not Cognito) storing rendered `title`/`body`/`metadata` with no idempotency key (duplicates on redelivery are an accepted outcome), Users pushing `NOTIFICATION_CREATED` over the existing WebSocket channel, and a capped (50, no pagination) three-endpoint REST surface; per [[users-service-design]], [[events-pipeline-design]], [[terraform-modules]], [[2026-08-05-realtime-tracking-events-websocket-design]], [[2026-08-17-web-app-foundation-design]].

---

## Lessons

Durable empirical findings from spikes, incidents, and debugging sessions — one note per
finding, all under `docs/lessons/`. Grouped below by the kind of trap each one records, since
what makes a lesson reusable is the shape of the mistake, not the service it happened in.

### Verification that proves less than it looks like it does

- [[2026-08-21-verify-in-the-viewer-not-the-api]] — confirming data reached a backend is not confirming a feature works; three claims in one session were verified against the wrong surface.
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] — a specified concurrent-PUT retry shipped as an unhandled 500 and passed review, because review asked "is this correct?" instead of "does this do what was specified?".
- [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]] — full unit coverage, review, and merge do not establish that a component is wired into any running path.
- [[2026-08-27-a-producer-side-test-proves-nothing-about-what-the-consumer-accepts]] — asserting what you emit says nothing about what the other side validates.
- [[2026-09-04-a-concurrency-test-can-fail-by-starvation]] — a non-overlap assertion made after flushing every concurrent write passes vacuously.
- [[2026-09-04-a-retrying-url-assertion-passes-mid-redirect]] — Playwright's retrying `toHaveURL` can pass in the frame before a guard's redirect finishes.
- [[mocks-hide-schema-bugs]] — a green mocked-Prisma suite cannot catch a wrong assumption about the real schema.
- [[2026-08-14-counter-metrics-need-a-clock-and-a-window]] — a counter without a clock and a window is not a rate, and reads as one.
- [[2026-08-25-reads-are-not-exempt-from-observability]] — read endpoints need the same instrumentation as writes, and an unchecked precedent carried a false claim through implementation.

### Frameworks and libraries behaving unlike their documentation

- [[2026-07-12-prisma-lazy-promise-als]] — Prisma's lazy `PrismaPromise` exits an `AsyncLocalStorage` scope before the query runs, stamping the wrong audit actor.
- [[grpc-context-activate-at-dispatch]] — a grpc-js interceptor must activate the propagated context around the continuation that dispatches the handler, not the one that returns first.
- [[2026-07-31-contextvars-lost-across-task-boundaries]] — Python `contextvars` silently drop request identity across two task boundaries.
- [[2026-07-31-python-logging-extra-silently-dropped]] — Python's `logging` discards `extra=` unless a formatter emits it.
- [[2026-08-12-server-error-middleware-outside-pure-asgi-middleware]] — Starlette's `ServerErrorMiddleware` sits outside every `add_middleware` layer, so pure-ASGI middleware never sees a 5xx.
- [[2026-08-21-asgi-instrumentation-double-spans-every-response]] — the ASGI instrumentation spans every ASGI message, drawing two identically-named spans per response.
- [[2026-08-27-a-librarys-defaults-encode-assumptions-about-a-generic-service]] — instrumentation defaults encode assumptions about a generic service; verify them against what yours carries.
- [[2026-09-04-angular-http-testing-traps]] — three Angular testing traps that read as wiring bugs.
- [[2026-09-04-instanceof-across-a-structured-clone-realm]] — `instanceof` stops holding once a value crosses a structured-clone realm.
- [[2026-09-10-formfield-owns-its-control-bindings-ng8022]] — `[formField]` owns a fixed set of control bindings; binding one by hand is a compile error.
- [[2026-09-10-formfield-reads-the-raw-dom-value]] — `[formField]` on a native input reads the raw DOM value, racing a sanitising `(input)` handler.
- [[2026-09-10-signal-forms-required-accepts-whitespace]] — Signal Forms' `required()` accepts whitespace, so it is weaker than the `.trim()` guard it replaces.

### Browser and UI defects invisible to the obvious probe

- [[2026-09-03-unstyled-custom-element-host-is-inline]] — unstyled Angular custom elements default to `display:inline`, collapsing `w-full` template roots.
- [[2026-09-03-animation-clock-sampling-beats-style-and-class-probes]] — only `requestAnimationFrame`-sampled `animation.currentTime` exposes a dropped frame.
- [[2026-09-03-cart-drawer-first-open-flicker]] — a freshly mounted element's first animation frame can miss its deadline, and the fix must resume from a zone-tracked signal.
- [[2026-09-03-cart-drawer-scrim-lead-flicker]] — the `animation` shorthand resets `animation-play-state`, so a pause rule's effect depends on declaration order.
- [[2026-09-07-dev-form-autofill]] — three constraints on dev-only form autofill that only surfaced by building it.

### Data, schema, and identity

- [[2026-08-25-cart-innodb-generated-column-fk-restriction]] — InnoDB rejects a `CASCADE` foreign key on a column a stored generated column depends on.
- [[2026-08-25-preview-must-mirror-charging-roundings-application-point]] — a preview must mirror the charging code's rounding *application point*, not just its rounding mode.
- [[2026-08-26-cache-keys-built-from-a-raw-identity-header]] — a cache key built from a raw identity header cannot be invalidated by a canonical-identity cascade.
- [[2026-09-09-migration-version-tables-lie-about-schema]] — a migration tool reports "up to date" from its version table, not from the schema.
- [[tightened-schemas-need-producer-first-deploys]] — tightening a schema across a producer/consumer boundary requires deploying the producer first.
- [[2026-09-09-a-rejected-message-is-not-a-retried-one]] — rejecting a message and retrying it are different outcomes, and the queue treats them differently.

### Gateway, routing, and performance

- [[2026-08-25-route-works-in-process-but-404s-at-gateway]] — a route that works on the service port can still 404 at the gateway; the 404's body shape names which layer dropped it.
- [[2026-09-04-a-build-time-env-var-absent-at-build-time-is-a-live-lookup]] — an `NG_APP_*` variable absent at build time becomes a live browser lookup that throws before Angular boots.
- [[2026-09-07-a-dead-path-is-not-fail-closed-against-an-external-host]] — a path that looks dead still reaches an external host, so it is not fail-closed.
- [[2026-09-08-put-cart-takes-five-seconds]] — where the five seconds in `PUT /v1/cart` actually went.

### Local environment, tooling, and the Floci emulator

- [[ministack-auth-chain-spike-findings]] — proven local auth-chain topology, DNS quirks, provider pins, and ECS workarounds from the JE-25 spike.
- [[floci-vs-ministack-spike-findings]] — A/B comparison of Floci vs Ministack on the same auth chain.
- [[floci-rds-apigw-limits]] — Floci's RDS/API Gateway limits found during JE-36.
- [[floci-sqs-lambda-docdb-support]] — probe of Floci's SQS, Lambda, and DocumentDB support ahead of the events-pipeline milestone.
- [[floci-websocket-apigw-dynamodb-support]] — probe of Floci's WebSocket API Gateway + DynamoDB support for realtime events.
- [[floci-elasticache-two-ports-and-provider-panic]] — a real Valkey container, a provider panic on `NodeGroups[0]`, and two disagreeing ports.
- [[floci-storage-modes-and-tmp-corruption]] — `persistent` (not the README's `hybrid`) is the correct storage mode, plus a truncated-`.tmp` corruption pattern.
- [[floci-recreate-destroys-backing-containers]] — Floci's persisted state must be destroyed together with its backing containers, or phantom clusters report "available".
- [[2026-08-27-accumulated-local-state-degrades-the-stack-silently]] — a long-running local stack degraded ~1700x on unchanged code and was misdiagnosed as a code defect twice.
- [[2026-08-29-the-emulator-was-the-ceiling-not-the-code]] — the throughput limit under measurement belonged to the emulator, not to the service.
- [[2026-09-09-makefile-orchestration-invariants]] — why the bootstrap chain is ordered the way it is.
- [[2026-07-31-exit-code-should-reflect-this-steps-work]] — a chained script's exit code must reflect its own step, not a downstream readiness check.
- [[2026-08-30-a-script-on-stdin-has-no-package-json]] — a script piped on stdin resolves nothing from the project it appears to run in.
- [[2026-08-30-a-global-teardown-cannot-be-scoped]] — a global teardown runs for the whole run, so it cannot be limited to one project's fixtures.
- [[signoz-selfhost-migrator-blocker]] — the self-hosted SigNoz schema-migrator hangs and never creates the `signoz_*` database.

### Observability and documentation output

- [[2026-08-16-cloudwatch-lambda-log-prefix-defeats-json-parse]] — CloudWatch's Lambda log prefix defeats a JSON-anchored parse.
- [[drawio-diagram-legibility]] — XML validity does not make a diagram legible; verify contrast and fit by rendering to PNG.

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
- [[code-comments]]
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
- [[2026-08-25-response-caching-layer-design]]
- [[x-cache-response-header]]
- [[2026-08-25-account-deletion-design]]
- [[2026-08-27-tracking-go-migration-design]]
- [[ADR-0021-tracking-go-gin-sqlc-stack]]
- [[pencil-design-extraction]]
- [[2026-08-17-web-app-foundation-design]]
- [[angular-component-authoring]]
- [[2026-09-04-web-gateway-integration-design]]
- [[web-gateway-integration-milestone]]
- [[2026-09-04-a-retrying-url-assertion-passes-mid-redirect]]
- [[2026-09-04-a-concurrency-test-can-fail-by-starvation]]
- [[2026-09-04-a-build-time-env-var-absent-at-build-time-is-a-live-lookup]]
- [[2026-09-06-address-geocoding-proxy-design]]
- [[web-app-foundation-milestone]]
- [[2026-07-31-contextvars-lost-across-task-boundaries]]
- [[2026-07-31-exit-code-should-reflect-this-steps-work]]
- [[2026-07-31-python-logging-extra-silently-dropped]]
- [[2026-08-12-server-error-middleware-outside-pure-asgi-middleware]]
- [[2026-08-14-counter-metrics-need-a-clock-and-a-window]]
- [[2026-08-16-cloudwatch-lambda-log-prefix-defeats-json-parse]]
- [[2026-08-21-asgi-instrumentation-double-spans-every-response]]
- [[2026-08-21-verify-in-the-viewer-not-the-api]]
- [[2026-08-25-cart-innodb-generated-column-fk-restriction]]
- [[2026-08-25-preview-must-mirror-charging-roundings-application-point]]
- [[2026-08-25-reads-are-not-exempt-from-observability]]
- [[2026-08-25-route-works-in-process-but-404s-at-gateway]]
- [[2026-08-26-cache-keys-built-from-a-raw-identity-header]]
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]
- [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]]
- [[2026-08-27-a-librarys-defaults-encode-assumptions-about-a-generic-service]]
- [[2026-08-27-a-producer-side-test-proves-nothing-about-what-the-consumer-accepts]]
- [[2026-08-27-accumulated-local-state-degrades-the-stack-silently]]
- [[2026-08-29-the-emulator-was-the-ceiling-not-the-code]]
- [[2026-08-30-a-global-teardown-cannot-be-scoped]]
- [[2026-08-30-a-script-on-stdin-has-no-package-json]]
- [[2026-09-03-animation-clock-sampling-beats-style-and-class-probes]]
- [[2026-09-03-cart-drawer-first-open-flicker]]
- [[2026-09-03-cart-drawer-scrim-lead-flicker]]
- [[2026-09-03-unstyled-custom-element-host-is-inline]]
- [[2026-09-04-angular-http-testing-traps]]
- [[2026-09-04-instanceof-across-a-structured-clone-realm]]
- [[2026-09-07-a-dead-path-is-not-fail-closed-against-an-external-host]]
- [[2026-09-07-dev-form-autofill]]
- [[2026-09-08-put-cart-takes-five-seconds]]
- [[2026-09-09-a-rejected-message-is-not-a-retried-one]]
- [[2026-09-09-makefile-orchestration-invariants]]
- [[2026-09-09-migration-version-tables-lie-about-schema]]
- [[2026-09-10-formfield-owns-its-control-bindings-ng8022]]
- [[2026-09-10-formfield-reads-the-raw-dom-value]]
- [[2026-09-10-signal-forms-required-accepts-whitespace]]
- [[floci-recreate-destroys-backing-containers]]
- [[floci-storage-modes-and-tmp-corruption]]
- [[grpc-context-activate-at-dispatch]]
- [[mocks-hide-schema-bugs]]
- [[signoz-selfhost-migrator-blocker]]
- [[tightened-schemas-need-producer-first-deploys]]
