---
title: "Three Angular Testing Traps That Read as Wiring Bugs"
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
related:
  - "[[2026-09-04-web-gateway-integration-design]]"
  - "[[testing]]"
---

# Three Angular Testing Traps That Read as Wiring Bugs

## Finding

While writing the web app's auth-screen specs (JE-243), three separate `HttpTestingController`
/ Angular test-harness behaviors each produced a failure that looked like a bug in the code
under test — a missing request, a value that should not have persisted — when the actual
defect was in the test harness itself. Each cost real debugging time before the harness, not
the production code, turned out to be at fault.

## Trap 1 — `HttpTestingController.match()` CONSUMES what it returns

`match(url)` does not merely peek at pending requests; it removes them from the controller's
queue. Verified empirically: calling `match()` twice for the same URL returns the request on
the first call and an empty array on the second.

The natural polling idiom is therefore broken: poll with `match()` until a request appears,
then read it with `expectOne()`. That throws `found none` for the very request just located —
the request WAS there, and the probe that located it is what took it out of the queue before
the second call could see it.

**Fix:** have the polling loop return the request it found, rather than locating it with one
API (`match()`) and reading it with another (`expectOne()`).

## Trap 2 — `fixture.whenStable()` does not pump the macrotask queue

`whenStable()` only drains pending microtasks (resolved promises). Anything that settles on a
**macrotask** — a `setTimeout` — is left untouched.

This bites through the encrypted `TokenStore`, whose IndexedDB round trip lands on the
macrotask queue: `fake-indexeddb` uses `setTimeout` internally, measured at 4 turns per write.
A spec that awaits `whenStable()` once and then asserts a follow-up request exists reports
`found none`, because the async chain has not yet reached the point that issues that request.

The symptom is the cruel part: an unfinished async read is indistinguishable from a request
that was never wired in the first place, so it reads as a wiring bug in the code under test
rather than as a timing gap in the test itself.

**Fix:** pump repeatedly across several turns (e.g. loop `await` + a macrotask flush) rather
than awaiting stability once.

## Trap 3 — `fake-indexeddb` keeps ONE database for the whole run

`fake-indexeddb` is not reset between tests within a file — its in-memory database persists
across every `it()` in that spec. A spec asserting "a failed login persists nothing" instead
reads tokens stored by the PREVIOUS test and fails, even though the code under test is
entirely correct.

**Fix:** reset the storage per test (e.g. in `afterEach`/`beforeEach`), not per file.

## Why these belong together

All three share a failure signature: **the test reports a defect in the production code that
does not exist.** That is the expensive kind of false negative — it sends you to read correct
code looking for a bug, and the actual fix is always in the test harness, never in the code
under test. When a freshly written spec claims a request is missing or a value persisted when
it should not have, suspect the harness — `match()`'s consuming semantics, an unpumped
macrotask queue, or shared fake-IndexedDB state — before the code.

## Related

- [[2026-09-04-web-gateway-integration-design]] — the spec whose auth-screen work (JE-243)
  surfaced all three traps while writing the corresponding tests.
- [[testing]] — the three-layer testing convention these traps affect at the unit/integration
  layer: a harness bug at that layer produces a false failure signal before a change ever
  reaches internal or gateway E2E.
