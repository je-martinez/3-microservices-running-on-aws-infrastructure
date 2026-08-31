---
title: "A producer-side test proves nothing about what the consumer accepts"
type: lesson
area: tracking
status: active
created: 2026-08-27
updated: 2026-08-27
tags:
  - type/lesson
  - area/tracking
  - status/active
  - severity/critical
  - milestone/tracking-go-migration
related:
  - "[[2026-08-27-tracking-go-migration-design]]"
  - "[[tracking-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[testing]]"
  - "[[tightened-schemas-need-producer-first-deploys]]"
  - "[[logging-context]]"
---

# A producer-side test proves nothing about what the consumer accepts

## Finding

During the Tracking Go migration ([[2026-08-27-tracking-go-migration-design]]), the Go
producer emitted the `TRACKING_STATUS_CHANGED` event's `shipping_address` field as a **JSON
string** — a plain address, not even valid JSON — where the events-pipeline Lambda's Zod schema
requires an **object**. The Lambda rejected the message with `transient: false`, meaning the
record was consumed and acknowledged, and never retried: the delivery-status email and the
realtime WebSocket push simply vanished. The producer's own logs showed success. The DLQ was
empty. Nothing anywhere recorded a failure — because from the producer's point of view, nothing
failed.

**This is a wire-contract violation, not a logic bug**, and it survived because the Go unit test
covering this field had encoded the bug as its own expectation: it asserted the emitted field
equals a plain street-address string. The test was green because the code did exactly what the
test said it should — the test was simply asserting the wrong contract. Every producer-side
signal — the test suite, the application log, the DLQ — agreed the write succeeded. The only
place the mismatch was ever visible was the consumer's own rejection, which the producer never
looks at.

It was found only by driving a real status transition through the real Lambda and confirming
an email actually arrived in the inbox — the same kind of end-to-end verification
[[2026-08-27-tracking-go-migration-design#Events and observability parity]] and
[[testing]]'s three-layer convention both exist to force, applied one hop further than "does
the endpoint respond," into "does the side effect the endpoint triggers actually happen."

## Why the unit test could not have caught this, structurally

A producer-side test that asserts "the payload I built equals X" can only ever confirm the
producer built what the producer intended to build. It has **no access to the consumer's
schema**, so it cannot distinguish "X is correct" from "X is what I meant to send, which happens
to be wrong." The test was not weak — it was answering a question ("did the code produce what
the code's author expected?") that is structurally incapable of catching a contract mismatch
with a system the test never talks to.

This generalizes past this one field: **any test that only inspects what a producer emits,
without independently verifying that shape against what the consumer's schema actually accepts,
proves conformance to the author's mental model of the contract — never conformance to the
contract itself.** The two can diverge silently, exactly as they did here, and a green producer
suite gives no signal that they have.

## The fix's shape

The guard added is a **parser that consumes the consumer's actual Zod schema**, not a second,
independently-written assertion of what the schema is believed to say. A test asserting "the
producer's shape equals a hand-copied description of the schema" would have the identical
weakness this bug exposed — two independently maintained descriptions of the same contract will
drift, and nothing forces them to be re-synchronized when one side changes. Reading the real
schema is what makes the guard a contract test rather than a second opinion.

## The mutation that proved the guard's value

The team validated the new guard by **deleting the required field and its assertion together** —
removing `shipping_address` from the payload and removing the corresponding assertion from the
producer-side unit test in the same change. Every producer-side test still passed: nothing in
the producer's own suite depends on the field being present, because nothing in the producer's
own suite reads the consumer's schema. **Only the schema-driven guard failed**, because it parses
the consumer's actual required-fields list independently of whatever the producer's test author
did or didn't think to assert.

This is the sharpest demonstration of the underlying claim: a producer can delete a required
field and delete the test that used to notice, and if verification lives entirely on the
producer's side, nothing catches it. Verification has to reach across the boundary to be worth
anything.

## The transferable lesson

**Never trust a producer-side test to prove a wire contract is satisfied.** A test that only
inspects the producer's own output, however precisely, can only confirm internal consistency
with itself — never external consistency with a consumer that was never present when the test
was written or run. For any message crossing a serialization boundary this repo doesn't
type-share (SQS envelopes between polyglot services, in particular — see
[[events-pipeline-design]] and [[tracking-service-design#Change impact — renaming a delivery
status]] for the sibling risk of an enum rename crossing the same boundary undetected), verify
against the **real, current** consumer contract, not a hand-copied description of it that can
drift out of sync unnoticed.

## How to apply

- When a message or payload crosses a service or language boundary with no shared type
  (SQS/Kafka/webhook envelopes, in this repo's case), write a guard that parses the actual
  consumer-side schema — not a redescription of it — and validate producer output against that
  parsed schema directly.
- Treat "the producer's unit tests are green" as evidence about the producer's internal logic
  only. It says nothing about whether a consumer elsewhere in the system will accept what was
  produced.
- When adding a schema-crossing guard, prove it actually guards something: delete the field
  **and** its producer-side assertion in the same mutation, and confirm only the cross-boundary
  guard catches the loss. If the producer-only tests still pass, the guard is the only thing
  standing between "looks fine" and a silent, retry-proof data loss.
- A consumer that rejects with `transient: false` and no DLQ entry is a especially dangerous
  failure shape: the message is gone, not delayed, and nothing downstream ever gets another
  chance to notice. Treat any such rejection path as one that needs an end-to-end check driving
  a real message through it, not just a unit test on either side of the boundary.

## Related

- [[2026-08-27-tracking-go-migration-design]] — the migration this bug was found during; see
  "Observability and event parity" for the envelope contract's other invariants
  (`author.actor`, omitted-never-null, best-effort publishing) this same section documents.
- [[tracking-service-design]] — the service spec this event contract belongs to; see "Events"
  for the full `TRACKING_STATUS_CHANGED` envelope shape.
- [[events-pipeline-design]] — the consuming side: the Zod validation, the `PermanentError`
  taxonomy that decided this record was not retried, and the dispatch map.
- [[testing]] — the three-layer testing convention; this bug was caught only by the equivalent
  of a fourth check (drive a real transition, confirm the real side effect), one layer past
  what the three-layer convention names explicitly.
- [[tightened-schemas-need-producer-first-deploys]] — a related schema-boundary lesson about
  deploy ordering when a schema tightens; this lesson is about proving conformance to a schema
  that never changed, the other is about sequencing a schema that does.
- [[logging-context]] — why the producer's own logs showed success despite the message being
  silently dropped: publishing is deliberately best-effort and logs only its own send outcome,
  never the consumer's eventual disposition of the message.
