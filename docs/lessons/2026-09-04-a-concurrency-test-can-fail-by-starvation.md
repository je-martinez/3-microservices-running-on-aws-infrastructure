---
title: "A concurrency non-overlap test can fail by starvation if it asserts after flushing, not inside the loop"
type: lesson
area: shared
status: active
created: 2026-09-04
updated: 2026-09-04
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
  - issue/JE-245
related:
  - "[[2026-09-04-web-gateway-integration-design]]"
  - "[[testing]]"
  - "[[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]"
  - "[[web-gateway-integration-milestone]]"
---

# A concurrency non-overlap test can fail by starvation if it asserts after flushing, not inside the loop

## Finding

A test asserting that queued cart mutations never overlap (serialized `PUT`s, per
[[2026-09-04-web-gateway-integration-design]]) must place its non-overlap assertion **inside
the loop that drives the concurrent writes, before flushing them** — not after the loop, once
everything has already settled.

Checking "how many requests are currently in flight" only at the very end lets all N parallel
writes land in the first round: nothing is ever in flight at the moment the assertion runs,
so the check passes vacuously — not because serialization worked, but because the test never
observed a moment where overlap could have been caught. The test doesn't report this as a
false pass, either: it goes red anyway, but for the wrong reason. It dies several rounds later
with something like "no request within 25 turns" — a failure message that accuses the test
harness (a stuck scheduler, an exhausted retry budget) rather than naming the actual race the
test was written to catch.

Moving the same assertion **in-loop** — checked on every round, before the next flush — changes
the failure to "expected length of 1 but got 4" on the very first mutation. That message names
the real defect directly: four writes were in flight simultaneously when only one should have
been.

## Why the after-the-loop version starves rather than catches

The mechanism is starvation, not merely a misplaced check: with the assertion deferred to the
end, the concurrent writes race ahead of the observation point. If the implementation under
test is genuinely broken (no serialization), all N requests fire in round one and complete
before the test ever samples "requests in flight" — the unserialized behavior is invisible
because nothing was watching during the only window it was observable in. The test then keeps
waiting for a *different* signal (a turn count, a settle event) that a broken implementation
happens to never produce in the shape expected, and the eventual failure reads as a harness
problem.

## Generalization

This applies to any assertion of the shape "at most K units of work overlap" or "these events
never interleave" — not just this cart mutation queue. The check has to run at the point in
time where overlap would be visible if it existed, which for a queue-draining loop is **inside
the loop, before the next flush** — never only once, after everything has already drained.

Relates to [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]], which already
records concurrency requirements as the class ordinary tests structurally miss: that lesson was
about a concurrency guard being specified and never implemented at all; this one is about a
concurrency guard that WAS implemented, with a test that could still fail to catch a regression
in it because of where the assertion was placed relative to the race it was meant to observe.

## Related

- [[2026-09-04-web-gateway-integration-design]] — the cart mutation-serialization design this
  test verifies.
- [[testing]] — three-layer testing convention; this is a unit-test-level discipline within
  layer 1.
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] — the sibling lesson on
  concurrency requirements being the highest-risk case for ordinary tests to miss.
- [[web-gateway-integration-milestone]] — the milestone this lesson was found during.
