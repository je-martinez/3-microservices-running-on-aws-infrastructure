---
title: "PUT /v1/cart takes five seconds"
type: lesson
area: orders
status: active
created: 2026-09-08
updated: 2026-09-08
tags:
  - type/lesson
  - area/orders
  - status/active
  - severity/medium
related:
  - "[[testing]]"
  - "[[local-dev]]"
  - "[[2026-08-29-the-emulator-was-the-ceiling-not-the-code]]"
---

# PUT /v1/cart takes five seconds

This is an **open question**, not a solved one. Do not read a root cause into it — none has
been found yet, and this note exists so the next person does not have to re-measure before
picking it up.

## What is known and measured

- `PUT /v1/cart` takes roughly 5 seconds against the local Floci stack. Measured three times:
  4.96s / 4.98s / 4.97s.
- That tightness is the whole point: a spread that consistent across three independent runs
  points at a **fixed timeout or a fixed-backoff retry** somewhere inside Orders, not at
  variable real work. Genuine work varies run to run; this does not.
- The service was **not** investigated or changed. The E2E suite raised its timeout instead
  and recorded the measurement:

  ```ts
  // e2e/support/web-session.ts
  export const CART_WRITE_TIMEOUT_MS = 20_000;
  ```

- **The constant is headroom around an unexplained cost, never an accepted latency.** Nobody
  should design to 5 seconds, or treat this measurement as the endpoint's real budget.

## A second symptom from the same slowness

The "an unknown order id renders the not-found state" spec in
`e2e/tests/web/navigation.spec.ts` passed in isolation and failed in **both** timezone
projects under a full parallel run. `GET /v1/orders/{id}` rides the same gateway path, so
Playwright's default 5s `expect` timeout sat right on top of the actual response time.

The failure presented as a missing empty state — the page snapshot showed only the header —
which sends a reader straight into `order-detail.ts` looking for a rendering bug, rather than
at the clock. It is not a rendering bug.

## Open question for whoever picks this up

Where does the ~5s go? Candidates, none diagnosed:

- A timeout or retry inside Orders itself.
- The gRPC call from Orders to Users.
- The Floci emulator's API Gateway hop.
- The MySQL proxy.

## Related

- [[testing]] — E2E timeout conventions this constant lives under
- [[local-dev]] — the local Floci stack this was measured against
- [[2026-08-29-the-emulator-was-the-ceiling-not-the-code]] — a prior case where local-emulator
  overhead, not application code, was the actual bottleneck; worth ruling in or out first
