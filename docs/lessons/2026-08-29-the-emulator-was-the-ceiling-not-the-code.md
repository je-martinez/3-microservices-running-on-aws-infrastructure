---
title: "The emulator was the ceiling, not the code"
type: lesson
area: events-pipeline
status: active
created: 2026-08-29
updated: 2026-08-29
tags:
  - type/lesson
  - area/events-pipeline
  - status/active
  - severity/high
related:
  - "[[events-pipeline-design]]"
  - "[[floci-sqs-lambda-docdb-support]]"
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[testing]]"
  - "[[logging-context]]"
  - "[[tightened-schemas-need-producer-first-deploys]]"
  - "[[2026-08-27-a-producer-side-test-proves-nothing-about-what-the-consumer-accepts]]"
---

# The emulator was the ceiling, not the code

## Presenting symptom

11 of 181 E2E specs failed, **all** of them "No … email appeared in Mailpit." Zero timeouts
elsewhere, zero assertion failures elsewhere. The same five spec files, run alone, passed
**30/30 in 45s**. That gap — fails only inside the full suite — is the whole story in miniature,
and it took seven wrong turns to get there.

> [!important] Why this note exists
> The value here is almost entirely in the false trails, not the fix. Each one was plausible,
> each one was investigated with a real measurement against the live stack, and each one was
> wrong. A coincidence that fits is not evidence — see Trail 5.

## The false trails, in order

### Trail 1 — "The Mailpit client reads inefficiently"

The initial framing, on both sides. **Disproven:** the client already polls at 1s intervals up
to a 60s budget, searches by exact recipient, and correctly `encodeURIComponent`s the `+` in
plus-addressed test emails. A solo probe — one registration, nothing else running — got its
email in **2 seconds**. The client was never the bottleneck; it was reading a system that hadn't
produced the message yet.

### Trail 2 — "Lambda containers recycle mid-run"

Real behavior — Floci-emulated Lambda containers do recycle and take their logs with them — but
it explained nothing about *load-dependence*. A container recycling doesn't care whether 1 spec
or 181 are running. Correct observation, wrong causal thread.

### Trail 3 — "Plain concurrency"

Hypothesis: Playwright's 6 parallel workers racing each other. **Disproven:** six simultaneous
registrations, matching the worker count exactly, delivered **6 of 6 emails**. Concurrency itself
was not the problem.

### Trail 4 — "The specific failing flow is broken"

Hypothesis: something about register → `otp/start` specifically. **Disproven:** reproduced that
exact flow by hand, in isolation. **Both** emails arrived.

### Trail 5 — "Mailpit is evicting messages" (the most instructive wrong answer)

`/api/v1/info` reported `SMTPAccepted: 511`, `Messages: 500`, `MessagesDeleted: 11`. **Eleven
evicted, eleven failing specs.** That match was called the root cause on the strength of the
coincidence alone.

> [!warning] A matching count is not a causal chain
> Raising `MP_MAX_MESSAGES` to 5000 and purging the inbox in global-setup left Mailpit
> demonstrably healthy for the whole run — and **the same specs still failed**. The inbox really
> was capped too low. It was also not why the specs failed. Both things were true at once, which
> is exactly what makes a matching-count coincidence dangerous: it doesn't announce itself as a
> red herring, it announces itself as confirmation.

### Trail 6 — "92% of events are lost in the pipeline"

A grep artifact, self-inflicted: counting `"type":"…"` occurrences in logs, which repeat several
times per event across a multi-line log record, then comparing that count against events pulled
from a *different* container. Corrected, honest count: **350 started, 350 succeeded, 0 failed**.
Nothing was ever lost. See the transferable rule below — a count computed wrong is worse than a
count that's merely uninterpreted.

### Trail 7 — "The 256MB Lambda is CPU-starved rendering React email templates"

The most plausible false trail of the session, because it isn't invented — the events-pipeline
service's own docs describe exactly this tradeoff for production. **Disproven locally:** raising
the function's memory 256MB → 1024MB (which in real Lambda scales CPU proportionally) moved p50
latency only 2161ms → 1844ms — nowhere near enough to explain an 11x latency blowup.
**Floci does not emulate Lambda's memory-to-CPU scaling behavior**, so that documented
characteristic describes production, not the local emulator it was being diagnosed against. Real
guidance, wrong environment.

## The actual cause, and the measurement that found it

Not a log-volume count — an **inter-event timing** measurement: the gaps between consecutive
`event_processing_started` lines. The pattern: **0.00s × 9, then 11.01s, then 0.00s × 9**, on
repeat.

