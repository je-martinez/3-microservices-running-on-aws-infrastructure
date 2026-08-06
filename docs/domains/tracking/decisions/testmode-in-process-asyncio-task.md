---
title: TestMode progression uses an in-process asyncio task, not a durable scheduler — accepted limitation
type: adr
area: tracking
status: accepted
id: tracking-testmode-asyncio-task
deciders: ["Jose E. Martinez"]
supersedes: null
superseded-by: null
created: 2026-07-31
updated: 2026-08-05
tags: [type/adr, area/tracking, status/accepted]
related:
  - "[[tracking-service-design]]"
  - "[[orders-service-design]]"
  - "[[testing]]"
---

# TestMode progression uses an in-process asyncio task, not a durable scheduler — accepted limitation

## Context

[[tracking-service-design#TestMode automatic progression]] needs a tracking created with
`test_mode: true` to advance automatically — `PLACED → PROCESSING → SHIPPED → OUT_FOR_DELIVERY →
DELIVERED`, one step every 10 seconds, 5 `Tracking_History` rows total — so that a gateway E2E
test with a real Cognito JWT can poll `GET /v1/trackings/{orderId}` and observe the full
lifecycle without a real carrier. The candidates for scheduling that progression were an
in-process `asyncio` task, APScheduler, Celery, or a durable queue-backed job.

## Decision

Use a plain **in-process `asyncio` task**, scheduled directly on the running event loop when
`init-tracking` handles the request, deliberately chosen over APScheduler, Celery, or a
durable queue:

- Each transition reuses the same `update_tracking_status` handler that backs the carrier
  `PUT` endpoint, differing only in `AuditActor.TEST_MODE_PROGRESSION` — never a parallel
  transition code path.
- Each transition opens its own write session; the creating request's session is closed
  before the first scheduled transition runs.
- A rejected transition (e.g. a real carrier update delivered it first) or a deleted tracking
  ends the run cleanly — never retried, never raised out of the background task.
- The interval is injectable (`progression_interval`); production default is 10s, the test
  suite passes ~0 so it never sleeps for 30 seconds per test.

**Accepted limitation, not a bug:** if the process restarts mid-progression — a docker-watch
rebuild, a redeploy, a crash — the pending `asyncio` task is lost entirely. The tracking stays
frozen at whatever status it last reached. There is no persistence of the schedule, no
recovery on restart, and no error logged anywhere marking the tracking as stuck. A TestMode
tracking found stuck at `SHIPPED` after a rebuild is **expected**, not a defect to
investigate.

This is acceptable because TestMode exists solely as a ~40-second E2E fixture
([[testing]]) — nothing downstream depends on a TestMode run completing, and every **real**
carrier update arrives through the persistent `PUT /v1/trackings/{orderId}/status` endpoint,
which is unaffected by process restarts because it isn't scheduled at all, it's driven by an
external caller on demand.

## Consequences

- Zero added infrastructure: no scheduler process, no job table, no queue. The entire feature
  is a coroutine and a loop-scheduled callback.
- A developer whose local stack rebuilds mid-TestMode-run (a normal docker-watch workflow) will
  see a tracking stuck partway through, with nothing in the logs explaining why. The recovery
  path is to create a new TestMode tracking, or manually drive the remaining transitions
  through the carrier `PUT` endpoint — not to treat the stall as a regression to fix.
- If Tracking ever needs a scheduled effect that **must** survive a restart, this decision does
  not extend to that case — it should be re-evaluated with a durable mechanism, precisely
  because this one was chosen on the premise that losing the schedule is tolerable.
- This is scheduling for a test fixture, not a general answer to background jobs in this
  service or repo; it should not be cited as precedent for scheduling anything with a
  production consequence.

## Related

- [[tracking-service-design]] — TestMode contract, the end-to-end header origin on Orders'
  `POST /v1/orders`, and the gRPC identity-resolution call this progression does not touch.
- [[orders-service-design]] — owns reading the `x-test-mode` header and the
  `E2E_TESTING_ENABLED` guard before the boolean ever reaches Tracking.
- [[testing]] — the three-layer convention; TestMode plus the REST reads are what make gateway
  E2E verification of this progression possible at all.
