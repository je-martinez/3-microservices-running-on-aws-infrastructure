# CLAUDE.md — Orders service

Nested project memory for the **Orders** microservice. Source of truth for this
service's stack and conventions. The global `orders-impl` agent reads this
first, every time. Cross-cutting rules are **referenced**, never duplicated.

## 1. Stack & versions
- Framework: .NET Core 10 — Minimal APIs.
- Language: C#.
- Database: Aurora MySQL (read + write replicas).
- ORM: Entity Framework Core.
- Env validation: options + validation (parity with the Zod convention).

## 2. Commands
- Restore: `dotnet restore`
- Build: `dotnet build`
- Test: `dotnet test`
- Lint/format: `dotnet format`
- Run local (docker-watch): `docker compose up orders --watch` (from repo root)
- Migrate: `dotnet ef database update`

> These commands are the intended contract; the project files themselves are
> created in the Orders implementation milestone.

## 3. Folder structure (screaming architecture)
```
services/orders/
├── src/Features/Orders/{Commands,Queries,Domain,Grpc}/
├── src/Shared/{Config,Persistence,Audit,Messaging}/
└── tests/
```

## 4. Conventions (referenced, never duplicated)
- Screaming architecture + DI: [../../docs/shared/patterns/screaming-architecture.md](../../docs/shared/patterns/screaming-architecture.md), [../../docs/shared/patterns/dependency-injection.md](../../docs/shared/patterns/dependency-injection.md)
- CQRS: [../../docs/shared/patterns/cqrs.md](../../docs/shared/patterns/cqrs.md)
- Soft delete only: [../../docs/shared/conventions/soft-delete.md](../../docs/shared/conventions/soft-delete.md)
- Prefixed nano IDs: [../../docs/shared/conventions/nano-id.md](../../docs/shared/conventions/nano-id.md)
- Audit fields: [../../docs/shared/conventions/audit-fields.md](../../docs/shared/conventions/audit-fields.md)
- API versioning: [../../docs/shared/conventions/versioning.md](../../docs/shared/conventions/versioning.md)
- DB naming (snake_case ↔ PascalCase aliases): [../../docs/shared/conventions/db-naming.md](../../docs/shared/conventions/db-naming.md)

## 5. Agent rules
- Converse with the user in **Spanish**; write code and comments in **English**.
- `orders-impl` writes **only source code** — never runs git or touches Linear.
- Leave finished work in the working tree for the **main session** to commit
  (`github-ops` is an optional helper for complex git batches — see [[git-workflow]]).
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Service spec (vault): [../../docs/domains/orders/specs/orders-service-design.md](../../docs/domains/orders/specs/orders-service-design.md)
- Endpoints: `[POST] /orders` (emits SQS `ORDER_CREATED`), `[GET] /orders/my-orders`, `[GET] /orders/{order_id}` (verify ownership). gRPC: `GetOrderById`.
- Entities: Product, Order, OrderDetails.
