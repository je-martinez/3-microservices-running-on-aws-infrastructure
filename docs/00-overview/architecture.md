---
title: System Architecture
type: spec
area: shared
status: active
created: 2026-06-26
updated: 2026-06-27
tags:
  - type/spec
  - area/shared
  - status/active
related:
  - "[[system-context]]"
  - "[[ADR-0009-apigw-alb-fargate]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[ADR-0003-grpc-inter-service]]"
  - "[[ADR-0002-cqrs]]"
  - "[[ADR-0006-read-write-replicas]]"
  - "[[ADR-0011-observability-signoz]]"
  - "[[ADR-0012-ministack-local]]"
  - "[[ADR-0015-drawio-diagrams]]"
---

# System Architecture

This note describes the overall runtime architecture of **3MRAI**: how traffic flows from clients through the AWS infrastructure to the three microservices, how those services communicate, and how data is persisted and observed.

> [!info] Scope
> This is the high-level architecture view. For C4-style context and container diagrams see [[system-context]]. For individual service internals see the service spec notes linked from [[index]].

---

## Architecture Overview

![[architecture.drawio.svg]]

---

## Traffic Ingress

All external traffic enters through **Amazon API Gateway**, which validates JWTs issued by **Amazon Cognito** before forwarding requests. Authenticated requests pass to the **Application Load Balancer (ALB)**, which routes to the appropriate ECS Fargate service based on path prefix.

Relevant decisions: [[ADR-0009-apigw-alb-fargate]], [[ADR-0010-cognito-auth]].

---

## Compute Layer — ECS Fargate

Each microservice runs as an independent ECS Fargate task definition. Stacks differ per service:

| Service | Runtime | Framework |
|---|---|---|
| Users | Node.js | Fastify |
| Orders | .NET Core 10 | Minimal APIs + Entity Framework Core |
| Tracking | Python 3.12 | FastAPI |

Services are stateless at the HTTP layer; all domain state lives in the service's own Aurora cluster (see [Persistence](#persistence--aurora-per-service--documentdb-event-store) below).

Services follow **screaming architecture** with **dependency injection** — see [[ADR-0008-screaming-arch-di]], [[screaming-architecture]], [[dependency-injection]].

---

## Inter-Service Communication — gRPC

Synchronous cross-service calls use **gRPC** over private networking (no public exposure):

- `Users` → `Orders`: user context enrichment.
- `Orders` → `Tracking`: order-to-shipment linking.

Relevant decision: [[ADR-0003-grpc-inter-service]].

---

## Event Pipeline — SQS + Lambda (CQRS)

Domain events are published asynchronously via the **CQRS** pattern:

1. A service emits a domain event (e.g. `USER_CREATED`, `ORDER_CREATED`) to its **SQS queue**.
2. A single **Lambda function** (Node.js) consumes the queue, validates the message with Zod, and dispatches it to the appropriate handler.
3. The Lambda persists the full event document — including a `status_history` audit trail — to **DocumentDB** (the event store).

This pipeline is separate from the operational databases of each service. Services read and write their own domain state in their Aurora clusters (see [Persistence](#persistence--aurora-per-service--documentdb-event-store)); DocumentDB is the event store only.

Relevant decisions: [[ADR-0002-cqrs]], [[ADR-0006-read-write-replicas]].
Pattern reference: [[cqrs]].

---

## Persistence — Aurora per service + DocumentDB event store

Each operational service owns its own **Aurora** cluster with read/write replica topology. DocumentDB is used exclusively by the events pipeline as the event store.

| Service | Engine | Topology |
|---|---|---|
| Users | Aurora PostgreSQL | 1 write replica + 1 read replica |
| Orders | Aurora MySQL | 1 write replica + 1 read replica |
| Tracking | Aurora MySQL | 1 write replica + 1 read replica |
| Events pipeline | DocumentDB | Event store (append-only; not an operational DB) |

Services send all mutations to their **write replica** and all query handlers to their **read replica**. Replication lag is acceptable for the eventual-consistency read paths in this system.

Relevant decision: [[ADR-0006-read-write-replicas]].

---

## Identifiers

All entities use **prefixed nano-ids** as primary keys (e.g., `usr_`, `ord_`, `trk_`). See [[ADR-0005-nano-id-prefixed]] and [[nano-id]].

---

## Deletion Strategy

There are no hard deletes anywhere in the system. All records use **soft-delete** (`isDeleted` flag + `deletedAt` timestamp). See [[ADR-0004-soft-delete-only]] and [[soft-delete]].

---

## Secrets Management

Runtime secrets (DB credentials, API keys) are stored in **AWS Parameter Store** and loaded at container startup. Environment variables are validated with **Zod** before the service accepts traffic.

Relevant decisions: [[ADR-0007-secrets-parameter-store]], [[ADR-0014-env-validation-zod]].

---

## Observability

All services emit structured logs and metrics to **CloudWatch**. A **SigNoz** instance aggregates those signals into dashboards and alerting.

Relevant decision: [[ADR-0011-observability-signoz]].
Reference: [[signoz-cloudwatch]].

---

## Local Development

The full stack can be reproduced locally using **Ministack** (Docker Compose). See [[ADR-0012-ministack-local]] and the runbook [[local-dev-ministack]].

---

## Related

- [[system-context]]
- [[index]]
- [[ADR-0009-apigw-alb-fargate]]
- [[ADR-0010-cognito-auth]]
- [[ADR-0003-grpc-inter-service]]
- [[ADR-0002-cqrs]]
- [[ADR-0006-read-write-replicas]]
- [[ADR-0011-observability-signoz]]
- [[ADR-0008-screaming-arch-di]]
- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0014-env-validation-zod]]
- [[ADR-0004-soft-delete-only]]
- [[ADR-0005-nano-id-prefixed]]
- [[ADR-0012-ministack-local]]
- [[cqrs]]
- [[screaming-architecture]]
- [[dependency-injection]]
- [[nano-id]]
- [[soft-delete]]
- [[signoz-cloudwatch]]
- [[local-dev-ministack]]
- [[ADR-0015-drawio-diagrams]]
