---
title: "Accumulated local state degrades the stack silently, and gets misdiagnosed as a code defect"
type: lesson
area: shared
status: active
created: 2026-08-27
updated: 2026-08-29
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/high
related:
  - "[[local-dev]]"
  - "[[2026-08-25-response-caching-layer-design]]"
  - "[[testing]]"
---

# Accumulated local state degrades the stack silently, and gets misdiagnosed as a code defect

## Finding

A long-running local stack silently degraded until it distorted every latency measurement
taken against it, and only a full `make clean` + `make bootstrap` restored it. It happened
**twice** in one session, and both times the degradation was mistaken for a code defect first.

**Occurrence 1.** `GET /v1/trackings/{order_id}` took ~9 seconds per request. Diagnosed at the
time as the OTLP exporter retrying against an absent `otel-collector`. After a clean the same
route answered in **90ms** — with `otel-collector` still absent. The diagnosis was wrong; the
state was the cause.

**Occurrence 2.** `GET /v1/trackings?order_ids=...` took 1-5s for a single request and
**20,027ms p50 at 10 concurrent**, while `GET /v1/health` on the same container answered in
**3ms** with CPU at 0.23% and 238MB of 15.66GB memory. After `make clean` + `make bootstrap`:
**4-46ms** single, **12ms p50 at 10 concurrent**, on comparable host load (3.71 vs 5.67).

That is roughly a 1700x difference on the same code, same machine, same load.

**Hypotheses ruled out by measurement, each individually** — this list is the valuable part,
because each is the obvious guess:

- `uvicorn --reload` (a local-dev flag that serializes requests): replaced with `--workers 4`,
  still 11.7s p50. Not it.
- Concurrency: a single request with no concurrency took 1-5s. Not a queueing problem.
- The gRPC identity resolution to Users: the identity cache was verified working (key written)
  and made no difference to latency. Not it.
- Host resources: CPU 0.23%, memory 1.5% — and `/v1/health` on the same process answered in
  3ms throughout.

## What it cost

- **Three load-test A/B runs invalidated.** The cache-ON leg measured 23,179ms p95 where the
  cache-OFF leg measured 18ms — a physically impossible result that consumed significant time
  to diagnose, because a cache cannot make a system 1000x slower. Both legs were measuring the
  environment, not the configuration.
- **Two E2E failures misattributed.** `cache.spec.ts` and `gateway/cache.spec.ts` failed
  because Orders reads Tracking under a hard 2s budget (`TrackingHttpClient.ReadTimeout`) and
  degrades to `tracking: null` on timeout; with the cache correctly declining to store a null
  tracking, the specs' MISS -> HIT pairs could never complete. On a clean stack both pass.
- **A real service-performance investigation** was opened and closed against a cause that did
  not exist.

## The transferable lesson

**Before trusting any latency measurement from a long-running local stack, verify the
environment against a known-cheap baseline on the same process.** `/v1/health` answering in
3ms while an authenticated route on the same container takes seconds is the signature — it
separates "this code is slow" from "this environment is degraded" in one request, and it is
the check that would have saved the time above both times.

The corollary for load testing specifically: **an A/B whose two legs run hours apart on a
stack that degrades between them is not an A/B.** Either run both legs back to back on a
freshly bootstrapped stack, or treat the numbers as unusable.

## What is NOT yet known

The specific mechanism is unconfirmed. Floci-side state, connection-pool exhaustion, and
DocumentDB/MySQL growth-or-leak are all candidates and none was confirmed. Recording this
plainly rather than guessing: a lesson that invents a cause is worse than one that bounds the
symptom precisely. An open Deuda Técnica issue in Linear tracks the root-cause investigation.

## Trusting a single sample as the steady state

**Correction (2026-08-29), and it is the same family as the finding above: trusting a
measurement without checking the instrument.** [[2026-08-27-go-vs-python-performance]] originally
attributed its E2E failures to "Floci pinned at 100-205% CPU while both services sat at ~1%" —
that attribution has since been retracted in that note. The number came from a **single**
`docker stats --no-stream` sample, which takes one instantaneous reading. If it lands during a
burst, it reports the peak as though it were the steady state.

Measured properly afterwards, with the container otherwise idle: six samples spaced 3s apart read
`0.11% 0.10% 0.17% 27.07% 0.05% 0.05%` — one spike, otherwise idle. The decisive check is
**cumulative process CPU time**, not an instantaneous rate: `docker top`'s TIME column did not
move across a 20-second window (17h45 → 17h45). A process consuming CPU accumulates CPU time; one
that is not busy does not, regardless of what any single point-in-time percentage reads.

This generalizes beyond Floci or CPU: **a single instantaneous sample cannot distinguish a spike
from a steady state**, for any metric sampled the same way (CPU%, a queue-depth gauge, an
in-flight request count). Take several samples spaced a few seconds apart before drawing a
conclusion, and where a cumulative counter exists (CPU time, request count, bytes transferred),
prefer it — it settles the question a rate sample cannot.

## How to apply

- Before diagnosing a slow endpoint as a code or config problem, hit `/v1/health` (or an
  equivalent cheap route) on the **same container** first. If it's fast and the real route is
  slow, suspect the environment before the code.
- Don't trust a load-test A/B whose legs weren't run back to back on the same freshly
  bootstrapped stack — a physically-impossible result (e.g. a cache making things 1000x slower)
  is a sign the stack degraded mid-comparison, not a sign the configuration is broken.
- When an E2E spec that depends on a downstream timeout/fallback starts failing
  inconsistently, check whether a degraded stack is pushing a normally-fast dependency call
  past its read-timeout budget before assuming the test or the feature is broken.
- `make clean` + `make bootstrap` is the reset of last resort when a stack's behavior stops
  matching its code — treat persistent unexplained latency as a signal to reach for it sooner
  rather than continuing to chase hypotheses against a moving target.

## Related

- [[local-dev]] — the local-development convention this stack's lifecycle (`make bootstrap`,
  `make clean`) belongs to.
- [[2026-08-25-response-caching-layer-design]] — the caching design whose A/B load-test
  numbers and cache/timeout interaction this finding invalidated and explained.
- [[testing]] — the layered-testing convention; the misattributed `cache.spec.ts` /
  `gateway/cache.spec.ts` failures are a concrete instance of an E2E layer catching a symptom
  whose real cause was environmental, not the code under test.
- [[2026-08-27-go-vs-python-performance]] — a second, later instance of the same symptom shape
  (environment masquerading as a code/runtime result) found during the Tracking Go migration's
  load-test comparison. Its original claim that the bottleneck was confirmed (Floci pinned at
  100-205% CPU) was retracted on 2026-08-29 — see "Trusting a single sample as the steady state"
  above — so both notes now share the same open status: cause unconfirmed.
