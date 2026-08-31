# Did `mapping_count = 4` cause the event loss? No.

**Verdict: the four SQS event-source mappings are NOT the cause.** Ruled out by
chronology, by concurrency evidence, and by mechanism. Investigation was
read-only: no mapping was deleted, no Terraform edited, nothing committed.

## The one fact that settles it

The three extra Lambda poller containers **did not exist when any message was
lost.**

| | UTC |
|---|---|
| First loss | 19:18:43 |
| **Last loss** | **19:21:32** |
| 2nd poller container created (`9c90b6f3`) | 19:38:42 |
| 3rd poller container created (`24da8ecc`) | 19:38:47 |
| 4th poller container created (`621f21b7`) | 19:39:27 |

Throughout the entire loss window only `0968c398` (created 19:12:07) was alive
and polling — it logged 56 `event_processing_started` in 19:18–19:22 while the
other three logged zero, because they had not been created yet.

The mappings were *registered* in the emulator API at 19:07:42, but Floci
materializes a poller container lazily. **Registered ≠ polling.** Every message
was lost while the system was effectively running at **one** poller.

## Measured loss, by effective poller count

Correlating `tracking_status_changed_published` (Tracking) against
`event_processing_started` (pipeline, all containers) by `event_id`:

| Period | Effective pollers | Published | Lost |
|---|---|---|---|
| before 19:38 | 1 | 25 | **15 (60%)** |
| after 19:38 | 4 | 22 | **0** |

Loss occurred **only** under one poller and vanished under four. That is the
opposite of the hypothesis.

### Confound, stated honestly
These two periods differ in burst intensity as well as poller count (peak 11
publishes in one second before 19:38, vs 4 after). So this table alone does not
*prove* four pollers are safer — the two variables are not separated. It is
reported as corroborating, not decisive. **The chronology above is the decisive
evidence**, and it is unaffected by the confound.

## Mechanism: overlapping receipt did not happen

Across all four containers, every `event_processing_started` line was counted by
`message_id`:

- **225 distinct `message_id`, 225 receipts, 0 processed more than once.**

If four pollers were racing — a message received by A while B held it invisible,
a partial-batch-failure response deleting another receiver's message, a
receipt-handle mix-up — the signature would be a `message_id` processed twice, or
DLQ entries, or receipt-handle errors. Observed instead:

- duplicate receipts: **0**
- DLQ depth: **0**
- `ReceiptHandleIsInvalid` / `MessageNotInflight` in the emulator: **0**
- pipeline failures / duplicate-index errors: **0**

SQS gives at-least-once delivery to exactly one receiver. Extra pollers add
readers, not copies. Nothing in the evidence contradicts that here.

## What the evidence actually points at

The losses are **upstream of the queue**. The pipeline cannot drop a message it
never received, and there is no trace of these 15 anywhere downstream — no
receipt, no DLQ entry, no failure line.

Meanwhile Tracking logged all 15 as `tracking_status_changed_published` with
**zero** `tracking_status_changed_publish_failed`. Reading
`services/tracking-go/internal/adapter/sqs/publisher.go`, that success line is
emitted strictly *after* `SendMessage` returns a nil error — the log does not
lie about the SDK call. So the SDK believed each send succeeded.

The losses cluster tightly at 19:20:07–19:20:17, exactly when the single poller
was draining saturated full batches of 10 back-to-back (batches at 19:20:01,
:12, :23, ~11s apart, handler median 1463ms / max 3542ms). The shape is
**publish-side loss under burst while the queue was backed up behind one
consumer** — an emulator SQS ingest problem, not a poller problem.

Note this also reframes the earlier "4 mappings took the suite from 5 failures to
1–2" result: adding pollers drained the backlog faster and so reduced the
pressure under which messages get dropped. It treated a symptom, which is
consistent with it helping without being the cause.

## Recommended next step

Point the investigation at the publish path: whether `SendMessage` returning
success under concurrent burst actually persists the message in Floci's SQS.
The direct test is a controlled probe — publish N uniquely-tagged messages at a
burst rate and compare sends against `ApproximateNumberOfMessages` before any
consumer runs. That isolates ingest from delivery, which neither the suite nor a
mapping-count change can do.

A mapping-count experiment is **not** needed to clear the mappings; the
chronology already does. It was deliberately not run here to avoid disturbing a
sibling worker's in-flight measurement on the shared stack.
