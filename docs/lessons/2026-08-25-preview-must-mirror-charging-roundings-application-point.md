---
title: "A preview must mirror the charging code's rounding application point, not just its rounding mode"
type: lesson
area: orders
status: active
created: 2026-08-25
updated: 2026-08-26
tags:
  - type/lesson
  - area/orders
  - status/active
  - severity/high
related:
  - "[[money-representation]]"
  - "[[orders-service-design]]"
  - "[[2026-08-25-cart-endpoints-design]]"
  - "[[money-as-integer-cents]]"
---

# A preview must mirror the charging code's rounding application point, not just its rounding mode

## Finding

`CartPricing.Totalize` (the cart's preview total) and `OrderPricing.PriceLine` (what
`POST /v1/orders` actually charges) used the **same rounding mode**
(`MidpointRounding.AwayFromZero`) and the **same tax rate**, and still disagreed by a cent.

The cart rounded tax **once, over the whole cart subtotal**. The order rounds tax **per line**,
inside `CreateOrderService`, accumulating `tax += lineTax` as it goes. Same inputs, same mode,
different **application point** — and that alone is enough to produce a different figure.

**Worked example**, at this repo's cart tax rate (0.08), three lines of 333 cents each:

| Application point | Computation | Result |
|---|---|---|
| Per line, then summed (the order's real behaviour) | `round(333 × 0.08) = 27`, three times | **81** |
| Once, over the summed subtotal (the cart's original behaviour) | `round(999 × 0.08) = round(79.92)` | **80** |

The user would see **$10.79** in the cart and be charged **$10.80** at checkout — a silent,
small, hard-to-explain billing discrepancy. Neither number is "wrong" in isolation; both are
correctly rounded. The bug is that they answer a different question (round-then-sum vs.
sum-then-round) while looking, at a glance, like the same computation restated twice.

## Why this is easy to miss

The two functions are in different files, tested in isolation, and each individually correct
and well-covered. Nothing about either implementation looks buggy on its own — the original
comment on the cart's version even asserted, confidently and wrong, that rounding once was the
choice that kept the cart and the order "agreeing to the cent." Matching the rounding **mode**
is the obvious thing to check when two money computations must agree; matching the rounding
**application point** is not, and it is exactly as load-bearing.

## Where this was caught

Final whole-branch review, before merge — not by a test, since the original `CartPricingTests`
asserted hardcoded expected values that happened to be internally self-consistent with the
(wrong) once-over-the-subtotal implementation. A hardcoded expectation cannot catch this class
of bug: it verifies the code computes what the test-writer expected, not that it agrees with a
second, independent implementation of "the same" figure.

## Fix

`CartPricing.Totalize` now sums **per-line** rounded tax
(`services/orders/src/Orders.Infrastructure/Carts/CartPricing.cs`), mirroring
`OrderPricing.PriceLine` exactly. `OrderPricing`/`CreateOrderService` — the order's real
pricing — was deliberately **left unchanged**: it is the incumbent and it is what actually
bills, so changing it would rewrite the pricing of every future order and make it disagree with
every already-placed, already-billed historical order. The cart moved to match the order, not
the other way around — the preview conforms to the charge, never the reverse.

Two tests now compute their expected tax by calling `OrderPricing.PriceLine` directly rather
than hardcoding a number, so the two implementations cannot drift apart again without a test
failing.

## How to apply

- **Whenever two surfaces report the "same" computed money figure — a preview and the charge it
  previews, a cached/denormalized total and its source, two services' independent recomputation
  of one value — verify the rounding APPLICATION POINT agrees, not only the rounding mode and
  rate.** Round-per-line-then-sum and round-once-over-the-sum are different functions that
  happen to usually agree, which is worse than always disagreeing: it passes casual testing and
  fails in production on specific input combinations.
- **Prefer pinning the equivalence with a test that derives its expected value from the other
  implementation**, not a hardcoded literal. `CartPricingTests` calling
  `OrderPricing.PriceLine` for its expected figure is what makes a future edit to either side's
  rounding impossible to land silently — either it stays in sync, or the test breaks and says
  why.
- **When two implementations of the same figure must agree, the newer/preview one conforms to
  the older/authoritative one, never the reverse** — the authoritative computation (here, the
  order, which actually bills) has already shipped real, historical, billed values; rewriting
  it to match a newer preview would retroactively disagree with its own past behaviour.
- The generalized rule (not cart-specific) lives in
  [[money-representation#Rounding point, not just rounding mode]] — read it before writing any
  second implementation of a money figure this repo already computes elsewhere.

## Related

- [[money-representation]] — "Rounding point, not just rounding mode" section: the
  cross-cutting convention this finding generalized into.
- [[orders-service-design]] — the Cart section documents the fix and cross-references this note.
- [[2026-08-25-cart-endpoints-design]] — the plan/spec whose Task 4 code block carries an
  inline amendment callout pointing here.
- [[money-as-integer-cents]] — the storage-side ADR this finding does not change: both
  implementations always operated on integer cents, correctly: the bug was purely about
  when/how those cents get rounded into tax, not about float/decimal drift.
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] — a sibling finding from
  the same milestone, but the inverse shape: this note is a wrong claim in a plan comment
  (documentation wrong about code), while that note is a spec that was correct from its first
  version and an implementation that silently didn't follow it (code wrong about documentation).
