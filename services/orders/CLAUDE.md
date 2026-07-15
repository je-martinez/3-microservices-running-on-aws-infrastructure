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
- Build: `dotnet build` — **also (re)generates `services/orders/openapi.yaml`** at
  build time (see §2a). There is no separate `generate:openapi` step; the plain
  build is the regenerate command.
- Test: `dotnet test` (unit + Testcontainers-MySQL integration; needs Docker)
- Format: `dotnet format` (verify in CI: `dotnet format --verify-no-changes`)
- Add a migration: `dotnet ef migrations add <Name> --project src/Orders.Infrastructure --startup-project src/Orders.Api --context OrdersWriteDbContext`
- Apply migrations: `dotnet ef database update --project src/Orders.Infrastructure --startup-project src/Orders.Api --context OrdersWriteDbContext`
- Run local (docker-watch): `docker compose up orders --watch` (from repo root)

## 2a. GOLDEN RULE — keep `openapi.yaml` in sync

`services/orders/openapi.yaml` is **generated from the Minimal-API endpoint
metadata at build time** and is the artifact imported into **Datadog**. It only
stays correct if it is regenerated after the routes change.

The pipeline: `Microsoft.AspNetCore.OpenApi` builds an OpenAPI **3.1** document
(configured in `Program.cs` via `AddOpenApi("v1", …)`, title `Orders Service API`);
`Microsoft.Extensions.ApiDescription.Server` (a build-only `PackageReference`,
`PrivateAssets=all`) emits it **at build time** into the service root as
`openapi.json`; then the `ConvertOpenApiToYaml` MSBuild target in
`Orders.Api.csproj` runs the file-based converter `tools/openapi-json-to-yaml.cs`
to re-serialize it as `openapi.yaml` (3.1) and deletes the intermediate JSON. The
`--file-name openapi` + document name `v1` combination is what produces a clean
`openapi.json` (no `_v1` suffix).

**Whenever you add/remove an HTTP route, or change any route's request/response
shape (`.Accepts<T>`, `.Produces<T>(status)`, path/query params, or the DTOs it
references), you MUST regenerate and commit `openapi.yaml` together with the code
change.** A route change without a matching `openapi.yaml` update is an incomplete
change.

**Regenerate command:** `dotnet build` (of `Orders.Api`, or the whole solution).
Generation is build-time — there is no separate generate script.

- Each endpoint carries `.WithName(...)` (→ `operationId`), `.WithTags("Orders")`,
  `.WithSummary(...)`, and `.Produces<T>(status)`/`.Produces(status)` for the
  **actual** status codes it returns — keep these accurate to the handler, do not
  document responses the code never returns.
- The E2E cleanup route (`DELETE /v1/orders/e2e-cleanup`) is only mapped at runtime
  under `E2E_TESTING_ENABLED`, but `Program.cs` also maps it during document
  generation (entry assembly `GetDocument.Insider`) so the committed spec is
  complete without exposing the route in a production runtime. Keep that guard if
  you add other flag-gated endpoints you still want documented.
- Response/request DTOs (`OrderDto`, `CreateOrderRequest`, …) surface as named
  `#/components/schemas/*` — the generator prunes unreferenced component schemas,
  so only DTOs a route actually uses appear.
- Verify after regenerating: all five routes are present with their real statuses,
  the document is OpenAPI 3.1, and `dotnet build && dotnet test` pass.

Locally Orders now runs against a **provisioned Floci MySQL cluster** (the second
`rds-aurora` instantiation in `infra/environments/local`), reached at Floci's RDS
proxy port — not the old `7002` placeholder (the port is discovered from
`terraform output`, never hardcoded). Migrations run via **`make migrate-orders`**
as the cluster superuser (`test/test`), mirroring Users' `make migrate` — NOT via
`SEED_ON_STARTUP` at boot. A least-privilege **`orders_app`** user
(SELECT/INSERT/UPDATE, **no DELETE** — [[soft-delete]]/[[ADR-0004-soft-delete-only]])
is created post-apply by `infra/environments/local/bootstrap.sh`. See
[[ADR-0017-floci-local]] and [[floci-rds-apigw-limits]].

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
