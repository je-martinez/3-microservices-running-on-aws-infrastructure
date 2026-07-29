---
title: Product stock locking via tagged LINQ + FOR UPDATE interceptor
type: adr
area: orders
status: accepted
id: orders-for-update-interceptor
deciders: ["Jose E. Martinez"]
supersedes: null
superseded-by: null
created: 2026-07-28
updated: 2026-07-28
tags: [type/adr, area/orders, status/accepted]
related:
  - "[[orders-service-design]]"
  - "[[ADR-0004-soft-delete-only]]"
  - "[[cqrs]]"
  - "[[2026-07-16-orders-for-update-interceptor-design]]"
  - "[[2026-07-16-orders-for-update-interceptor]]"
---

# Product stock locking via tagged LINQ + FOR UPDATE interceptor

## Context

`POST /v1/orders` must lock each `Product` row for the duration of the create-order
transaction so concurrent orders cannot oversell stock. The first implementation used
`FromSqlInterpolated("SELECT ... FOR UPDATE")` because EF Core has no first-class LINQ
API for pessimistic row locking. Raw SQL bypasses EF Core's global query filters, so
the soft-delete predicate (`deleted_at IS NULL`) had to be added by hand to the raw
string — and was, at one point, missed, letting a soft-deleted product be read and
sold (an [[ADR-0004-soft-delete-only]] leak).

## Decision

Replace the raw SQL with a pure LINQ query tagged via EF Core's `TagWith`, plus a
`DbCommandInterceptor` that appends `FOR UPDATE` when it recognizes the tag:

- The service writes ordinary LINQ:
  `_db.Products.TagWith(ForUpdateInterceptor.Tag).FirstOrDefaultAsync(p => p.Id == id, ct)`.
  EF's global query filter (`deleted_at IS NULL`) applies automatically — no manual
  predicate, so it cannot be forgotten again.
- `ForUpdateInterceptor : DbCommandInterceptor` overrides `ReaderExecuting` /
  `ReaderExecutingAsync`; if the emitted SQL carries the tag comment, is a `SELECT`,
  and doesn't already contain `FOR UPDATE`, it appends ` FOR UPDATE` before execution.
  The tag is a single shared constant used by both `TagWith(...)` and the
  interceptor's matcher so the two sides cannot desync.
- Registered on the **write** `DbContext` only (`OnConfiguring`, next to
  `AuditInterceptor`) — never the read context; pure reads must not take locks. This
  is the same read/write split as [[cqrs]].
- `FOR UPDATE` is MySQL/InnoDB syntax (Orders runs on Aurora MySQL); the interceptor
  is the single documented point to change if the engine ever changes.
- A test asserts the executed SQL actually contains `FOR UPDATE` — trusting "should
  work" was exactly how the soft-delete leak happened silently the first time.

## Consequences

- No raw SQL remains in Orders business code for the locking path.
- The soft-delete filter can no longer be silently bypassed by a future edit to the
  locking query — it comes from the same EF configuration every other query uses.
- If the interceptor ever fails to match the tag (e.g. EF changes its comment
  format), the query silently runs without the lock. Mitigated by the shared-constant
  tag and the emitted-SQL assertion test, not eliminated — a future engine/EF upgrade
  should re-run that test explicitly.

## Related

- [[orders-service-design]]
- [[ADR-0004-soft-delete-only]]
- [[cqrs]]
- [[2026-07-16-orders-for-update-interceptor-design]]
- [[2026-07-16-orders-for-update-interceptor]]
