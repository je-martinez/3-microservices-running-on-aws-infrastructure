---
title: "A fake transaction must hold a real lock, or concurrency tests prove nothing"
type: lesson
area: users
status: active
created: 2026-10-06
updated: 2026-10-06
tags:
  - type/lesson
  - area/users
  - status/active
  - severity/medium
related:
  - "[[testing]]"
  - "[[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]"
  - "[[mocks-hide-schema-bugs]]"
---

# A fake transaction must hold a real lock, or concurrency tests prove nothing

When a unit test fakes Prisma's interactive `$transaction` to test code that serialises through `lockUserRow` (`SELECT ... FOR UPDATE`), the fake `$queryRaw` must acquire a **real per-user async mutex** that is held until the transaction callback finishes. A fake that only records call order passes even with the lock deleted.

## Symptom

Removing the lock leaves the suite green. The concurrency requirement is untested while appearing covered.

## Evidence

`services/users/tests/payment-methods/attach-payment-method.command.test.ts` (2026-10-06, the first active card becomes the default). Mutation check: commenting out `lockUserRow` failed 2 tests, the ordering test and the concurrent first-card attaches (exactly one default and exactly one Stripe `customers.update`).

This is the case [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] calls the highest-risk one: ordinary tests do not exercise concurrency. The mutex-backed fake closes that for the unit layer only. It is **not** a substitute for a real-Postgres test, and none exists yet for payment methods (see [[mocks-hide-schema-bugs]]).

## Related

- [[testing]]
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]
- [[mocks-hide-schema-bugs]]
