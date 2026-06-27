---
title: System Context
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
  - "[[architecture]]"
  - "[[users-service-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[ADR-0009-apigw-alb-fargate]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[ADR-0015-drawio-diagrams]]"
---

# System Context

C4-style context and container diagrams for the **3MRAI** system. These diagrams answer "what is this system and how does it fit with its environment?" (Level 1) and "what containers make up this system?" (Level 2).

For the detailed runtime architecture (traffic flow, gRPC, SQS/Lambda, Aurora, DocumentDB event store) see [[architecture]].

---

## Level 1 — System Context

The system context diagram shows **3MRAI** as a black box and identifies its users and external systems.

![[system-context-l1.drawio.svg]]

> [!note] External Systems
> Amazon Cognito, Aurora, DocumentDB, SQS, Parameter Store, and CloudWatch are managed AWS services — they are **external** to the 3MRAI application code but **internal** to the AWS account boundary. Aurora (PostgreSQL/MySQL) is the operational database for each microservice; DocumentDB is the event store for the events pipeline only. SigNoz may run as a container within the VPC or as a managed external service depending on deployment configuration.

---

## Level 2 — Containers

The container diagram zooms into the 3MRAI system and shows the independently deployable units.

![[system-context-l2.drawio.svg]]

---

## Container Responsibilities

| Container | Technology | Responsibility |
|---|---|---|
| API Gateway | AWS API Gateway | TLS termination, JWT validation, rate limiting |
| ALB | AWS ALB | Path-based routing to ECS tasks |
| Users Service | Fastify (Node.js), ECS Fargate | User CRUD, Cognito sync, soft-delete |
| Orders Service | .NET Core 10 Minimal APIs, ECS Fargate | Order lifecycle, gRPC calls to Tracking |
| Tracking Service | FastAPI (Python 3.12), ECS Fargate | Shipment events, gRPC receiver |
| events-pipeline-handler | AWS Lambda (Node.js) | CQRS dispatcher; persists domain events to DocumentDB event store |
| users-events / orders-events | SQS | Event buffers between services and Lambda handler |
| Users DB | Aurora PostgreSQL | Operational data for Users service (read/write replicas) |
| Orders DB | Aurora MySQL | Operational data for Orders service (read/write replicas) |
| Tracking DB | Aurora MySQL | Operational data for Tracking service (read/write replicas) |
| Event Store | DocumentDB | Append-only event store for the events pipeline (not an operational DB) |

---

## Key Design Decisions at a Glance

| Concern | Decision |
|---|---|
| Auth | Cognito JWTs — [[ADR-0010-cognito-auth]] |
| Compute | ECS Fargate — [[ADR-0009-apigw-alb-fargate]] |
| Inter-service calls | gRPC — [[ADR-0003-grpc-inter-service]] |
| Write path | CQRS via SQS + Lambda — [[ADR-0002-cqrs]] |
| Persistence topology | Read/write replicas — [[ADR-0006-read-write-replicas]] |
| Observability | SigNoz via CloudWatch — [[ADR-0011-observability-signoz]] |

---

## Related

- [[architecture]]
- [[index]]
- [[users-service-design]]
- [[orders-service-design]]
- [[tracking-service-design]]
- [[events-pipeline-design]]
- [[ADR-0009-apigw-alb-fargate]]
- [[ADR-0010-cognito-auth]]
- [[ADR-0003-grpc-inter-service]]
- [[ADR-0002-cqrs]]
- [[ADR-0006-read-write-replicas]]
- [[ADR-0011-observability-signoz]]
- [[ADR-0015-drawio-diagrams]]
