---
title: Soft delete only
type: convention
area: shared
status: active
created: 2026-06-26
updated: 2026-08-27
tags: [type/convention, area/shared, status/active, issue/JE-39]
related: ["[[audit-fields]]", "[[nano-id]]", "[[orders-service-design]]", "[[tracking-service-design]]", "[[users-service-design]]", "[[2026-08-25-account-deletion-design]]"]
---

# Soft delete only

## Rule

There are **no hard deletes anywhere**. Deleting a record means setting its `deletedAt` and `deletedBy` audit fields, never removing the row.

- The database write user is granted **no `DELETE` privilege** — hard deletes are impossible even by accident.
- The ORM's delete methods are overridden so that calling "delete" performs a soft-delete (stamping the audit fields) instead of issuing SQL `DELETE`.
- Queries filter out soft-deleted rows by default (`isDeleted = false`).

## Rationale

Data is never lost: every record stays recoverable and auditable. Enforcing this at the database-privilege level — not just in application code — makes the guarantee impossible to bypass, and it pairs directly with our [[audit-fields]] so each deletion records who and when.

## The partial-unique-index pattern

> [!info] Added 2026-08-26 — Account Deletion milestone
> Full design: [[2026-08-25-account-deletion-design]].

Soft delete creates a problem plain uniqueness constraints don't anticipate: a natural key (an
email, a slug, any value a user would recognize) must stay unique among **live** rows, while a
soft-deleted row is explicitly allowed to keep the same value it always had — the whole point of
soft delete is that the old row is preserved intact, not tombstoned or rewritten. A plain
`UNIQUE` constraint can't express that distinction; it blocks a second live row from ever reusing
a value a deleted row still holds.

**Postgres** supports this declaratively via a **partial unique index** — `UNIQUE (...) WHERE
<condition>` — scoped to rows matching the condition only. In Prisma (≥7.4, `partialIndexes`
preview feature), the equivalent is `@@unique([...], where: raw("deleted_at IS NULL"))` on the
model, plus enabling `previewFeatures = ["partialIndexes"]` on the generator block. No raw-SQL
migration is required; the index is generated declaratively from the schema.

