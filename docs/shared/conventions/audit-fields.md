---
title: Audit fields
type: convention
area: shared
status: active
created: 2026-06-26
updated: 2026-06-26
tags: [type/convention, area/shared, status/active]
related: ["[[soft-delete]]"]
---

# Audit fields

## Rule

Every persisted entity carries a standard set of audit fields:

- `createdBy`, `createdAt` — who created the row and when.
- `updatedBy`, `updatedAt` — who last modified it and when.
- `deletedBy`, `deletedAt` — who soft-deleted it and when (null while live).
- `isDeleted` — a computed flag, `true` when `deletedAt` is set, `false` otherwise.

These fields are populated automatically by the persistence layer, not by hand in use-cases.

## Rationale

A uniform audit trail makes every change traceable across services and is the backbone of our [[soft-delete]] policy: deletion is just stamping `deletedAt`/`deletedBy`, and `isDeleted` derives directly from it. No entity is exempt, so observability and recovery are consistent everywhere.

## Related

- [[soft-delete]] — deletion sets `deletedAt`/`deletedBy` instead of removing rows; `isDeleted` is derived from them.
