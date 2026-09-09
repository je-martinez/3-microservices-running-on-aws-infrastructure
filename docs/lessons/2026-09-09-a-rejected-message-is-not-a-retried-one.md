---
title: "A rejected message is not a retried one"
type: lesson
area: events-pipeline
status: active
created: 2026-09-09
updated: 2026-09-09
tags:
  - type/lesson
  - area/events-pipeline
  - status/active
  - severity/critical
related:
  - "[[events-pipeline-design]]"
  - "[[logging-context]]"
  - "[[2026-08-29-the-emulator-was-the-ceiling-not-the-code]]"
---

# A rejected message is not a retried one

## Finding

A dead-letter queue only catches what the consumer **keeps failing at**. It does not catch what
the consumer **successfully refuses**. Returning "I will not process this" and returning "this
worked" are the same signal to SQS — both delete the message. So the safety net everyone assumes
is there covers only half the failure space, and the uncovered half is invisible precisely
because nothing accumulates anywhere to look at.

This is bigger than this repo: it applies to any queue consumer that reports success/failure by
whether it hands a message back to the broker for retry (SQS `batchItemFailures`, a Kafka
consumer's commit/no-commit, a Rabbit ack/nack). A DLQ is wired to **retry exhaustion**, not to
"the consumer decided this message is invalid." Those are different events, and a message that
never enters the retry path never reaches the DLQ either.

## Real occurrence

In the events pipeline (`functions/events-pipeline/`), a message the consumer refused —
because it failed envelope validation, or because the initial DocumentDB insert itself failed
permanently — was excluded from `batchItemFailures`. SQS interpreted that exclusion as "this
record succeeded" and deleted it from the queue. Because deletion-after-success and
deletion-after-permanent-rejection look identical to SQS, the redrive policy (`maxReceiveCount =
3`, feeding the DLQ) never saw the message either: redrive only fires when SQS itself has retried
a record to exhaustion, and this record was never retried at all — it was ACKed away on its
first and only attempt.

The event was gone. DLQ depth stayed at `0`. `events-pipeline-design.md` described a system where
every permanent failure is `Recorded FAILED and the SQS message is consumed` — true for most
permanent failures, but silently untrue for the two where nothing had been persisted yet (a
malformed envelope with no `event_id` to record against, and an initial insert that itself failed
permanently). The spec's own wording obscured the gap: it read as "consumed AND recorded," when
what shipped was "consumed, sometimes without ever being recorded."

Found by an audit worker sending a deliberate probe message with a malformed envelope and
watching it disappear — not by any dashboard, alert, or test. Fixed in `d7a4499`: the consumer
now copies the raw, unmodified body to the DLQ (tagged with a `quarantine_reason` message
attribute) for exactly those two undocumented paths, before ACKing. See
[[events-pipeline-design#Quarantine — the two paths a `FAILED` document cannot cover]] for the
full mechanics and its contracts (never fails the record, `EVENTS_DLQ_URL` optional, IAM grant
never falls back to the main queue's ARN).

## Root cause

Two independent gaps compounded:

1. **The mental model of "DLQ = safety net for everything that goes wrong" is wrong.** A DLQ via
   redrive is a safety net for exactly one failure shape: a message that was retried and kept
   failing. A message the consumer looks at once and declines to process (validation failure,
   an error it deliberately classifies as non-retryable) never enters that shape. SQS itself has
   no third bucket for "the consumer refused this, but not because it plans to retry" — success
   and permanent-refusal-without-a-retry-attempt are the same wire signal.
2. **The spec's wording asserted an invariant ("recorded FAILED") that the code did not actually
   guarantee** for two specific paths where no record could exist yet. A reader trusting the spec
   would have no reason to suspect a gap; the prose reads as universally true.

## Why it stayed hidden

- **Monitoring DLQ depth would not have caught it.** Depth stayed `0` throughout — the message
  was never in a state a depth metric measures.
- **The spec described the behavior in a way that implied a record always existed**, so a reader
  auditing "what happens to a bad message?" against the spec alone would conclude the system was
  fully auditable.
- **The only trace was one log line**, in an observability stack (OpenObserve) that is opt-in
  locally and easy to not be looking at during the exact window a message was lost. Logs are
  sampled, retained briefly, and often opt-in — none of that is "recovery."

## The transferable check

For any queue consumer, and for every way the handler can **decline** a message (not just fail
transiently), ask: **what artifact survives?**

- If the answer is "a `FAILED`/dead-lettered record in the store the consumer already writes to,"
  that is recovery — an operator can find and act on it.
- If the answer is "a log line," that is not recovery. Logs are sampled, retained briefly, and
  often opt-in.
- If the answer is "nothing — the message is just gone," that is the gap this lesson is about,
  and it is invisible to every metric that only measures the retry/DLQ path (queue depth, DLQ
  depth, redrive count) because the message never entered that path.

A DLQ's existence is not, by itself, evidence that rejected messages are recoverable. Whether
they are depends on whether the consumer's rejection path actually reaches it — and the default,
un-audited behavior of "just don't report it as a batch item failure" does not.

## Related

- [[events-pipeline-design]] — the corrected spec section
  ([Quarantine — the two paths a `FAILED` document cannot cover](events-pipeline-design.md#quarantine--the-two-paths-a-failed-document-cannot-cover))
  and the error taxonomy this lesson's fix sits inside.
- [[logging-context]] — why "a log line" is not an acceptable substitute for a persisted,
  queryable artifact; the same opt-in-observability gap this lesson names explicitly.
- [[2026-08-29-the-emulator-was-the-ceiling-not-the-code]] — the prior investigation into this
  same pipeline's observability surface, on the local emulator stack this bug was found and
  verified against.
