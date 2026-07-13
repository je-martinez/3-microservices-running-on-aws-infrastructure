---
title: Orders Service Design
type: spec
area: orders
status: draft
created: 2026-06-26
updated: 2026-07-12
tags: [type/spec, area/orders, status/draft]
related:
  - soft-delete
  - nano-id
  - audit-fields
  - db-naming
  - cqrs
  - versioning
  - ADR-0003-grpc-inter-service
  - ADR-0006-read-write-replicas
---

# Orders Service Design

> [!warning] Not implemented yet
> The Orders service is **design-only** — no source code exists. `services/orders/src/` contains
> only `.gitkeep` placeholders (no `.csproj`, no tests), and `services/orders/Dockerfile` has every
> build line commented out. Only a stub [`services/orders/CLAUDE.md`](../../../../services/orders/CLAUDE.md)
> and a placeholder `orders` service in the root `docker-compose.yml` (build + network wiring only —
> no ports, no database, no healthcheck) exist so far. Everything below describes the **intended**
> design, not running behavior.
>
> The supporting infrastructure this design assumes is also not built yet: there is no SQS/messaging
> Terraform module (`infra/modules/messaging/` is an empty `.gitkeep`), no DocumentDB module
> (`infra/modules/database/` is empty — only `rds-aurora` exists), no Aurora MySQL cluster, and no
> gRPC surface anywhere in the repo (no `.proto` files exist yet).

## Summary

The Orders service is responsible for creating and managing orders submitted by users. It exposes a REST API built with .NET Core 10 Minimal APIs, persists data in Aurora MySQL using two replicas (one for reads, one for writes), and publishes an `ORDER_CREATED` event to SQS whenever a new order is placed. Inter-service data retrieval is handled via gRPC.

## Stack & Data Store

| Concern | Choice |
|---|---|
| Runtime | .NET Core 10 — Minimal APIs |
| ORM | Entity Framework Core |
| Database | Aurora MySQL |
| Read traffic | Read replica |
| Write traffic | Write replica |
| Event bus | AWS SQS |
| Inter-service RPC | gRPC |
| Auth | AWS Cognito (via API Gateway) |

Database credentials are stored in AWS Secrets Manager and pulled at startup via AWS Parameter Store. See [[ADR-0006-read-write-replicas]] for the replica strategy and [[ADR-0007-secrets-parameter-store]] for secrets management.

## API / Endpoints

