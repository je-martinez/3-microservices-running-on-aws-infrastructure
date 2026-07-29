---
title: Orders stores money as integer cents, not decimal
type: adr
area: orders
status: accepted
id: orders-money-integer-cents
deciders: ["Jose E. Martinez"]
supersedes: null
superseded-by: null
created: 2026-07-28
updated: 2026-07-28
tags: [type/adr, area/orders, status/accepted]
related:
  - "[[orders-service-design]]"
  - "[[db-naming]]"
  - "[[2026-07-14-orders-service-milestone-design]]"
  - "[[2026-07-14-orders-service-milestone]]"
---

# Orders stores money as integer cents, not decimal

## Context

The original [[orders-service-design]] specified `decimal(10,2)` columns for
`subtotal`/`tax`/`total`/`unit_price`. During the Orders Service milestone design
(2026-07-14), the team chose Stripe's approach instead, to eliminate floating-point
and decimal-rounding risk in money math end-to-end.

## Decision

All monetary amounts are stored as **integer cents** in `bigint` columns (mapped to
`long` in C#), with column names carrying the `_cents` suffix: `unit_price_cents`,
`subtotal_cents`, `tax_cents`, `total_cents`. Each entity exposes read-only,
non-persisted computed properties without the suffix (`UnitPrice`, `Subtotal`, `Tax`,
`Total`) returning `cents / 100m` for display. `POST /v1/orders` pricing
(`OrderPricing.PriceLine`) is pure integer-cents arithmetic; tax is rounded to the
nearest cent (`MidpointRounding.AwayFromZero`) exactly once per line. API responses
expose cents as integers — dollar conversion is a display-only concern, never
serialized directly from stored state.

This **supersedes** the `decimal(10,2)` columns described in [[orders-service-design]]
for `Product.unit_price`, `Order.subtotal/tax/total`, and
`OrderDetails.subtotal/tax/total`.

## Consequences

- No floating-point or decimal rounding drift accumulates across order lines.
- Every money column needs the `_cents` suffix and a paired computed property; a
  future column that stores a dollar amount without this pattern is a bug, not a
  style choice.
- `ProductDto` and `OrderDto` (Application layer) expose cents fields directly,
  keeping the API contract integer-only end-to-end.

## Related

- [[orders-service-design]]
- [[db-naming]]
- [[2026-07-14-orders-service-milestone-design]]
- [[2026-07-14-orders-service-milestone]]
