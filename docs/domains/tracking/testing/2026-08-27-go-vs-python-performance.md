---
title: "Tracking Go vs Python — measured performance comparison"
type: spec
area: tracking
status: active
created: 2026-08-27
updated: 2026-08-27
tags:
  - type/spec
  - area/tracking
  - status/active
  - milestone/tracking-go-migration
  - issue/JE-229
related:
  - "[[tracking-service-design]]"
  - "[[ADR-0021-tracking-go-gin-sqlc-stack]]"
  - "[[2026-08-27-tracking-go-migration-design]]"
  - "[[2026-08-27-tracking-go-migration]]"
  - "[[2026-08-27-accumulated-local-state-degrades-the-stack-silently]]"
  - "[[testing]]"
  - "[[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]]"
---

# Tracking Go vs Python — measured performance comparison

Closing-gate criterion 3 of the [[2026-08-27-tracking-go-migration-design|Tracking Go migration]]
("Performance: both arms measured and recorded, honestly" — Task 26,
[JE-229](https://linear.app/je-martinez/issue/JE-229)). Measured 2026-08-27 on one machine, both
services against the SAME database, coexisting (Python host `:3002`, Go host `:3012`).

## Verdict

**Resource and startup metrics: measured and trustworthy — Go wins all four.**
**Latency and throughput under load: NOT measurable on this stack.** Reported as unmeasured
rather than estimated.

## What was measured reliably

| Dimension | Python/FastAPI | Go/Gin | Ratio |
|---|---|---|---|
| Image size | 277 MB | 38.9 MB | 7.1x smaller |
| Cold start to first 200 on `/v1/health` | 3.536 / 2.685 / 2.799 s | 0.841 / 0.832 / 0.808 s | ~3.4x faster |
| Memory at rest | 253.5 MB | 20.8 MB | 12x less |
| Memory under load (6 concurrent, 60s) | 235-261 MB | 18.4-37.2 MB | ~8x less |

Cold start: 3 runs each, `docker rm -f` then `docker compose up -d`, polling `/v1/health` every
50ms. Go's variance is 33ms across runs; Python's is 851ms. Memory: `docker stats --no-stream`,
12 samples over the load window.

Go does not lose or tie on any dimension that could be measured.

Separately, from the Wave 3A E2E run rather than this task: the internal E2E suite (22 specs)
took 22.5s against Python and 6.6s against Go. Recorded as an observation, not as a controlled
measurement.

Code size, counted after the fact: 6,563 non-blank non-comment lines in Python's `src` against
5,905 in Go — about 10% smaller, NOT the large reduction the raw line counts suggest (9,776 vs
11,211), because 39% of the Go files are comments. This matches what the design spec predicted:
the complexity was in the requirements, not in Python.

## What could NOT be measured, and why

Both arms ran the EXISTING `fullJourney` simulation through the gateway with identical
parameters (`usersPerSec=1 duration=120 rampUsers=10 rampDuration=20`). Both collapsed almost
identically:

| | Python arm | Go arm |
|---|---|---|
| KO rate | 94.36% | 94.77% |
| 401s | 2,788 | 2,802 |
| 60s gateway timeouts to `:4566` | 1,792 | 1,788 |
| Tracking rows | 2 requests | 3 requests |

Percentiles over 2-3 samples are not percentiles. **The near-identical failure profile across
two different runtimes is itself the proof that the simulation measured the ENVIRONMENT, not the
service.**

The bottleneck is Floci (the local AWS emulator): pinned at 100-205% CPU while both services sat
at ~1%. `POST /v1/users/register` degraded from 0.28s to 4.9s with Users at 2.76% CPU.

This is a second, independent instance of the failure mode described in
[[2026-08-27-accumulated-local-state-degrades-the-stack-silently]] — a degraded local stack
producing latency numbers that look like a code or configuration problem but are the environment
instead. That lesson's stack-degradation mechanism was never confirmed; here the bottleneck was
identified directly (Floci pinned at 100-205% CPU while both services idled), so the two findings
are related but distinct: same symptom shape (an environment masquerading as a code result),
different confirmed cause.

## Two defects found while measuring

**1. The running tracking-go container was a stale image** predating the commit that delivered
the cache metrics. It published ZERO cache metrics while Python published 15 for 15 requests —
attributed by pausing the Python container and querying CloudWatch. This produced an apparent
"Go is 400x faster" that was entirely an artefact of Go doing less work. After a rebuild, with
both arms publishing metrics, the gap VANISHED: Python 0.38-1.00s vs Go 0.37-0.58s, statistically
indistinguishable, both dominated by the same ~100ms-per-call Floci `PutMetricData`.

**The lesson, and it generalizes beyond this comparison: before any A/B, verify both arms do
EQUIVALENT WORK, not merely that both return 200. Compare a side effect — metrics published, rows
written — not only the response.**

**2. Python ignores `METRICS_ENABLED=false` on the cache path.** With the flag false, traces
still showed `cloudwatch PutMetricData cache_requests_total` and `cache_operation_duration_ms`
inside `cache.get`. Go honours the flag: its composition root refuses to construct the publisher
at all. This blocks the obvious way to equalise conditions between the two arms.

## The dominant cost on both runtimes

Trace spans for one Python request (896ms total): `cache.get` at 400ms and 494ms, each containing
two synchronous `PutMetricData` calls of 139-348ms. A single `PutMetricData` against Floci
measured 106ms when quiet, degrading to 478ms under load. This is emulator cost, not a property
of either runtime, and it would not exist against real CloudWatch.

## How to obtain trustworthy latency numbers

1. `make clean && make bootstrap` — the degradation window is a SINGLE test session.
2. Measure BEFORE running the E2E suite, never after.
3. Fix Python's `METRICS_ENABLED` gate, or disable metrics on both arms another way, so neither
   blocks on Floci CloudWatch.
4. Run both arms back to back, interleaved, and report variance across runs.

## Related

- [[tracking-service-design]] — the service spec these two implementations (Python and Go) both
  satisfy; propagation target for the migration's decisions.
- [[ADR-0021-tracking-go-gin-sqlc-stack]] — the stack decision this measurement evaluates the
  outcome of.
- [[2026-08-27-tracking-go-migration-design]] — the design spec defining the four-part closing
  gate this note satisfies criterion 3 of.
- [[2026-08-27-tracking-go-migration]] — the implementation plan; Task 26 produced this note.
- [[2026-08-27-accumulated-local-state-degrades-the-stack-silently]] — the related local-stack
  degradation finding from the same milestone; distinct confirmed cause, same symptom shape.
- [[testing]] — the three-layer testing convention this performance comparison sits alongside,
  as a fourth, non-functional verification axis.
- [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]] — the
  wiring-hazard lesson this note's "Two defects found while measuring" §1 (the stale container
  publishing zero cache metrics) is one instance of.
