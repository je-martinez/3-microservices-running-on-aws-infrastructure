---
title: "Count-only assertions hide cause — assert or log WHAT arrived, not just how many"
type: convention
area: shared
status: active
created: 2026-09-13
updated: 2026-09-15
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[testing]]"
  - "[[2026-08-05-realtime-tracking-events-websocket-design]]"
  - "[[2026-09-10-in-app-notifications-design]]"
  - "[[2026-09-11-plans-locate-tests-by-name-not-by-importer]]"
  - "[[floci-websocket-apigw-dynamodb-support]]"
  - "[[code-comments]]"
  - "[[2026-09-15-a-live-push-cascade-invalidates-exact-ui-assertions]]"
---

# Count-only assertions hide cause — assert or log WHAT arrived, not just how many

## Rule

**An assertion that checks only a count cannot distinguish a genuinely broken system from a
merely wrong expectation.** `expected 5, got 4` is consistent with two unrelated failure modes —
the system under test silently dropped one of five legitimate items, or the test's own
expectation was wrong about how many there should be — and the failure message cannot tell you
which. The reader learns that *something* is off, not *what*, and the natural next step
(re-running with more logging, or attaching a debugger) spends a full debugging cycle on
information the assertion could have surfaced for free.

**Assertions on "N things happened" must assert or log WHAT arrived, not only how many.** Print
the actual set/list on failure — the shape, ids, statuses, or types of every item collected — so
a wrong count is diagnosable from the first failure, not the second run.

This generalizes past countable collections: any assertion of the form "did the right thing(s)
happen" should surface the observed shape, not collapse it to a scalar, before it is trusted as
a pass/fail gate.

## Origin (2026-08-05, realtime tracking)

First identified during the WebSocket realtime-tracking design
([[2026-08-05-realtime-tracking-events-websocket-design]]). While a five-transition assertion
was still in the spec, the gateway E2E test failed with only `expected 5 messages, got 4` — a
result indistinguishable between the fan-out silently dropping one of five legitimate pushes (a
real bug in the events-pipeline's WebSocket publisher) and the expectation itself being wrong
(the spec's own five-transition count, which included `PLACED` — a status tracking never emits
as a transition). The count alone could not tell which.

The collector was changed to report **which** messages arrived, not just how many, and the
failure immediately became legible: the set showed `PLACED` present where it never should be,
which is what led to finding the assertion — not the system — was wrong. With the assertion
corrected to the four real transitions, all three realtime gateway E2E tests passed. Full
narrative and the resolved gap: [[2026-08-05-realtime-tracking-events-websocket-design#Debugging lesson — a count-only assertion hides which system is wrong]] and
[[floci-websocket-apigw-dynamodb-support]].

## Applied consistently since

`e2e/support/ws-client.ts` is the shared WebSocket collector built out of that debugging session,
and it embeds the rule directly: its `waitForCount` timeout reports the full collected message
list, not a bare number, in the error it throws.

## Reinforced on 2026-09-12/13 — in-app notifications gateway E2E

The in-app-notifications gateway E2E (`e2e/tests/gateway/notifications.spec.ts`, per
[[2026-09-10-in-app-notifications-design]]) asserts five `NOTIFICATION_CREATED` frames over one
order lifecycle. The agent writing it deliberately mutated one expectation to verify the test
could fail (see [Verify a test can fail](#related-practice--verify-a-test-can-fail) below), and
the resulting failure read:

```
timed out after 150000ms waiting for 6 NOTIFICATION_CREATED frames; got 5.
Everything that arrived: [...]
```

— followed by all five notification frames (title, status, `unread_count`) plus the four
`TRACKING_STATUS_CHANGED` frames sharing the same socket. A reader sees instantly that the system
delivered exactly what it should and the expectation (six) was wrong. Contrast the count-only
version of the same failure: `expected 6, got 5` — which sends you debugging a healthy system.

## The sharper instance — a count-based WAIT can be actively wrong, not merely unhelpful

The same socket in that work carries **two** message types: `NOTIFICATION_CREATED` (this design)
and `TRACKING_STATUS_CHANGED` (the earlier realtime-tracking work). The plan's suggested test
helper waited on a frame **count**. Because a count-based wait resolves as soon as *any* N frames
have arrived regardless of type, it would resolve on a **mixture** of the two message types and
then assert the wrong set against it — five frames total might be four `TRACKING_STATUS_CHANGED`
plus one `NOTIFICATION_CREATED`, satisfying "count == 5" while containing almost none of what the
assertion actually meant to check.

This is the strongest form of the argument: on a socket carrying more than one message shape, a
count-only wait is not merely uninformative on failure — it can pass on the **wrong data**,
because counting conflates message types that a shape (type) check would keep separate. The fix
was a type-filtered wait (`waitForNotificationFrames` in the gateway spec), which counts only
`NOTIFICATION_CREATED` frames and, on timeout, prints a one-line-per-frame digest of everything
that arrived across both types.

## Related practice — verify a test can fail

The same work demonstrated a companion discipline worth stating alongside this rule: **before
trusting an assertion, verify it can fail.** Mutate one expectation per layer (e.g. bump the
expected count by one) and read the failure output — this is what proves both that the
assertion is actually wired up (not vacuously true) and that its diagnostics are useful when it
does fail. A test that has never failed has demonstrated neither. This is how the
`expected 6, got 5` / full-frame-list contrast above was produced and confirmed, rather than
assumed.

## How to apply

- Any helper that waits for or asserts "N events/messages/rows happened" must include the
  observed set (or a compact digest of it — ids, types, statuses) in its failure message, not
  only the count.
- On a channel/socket/queue carrying more than one item shape, a wait condition must filter by
  shape (type) before comparing counts — a bare count risks resolving on the wrong mixture, not
  just reporting it poorly.
- When writing a new assertion of this shape, deliberately break one expectation and read the
  failure once before considering the test finished — see
  [Related practice — verify a test can fail](#related-practice--verify-a-test-can-fail).

## Related

- [[testing]] — the three-layer testing convention this rule is a cross-cutting requirement
  under; its gateway-E2E sections for realtime tracking and in-app notifications both cite this
  note.
- [[2026-08-05-realtime-tracking-events-websocket-design]] — the original narrative this rule was
  extracted from (see its "Debugging lesson" section for full detail).
- [[floci-websocket-apigw-dynamodb-support]] — the lesson recording the resolved gap this
  debugging session produced.
- [[2026-09-10-in-app-notifications-design]] — the design whose gateway E2E reinforced this rule
  and produced the type-filtered-wait instance.
- [[2026-09-11-plans-locate-tests-by-name-not-by-importer]] — a sibling finding from the same
  milestone about a different class of test-authoring gap (locating suites by importer, not
  filename).
- [[code-comments]] — the tagged-comment convention `e2e/support/ws-client.ts` follows when
  pointing at this note from its `CONTRACT:` block.
- [[2026-09-15-a-live-push-cascade-invalidates-exact-ui-assertions]] — the same rule applied to
  the *shape* of an assertion rather than its failure message: an emptiness/exact-count check on
  a live-push surface can be actively wrong (racing a legitimate later arrival), not merely
  unhelpful on failure.
