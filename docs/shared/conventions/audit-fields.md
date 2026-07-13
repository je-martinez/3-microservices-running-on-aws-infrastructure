---
title: Audit fields
type: convention
area: shared
status: active
created: 2026-06-26
updated: 2026-07-12
tags: [type/convention, area/shared, status/active, issue/JE-39]
related: ["[[soft-delete]]", "[[nano-id]]", "[[2026-07-12-audit-actor-enum-design]]"]
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
- The current actor is read from an **AsyncLocalStorage** (`services/users/src/shared/audit/actor-context.ts`). The `onRequest` hook in `routes.ts` still populates it once per request from `x-user-id` — needed for identity resolution (e.g. `getMe`) — because the Prisma client (with this extension applied) is a process-wide singleton and can't reach into a per-request scope directly.
- Semantic actor model: for self-service write paths, the value stamped into `createdBy`/`updatedBy`/`deletedBy` is not the per-request `x-user-id` but a semantic **`AuditActor`** enum value (`services/users/src/shared/audit/audit-actor.ts`), format `users_api:<action>`. It records *what produced the row* rather than a specific user id: `users_api:register` for self-registration, `users_api:update_profile` for profile updates, `users_api:identity_capture` for the Cognito webhook capture, and `users_api:e2e_cleanup` for the E2E cleanup soft-delete. All four share the `users_api` source (self-service / internal-maintenance endpoints, not an admin console); the action segment distinguishes what produced the row. Each write path wraps its write in `runAsActor(AuditActor.X, ...)`, which locally overrides the per-request actor for that write. See [[2026-07-12-audit-actor-enum-design]] for the design rationale.
- The old manual helpers `stampCreate`/`stampSoftDelete` (`shared/audit/audit.ts`) have been removed; stamping now happens exclusively inside the extension in `services/users/src/shared/db/prisma-extensions.ts`, composed onto the client in `services/users/src/shared/db/prisma.ts`.

### Pitfall — `runAsActor` must await inside (Prisma's lazy `PrismaPromise`)

> [!danger] Verified empirically against live Postgres — silently corrupted audit data, not just nulls
> Prisma's `create`/`update`/`deleteMany` return a **lazy `PrismaPromise`** (a thenable, not a
> native Promise). It starts **no work at construction** — the query, and therefore the audit
> extension's `getActor()`, only runs when the promise is **awaited**.
>
> `AsyncLocalStorage.run(store, fn)` exits its store the moment `fn` returns **synchronously**. A
> call site written as `runAsActor(Actor.X, () => db.user.create({...}))` — a non-`async` arrow
> returning the un-started `PrismaPromise` — hands back the thenable, the store exits immediately,
> and the query later executes under whatever ALS store is active at the **await site** (the
> per-request `onRequest` store), not the intended one.
>
> **Consequence:** on the unauthenticated `POST /register` (no `x-user-id`) this stamped
> `createdBy = null`; on an **authenticated** write it silently stamped the caller's Cognito sub
> instead of the semantic actor — data corruption, not just a null.
>
> **Fix (implemented):** `runAsActor` now does `actorContext.run({ actor }, async () => await fn())`
> — awaiting inside keeps the store alive for the whole query, regardless of the arrow style the
> caller uses. Call sites need no special form.
>
> **Testing note:** mocked Prisma clients return *eager* promises, so unit tests with mocks cannot
> catch this class of bug. The regression test (`tests/shared/audit/actor-context.test.ts`) models
> the laziness with a real lazy thenable; persistence behavior must be verified against a real
> Postgres. See [[2026-07-12-prisma-lazy-promise-als]] for the full lesson.

## Related

- [[soft-delete]] — deletion sets `deletedAt`/`deletedBy` instead of removing rows; `isDeleted` is derived from them.
- [[nano-id]] — stamped by the same Prisma client extension.
- [[2026-07-12-audit-actor-enum-design]] — design of the semantic `AuditActor` enum used for self-service audit stamping.
- [[2026-07-12-prisma-lazy-promise-als]] — lesson on the lazy-`PrismaPromise`/ALS pitfall and its fix.
