---
title: "A live-push cascade invalidates any exact UI assertion"
type: lesson
area: shared
status: active
created: 2026-09-15
updated: 2026-09-15
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
related:
  - "[[2026-09-10-in-app-notifications-design]]"
  - "[[count-only-assertions-hide-cause]]"
  - "[[testing]]"
---

# A live-push cascade invalidates any exact UI assertion

## What happened

While writing the web E2E for the notification surface, the plan called for placing a
**TestMode** order to exercise the flow. TestMode drives Tracking's status progression
automatically, which pushes several more notifications over the WebSocket in the following
tens of seconds. A filter-pill test asserting the Unread tab was empty after marking two rows
read then failed, because legitimate later arrivals (further tracking-status pushes) landed
under Unread in between. The assertion had been correct at the moment it was written and wrong
a moment later — not because anything was broken, but because the fixture kept producing new,
real events for the rest of the test's run.

A related instance, same root cause: the plan also called for asserting that a
newly-registered user's inbox is empty. Registration publishes `USER_CREATED`, and the WELCOME
row lands in roughly two seconds — so that assertion passes or fails on consumer latency, not
on behaviour.

## The rule, in two parts

**1. In a UI spec with live push, assert the ABSENCE OF SPECIFIC ROWS, never the emptiness of a
set.** "Unread should be empty" races every arrival between the check and the moment it
resolves; "Unread must not contain the two rows we just marked read" does not, because any row
arriving over the socket mid-test lands there legitimately without falsifying it. This is the
same reasoning as [[count-only-assertions-hide-cause]] applied to the *shape* of the assertion
rather than to its failure message: a count (or an emptiness check, which is just a count of
zero) collapses information a set-membership check preserves. The two notes reference each
other for that reason. The fix in this codebase is recorded directly at the call site —
`e2e/tests/web/notifications.spec.ts`'s filter-pill test carries the comment: *"Assert their
ABSENCE, never that Unread is empty. Any row arriving over the socket mid-test lands here
legitimately, so an emptiness check races every later arrival"* — and asserts
`.not.toEqual(expect.arrayContaining([...]))` against the two specific rows just marked read,
rather than checking the list length.

**2. Choose the quietest fixture that still exercises the path.** The "Order placed" toast
comes from `ORDER_CREATED`, which a plain order raises just as reliably as a TestMode one, but
without the four-step cascade that keeps pushing rows for ~40 seconds afterward. The spec's
`placeOrder` helper deliberately sends **no** `x-test-mode` header, and its own comment records
why: *"No `x-test-mode`. Its four-step cascade keeps pushing rows for ~40s, so every exact
assertion on the badge, the dots or the showing toast would be racing an arrival."* Prefer the
fixture that produces exactly the event under test and nothing else, over one that happens to
also exercise it as a side effect.

## The registration/WELCOME instance

Both `e2e/tests/web/notifications.spec.ts` and `e2e/tests/notifications.spec.ts` carry the same
prohibition at their registration helpers: do not assert a fresh user's inbox is empty, because
`USER_CREATED` is published in-process and the WELCOME row lands within roughly two seconds —
so "a new user has no notifications" is a race on consumer latency, not a behaviour. Both were
replaced by a helper (`registerUserWithWelcome` / the equivalent in the web spec) that **waits
for** the WELCOME row and returns it, then builds subsequent assertions on top of a known,
settled state instead of an assumed absence.

## How to apply

- Before writing an assertion against a UI or API surface fed by live push, ask: can anything
  else legitimately arrive on this channel between now and when the assertion resolves? If yes,
  an emptiness or exact-count check on that surface is racing the system, not testing it.
- Replace "is empty" / "has exactly N" with "does not contain X" / "contains at least X" against
  the specific items the test caused, and wait for expected arrivals explicitly rather than
  assuming their absence.
- When a fixture can trigger more than the one event under test (TestMode's cascade, a webhook
  chain), prefer the narrower fixture that raises only the event being tested, and record why in
  a `CONTRACT:` comment on the helper — see [[code-comments]].

## Related

- [[2026-09-10-in-app-notifications-design]] — the milestone whose gateway and web E2E specs
  produced both instances of this finding.
- [[count-only-assertions-hide-cause]] — the sibling rule this lesson is an instance of: a
  count-shaped (or emptiness-shaped) assertion collapses information that a set/membership
  check preserves, whether the failure is being read for cause or the assertion is racing a
  live system.
- [[testing]] — the three-layer testing convention these specs implement; the gateway and web
  layers are exactly where a live-push race like this surfaces, since unit tests fake the
  channel and never race it.
