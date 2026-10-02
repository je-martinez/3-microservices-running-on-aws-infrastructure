---
title: "A zero-seed behind a failing read is not a seed"
type: lesson
area: shared
status: active
created: 2026-10-02
updated: 2026-10-02
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
related:
  - "[[users-service-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[x-cache-response-header]]"
  - "[[2026-08-12-custom-business-metrics-cloudwatch-design]]"
---

# A zero-seed behind a failing read is not a seed

## Symptom

In all three services the per-tick zero-seeds (`http_errors_total`, `cache_requests_total` and the
event-only counters) were published after the database read of the same metrics tick: Users after
the `users_total` counts, Orders after the `orders_total` read, Tracking after `CountByStatus`.
When the database was down, the read threw, the tick failed, and the seeds were never published.

The dashboards lost the series they exist to show. The error cards (`http_errors_total`) went
blank exactly during a database outage, the one window in which an operator looks at them.

## Cause

A zero-seed exists so that a quiet window still has a datapoint. That guarantee holds only if the
seed is published whether or not anything else in the tick works. Putting it after a call that can
fail made it conditional on that call, so it covered the quiet windows and missed the outages.

## Fix

The seeds no longer depend on the database read in any service:

- **Users** publishes the counts and the seeds independently, through `Promise.allSettled` (`fix/users-seeds-survive-db-failure`).
- **Orders** publishes the seeds before the `orders_total` read (`fix/orders-cache-metric-unit-seeds`).
- **Tracking** publishes all seeds before `CountByStatus`
  (`fix/tracking-cache-metric-unit-seeds`).

A database failure still fails the tick: the span ends in ERROR and the service logs
`metrics_collection_failed` (Users, Orders) or `metrics_tick_failed` (Tracking).

## A test that counts datapoints stops distinguishing ticks

Once failed ticks also publish, a test asserting "N datapoints arrived" can no longer tell a
healthy tick from a failed one, because both now emit the seeds. Wait on a series name that only
a successful tick publishes (for example `users_total`) instead of a datapoint count.

## Rules

- **Publish unconditional values before any call that can fail.** A seed, a heartbeat or a
  "still alive" marker placed after a read is conditional on that read.
- **Keep a failing tick loud.** Publishing the seeds first must not swallow the error: the tick
  still fails and logs.
- **Assert on a named series, not a datapoint count,** when both outcomes publish something.

## Related

- [[users-service-design]] — the Metrics section, zero-seeding subsection.
- [[orders-service-design]] — Orders publishes the same seeds.
- [[tracking-service-design]] — Tracking publishes the same seeds.
- [[x-cache-response-header]] — the cache metrics whose `cache_requests_total` series are seeded.
- [[2026-08-12-custom-business-metrics-cloudwatch-design]] — the design that introduced zero-seeding.
- [[2026-10-02-a-migration-dropped-the-poller-its-plan-specified]] — the same dashboards lost their seeds when the poller stopped.
