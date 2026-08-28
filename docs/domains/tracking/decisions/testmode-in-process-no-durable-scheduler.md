---
title: TestMode progression runs in-process, not on a durable scheduler — accepted limitation
type: adr
area: tracking
status: accepted
id: tracking-testmode-in-process-no-durable-scheduler
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

# TestMode progression runs in-process, not on a durable scheduler — accepted limitation

## Context

[[tracking-service-design#TestMode automatic progression]] needs a tracking created with
`test_mode: true` to advance automatically — `PLACED → PROCESSING → SHIPPED → OUT_FOR_DELIVERY →
DELIVERED`, one step every 10 seconds, 5 `Tracking_History` rows total — so that a gateway E2E
test with a real Cognito JWT can poll `GET /v1/trackings/{orderId}` and observe the full
lifecycle without a real carrier. The candidates for scheduling that progression were something
scheduled directly in-process on the running service, or a durable, persisted mechanism
(APScheduler, Celery, a queue-backed job).

## Decision

Use a plain **in-process scheduling primitive** — no durable scheduler, no job table, no queue —
deliberately chosen over any durable alternative:

- Each transition reuses the same status-update use case that backs the carrier `PUT` endpoint,
  differing only in the actor recorded (`TEST_MODE_PROGRESSION` vs the carrier's), never a
  parallel transition code path.
- Each transition operates on its own database session/context; the creating request's own
  session or context is gone by the time a later step fires.
- A rejected transition (e.g. a real carrier update delivered it first) or a deleted tracking
  ends the run cleanly — never retried, never raised out of the background task.
- The interval is injectable; production default is 10s, the test suite passes ~0 so it never
  sleeps for 30-40 seconds per test.

**Accepted limitation, not a bug:** if the process restarts mid-progression — a docker-watch
rebuild, a redeploy, a crash, a container reschedule — the pending progression is lost entirely.
The tracking stays frozen at whatever status it last reached. There is no persistence of the
schedule, no recovery on restart, and no error logged anywhere marking the tracking as stuck. A
TestMode tracking found stuck at `SHIPPED` after a rebuild is **expected**, not a defect to
investigate. Recover by creating a new TestMode tracking, or by driving the remaining
transitions through the carrier `PUT /v1/trackings/{orderId}/status` endpoint.

This is acceptable because TestMode exists solely as a ~40-second E2E fixture
([[testing]]) — nothing downstream depends on a TestMode run completing, and every **real**
carrier update arrives through the persistent `PUT /v1/trackings/{orderId}/status` endpoint,
which is unaffected by process restarts because it isn't scheduled at all, it's driven by an
external caller on demand.

## Two implementations, same decision — the mechanism, not the choice, differs

This decision has now been implemented twice, first in the Python/FastAPI service (retired
2026-08-27) and since in the Go/Gin service that replaced it
([[2026-08-27-tracking-go-migration-design]]). **The decision itself was not revisited at the
port**: in-process scheduling, no durable scheduler, and the same accepted
lose-the-schedule-on-restart limitation carried forward unchanged. What changed is the
implementation shape — and one of those shape changes is a bug the Python code could not teach
the Go port, because Python never had the failure mode.

**Python** scheduled the progression as an `asyncio` task on the running event loop, submitted
at `init-tracking` time. Because `CreateTracking` ran on a gRPC thread pool with no event loop of
its own (from the era before creation became an ordinary async handler), scheduling required a
sync→async bridge — registering uvicorn's loop and submitting through
`run_coroutine_threadsafe`. That bridge existed only to solve a Python-specific threading
problem and had no reason to survive a port to a language without that constraint.

**Go** schedules the progression as a plain goroutine — no bridge needed, since Go has no
thread-pool boundary between the HTTP handler and the background work. But Go introduces a trap
Python structurally could not have:

> ### The Go-specific trap: the goroutine must NOT inherit the request context
>
> **A goroutine that outlives its request must not derive from that request's
> `context.Context`** — `net/http` cancels it the instant the response is written. The
> progression would then die on its first context-aware call, **every time**.
>
> This is called out separately because **that failure is indistinguishable from the accepted
> limitation above.** A tracking frozen at `PROCESSING` looks identical whether the process
> restarted or the context was cancelled at t=0 — so the bug hides inside a documented non-bug
> and nobody investigates it. That similarity is precisely what makes it dangerous: it would
> read as this decision's known behavior rather than as a defect to fix.

The structural defences the Go implementation uses:

- The progression holds a **process-lifetime base context** (the one derived from
  `signal.NotifyContext` in the composition root), never the request's — documented at the
  field that holds it (`//nolint:containedctx` is deliberate there).
- The function that starts a progression run takes **no context parameter at all**, and neither
  does the port the HTTP layer declares for it. A handler only *has* the request's context, so a
  signature that accepted one would invite exactly this bug; removing the parameter makes it
  unrepresentable.
- The scheduling hook fires **after the response is written**, and therefore after the creating
  transaction has committed — starting earlier races the commit, and the progression's own fresh
  read would see no tracking yet and end immediately at `PLACED`.
- Graceful shutdown is in scope for the Go port in a way it never was for Python: the process
  must not exit leaving progression goroutines mid-flight without at least logging it.

A faithful line-by-line translation would have silently gotten the context-inheritance part
wrong. The Go migration design called this out as the reason TestMode was implemented as its own
standalone wave rather than folded into ordinary endpoint porting.

## Consequences

- Zero added infrastructure in either implementation: no scheduler process, no job table, no
  queue. The entire feature is a scheduled background task and a periodic callback.
- A developer whose local stack rebuilds mid-TestMode-run (a normal docker-watch workflow) will
  see a tracking stuck partway through, with nothing in the logs explaining why. The recovery
  path is to create a new TestMode tracking, or manually drive the remaining transitions through
  the carrier `PUT` endpoint — not to treat the stall as a regression to fix.
- If Tracking ever needs a scheduled effect that **must** survive a restart, this decision does
  not extend to that case — it should be re-evaluated with a durable mechanism, precisely
  because this one was chosen on the premise that losing the schedule is tolerable.
- This is scheduling for a test fixture, not a general answer to background jobs in this
  service or repo; it should not be cited as precedent for scheduling anything with a
  production consequence.
- Porting an in-process background task to a new language is not a mechanical translation: the
  concurrency primitive changes, and each language's own failure modes (a sync→async bridge in
  Python; context-lifetime rules in Go) have to be re-derived, not carried over by analogy.

## Related

- [[tracking-service-design]] — TestMode contract, the end-to-end header origin on Orders'
  `POST /v1/orders`, and the gRPC identity-resolution call this progression does not touch.
- [[orders-service-design]] — owns reading the `x-test-mode` header and the
  `E2E_TESTING_ENABLED` guard before the boolean ever reaches Tracking.
- [[testing]] — the three-layer convention; TestMode plus the REST reads are what make gateway
  E2E verification of this progression possible at all.
- [[2026-08-27-tracking-go-migration-design]] — the migration design that carried this decision
  forward for the Go/Gin port (wave 2.5, TestMode) and is the source of the context-cancellation
  trap and the graceful-shutdown requirement documented above.
