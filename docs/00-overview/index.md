---
title: 3MRAI — Index
type: spec
area: shared
status: active
created: 2026-06-26
updated: 2026-06-28
tags:
  - type/spec
  - area/shared
  - status/active
related:
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
  - "[[ADR-0015-drawio-diagrams]]"
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
| [[events-pipeline-design]] | Events pipeline: SQS queues, Lambda CQRS handlers, DocumentDB writes |

---

## Infrastructure

### Specs

- [[terraform-modules]] — Terraform module layout using CloudPosse naming convention.
- [[networking]] — VPC, subnets, security groups, ALB configuration.
- [[aws-resources]] — ECS Fargate clusters, DocumentDB clusters, SQS queues, Parameter Store.

### Runbooks

- [[local-dev-ministack]] — Running the full stack locally with Ministack (Docker Compose).
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

- [[ADR-0011-observability-signoz]] — SigNoz (via CloudWatch) as the observability backend.

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
- [[skills-catalog]] — Claude Code skills evaluated and approved for the 3MRAI agents (deliverable of [JE-23](https://linear.app/je-martinez/issue/JE-23)).

---

## Patterns

Architectural patterns documented once and linked from service specs.

- [[cqrs]] — CQRS pattern: command/query segregation, handler structure.
- [[screaming-architecture]] — Screaming architecture: folder structure by feature/domain.
- [[dependency-injection]] — DI container setup and usage across services.

---

## Observability

- [[signoz-cloudwatch]] — SigNoz setup, CloudWatch integration, and dashboard conventions.

---

## Design Specs (Superpowers Output)

Specs produced through the planning phase, normalized to vault conventions.

- [[2026-06-26-3mrai-docs-vault-design]] — Design of this documentation vault (structure, conventions, seeded content).
- [[2026-06-26-implementation-workflow-design]] — Implementation workflow and agent topology (two layers, Phase A–D flow).
- [[2026-06-28-services-infra-scaffold-design]] — Services & infra scaffold + skill discovery: screaming-architecture skeletons, nested CLAUDE.md per service, Docker orchestrator, and suggested-skills catalog.
- [[2026-06-28-users-service-design]] — Users Service implementation design: pnpm workspace, Prisma schema with `tags` column, Fastify API, Cognito JWT authorizer, Terraform modules, and Playwright E2E suite on Ministack.

---

## Source Material

Origin materials the project grew from — kept for reference only, not the source of truth.

- [[sources/index|Source Material Index]] — Original prompt and early vault notes.

---

## Related

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
- [[ADR-0015-drawio-diagrams]]