All routes are versioned under the `/v1` prefix. See [[versioning]] for the versioning convention.

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/orders` | Create a new order. Publishes `ORDER_CREATED` to SQS. |
| `GET` | `/v1/orders/my-orders` | List all orders belonging to the authenticated user. |
| `GET` | `/v1/orders/{order_id}` | Fetch a single order. Returns `403` if the order does not belong to the requesting user. |
| `GET` | `/v1/health` | Liveness/readiness probe. Returns `200 { "status": "ok" }` when healthy. No auth required. Used by ALB/Fargate as health check target. |

> [!note] Authorization check
> `GET /orders/{order_id}` must compare the `user_id` stored on the order against the caller's identity (from the Cognito JWT). Return `403 Forbidden` — never `404` — to avoid leaking existence of other users' orders.

## gRPC Methods

Defined in the `OrdersService` proto. Used by other microservices to fetch order data without going through the public HTTP API. See [[ADR-0003-grpc-inter-service]].

| Method | Request | Response |
|---|---|---|
| `GetOrderById` | `GetOrderByIdRequest { order_id: string }` | `OrderResponse { id, user_id, subtotal, tax, total, created_at }` |

## Data Model

All fields follow snake_case naming in the database and are mapped to PascalCase aliases in the ORM layer. See [[db-naming]]. All IDs use the prefixed nano-id format (`ord_`, `prd_`, `odd_`). See [[nano-id]]. All entities carry the standard audit fields and support soft delete only. See [[audit-fields]] and [[soft-delete]].

### Product

Catalog of available products. Used by `OrderDetails` to record what was ordered.

| Column | Type | Notes |
|---|---|---|
| `id` | `varchar(26)` | `prd_` prefix, nano-id |
| `name` | `varchar(255)` | |
| `description` | `text` | |
| `unit_price` | `decimal(10,2)` | |
| `units_in_stock` | `int unsigned` | |
| `created_by` | `varchar(26)` | audit |
| `created_at` | `datetime` | audit |
| `updated_by` | `varchar(26)` | audit |
| `updated_at` | `datetime` | audit |
| `deleted_by` | `varchar(26)` | audit |
| `deleted_at` | `datetime` | audit — null means active |

Computed property `isDeleted` returns `true` when `deleted_at` is not null.

### Order

One record per submitted order.

| Column | Type | Notes |
|---|---|---|
| `id` | `varchar(26)` | `ord_` prefix, nano-id |
| `user_id` | `varchar(26)` | FK → Users service (resolved via gRPC) |
| `subtotal` | `decimal(10,2)` | |
| `tax` | `decimal(10,2)` | |
| `total` | `decimal(10,2)` | |
| `created_by` | `varchar(26)` | audit |
| `created_at` | `datetime` | audit |
| `updated_by` | `varchar(26)` | audit |
| `updated_at` | `datetime` | audit |
| `deleted_by` | `varchar(26)` | audit |
| `deleted_at` | `datetime` | audit — null means active |

### OrderDetails

Line items for each order. One row per product per order.

| Column | Type | Notes |
|---|---|---|
| `id` | `varchar(26)` | `odd_` prefix, nano-id |
| `product_id` | `varchar(26)` | FK → `products.id` |
| `user_id` | `varchar(26)` | denormalized for query convenience |
| `quantity` | `int unsigned` | |
| `subtotal` | `decimal(10,2)` | |
| `tax` | `decimal(10,2)` | |
| `total` | `decimal(10,2)` | |
| `created_by` | `varchar(26)` | audit |
| `created_at` | `datetime` | audit |
| `updated_by` | `varchar(26)` | audit |
| `updated_at` | `datetime` | audit |
| `deleted_by` | `varchar(26)` | audit |
| `deleted_at` | `datetime` | audit — null means active |

## Events

| Event | Trigger | Payload |
|---|---|---|
| `ORDER_CREATED` | `POST /orders` succeeds | `{ order_id, user_id, total, created_at }` |

The event is dispatched to SQS. The Events Pipeline Lambda picks it up, saves it with status `STARTED`, dispatches to `OrderCreatedHandler`, and updates status to `COMPLETED` or `FAILED`.

## Cross-cutting rules

This service follows all shared conventions defined once in the vault:

- [[soft-delete]] — no physical deletes; `deleted_at`/`deleted_by` only. DB user forbidden from running `DELETE`.
- [[nano-id]] — prefixed nano-ids for all entity IDs (`ord_`, `prd_`, `odd_`).
- [[audit-fields]] — `created_by`, `created_at`, `updated_by`, `updated_at`, `deleted_by`, `deleted_at` on every entity.
- [[db-naming]] — snake_case in DB, PascalCase aliases in EF Core models.
- [[cqrs]] — read queries routed to the read replica; write commands routed to the write replica.
- [[versioning]] — all HTTP endpoints versioned under `/v1/`.

Additional ADRs:

- [[ADR-0003-grpc-inter-service]] — gRPC is the inter-service communication protocol.
- [[ADR-0006-read-write-replicas]] — Aurora MySQL read/write replica topology.
- [[ADR-0008-screaming-arch-di]] — Screaming architecture + dependency injection.
- [[ADR-0010-cognito-auth]] — Authentication via AWS Cognito JWT.

## Related

- [[soft-delete]]
- [[nano-id]]
- [[audit-fields]]
- [[db-naming]]
- [[cqrs]]
- [[versioning]]
- [[ADR-0003-grpc-inter-service]]
- [[ADR-0006-read-write-replicas]]
- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0008-screaming-arch-di]]
- [[ADR-0010-cognito-auth]]
