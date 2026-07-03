---
title: Audit fields
type: convention
area: shared
status: active
created: 2026-06-26
updated: 2026-07-02
tags: [type/convention, area/shared, status/active, issue/JE-39]
related: ["[[soft-delete]]", "[[nano-id]]"]
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

## Implementation (Users service, [JE-39](https://linear.app/issue/JE-39))

The Users service populates these fields automatically via the same **single Prisma client extension** that implements [[nano-id]] and [[soft-delete]] — there is no manual stamping helper in commands/queries:

- `createdBy`/`updatedBy` are stamped automatically by a `$allModels` query extension on `create`/`createMany`/`update`/`updateMany`/`upsert`.
- The acting user is read from an **AsyncLocalStorage** (`services/users/src/shared/audit/actor-context.ts`), populated once per request by the `onRequest` hook in `routes.ts` — **not** read from the Awilix DI cradle directly, because the Prisma client (with this extension applied) is a process-wide singleton and can't reach into a per-request scope.
- Special case — self-registration: since a newly-registered user's own row is its own actor, `register` reserves the row's id up front and runs the `create` call inside `runAsActor(id, ...)`, so `createdBy`/`updatedBy` on that first row point at the row itself.
- The old manual helpers `stampCreate`/`stampSoftDelete` (`shared/audit/audit.ts`) have been removed; stamping now happens exclusively inside the extension in `services/users/src/shared/db/prisma-extensions.ts`, composed onto the client in `services/users/src/shared/db/prisma.ts`.

## Related

- [[soft-delete]] — deletion sets `deletedAt`/`deletedBy` instead of removing rows; `isDeleted` is derived from them.
- [[nano-id]] — stamped by the same Prisma client extension.
