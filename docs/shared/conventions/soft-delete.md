---
title: Soft delete only
type: convention
area: shared
status: active
created: 2026-06-26
updated: 2026-06-26
tags: [type/convention, area/shared, status/active]
related: ["[[audit-fields]]"]
---

# Soft delete only

## Rule

There are **no hard deletes anywhere**. Deleting a record means setting its `deletedAt` and `deletedBy` audit fields, never removing the row.

- The database write user is granted **no `DELETE` privilege** — hard deletes are impossible even by accident.
- The ORM's delete methods are overridden so that calling "delete" performs a soft-delete (stamping the audit fields) instead of issuing SQL `DELETE`.
- Queries filter out soft-deleted rows by default (`isDeleted = false`).

## Rationale

Data is never lost: every record stays recoverable and auditable. Enforcing this at the database-privilege level — not just in application code — makes the guarantee impossible to bypass, and it pairs directly with our [[audit-fields]] so each deletion records who and when.

## Related

- [[audit-fields]] — `deletedAt`/`deletedBy` and the computed `isDeleted` that soft-delete relies on.
