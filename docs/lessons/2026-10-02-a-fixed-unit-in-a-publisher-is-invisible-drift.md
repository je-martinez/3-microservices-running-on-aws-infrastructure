---
title: A fixed unit in a publisher is invisible drift
type: lesson
area: shared
status: active
created: 2026-10-02
updated: 2026-10-02
tags:
  - type/lesson
  - area/shared
  - area/orders
  - area/tracking
  - area/users
  - status/active
  - severity/low
related:
  - "[[x-cache-response-header]]"
  - "[[testing]]"
---

# A fixed unit in a publisher is invisible drift

## What happened

Orders' and Tracking's CloudWatch publishers stamped every metric with unit `Count`. So `cache_operation_duration_ms` (milliseconds) was `Count` in those two services and `Milliseconds` in Users: one metric, three implementations, no test on the unit.

Nothing failed. Floci's `GetMetricData` returned the data regardless of unit, so dashboards and E2E checks stayed green while the unit was wrong.

## Fix

Each publisher resolves a per-metric unit (`*_ms` maps to `Milliseconds`), with unit tests in both services (merged 2026-10-02).

## Rule

A cross-service metric's unit is part of its contract. Test the unit per metric in every publisher, because the emulator does not enforce it. For the cache metrics, see [[x-cache-response-header]].

## Related

- [[x-cache-response-header]]
- [[testing]]