Floci delivers one SQS batch per ~10s poll and runs **at most 2 function containers** regardless
of configured concurrency (see [[floci-sqs-lambda-docdb-support]] for the same emulator's
verified SQS/Lambda behavior on other axes). The resulting ceiling is
`batch_size / poll_interval ≈ 1 event/s`.

A full E2E suite publishes far faster than that — 808 events from registrations alone against 494
consumed in the same window — so the backlog grows monotonically for the whole run. An event
published mid-suite can land ~86s behind ~72 others already queued, well past the 45s budget every
email-asserting spec allows.

**The emails were never lost, and were never evicted. They arrived late** — later than any
individual spec's patience, but not later than the suite's total runtime.

## What was changed, and what it did and did not buy

The handler's per-record loop went from serial `for … await` to `Promise.allSettled` over the
batch. Deliberately `allSettled`, never `all`: `Promise.all` rejects on the first failure and
abandons in-flight siblings, which loses their `batchItemFailures` entries and silently
misreports records that genuinely needed SQS redelivery.

Four safety properties were checked before trusting concurrent record processing, not assumed:

- Standard (non-FIFO) queue — no per-record ordering contract to preserve.
- `runWithLogContext` already scopes AsyncLocalStorage per record, so concurrent records don't
  bleed trace/log context into each other (see [[logging-context]]).
- The shared MongoClient (pool size 100) and SES client are both built for concurrent use.
- The unique index on `event_id` makes record processing idempotent, so a partial-batch retry
  after concurrent partial failure is safe.

**Result:** records verifiably start together; mid-suite email latency dropped from **>90s to
69.7s**; failing specs dropped from **12 to 9**. It did **not** get under the 45s budget, because
the binding constraint is the emulator's fixed poll cadence and container ceiling, not the
handler's internal concurrency.

### Measured knob sweep (all with the concurrent handler)

| Setting | Throughput |
|---|---|
| `batch_size=10` (existing default) | 0.86–1.00 ev/s (~52/min) — the optimum |
| `batch_size=20` | 0.11 ev/s (~7/min) |
| `batch_size=50` | did not drain 100 events in 10 minutes |
| `ScalingConfig.MaximumConcurrency=10` | persists in the API; still peaks at **2 containers** |

Bigger batches make throughput dramatically *worse*, not better, because Floci does not overlap
invocations — one long-running batch blocks the next poll entirely. Both rejected knobs
(`batch_size=20/50`, raised `MaximumConcurrency`) were reverted so the live event source mapping
matches what Terraform declares.

## Transferable rules

- **A coincidence that fits is not evidence.** Eleven evicted Mailpit messages against eleven
  failing specs was the most convincing wrong answer of the session, and the only way to find out
  was to remove the suspicious condition and watch the symptom survive it.
- **Verify the fix removes the symptom, not just the suspicious condition.** The Mailpit inbox
  was genuinely unhealthy *and* genuinely not the cause — both were true, which is why the naive
  check ("is the inbox healthy now?") would have reported false success.
- **A measured negative is a finding.** "I cannot reproduce this outside the full suite" is what
  finally pointed at load rather than at the flow — that single fact ruled out Trails 1, 2, and 4
  at once.
- **Check whether a documented characteristic applies to the environment you're diagnosing.**
  The 256MB/render-cost note was true. For production. Applying a real, written-down fact to the
  wrong environment produced Trail 7.
- **Grep counts are not domain counts.** Multi-line-per-event log records make naive `grep -c`
  comparisons meaningless, especially across different containers.
- **Prefer end-to-end drain timing over per-minute log buckets** when measuring pipeline
  throughput. The bucketed view hid the 10s poll cadence; the raw inter-record gaps exposed it on
  the first look.

## Standing guidance

Do **not** widen the specs' 45s email-arrival budget to make these nine specs green. That budget
is the only assertion in the suite that the pipeline is timely, and in production the function
scales out per batch in a way the now-concurrent handler assumes — loosening the local budget
would hide a real regression instead of accommodating a known local ceiling. Running the
email-asserting specs in their own isolated run (30/30 passing) remains the honest local
workaround until/unless the emulator's batching behavior changes; see [[testing]] for the
three-layer testing convention this suite sits under, and [[floci-vs-ministack-spike-findings]]
for the broader pattern of emulator throughput ceilings not present in real AWS.

## Related

- [[events-pipeline-design]]
- [[floci-sqs-lambda-docdb-support]]
- [[floci-vs-ministack-spike-findings]]
- [[testing]]
- [[logging-context]]
- [[tightened-schemas-need-producer-first-deploys]]
- [[2026-08-27-a-producer-side-test-proves-nothing-about-what-the-consumer-accepts]]
