---
title: "A global teardown cannot be scoped"
type: lesson
area: tracking
status: active
created: 2026-08-30
updated: 2026-08-30
tags:
  - type/lesson
  - area/tracking
  - status/active
  - severity/high
related:
  - "[[2026-08-29-the-emulator-was-the-ceiling-not-the-code]]"
  - "[[testing]]"
  - "[[tracking-service-design]]"
  - "[[floci-sqs-lambda-docdb-support]]"
---

# A global teardown cannot be scoped

## Presenting symptom

`gateway/tracking-flow.spec.ts` failed only inside the full suite — alone it passed 3/3. The
error said a `delivered` email never arrived for a tracking that had demonstrably **reached**
`delivered`. Everything downstream measured clean: SQS depth 0, DLQ 0, the events-pipeline
processed 254 events with zero failures and zero duplicate-event errors, and the counts did not
change minutes later. So the events were not late and not lost in transit — **they were never
published**.

> [!important] Why this note exists
> "Never published" and "lost in transit" look identical from the consumer's side and have
> opposite fixes. Three separate investigations (queue, mappings, publisher) each measured
> clean and each correctly concluded "not me" — and none of that located the bug, because the
> bug was upstream of all three.

## Root cause

`DELETE /v1/trackings/e2e-cleanup` soft-deletes **every** row carrying the "E2E Source" tag,
globally, with no scoping by run, worker, or user. When it fires while a TestMode progression is
still ticking, the progression's next tick reads `tracking_not_found`
(`internal/app/progression.go:282`), **aborts**, and every remaining status goes unpublished.
With `workers: 10` and overlapping runs, one run's teardown lands inside another's live 20s
progression.

### Proof — a single-variable harness

| Scenario | Result |
|---|---|
| 4 concurrent TestMode trackings, no cleanup | 16/16 published |
| Same 4, one cleanup at t=+12s | 8/16 |
| Same 4, one cleanup at t=+17s | **12/16, only DELIVERED missing** — the reported symptom, exactly |

## Transferable lessons

1. **"Never published" and "lost in transit" look identical from the consumer's side, and have
   opposite fixes.** Everything downstream being clean is evidence about the *producer*, not
   exoneration of the pipeline. A clean queue and a clean pipeline both being true at once does
   not mean nothing is wrong — it means the fault is upstream of where you're measuring.

2. **A destructive fixture sweep is a concurrency hazard, not just housekeeping.** The teardown
   was written when the suite ran one run at a time; `workers: 10` and overlapping runs turned a
   correct-looking global delete into a cross-run killer. Nothing about the cleanup changed —
   the concurrency around it did. A shared destructive fixture's safety is a property of its
   *calling context*, not just its own logic, and that context can change without the fixture's
   code changing at all.

3. **Scoping the fix at the wrong layer makes things worse, and measurement caught it.** The
   obvious fix — scope the cleanup by run id — was implemented, tested, and made the suite
   *worse*: 1–2 failures became 7 and 9 across paired runs. Reason: the final global sweep is the
   only thing that clears the table between runs, so narrowing it leaves every earlier run's rows
   alive to accumulate (one run soft-deleted 20 trackings against 25 orders once the sweep
   finally caught up). A scoped delete belongs to a per-spec or per-worker cleanup, never to the
   one sweep whose job is to leave the database empty. The service-side `?run_id=` capability was
   kept and tested for that future use; the teardown flag that would scope the global sweep
   stays off.

4. **Chronology beats correlation for exoneration.** A suspected cause (four SQS event-source
   mappings, added an hour earlier) was cleared not by argument but by timestamps: the extra
   poller containers were materialized at 19:38–19:39 UTC while the last lost message was at
   19:21. Related finding worth recording on its own: **Floci registers an event-source mapping
   in the API immediately but materializes its poller container lazily**, so
   `list-event-source-mappings` returning 4 does not mean 4 pollers are running yet — see
   [[floci-sqs-lambda-docdb-support]] for the same emulator's other verified SQS/Lambda quirks.

5. **Run-to-run variance can exceed the effect you are measuring.** Whole-suite failures ranged
   4–15 across runs of the *same* commit, so no single before/after run can validate a change
   here. Paired or repeated runs, or a direct measurement (drain rate, publish count), are the
   only honest acceptance criteria — see [[2026-08-29-the-emulator-was-the-ceiling-not-the-code]]
   for the same principle applied to a different local-stack timing ceiling.

## Also found, still open

A second, independent bug the audit surfaced: `tracking-flow.spec.ts:176` asserts
`status === "PLACED"` on the first read, which races the progression once its interval is short
(0/5 in the gateway project, 3/3 alone). Exposed by lowering `PROGRESSION_INTERVAL_SECONDS`, not
caused by the cleanup bug above. Not yet fixed.

## Related

- [[2026-08-29-the-emulator-was-the-ceiling-not-the-code]] — the previous lesson in this same
  investigation; same "failure only under full-suite load" shape, different mechanism (a fixed
  emulator throughput ceiling rather than a cross-run teardown race).
- [[testing]] — the three-layer testing convention this suite sits under; none of the three
  layers alone was built to catch a cross-run fixture race, only a full-suite run with enough
  workers exposed it.
- [[tracking-service-design]] — TestMode progression behaviour (`internal/app/progression.go`)
  and the E2E cleanup endpoint this bug lives in.
- [[floci-sqs-lambda-docdb-support]] — the emulator's verified SQS/Lambda quirks, including the
  lazy poller-container materialization used to exonerate the event-source-mapping suspect here.
