---
title: Orders Service Milestone Design
type: spec
area: orders
status: draft
created: 2026-07-14
updated: 2026-07-14
tags:
  - type/spec
  - area/orders
  - status/draft
related:
  - "[[orders-service-design]]"
  - "[[soft-delete]]"
  - "[[nano-id]]"
  - "[[audit-fields]]"
  - "[[db-naming]]"
  - "[[cqrs]]"
  - "[[versioning]]"
  - "[[ADR-0003-grpc-inter-service]]"
  - "[[ADR-0006-read-write-replicas]]"
  - "[[ADR-0008-screaming-arch-di]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[users-service-design]]"
  - "[[2026-06-26-implementation-workflow-design]]"
---

# Orders Service Milestone Design

Design for the **Orders Service — first delivery milestone**: HTTP API, persistence, and the Users gRPC gate. Decided in a brainstorming session on 2026-07-14. This spec is milestone-scoped and refines/overrides the parts of [[orders-service-design]] listed under [[#Deltas from the existing Orders service spec]] below; where it is silent, [[orders-service-design]] still applies.

> [!note] Status
> Draft — no code exists yet for this milestone. This spec captures the design decided in brainstorming, to be turned into a plan and Linear issues per [[2026-06-26-implementation-workflow-design]].

## Milestone scope

**IN scope:**

- .NET Core 10 Minimal APIs service, live on Floci, backed by local MySQL. This mirrors how Users runs on local Postgres via Floci — writer/reader point at the **same** local endpoint because Floci does not emulate an Aurora read replica, but the code keeps two URLs to preserve the read/write split, exactly like Users.
- EF Core persistence: entities `Product`, `Order`, `OrderDetails`, with prefixed nano-ids (`prd_`/`ord_`/`odd_`), audit fields, soft-delete only, computed `IsDeleted`. See [[nano-id]], [[audit-fields]], [[soft-delete]].
- `Product`: table + seed, **no** public CRUD. `POST /v1/orders` reads price/stock from the seeded catalog.
- Endpoints: `POST /v1/orders`, `GET /v1/orders/my-orders`, `GET /v1/orders/{order_id}`, `GET /v1/health`.
- Server-side money calculation (unit price from `Product`, configurable tax, total) plus stock validation and decrement — all transactional.
- Identity: the API Gateway injects the **Cognito Sub** into the `x-user-id` header. Only `POST /v1/orders` resolves Cognito Sub → internal `user_id` (`usr_`) via the Users gRPC `GetUserById`. The read endpoints filter directly by `cognito_sub` and do **not** call gRPC.
- Gate (Issue A): wire up the Users gRPC server (+ shared `.proto`). This is the **first, mandatory** item of the milestone — a Users leftover completed here.
- `ORDER_CREATED`: emission seam via a `NoopEventPublisher` (no real SQS), mirroring the Users `NoopEventPublisher` pattern.
- Cross-cutting convention for this milestone: **every write runs inside an EF Core transaction, always.**

**OUT of scope** (later milestones/issues): real SQS wiring; Orders' own gRPC *server* surface (`GetOrderById`); Product CRUD; Terraform messaging/prod-Aurora modules.

## Architecture — Clean Architecture with Class Libraries

This service **diverges** from the shared screaming-architecture pattern ([[ADR-0008-screaming-arch-di]]) for this milestone. The divergence is recorded here and must be reflected in [[orders-service-design]] and `services/orders/CLAUDE.md`; **no new ADR** is created for it.

Solution `Orders.sln`; dependencies point inward; boundaries enforced by project references.

| Project | Kind | Responsibility | References |
|---|---|---|---|
| `Orders.Domain` | Class Library | Entities (`Order`, `OrderDetails`, `Product`), business rules, value objects, invariants (money/total calculation, stock validation), repository interfaces (ports) | none |
| `Orders.Application` | Class Library | Application services (`OrderService`, `ProductService`), DTOs, use-case orchestration, ports (Users gRPC client, event publisher, unit-of-work/transaction), read/write ports (CQRS) | Domain |
| `Orders.Infrastructure` | Class Library | EF Core (read `DbContext` + write `DbContext`, migrations, entity configs, snake_case mapping), repository implementations, Users gRPC client, `NoopEventPublisher`, Product seed, `IUnitOfWork`/transaction implementation | Application, Domain |
| `Orders.Api` | Executable, Minimal API | `/v1/*` endpoints, identity filter (`x-user-id`), DI wiring, config/env, health. Composition root | Application, Infrastructure |
| `Orders.Tests` | Test project | Unit (Domain/Application) + integration | — |

- **CQRS:** Application uses read/write ports; Infrastructure implements a read `DbContext` (read replica) and a write `DbContext` (write replica). Locally both point at the same MySQL instance. See [[cqrs]] and [[ADR-0006-read-write-replicas]].
- **Transactions:** an `IUnitOfWork` / `ITransactionScope` port is defined in Application, implemented in Infrastructure over EF Core. "All writes run inside an EF Core transaction" is both a service convention for this milestone and an acceptance criterion of the create-order command.

## Data model (MySQL, EF Core)

Shared conventions still apply: snake_case in DB ↔ PascalCase aliases in EF Core ([[db-naming]]), prefixed nano-ids ([[nano-id]]), audit fields ([[audit-fields]]), soft-delete only — no physical `DELETE` ([[soft-delete]]), computed `IsDeleted`.

### Money — Stripe-style integer cents

All monetary amounts are stored as **integer cents** using `bigint` columns (mapped to `long` in C#), following Stripe's approach — never `decimal`, never float. Columns carry the `_cents` suffix to make the unit explicit in the schema. Each entity exposes read-only **computed properties** (not persisted; EF Core `[NotMapped]`/`Ignore()`) named without the suffix, returning the dollar value as `cents / 100m` for display/serialization.

All `POST /v1/orders` calculation is integer arithmetic in cents (`unit_price_cents * quantity`, sum of lines, `tax_cents`); conversion to dollars happens **only** for display via the computed properties. This eliminates floating-point rounding in money and **supersedes the `decimal(10,2)` columns described in [[orders-service-design]]** for this milestone.

### Double identity (explicit instruction)

Both `order` and `order_details` store **both** buyer identifiers:

- `user_id` — internal `usr_` id, resolved via gRPC on `POST`.
- `cognito_sub` — the Cognito Sub as it arrived from the gateway.

### `product` — seeded, no CRUD

| Column | Type | Notes |
|---|---|---|
| `id` | `varchar(26)` | PK, `prd_` nano-id |
| `name` | `varchar(255)` | |
| `description` | `text` | |
| `unit_price_cents` | `bigint` | integer cents |
| `units_in_stock` | `int unsigned` | |
| audit fields | — | see [[audit-fields]] |
| soft-delete | — | `deleted_at` null = active, see [[soft-delete]] |

Computed: `UnitPrice` → `UnitPriceCents / 100m`.

### `order` — one row per order

| Column | Type | Notes |
|---|---|---|
| `id` | `varchar(26)` | PK, `ord_` |
| `user_id` | `varchar(26)` | internal `usr_`, resolved via gRPC on `POST` |
| `cognito_sub` | `varchar(255)` | from gateway `x-user-id`; used to filter ownership on reads |
| `subtotal_cents` | `bigint` | |
| `tax_cents` | `bigint` | |
| `total_cents` | `bigint` | |
| audit fields | — | see [[audit-fields]] |
| soft-delete | — | see [[soft-delete]] |

Computed: `Subtotal`, `Tax`, `Total` → `*_Cents / 100m`.

Indexes: `idx_order_user_id`, `idx_order_cognito_sub`, `idx_order_deleted_at`.

### `order_details` — one row per product per order

| Column | Type | Notes |
|---|---|---|
| `id` | `varchar(26)` | PK, `odd_` |
| `order_id` | `varchar(26)` | FK → `order.id` |
| `product_id` | `varchar(26)` | FK → `product.id` |
| `user_id` | `varchar(26)` | internal `usr_`, denormalized |
| `cognito_sub` | `varchar(255)` | denormalized |
| `quantity` | `int unsigned` | |
| `subtotal_cents` | `bigint` | |
| `tax_cents` | `bigint` | |
| `total_cents` | `bigint` | |
| audit fields | — | see [[audit-fields]] |
| soft-delete | — | see [[soft-delete]] |

Computed: `Subtotal`, `Tax`, `Total` → `*_Cents / 100m`.

Indexes: `idx_order_details_order_id`, `idx_order_details_product_id`, `idx_order_details_deleted_at`.

**Relations:** `order` 1–N `order_details`; `product` 1–N `order_details`.

> [!question] Open note (not a decision)
> `cognito_sub` is `varchar(255)` with headroom (Cognito subs are UUIDs, 36 chars). `order_details.user_id`/`cognito_sub` are denormalized (redundant with `order`) — kept deliberately for the double-identity instruction above.

### Ownership enforcement — filter in the query, not fetch-then-compare

The `WHERE` clause includes the caller's identifier, so someone else's order returns zero rows and the endpoint responds **404** — indistinguishable from "does not exist," so it does not leak the existence of other users' orders. **This changes [[orders-service-design]]'s `403` to `404` for `GET /v1/orders/{order_id}`** for this milestone. Reads filter by **`cognito_sub`** (the direct `x-user-id` value), so reads do not call gRPC.

### Stock decrement — concurrency

Inside the `POST /v1/orders` transaction, re-read each `Product` with a pessimistic lock (`SELECT ... FOR UPDATE`); if stock is insufficient, respond **409 Conflict** and roll back fully.

## Endpoints & flows

`POST /v1/orders` is the **only** endpoint that uses the gRPC gate.

**`POST /v1/orders`:**

1. Read `x-user-id` (= Cognito Sub) from the header.
2. `gRPC GetUserById(Sub)` → Users → obtain internal `user_id` (`usr_`). If the user does not exist, respond with a mapped error.
3. Open a transaction: validate stock per line with `FOR UPDATE`; compute subtotal/tax/total in cents from `Product`; create `Order` + N `OrderDetails` storing both `user_id` and `cognito_sub`; decrement `units_in_stock`; emit `ORDER_CREATED` via `NoopEventPublisher`. Commit, or roll back fully.
4. Insufficient stock → `409`. The API responds with amounts in **cents** (integer fields `subtotal_cents`/`tax_cents`/`total_cents`).

**`GET /v1/orders/{order_id}`:** `WHERE id = @orderId AND cognito_sub = @callerSub AND deleted_at IS NULL`. Zero rows → `404`. No gRPC call.

**`GET /v1/orders/my-orders`:** `WHERE cognito_sub = @callerSub AND deleted_at IS NULL`. No gRPC call.

**`GET /v1/health`:** `200 { "status": "ok" }`, no auth.

**API money contract:** responses expose amounts in **cents (integers)**, Stripe-style end-to-end; dollar computed values stay internal.

## Inter-service gRPC authorization (API key)

- A shared symmetric API key `GRPC_API_KEY` (same value in Users and Orders). Local: a `local-dev-secret`-style value in compose/`.env`, not exposed outside the compose network. Prod: Secrets Manager, deferred like other secrets (see [[ADR-0007-secrets-parameter-store]]).
- The key travels in the gRPC **metadata** under the key **`x-api-key`** — not in the message body, not the user JWT.
- **Users (server):** a gRPC **server interceptor** (cross-cutting, runs before any handler) extracts `x-api-key` from metadata and compares it to `GRPC_API_KEY` using a **constant-time** comparison. Missing/mismatch → `UNAUTHENTICATED` (gRPC code 16), handler not executed. Match → proceeds to `getUserByIdHandler`.
- **Orders (client):** attaches `x-api-key` in the metadata of every gRPC call (client generated with `Grpc.Tools`), reading `GRPC_API_KEY` from its env.

See [[ADR-0003-grpc-inter-service]] for the base gRPC decision and [[ADR-0010-cognito-auth]] for the Cognito auth layer this gate sits behind.

## Testing & local infra

### Local infra (compose/Floci)

- `orders` service in `docker-compose.yml`, reachable by DNS (`orders`) on the `3mrai-network`, `depends_on` Floci healthy, own port exposed.
- MySQL via Floci (emulated Aurora MySQL): `DATABASE_WRITER_URL` and `DATABASE_READER_URL` point at Floci's MySQL proxy port, same endpoint locally (parity with Users). Two URLs are kept even when pointing at the same place.
- Bootstrap: `dotnet ef database update` (migrations) + Product seed applied on local startup, chained in the Makefile/`make migrate` like Users.
- `develop.watch` syncing `services/orders/src` for docker-watch hot-reload, like Users.
- The Users gRPC port is exposed on the network (Issue A) so `orders` can reach it.

### Testing (two layers, via `dotnet test`)

- **Unit** — Domain and Application pure logic: total calculation in cents, stock validation, order invariants, identity mapping. No DB.
- **Integration** — against **real** MySQL via **Testcontainers-MySQL** (ephemeral per run): applies migrations + seed, tests transactional stock decrement under concurrency (`FOR UPDATE`), ownership-by-filter (`404` on someone else's order), and the full `POST` flow with the Users gRPC **mocked at the port level** (not the DB). This is what avoids a "mocks hide schema bugs" failure mode — persistence is tested against the real schema, not a mocked one.
- **E2E surface:** replicate the Users pattern — endpoints guarded by `E2E_TESTING_ENABLED` (e.g. order cleanup/seed) for a future cross-service E2E.
- Health check verified via `/v1/health` (ALB/Fargate target).

## Sequencing (dependency gate)

1. **Issue A (first item, gate) — Users gRPC server** (a Users leftover, completed here):
   - Shared `/proto/users.proto` (proto file at repo root, shared by both services): `service Users { rpc GetUserById(GetUserByIdRequest) returns (UserResponse) }`.
   - Users: add official `@grpc/grpc-js` + `@grpc/proto-loader`; gRPC server in `shared/grpc/`, registers the **existing** `getUserByIdHandler`, starts in the bootstrap alongside Fastify on its own port (`:50051`), graceful shutdown. `getUserById` already resolves by `usr_` id OR Cognito Sub (existing `byIdOrCognitoSub` behavior — see [[2026-07-11-authenticated-identity-resolution-design]]). Includes the API-key server interceptor + `GRPC_API_KEY` env var.
   - Compose/Floci: expose the Users gRPC port on the network.
   - Best practices applied: `.proto` as the contract source of truth, `loadSync` at startup, `NOT_FOUND` when the user does not exist, lifecycle tied to the process.
   - Must be merged **before** the Orders `POST` endpoint.
2. **Orders issues independent of the gate** (parallelizable after scaffolding):
   - `Orders.sln` + 5 Class Library projects.
   - EF Core data model + migrations + Product seed.
   - Read endpoints `GET /my-orders`, `GET /{order_id}`, `/v1/health` (no gate dependency).
   - `NoopEventPublisher`.
   - Local MySQL infra in compose/Floci + migration/seed bootstrap.
3. **Integration issue** (depends on Issue A merged): Orders gRPC client (`Grpc.Tools` from `/proto/users.proto`, attaching `x-api-key`) + `POST /v1/orders` with identity resolution, cents calculation, and transactional stock decrement.

## Deltas from the existing Orders service spec

This milestone spec changes the following from [[orders-service-design]]:

- Money columns: `decimal(10,2)` → integer `_cents` `bigint` columns with computed dollar properties (Stripe-style).
- `GET /v1/orders/{order_id}` ownership-failure response: `403 Forbidden` → `404 Not Found` (filter-in-query pattern).
- `order` and `order_details` now store both `user_id` (internal) and `cognito_sub` (gateway-supplied), not `user_id` alone.
- Architecture: Clean Architecture with 5 Class Library/executable projects, diverging from the shared screaming-architecture pattern ([[ADR-0008-screaming-arch-di]]) for this service — no new ADR.
- Adds the Users gRPC **server** gate (Issue A) as an explicit, mandatory first item of this milestone.
- Adds the gRPC inter-service API-key authorization scheme (`x-api-key` metadata, constant-time compare, server interceptor).

## Open questions

- No open questions beyond the "double identity" note captured under [[#Data model (MySQL, EF Core)|Data model]] above — everything else in this design was an explicit decision from the brainstorming session.

## Related

- [[orders-service-design]]
- [[soft-delete]]
- [[nano-id]]
- [[audit-fields]]
- [[db-naming]]
- [[cqrs]]
- [[versioning]]
- [[ADR-0003-grpc-inter-service]]
- [[ADR-0006-read-write-replicas]]
- [[ADR-0008-screaming-arch-di]]
- [[ADR-0010-cognito-auth]]
- [[users-service-design]]
- [[2026-06-26-implementation-workflow-design]]
- [[2026-07-11-authenticated-identity-resolution-design]]
