# CLAUDE.md — Orders service

Nested project memory for the **Orders** microservice. Source of truth for this
service's stack and conventions. The global `orders-impl` agent reads this
first, every time. Cross-cutting rules are **referenced**, never duplicated.

## 1. Stack & versions
- Framework: .NET Core 10 — Minimal APIs.
- Language: C#.
- Database: Aurora MySQL (read + write replicas). Locally: MySQL via Floci.
- ORM: Entity Framework Core 9 (Pomelo MySQL provider — pinned 9.0.0; Pomelo has
  no EF 10 build). CQRS split: `OrdersReadDbContext` (read replica, `AsNoTracking`)
  and `OrdersWriteDbContext` (write replica, transactional). Locally both point at
  the same MySQL. See [[cqrs]] and [[ADR-0006-read-write-replicas]].
- Inter-service identity: a **gRPC client** to the Users service
  (`Grpc.Net.Client` + `Grpc.Tools`), generated from the shared repo-root
  `proto/users.proto` (`GrpcServices="Both"` — the client is used at runtime; the
  server stub is only for the in-process test). Every call attaches the shared
  `x-api-key` metadata (`GRPC_API_KEY`); `NOT_FOUND` maps to a null resolution.
- Money: stored as **integer cents** in `bigint` `_cents` columns (Stripe-style),
  mapped to `long` in C#. Dollar values are non-persisted computed properties
  (`cents / 100m`), ignored by EF. Never `decimal`/`float` for stored money; API
  responses expose cents.
- Config: read from environment via `builder.Configuration` (options + validation
  parity with the Users Zod convention).

## 2. Commands
- Restore: `dotnet restore`
- Build: `dotnet build`
- Test: `dotnet test` (unit + Testcontainers-MySQL integration; needs Docker)
- Format: `dotnet format` (verify in CI: `dotnet format --verify-no-changes`)
- Add a migration: `dotnet ef migrations add <Name> --project src/Orders.Infrastructure --startup-project src/Orders.Api --context OrdersWriteDbContext`
- Apply migrations: `dotnet ef database update --project src/Orders.Infrastructure --startup-project src/Orders.Api --context OrdersWriteDbContext`
- Run local (docker-watch): `docker compose up orders --watch` (from repo root)

Locally the service **migrates + seeds itself on startup** when
`SEED_ON_STARTUP=true` (set in compose): `Program.cs` runs `MigrateAsync` then
`ProductSeed.ApplyAsync` before serving. This is the local bootstrap path — there
is no Aurora-MySQL cluster in infra yet, so no standalone `make migrate` step.

## 3. Solution layout (Clean Architecture)
Five projects; dependencies point inward (Domain ← Application ← Infrastructure/Api,
Api → Infrastructure). Domain references nothing.
```
services/orders/
├── Orders.sln
├── src/
│   ├── Orders.Domain/          — entities (AuditableEntity, Product, Order,
│   │                             OrderDetail), OrderPricing. No dependencies.
│   ├── Orders.Application/      — ports + pure DTOs/records/exceptions:
│   │                             IUserDirectory, IEventPublisher, OrderDto,
│   │                             CreateOrderCommand, InsufficientStock/UnknownUser.
│   ├── Orders.Infrastructure/   — EF Core DbContexts + configs + migrations, the
│   │                             nano-id helper, the gRPC client
│   │                             (Grpc/UserDirectoryGrpcClient), NoopEventPublisher,
│   │                             and the read/write SERVICES (Orders/OrderReadService,
│   │                             Orders/CreateOrderService).
│   └── Orders.Api/              — composition root: Program.cs DI, Minimal-API
│                                 endpoints (Endpoints/), CallerIdentity.
└── tests/Orders.Tests/         — xUnit; Domain unit tests + Testcontainers-MySQL
                                  integration + WebApplicationFactory endpoint tests.
```

> **Dependency-direction rule (important).** Application must NOT reference
> Infrastructure/EF Core. Any class that touches a DbContext or the gRPC client
> lives in **Infrastructure**, not Application — this is why `OrderReadService`
> and `CreateOrderService` sit under `Orders.Infrastructure.Orders` even though
> the plan drafted them in Application. Application owns only ports (interfaces),
> commands, DTOs, and exceptions. The Api wires the concrete services.

## 4. Conventions (referenced, never duplicated)
- CQRS (read/write DbContexts): [../../docs/shared/patterns/cqrs.md](../../docs/shared/patterns/cqrs.md)
- Soft delete only: [../../docs/shared/conventions/soft-delete.md](../../docs/shared/conventions/soft-delete.md)
- Prefixed nano IDs (`prd_`, `ord_`, `odd_`): [../../docs/shared/conventions/nano-id.md](../../docs/shared/conventions/nano-id.md)
- Audit fields: [../../docs/shared/conventions/audit-fields.md](../../docs/shared/conventions/audit-fields.md)
- API versioning (`/v1`): [../../docs/shared/conventions/versioning.md](../../docs/shared/conventions/versioning.md)
- DB naming (snake_case columns ↔ PascalCase properties): [../../docs/shared/conventions/db-naming.md](../../docs/shared/conventions/db-naming.md)
- gRPC inter-service: [../../docs/shared/decisions/ADR-0003-grpc-inter-service.md](../../docs/shared/decisions/ADR-0003-grpc-inter-service.md)
- Read/write replicas: [../../docs/shared/decisions/ADR-0006-read-write-replicas.md](../../docs/shared/decisions/ADR-0006-read-write-replicas.md)

## 5. Agent rules
- Converse with the user in **Spanish**; write code and comments in **English**.
- `orders-impl` writes **only source code** — never runs git or touches Linear.
- Leave finished work in the working tree for the **main session** to commit
  (`github-ops` is an optional helper for complex git batches — see [[git-workflow]]).
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Service spec (vault): [../../docs/domains/orders/specs/orders-service-design.md](../../docs/domains/orders/specs/orders-service-design.md)
- Endpoints (all `/v1`-prefixed):
  - `[GET] /v1/health`
  - `[POST] /v1/orders` → 201 (new `ord_` id) · 401 no `x-user-id` · 404
    `unknown_user` · 409 `insufficient_stock`. Resolves the caller's Cognito sub
    to the internal `usr_` id via the Users gRPC client, then in one transaction
    locks each product `FOR UPDATE`, decrements stock, prices lines in cents,
    persists Order + OrderDetails with BOTH `user_id` and `cognito_sub`, and emits
    `ORDER_CREATED` (Noop seam). Full rollback on any failure.
  - `[GET] /v1/orders/my-orders`, `[GET] /v1/orders/{order_id}` — ownership by
    query filter (`cognito_sub` from `x-user-id`); another user's order → 404. No
    gRPC on reads.
  - `[DELETE] /v1/orders/e2e-cleanup` — soft-deletes the caller's orders; mapped
    only when `E2E_TESTING_ENABLED`.
- `ORDER_CREATED` is **not** on SQS yet — `NoopEventPublisher` is the emission
  seam; the SQS wiring is deferred.
