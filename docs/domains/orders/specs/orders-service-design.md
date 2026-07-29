---
title: Orders Service Design
type: spec
area: orders
status: accepted
created: 2026-06-26
updated: 2026-07-28
tags: [type/spec, area/orders, status/accepted]
related:
  - "[[soft-delete]]"
  - "[[nano-id]]"
  - "[[audit-fields]]"
  - "[[db-naming]]"
  - "[[cqrs]]"
  - "[[versioning]]"
  - "[[ADR-0003-grpc-inter-service]]"
  - "[[ADR-0006-read-write-replicas]]"
  - "[[logging-context]]"
  - "[[env-files]]"
  - "[[testing]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[clean-architecture-divergence]]"
  - "[[money-as-integer-cents]]"
  - "[[grpc-api-key-authorization]]"
  - "[[for-update-pessimistic-locking]]"
  - "[[2026-07-14-orders-service-milestone-design]]"
  - "[[2026-07-16-orders-list-products-endpoint-design]]"
---

# Orders Service Design

> [!note] Live since the Orders Service milestone
> The Orders service shipped in the Orders Service milestone (merged via PR #51, plus follow-up
> commits) as a .NET Core 10 Minimal API on Aurora MySQL (Floci-emulated locally), with a live
> Users gRPC client, OpenTelemetry tracing, and the three-layer test suite ([[testing]]). It
> diverges from this spec's original design in several ways — see
> [[#Deltas from the original design (superseded)|Deltas from the original design]] below and the
> service-local decision notes it links to. `services/orders/CLAUDE.md` is the day-to-day
> reference for stack/commands; this note is the durable service-design record.
>
> **Not yet built:** real SQS wiring for `ORDER_CREATED` (still a `NoopEventPublisher` emission
> seam), Orders' own gRPC **server** surface (`GetOrderById`), and Product CRUD — all explicitly
> out of scope for the shipped milestone.

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
| `POST` | `/v1/orders` | Create a new order. Emits `ORDER_CREATED` via a `NoopEventPublisher` seam today — real SQS publish is deferred. |
| `GET` | `/v1/orders/my-orders` | List all orders belonging to the authenticated user. |
| `GET` | `/v1/orders/{order_id}` | Fetch a single order. Returns `404` if the order does not belong to the requesting user — see the ownership note below. |
| `GET` | `/v1/products` | List the active product catalog. Private (requires `x-user-id`), no ownership filtering — products have no owner. See [[2026-07-16-orders-list-products-endpoint-design]]. |
| `GET` | `/v1/health` | Liveness/readiness probe. Returns `200 { "status": "ok" }` when healthy. No auth required. Used by ALB/Fargate as health check target. |

> [!note] Authorization check — filter in the query, not fetch-then-compare
> `GET /orders/{order_id}` filters `WHERE id = @orderId AND cognito_sub = @callerSub`
> directly in the query, so another user's order returns zero rows and the endpoint answers
> **`404`**, not `403` — indistinguishable from "does not exist," so existence of other users'
> orders is never leaked. This **supersedes** this spec's original `403 Forbidden` choice; see
> [[2026-07-14-orders-service-milestone-design]].

## gRPC Methods

Defined in the `OrdersService` proto. Used by other microservices to fetch order data without going through the public HTTP API. See [[ADR-0003-grpc-inter-service]].

| Method | Request | Response |
|---|---|---|
| `GetOrderById` | `GetOrderByIdRequest { order_id: string }` | `OrderResponse { id, user_id, subtotal, tax, total, created_at }` |

## Data Model

All fields follow snake_case naming in the database and are mapped to PascalCase aliases in the ORM layer. See [[db-naming]]. All IDs use the prefixed nano-id format (`ord_`, `prd_`, `odd_`). See [[nano-id]]. All entities carry the standard audit fields and support soft delete only. See [[audit-fields]] and [[soft-delete]].

> [!note] Money is integer cents, not decimal
> The tables below still show the original `decimal(10,2)` columns as first designed. As shipped,
> every monetary column is an integer-cents `bigint` (`unit_price_cents`, `subtotal_cents`,
> `tax_cents`, `total_cents`) with a non-persisted computed dollar property — see
> [[money-as-integer-cents]] for the full decision and rationale. `Order` and `OrderDetails` also
> carry both `user_id` (internal) and `cognito_sub` (gateway-supplied) — the "double identity"
> decision recorded in [[2026-07-14-orders-service-milestone-design]].

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
- [[logging-context]] — every log line carries the shared cross-service context (`trace_id`, `cognito_sub`, `user_id`, `email_hash`, `order_id`, `duration_ms`); Orders attaches it via a Serilog enricher reading `ICurrentCaller` lazily (never cached — see `services/orders/CLAUDE.md` §4).
- [[env-files]] — Orders reads its config from `.env.local.orders`, generated by `make env-file`; nothing is hand-maintained.
- [[testing]] — every endpoint needs all three test layers (unit/integration, internal E2E, gateway E2E with a real Cognito JWT); see [[domains/orders/testing/index]] for how Orders satisfies it.
- [[ADR-0019-distributed-tracing-opentelemetry]] — traces export via OTel to Jaeger, logs to OpenObserve; OTel endpoint/protocol come from environment variables only, never set in code.

Additional ADRs and service-local decisions:

- [[ADR-0003-grpc-inter-service]] — gRPC is the inter-service communication protocol.
- [[ADR-0006-read-write-replicas]] — Aurora MySQL read/write replica topology.
- [[ADR-0008-screaming-arch-di]] — Screaming architecture + dependency injection (Orders diverges — see [[clean-architecture-divergence]]).
- [[ADR-0010-cognito-auth]] — Authentication via AWS Cognito JWT.
- [[clean-architecture-divergence]] — Orders' 5-project Clean Architecture layering, service-local.
- [[money-as-integer-cents]] — money stored as integer cents, not `decimal`.
- [[grpc-api-key-authorization]] — the `x-api-key` scheme securing the Orders→Users gRPC call.
- [[for-update-pessimistic-locking]] — tagged LINQ + interceptor for the stock row lock.

## Deltas from the original design (superseded)

The following decisions, made during and after the Orders Service milestone, supersede what this
spec originally said:

- Money columns: `decimal(10,2)` → integer `_cents` `bigint` columns. See [[money-as-integer-cents]].
- `GET /v1/orders/{order_id}` ownership-failure response: `403 Forbidden` → `404 Not Found` (filter-in-query pattern, avoids leaking existence).
- `Order`/`OrderDetails` store both `user_id` (internal) and `cognito_sub` (gateway-supplied), not `user_id` alone.
- Architecture diverges from [[ADR-0008-screaming-arch-di]] for this service only. See [[clean-architecture-divergence]].
- Added `GET /v1/products` (not in the original endpoint table). See [[2026-07-16-orders-list-products-endpoint-design]].
- Added the gRPC `x-api-key` authorization scheme for the Users call. See [[grpc-api-key-authorization]].
- Stock locking moved from raw `FOR UPDATE` SQL to tagged LINQ + an EF Core interceptor. See [[for-update-pessimistic-locking]].

Full milestone design: [[2026-07-14-orders-service-milestone-design]].

## Related

- [[soft-delete]]
- [[nano-id]]
- [[audit-fields]]
- [[db-naming]]
- [[cqrs]]
- [[versioning]]
- [[logging-context]]
- [[env-files]]
- [[testing]]
- [[ADR-0003-grpc-inter-service]]
- [[ADR-0006-read-write-replicas]]
- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0008-screaming-arch-di]]
- [[ADR-0010-cognito-auth]]
- [[ADR-0019-distributed-tracing-opentelemetry]]
- [[clean-architecture-divergence]]
- [[money-as-integer-cents]]
- [[grpc-api-key-authorization]]
- [[for-update-pessimistic-locking]]
- [[2026-07-14-orders-service-milestone-design]]
- [[2026-07-16-orders-list-products-endpoint-design]]
