# CLAUDE.md — Tracking service

Nested project memory for the **Tracking** microservice. Source of truth for
this service's stack and conventions. The global `tracking-impl` agent reads
this first, every time. Cross-cutting rules are **referenced**, never duplicated.

## 1. Stack & versions
- Framework: FastAPI (Python 3.12+).
- Database: Aurora MySQL (read + write replicas).
- ORM: SQLAlchemy (migrations via Alembic).
- Env validation: Pydantic settings (parity with the Zod convention).

## 2. Commands
- Install: `pip install -r requirements.txt`
- Run/build: `uvicorn src.main:app`
- Test: `pytest`
- Lint: `ruff check .`
- Run local (docker-watch): `docker compose up tracking --watch` (from repo root)
- Migrate: `alembic upgrade head`

> These commands are the intended contract; the project files themselves are
> created in the Tracking implementation milestone.

## 3. Folder structure (screaming architecture)
```
services/tracking/
├── src/features/tracking/{commands,queries,domain,grpc}/
├── src/shared/{config,db,di,audit}/
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
- `tracking-impl` writes **only source code** — never runs git or touches Linear.
- Leave finished work in the working tree for the **main session** to commit
  (`github-ops` is an optional helper for complex git batches — see [[git-workflow]]).
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Service spec (vault): [../../docs/domains/tracking/specs/tracking-service-design.md](../../docs/domains/tracking/specs/tracking-service-design.md)
- Endpoints: `[POST] /trackings`, `[PUT] /trackings/{order_id}/status`. gRPC: `GetTrackingByOrderId`, `GetTrackingsByOrderIds`.
- Entities: Tracking, Tracking_History.
