---
title: "Reads are not exempt from observability, and an unchecked precedent carried a false claim through implementation"
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
  - "[[orders-service-design]]"
  - "[[logging-context]]"
  - "[[2026-08-25-cart-endpoints-design]]"
  - "[[2026-08-25-route-works-in-process-but-404s-at-gateway]]"
---

# Reads are not exempt from observability, and an unchecked precedent carried a false claim through implementation

## Finding

`PUT /v1/cart` shipped with full flow logs (`update_cart_started`/`_succeeded`/`_failed`) and a
workflow span, per the milestone's own spec and plan. `GET /v1/cart` and `DELETE /v1/cart`
shipped with **neither** — no span, no log line, no tracer call anywhere in `CartReadService`.

This was caught by the **user**, after the branch was pushed, asking a plain question: "did you
add logs to the cart endpoints, like the other endpoints?" Not a test failure — a question. No
automated check flagged the absence, because there is nothing to assert against when a code
path simply never calls a logger or a tracer.

## Root cause — a stated precedent that was never verified

The implementation plan justified skipping `GET`'s observability with: *"the `GET` carries no
flow logs (it is a read, like `my-orders`)."* That claim was **false on its own terms**:
`OrderReadService.GetMyOrdersAsync` (the very `my-orders` endpoint cited as precedent) already
wraps itself in a `list_my_orders` workflow span and emits a `list_my_orders_succeeded` line
carrying `order_count`.

The person who wrote the plan asserted a precedent without opening the file it named. The
plan's confident, settled-fact phrasing then carried that error through every subsequent step
unchallenged — implementation, and every per-task review — because nobody re-derived the claim;
it read as already-checked.

## Why this evaded every layer that should have caught it

- **No test can catch a missing log line or a missing span.** There is no assertion to write
  against an absence of instrumentation — the code runs, returns the right JSON, and every
  functional test (233/233, six gateway scenarios) passes cleanly regardless of whether a
  logger was ever called.
- **The plan's own claim looked like verification.** "like `my-orders`" reads as a citation, not
  an assumption — it has the grammatical shape of a fact someone checked, which is precisely
  what stopped anyone from checking it again.
- **Per-task review checks the diff against the plan, not the plan against the codebase.** A
  reviewer confirming "does this match what the plan says" will not catch a plan that is
  internally wrong about an existing file.

## The fix — the read/write log-shape distinction

Reads and writes are instrumented differently, and the difference is deliberate, not an
oversight the fix should erase:

- **Reads** (`list_my_orders`, `read_cart`) get a span plus **one** `_succeeded` line carrying
  a count (`order_count`, `item_count`) — no `_started` twin, no `_failed` branch. There is no
  intermediate step where `_started` could be the last line seen before a failure, and the
  method names no failure of its own: a DB fault throws out of the tracer's workflow wrapper,
  which already records it on the span. Inventing a `_started`/`_failed` pair for a branch the
  code does not have would be manufacturing signal that does not exist.
- **Writes** (`create_order`, `update_cart`, `delete_cart`) keep the full
  `_started`/`_succeeded`/`_failed` triad plus `reason` on failures, because they have real
  intermediate steps.
- **`DELETE /v1/cart` needed the full write triad despite being four lines of code.** Its
  brevity made it look too simple to instrument, but log lines are exactly what lets a support
  request ("where did my cart go?") distinguish a user-requested delete from the cart being
  silently consumed by an order. Small code is not low-stakes code when it destroys user data.
- **Instrument the entry point, not a shared helper.** `CartReadService.BuildAsync` is called
  by the WRITE path too (to render its own response after a `PUT`), so wrapping `BuildAsync`
  itself would emit a spurious nested read span inside every `update_cart`. The span belongs on
  the actual entry point, `GetMyCartAsync`.

Full read/write log-shape rule, in context: `services/orders/CLAUDE.md` §4, "Logging & tracing
in this service." New-route checklist this incident fed into the root `CLAUDE.md`'s testing
section (`docs/shared/conventions/testing.md` → [[testing]]).

## How to apply

- **"It's only a read" is not a reason to instrument nothing.** The shape is lighter than a
  write's, not absent.
- **A plan citing a precedent ("same as X", "like X") must have opened X.** Confident,
  settled-tone phrasing in a plan is not evidence the claim was checked — if anything its
  confidence is what suppresses the re-check a reviewer would otherwise do. When reviewing a
  plan or a diff that cites an existing pattern, open the cited file before accepting the claim.
- **A small/trivial-looking write path (few lines, simple logic) still needs full observability
  if it destroys or mutates user-owned data** — code size is not a proxy for support-need.
- **No test defends against missing observability.** The only real defence is a written,
  specific convention a reviewer can check the diff against (line-by-line: "does this new
  endpoint have a span? a `_succeeded` line? the right shape for read vs. write?") — see
  `services/orders/CLAUDE.md` §4 for the version this incident produced.
- When instrumenting a read/write pair that share a rendering helper, **instrument each entry
  point separately** — a shared helper wrapped in a span double-counts on every call path that
  reuses it.

## Related

- [[orders-service-design]] — the Cart section this observability gap concerned.
- [[logging-context]] — the shared cross-service logging convention this incident's read/write
  shape distinction sits underneath.
- [[2026-08-25-cart-endpoints-design]] — the milestone whose plan carried the unchecked claim.
- [[2026-08-25-route-works-in-process-but-404s-at-gateway]] — a sibling finding from the same
  milestone: another case where full functional test coverage passed while a real gap (there,
  gateway wiring; here, observability) went undetected, both now folded into the root
  `CLAUDE.md`'s "a new route is not done when the service serves it" checklist.
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] — the closest sibling in
  shape: also a claim in the design spec that turned out false, but there the spec's own words
  were wrong ("GET carries no flow logs... like my-orders", an unchecked precedent); here the
  spec's Concurrency section was correct and the implementation silently didn't follow it.
