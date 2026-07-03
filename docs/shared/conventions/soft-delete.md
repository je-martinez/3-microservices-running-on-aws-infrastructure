---
title: Soft delete only
type: convention
area: shared
status: active
created: 2026-06-26
updated: 2026-07-02
tags: [type/convention, area/shared, status/active, issue/JE-39]
related: ["[[audit-fields]]", "[[nano-id]]"]
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
- `isDeleted` moved from a standalone helper function (`isDeleted(row)`, now removed) to a Prisma **computed result field** (`row.isDeleted`), registered in the same extension's `result` block.
  - Technical note: it's registered per-model (`result: { user: { isDeleted: {...} } }`) rather than with `$allModels`, because `$allModels`'s generic `needs` type collapses to `never` and can't resolve a concrete field shape (like `{ deletedAt: true }`) across every model at once. This is the same extensibility trade-off as `MODEL_ID_PREFIXES` in [[nano-id]] — new models register their own `isDeleted` entry as they're added.

## Related

- [[audit-fields]] — `deletedAt`/`deletedBy` and the computed `isDeleted` that soft-delete relies on.
- [[nano-id]] — stamped by the same Prisma client extension; its per-model map shares the extensibility trade-off with `isDeleted`'s per-model registration.