**MySQL has no partial indexes.** The equivalent there is a **stored generated column** whose
value collapses to `NULL` exactly when the row is soft-deleted, backing an ordinary unique index
— MySQL's unique indexes already ignore `NULL`s, so a column that is `NULL` on every deleted row
is invisible to the constraint while carrying the natural key's value on every live row. This is
not a new pattern for this decision: it is the identical trick Orders' cart aggregate already
uses for its one-active-cart-per-user invariant (`active_user_id`, a generated column equal to
`user_id` while `deleted_at IS NULL` and `NULL` otherwise — see
[[orders-service-design#The one-active-cart invariant — enforced by the database, not C#]]).

**Worked example — `users.email`.** Before account deletion, `email` was a plain `@unique`
column. As shipped (migration `20260826000000_partial_unique_email`), it is
`@@unique([email], where: raw("deleted_at IS NULL"))` — unique among live rows only. A
soft-deleted user's row keeps its **real** email intact (no tombstoning to
`deleted+<id>@…`, which would destroy the historical data the deletion feature exists to
preserve and break the row's `email_hash` for audit), and a **new** registration can reuse the
same address, producing two rows that share an email: one carrying `deletedAt`, one live. Full
data-model detail: [[users-service-design#Data Model]].

## The per-user cascade

> [!info] Added 2026-08-26 — Account Deletion milestone
> Full design: [[2026-08-25-account-deletion-design]].

Two primitives implement "soft-delete everything belonging to this user, across services,
synchronously" — `SoftDeleteByUser` (Tracking) and the 3-arg
`CartWriteService.DeleteForUserAsync` overload plus the `ExecuteUpdateAsync` sweep in Orders'
`InternalEndpoints.cs` (no equivalent single named method in Orders; the cascade is split across
two `ExecuteUpdateAsync` calls and one `SaveChanges` call under `AmbientActor`). Both are the
per-**identity** analogues of the pre-existing per-**tag** primitives (`SoftDeleteByTag` in
Tracking, the E2E cleanup's `ExecuteUpdateAsync` in Orders) that already served the E2E teardown
— same never-a-SQL-DELETE shape, same FK-following order, different selector.

**The rule, as shipped:** an erasure cascade matches `cognito_sub OR user_id` in **both**
services, while every ordinary read continues to key on `cognito_sub` **alone**. This widening is
erasure-only and deliberate, for two reasons:

1. `cognito_sub` is not the durable identity. A user who deletes their account and registers
   again gets a **new** sub minted by Cognito, while their internal `usr_` id never changes. A
   cascade keyed on `cognito_sub` alone would leave a row whose sub is stale or empty perfectly
   intact and silently unreachable — the deletion request would still answer success, with a
   cascade count of zero, while the data survives.
2. Tracking has a **second**, independent reason: `cognito_sub` is nullable on rows predating
   migration `b17f4c2e9a30`, reachable only through `user_id`.

It costs nothing — both services already index both columns (Orders:
`idx_order_user_id`/`idx_order_cognito_sub`; Tracking: the equivalent pair) — but it is not free
of risk: `cognito_sub`/`user_id` are `NOT NULL varchar` columns in both services' schemas, which
still permits `""`. An empty identity reaching either side of the `OR` would match every row
carrying an empty string in that column — someone else's data — which is why empty identities are
refused at **four** independent layers across the whole cascade (Users' outbound client, Orders'
route, Tracking's schema, Tracking's repository); full table:
[[2026-08-25-account-deletion-design#Empty-identity guards (four layers)]].

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
ordinary `SaveChanges` and pick up the interceptor as usual.

> [!info] A second `ExecuteUpdateAsync` exception, and a hybrid handler (2026-08-26)
> The E2E cleanup is no longer the **only** deliberate `ExecuteUpdateAsync` bypass. The
> account-deletion cascade (`DELETE /v1/orders/by-user`, `InternalEndpoints.cs`) adds a
> **second**: it stamps `order_details` and `orders` via two `ExecuteUpdateAsync` calls (bypassing
> the interceptor, `DeletedBy` set explicitly in each call, same shape as the E2E cleanup), but
> the cart leg of the same handler goes through **ordinary `SaveChanges` under
> `AmbientActor.RunAsync`**, using the interceptor as normal. One HTTP handler is therefore a
> **hybrid**: two bulk statements that bypass audit stamping entirely, one call that uses it. Both
> `ExecuteUpdateAsync` exceptions stamp the same actor, `AuditActor.DeleteByUser` =
> `"orders_api:delete_by_user"`. Full design:
> [[orders-service-design#Account-deletion cascade (internal)]].

## Implementation (Tracking, Go/sqlc)

`SoftDeleteRepository.SoftDeleteByTag`
(`services/tracking-go/internal/adapter/mysql/soft_delete.go`) issues two bulk `UPDATE`
statements — `Tracking_History` first, then `Tracking`, following the FK direction — stamping
`deleted_at`/`deleted_by` and never issuing a SQL `DELETE`. Every read goes through a query
that appends `deleted_at IS NULL`, so a stamped row disappears from every read path without a
matching hard delete anywhere in the code.

**`SoftDeleteByUser`** is the per-identity sibling in the same file: same two-statement,
children-then-parents shape, but selected by `cognito_sub OR user_id` instead of a tag, and its
**parent** selection is deliberately not filtered on `deleted_at IS NULL` — an
already-soft-deleted tracking may still have live history from a partial previous cascade run,
and that history must remain reachable on retry. Idempotency instead comes from the per-statement
`deleted_at IS NULL` guard on each `UPDATE`. Full design:
[[tracking-service-design#Account-deletion cascade (internal)]].

## The ADR-0004 boundary — our databases, not Cognito

> [!info] Added 2026-08-26 — Account Deletion milestone

[[ADR-0004-soft-delete-only]] and this convention govern **our databases** — the write user in
each service holds no `DELETE` grant, which is what makes the rule structural rather than merely
conventional. Account deletion's Cognito step, `AuthProvider.deleteUser` → `AdminDeleteUser`
(Users), does **not** violate that rule, because Cognito is not one of our databases: it is an
**external identity provider**, and what it holds for a user is a **credential** (the Cognito
sub), not a durable **record** of them. The durable record stays exactly where this convention
protects it — in Postgres, as a soft-deleted row keeping its real email intact.

`AdminDeleteUser` was chosen over `AdminDisableUser` specifically because a disabled account
still **occupies its email in the pool**, permanently blocking the confirmed re-registration
requirement (`UsernameExistsException` forever). Deleting the Cognito account is what actually
frees the email address; nothing about it removes or rewrites the Postgres record this convention
protects. Full rationale: [[users-service-design#Account deletion]] and
[[2026-08-25-account-deletion-design]].

## Related

- [[audit-fields]] — `deletedAt`/`deletedBy` and the computed `isDeleted` that soft-delete relies on.
- [[nano-id]] — stamped by the same Prisma client extension; its per-model map shares the extensibility trade-off with `isDeleted`'s per-model registration.
- [[orders-service-design]] — Orders' `e2e-cleanup` endpoint, the `ExecuteUpdateAsync`/`AuditInterceptor` bypass, and the account-deletion cascade's second `ExecuteUpdateAsync` exception and hybrid handler, documented above.
- [[tracking-service-design]] — Tracking's `e2e-cleanup` endpoint, `SoftDeleteByTag`, and the account-deletion `SoftDeleteByUser` sibling, documented above.
- [[users-service-design]] — the partial-unique-index worked example (`users.email`), and `AuthProvider.deleteUser`'s role at the ADR-0004/Cognito boundary, documented above.
- [[2026-08-25-account-deletion-design]] — the full account-deletion design this note's "partial-unique-index pattern", "per-user cascade", and "ADR-0004 boundary" sections propagate from.
