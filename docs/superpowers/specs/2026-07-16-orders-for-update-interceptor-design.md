---
title: Orders FOR UPDATE via LINQ + Interceptor Design
type: spec
area: orders
status: draft
created: 2026-07-16
updated: 2026-07-16
tags:
  - type/spec
  - area/orders
  - status/draft
related:
  - "[[ADR-0004-soft-delete-only]]"
  - "[[orders-service-design]]"
  - "[[2026-07-14-orders-service-milestone-design]]"
  - "[[cqrs]]"
  - "[[db-naming]]"
---

# Orders FOR UPDATE via LINQ + Interceptor Design

## Summary

Replace the raw `FromSqlInterpolated(... FOR UPDATE)` pessimistic-lock query in the Orders
create-order path with a pure LINQ query plus an EF Core command interceptor that appends
`FOR UPDATE`. This removes raw SQL from business code, and — critically — lets EF Core's
global soft-delete query filter (`deleted_at IS NULL`) apply automatically, so the soft-delete
filtering can never be forgotten again (a raw query previously bypassed the filter and let a
soft-deleted product be sold — an [[ADR-0004-soft-delete-only]] leak, since fixed by an explicit
predicate, now removed entirely).

## Motivation / current state

- `services/orders/src/Orders.Infrastructure/Orders/CreateOrderService.cs` locks each product
  row with `FromSqlInterpolated($"SELECT * FROM product WHERE id = {line.ProductId} AND
  deleted_at IS NULL FOR UPDATE")`. The raw SQL exists ONLY because EF Core has no first-class
  LINQ API for pessimistic row locking (`FOR UPDATE`). Raw SQL bypasses EF's global query
  filters, so the `AND deleted_at IS NULL` had to be added by hand (that hand-added predicate is
  the current fix — this design removes the need for it).
- The team dislikes raw SQL inside an ORM; the goal is LINQ-first while keeping the strong
  pessimistic-lock guarantee against overselling.

## Section 1 — Mechanism (LINQ + TagWith + interceptor)

In the service, write a normal LINQ query tagged with a shared constant:

```csharp
var product = await _db.Products
    .TagWith(ForUpdateInterceptor.Tag)   // EF emits "-- <Tag>" as a SQL comment
    .FirstOrDefaultAsync(p => p.Id == line.ProductId, ct)
    ?? throw new InsufficientStockException(line.ProductId);
```

The global query filter (`deleted_at IS NULL`) applies automatically — no manual predicate.
Idiomatic LINQ.

`ForUpdateInterceptor : DbCommandInterceptor` overrides `ReaderExecuting` /
`ReaderExecutingAsync`. If the CommandText contains the tag marker AND is a SELECT AND doesn't
already contain `FOR UPDATE`, it appends ` FOR UPDATE` before execution.

Robustness: the tag is a single shared constant (`ForUpdateInterceptor.Tag`) used both in
`TagWith(...)` and the interceptor's matcher, so they can't desync. Only tagged SELECTs are
touched; every other query passes through untouched. `FOR UPDATE` requires the open write
transaction that the create-order flow already has.

## Section 2 — Location, portability, edge behavior

**(a) Location.** `ForUpdateInterceptor` lives in `Orders.Infrastructure/Persistence/` next to
`AuditInterceptor`, registered on the WRITE DbContext via `OnConfiguring`
`AddInterceptors(...)` (the same single registration point `AuditInterceptor` uses — covers DI,
the design-time factory, and test contexts). NOT on the read DbContext: `FOR UPDATE` only makes
sense inside a write transaction; pure reads (`OrderReadService`) must not take locks. This
mirrors the [[cqrs]] read/write DbContext split already in use.

**(b) Portability.** `FOR UPDATE` is MySQL/Postgres (InnoDB/Postgres) syntax, NOT universal (SQL
Server uses `WITH (UPDLOCK)`). Orders is MySQL-only (Aurora MySQL), so the interceptor emits
`FOR UPDATE` directly, documented as MySQL-specific — the single point to change if the engine
ever changes. This is cleaner than today's raw SQL, which was already MySQL-specific but
scattered in business code.

**(c) Edge behavior — tag doesn't match.** If the interceptor doesn't find the tag (or EF
changes how it emits comments), the query runs WITHOUT `FOR UPDATE` — a SILENT failure of the
concurrency guarantee. Mitigations: the tag is a shared constant (can't desync); and a test
asserts the emitted SQL actually contains `FOR UPDATE` (don't trust "should").

**(d) Idempotency.** The matcher checks the SQL doesn't already contain `FOR UPDATE` before
appending, and that it's a SELECT (never an INSERT/UPDATE).

## Section 3 — Testing

**(a) Soft-delete regression.** The existing `Rejects_soft_deleted_product` test (added when the
raw query was fixed) must STILL PASS — now the filter is applied by EF automatically instead of
the manual `AND deleted_at IS NULL`. It's the safety net that the refactor didn't reintroduce
the [[ADR-0004-soft-delete-only]] leak.

**(b) FOR UPDATE emission assertion.** Assert `FOR UPDATE` is actually emitted (the critical
edge from Section 2c): a test that captures the generated SQL (via EF's logger or a test
`DbCommandInterceptor` recording the final CommandText) when running the tagged query, and
asserts it ends with `FOR UPDATE`. This catches a desynced tag or an EF comment-format change.

**(c) End-to-end regression.** The existing `CreateOrderService` integration tests (happy path
decrements stock, insufficient stock rolls back, unknown user throws) must STILL PASS on the new
mechanism (Testcontainers-MySQL) — proving the lock + transaction + decrement still work
end-to-end.

**(d) Out of scope (YAGNI).** A real-concurrency test (two concurrent create-orders on the same
limited-stock product, assert no oversell) is fragile/slow; the (b) test proves `FOR UPDATE` is
emitted and we trust InnoDB. Add only if requested.

## Done criterion

The raw `FromSqlInterpolated` is gone from the service; the query is pure LINQ with
`TagWith`; the interceptor appends `FOR UPDATE`; existing tests (soft-delete rejected, happy
path, insufficient stock, unknown user) pass; a new test confirms the emitted SQL contains
`FOR UPDATE`.

## Open questions

- Exact interceptor method(s) to override — `ReaderExecuting` + `ReaderExecutingAsync` (sync +
  async); confirm both are needed given the create path is async (async is the live path; sync
  for completeness). Decide at implementation.
- Whether to match the tag by EF's exact comment format (`-- <Tag>\n`) or a looser
  `Contains(Tag)` — looser is more robust to format changes but must still be specific enough
  not to catch unrelated queries; decide at implementation.
- Whether the append must handle a trailing semicolon / whitespace in the generated SQL (MySQL:
  `SELECT ... FOR UPDATE`); verify against Pomelo's generated SQL at implementation.

## Related

- [[ADR-0004-soft-delete-only]]
- [[orders-service-design]]
- [[2026-07-14-orders-service-milestone-design]]
- [[cqrs]]
- [[db-naming]]
