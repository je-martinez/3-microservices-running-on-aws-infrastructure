---
title: Soft delete only
type: convention
area: shared
status: active
created: 2026-06-26
updated: 2026-08-03
tags: [type/convention, area/shared, status/active, issue/JE-39]
related: ["[[audit-fields]]", "[[nano-id]]", "[[orders-service-design]]", "[[tracking-service-design]]"]
---

# Soft delete only

## Rule

There are **no hard deletes anywhere**. Deleting a record means setting its `deletedAt` and `deletedBy` audit fields, never removing the row.

- The database write user is granted **no `DELETE` privilege** — hard deletes are impossible even by accident.
- The ORM's delete methods are overridden so that calling "delete" performs a soft-delete (stamping the audit fields) instead of issuing SQL `DELETE`.
- Queries filter out soft-deleted rows by default (`isDeleted = false`).

## Rationale

Data is never lost: every record stays recoverable and auditable. Enforcing this at the database-privilege level — not just in application code — makes the guarantee impossible to bypass, and it pairs directly with our [[audit-fields]] so each deletion records who and when.

## Implementation (Users service, [JE-39](https://linear.app/issue/JE-39))

The Users service enforces this via the same **single Prisma client extension** that implements [[nano-id]] and [[audit-fields]], in `services/users/src/shared/db/prisma-extensions.ts` (composed in `services/users/src/shared/db/prisma.ts`):

- `delete`/`deleteMany` are transparently rewritten into `update`/`updateMany` that set `deletedAt`/`deletedBy` — following the pattern from the official `prisma-client-extensions` repo. No real SQL `DELETE` is ever issued.
- `find*`/`count` exclude soft-deleted rows by default by injecting `deletedAt: null` into `where`, unless the caller has already filtered on `deletedAt` itself.
- `isDeleted` moved from a standalone helper function (`isDeleted(row)`, now removed) to a Prisma **computed result field** (`row.isDeleted`), registered in the same extension's `result` block via an exported `RESULT_EXTENSIONS` map. The invariant is **every model with a `deletedAt` column is registered in `RESULT_EXTENSIONS`**, and it currently covers all three soft-deletable models — `user`, `usersCognitoData`, `usersCognitoEvent` — sharing one `isDeletedField` definition (`needs: { deletedAt: true }`, `compute: computeIsDeleted`).
  - Technical note: it's registered per-model (`result: { user: {...}, usersCognitoData: {...}, ... }`) rather than with `$allModels`, because `$allModels`'s generic `needs` type collapses to `never` and can't resolve a concrete field shape (like `{ deletedAt: true }`) across every model at once. This is the same extensibility trade-off as `MODEL_ID_PREFIXES` in [[nano-id]] — new models register their own `isDeleted` entry as they're added.
  - The invariant is **enforced by a test**, not just convention: `tests/shared/db/prisma-extensions.test.ts` reads `prisma/schema.prisma`, collects every model declaring a `deletedAt` column, and asserts each one appears in `RESULT_EXTENSIONS` with `computeIsDeleted`. A future model that gains `deletedAt` without a matching `RESULT_EXTENSIONS` entry fails the suite — this is why the map is a named export rather than inlined into the `result` block.
- The same extension's `model` block also carries `findByIdOrCognitoSub` (used by `GET`/`PATCH /v1/users/me`), sitting alongside the `query` and `result` components above — it resolves a user by either their `usr_` id or their Cognito `sub`, going through `findFirst` so the soft-delete/read-replica behavior still applies.

## Implementation (Orders, EF Core)

Orders' `e2e-cleanup` endpoint (`services/orders/src/Orders.Api/Endpoints/E2eEndpoints.cs`) stamps
`DeletedAt`/`DeletedBy` through `ExecuteUpdateAsync`, which issues a single SQL `UPDATE` and
**bypasses `SaveChanges` entirely** — so the `AuditInterceptor` (a `SaveChangesInterceptor`,
`Orders.Infrastructure/Persistence/AuditInterceptor.cs`) that normally stamps audit fields never
runs for it. `DeletedBy` is therefore set explicitly in the `ExecuteUpdateAsync` call itself,
mirroring the actor the interceptor would otherwise have set. The rest of Orders' writes go through
ordinary `SaveChanges` and pick up the interceptor as usual; the E2E cleanup is the one deliberate
bulk-update exception.

## Implementation (Tracking, SQLAlchemy)

`TrackingRepository.soft_delete_by_tag` (`services/tracking/src/features/tracking/domain/repository.py`)
issues two bulk `UPDATE` statements — `Tracking_History` first, then `Tracking`, following the FK
direction — stamping `deleted_at`/`deleted_by` and never issuing a SQL `DELETE`. Every read in the
repository goes through `_live()`, which appends `deleted_at IS NULL`, so a stamped row disappears
from every read path without a matching hard delete anywhere in the code.

## Related

- [[audit-fields]] — `deletedAt`/`deletedBy` and the computed `isDeleted` that soft-delete relies on.
- [[nano-id]] — stamped by the same Prisma client extension; its per-model map shares the extensibility trade-off with `isDeleted`'s per-model registration.
- [[orders-service-design]] — Orders' `e2e-cleanup` endpoint, the `ExecuteUpdateAsync`/`AuditInterceptor` bypass documented above.
- [[tracking-service-design]] — Tracking's `e2e-cleanup` endpoint and `soft_delete_by_tag`, documented above.
