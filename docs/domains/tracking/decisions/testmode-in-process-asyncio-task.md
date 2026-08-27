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
updated: 2026-08-27
tags: [type/adr, area/tracking, status/accepted]
related:
  - "[[tracking-service-design]]"
  - "[[orders-service-design]]"
  - "[[testing]]"
  - "[[2026-08-27-tracking-go-migration-design]]"
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

## Addendum — Go port (2026-08-27)

[[2026-08-27-tracking-go-migration-design]] carries this decision forward unchanged for the
Go/Gin port: in-process scheduling, no durable scheduler, and the same accepted
lose-the-schedule-on-restart limitation. **The decision itself is not revisited.** What changes
is the implementation shape, and one of those shape changes is a bug the Python code cannot
teach the Go port, because Python never had the failure mode:

- The `run_coroutine_threadsafe` bridge that scheduling required in Python (from the era
  `CreateTracking` ran on the gRPC thread pool) is dead weight — the Go port has no thread-pool
  boundary to bridge, and the equivalent is a plain `go func()`.
- Each transition still opens its own write context, because the request's is gone by the time
  a later step fires — same as Python. But in Go this is a real risk, not a formality: the
  scheduled goroutine **must not inherit the HTTP request's `context.Context`**, which is
  cancelled the moment the response is sent. It must derive from the process lifetime context
  instead.
- A faithful line-by-line translation would silently get this wrong — a goroutine started from
  the request context would die at the first `PROCESSING` transition, and the symptom (tracking
  frozen partway through) is **indistinguishable** from the already-accepted restart limitation
  this ADR documents. That similarity is precisely what makes the bug dangerous: it would read
  as this decision's known behavior rather than as a defect to fix. The Go migration design
  calls this out as the reason its TestMode work is a standalone wave, not folded into ordinary
  endpoint porting.
- Graceful shutdown is in scope for the Go port in a way it never was for Python: the process
  must not exit leaving progression goroutines mid-flight without at least logging it.

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
- [[2026-08-27-tracking-go-migration-design]] — carries this decision forward for the Go/Gin
  port (wave 2.5, TestMode) and is the source of the [Addendum](#addendum--go-port-2026-08-27)
  above: the `context.Context`-cancellation trap a faithful translation would introduce, and
  why graceful shutdown is newly in scope.
