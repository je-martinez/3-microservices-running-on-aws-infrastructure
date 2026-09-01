# Tracking event loss — reproduction recipe and trigger

**Date:** 2026-08-30 · **Branch:** feature/tracking-go-migration · **Method:** empirical, on this machine

## Verdict

The lost events are **never published at all**. Nothing is lost in SQS, in the Lambda
event-source mappings, or in the events pipeline.

**Trigger:** `DELETE /v1/trackings/e2e-cleanup` soft-deletes **every** E2E-tagged
tracking **globally**, with no scoping by user, spec, worker, or run. When it fires while a
TestMode progression is still ticking, that progression's next tick reads
`tracking_not_found`, the run aborts, and **every remaining status is never published** —
so the emails for those statuses never exist.

It is a **test-harness isolation defect**, not a messaging bug.

## Reproduction recipe (100% deterministic, both directions)

Stack up, no other suite running. Script: `proof.py` (control vs. treat, single variable).

```
# CONTROL — 4 concurrent TestMode trackings, nothing else
python proof.py control 4

# TREAT — identical, plus one global cleanup fired mid-progression
python proof.py treat 4 12     # fires at t=+12s
python proof.py treat 4 17     # fires at t=+17s
```

| Arm | Cleanup | Published | Received (DocDB) | Never published |
|---|---|---|---|---|
| control | none | 16/16 | 16 | **0** |
| treat, t=+12s | yes | 8/16 | 8 | **8** (OUT_FOR_DELIVERY + DELIVERED) |
| treat, t=+17s | yes | 12/16 | 12 | **4** (DELIVERED only) |

`LOST_IN_TRANSPORT = 0` in every arm: every event Tracking published reached DocumentDB.

**`treat 4 17` is the reported symptom exactly** — tracking reaches DELIVERED, the
"processing" and "shipped" emails arrive, the "delivered" email never does. Verified in
Mailpit: 4× processing, 4× shipped, 0× delivered.

**How much tail is lost depends only on WHEN the cleanup lands.** That is why the
whole-suite failure count swings 4–15 across runs of the same commit.

## Evidence that clears the transport

1. **SQS + ESM, direct probe.** 100 synthetic valid `TRACKING_STATUS_CHANGED` envelopes
   sent straight to the queue at concurrency 24, bypassing Tracking: **100/100** in
   DocumentDB, 0 lost, 0 duplicate MessageIds. Also 20/20 at concurrency 8.
2. **Log reconciliation.** Every `tracking_status_changed_published` line vs. every
   `TRACKING_STATUS_CHANGED` document: **77 claimed, 77 received, 0 missing, 0 publish
   failures, 0 duplicate `event_id`s.**
3. **Pipeline outcomes.** All 228 tracking events in DocumentDB are `COMPLETED`. Zero
   `FAILED`, zero rejections, empty DLQ.
4. **The publisher cannot lie.** `publisher.go` logs
   `tracking_status_changed_published` **only after** `SendMessage` returns a nil error;
   all four failure paths log `tracking_status_changed_publish_failed` at ERROR. Zero such
   lines exist. So "published" really means "SQS accepted it".

The KEY CONTRADICTION in the brief dissolves: Tracking never claimed to publish the
missing events. The counts looked like loss because published-vs-received was compared in
aggregate rather than per `event_id`.

## The mechanism, observed

`internal/app/e2e_cleanup.go` → `SoftDeleteByTag(E2ESourceTag)`: unscoped by design, one
global sweep. `internal/app/progression.go` → `advanceOnce` maps
`ErrTrackingNotFound` to `done=true, reason="tracking_not_found"` and stops — correct
behaviour for a deleted row, and it logs at **INFO**, so the abort is invisible in an error
scan.

Caught live during a 12-tracking burst while another worker's suite teardown ran:

```
19:50:13.2 – 19:50:13.6   test_mode_progression_started   × 12
19:50:32.344              e2e_cleanup_succeeded           ← ONE global sweep
19:50:32.365 – 19:50:33.7 test_mode_progression_failed    × 12   (tracking_not_found)
```

One cleanup, twelve progressions dead inside 1.3 s. Result: `published=36 received=36
expected=48` — 12 DELIVERED events that were never published, one per tracking. That is
the brief's "exactly one of each status is missing … one tracking's entire chain
vanished", seen at the moment it happens.

Collateral damage is real: a `treat 4` run reported `{"deleted": 8}` — it removed four rows
belonging to an unrelated earlier run.

## Why the spec still sees DELIVERED

The delete is a **soft** delete and it races the read. When the sweep lands after DELIVERED
is persisted, the poll reads it (cache or a read that precedes the delete) and the journey
assertion passes; only the email assertion fails. When the sweep lands earlier, the row
freezes mid-chain (verified in MySQL: `status=SHIPPED, deleted_at NOT NULL`).

## Why it passes alone and fails in the suite

`e2e/playwright.config.ts` sets `workers: 10`. `global-teardown.ts` calls the unscoped
cleanup at the end of a run. With 10 parallel workers and repeated/overlapping runs, one
worker's teardown lands inside another worker's live 20 s progression. Run alone, nothing
else fires the sweep — so it passes, repeatedly.

Cadence explains the earlier observations without being the cause: at 2 s the progression
window was short but many more trackings overlapped each sweep; at 5 s the single-spec case
stopped overlapping any teardown, which is why it started passing in isolation.

## What this predicts (untested, for whoever fixes it)

Any fix that removes the overlap should drive the loss to zero: scope the cleanup (by user
or by run tag) instead of sweeping globally; or exclude rows whose progression is still in
flight; or serialize teardown against live progressions. Per the brief's own warning, a
single before/after suite run cannot validate any of them — use the control/treat harness
above, which is deterministic.

## Artifacts

Scratchpad: `probe_sqs.py` (transport probe), `reconcile.py` (log↔DocDB reconciliation),
`burst.py` (N concurrent TestMode trackings), `proof.py` (the control/treat proof).

No repository code or configuration was changed.
