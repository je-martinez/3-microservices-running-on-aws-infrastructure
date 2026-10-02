---
title: "A Nest bootstrap error surfaces as a process exit in vitest, not as its cause"
type: lesson
area: users
status: active
created: 2026-10-02
updated: 2026-10-02
tags:
  - type/lesson
  - area/users
  - status/active
  - severity/medium
related:
  - "[[dependency-injection]]"
  - "[[testing]]"
  - "[[users-service-design]]"
  - "[[2026-10-02-a-migration-dropped-the-poller-its-plan-specified]]"
---

# A Nest bootstrap error surfaces as a process exit in vitest, not as its cause

## Symptom

Verified 2026-10-02 while writing `services/users/tests/boot-smoke.test.ts`, which boots the real
Users app through `main.ts`'s `createNestApp()`. A dependency-injection error, such as a provider
missing from `MetricsModule`, does not fail the test with its cause. Vitest reports one of:

- `process.exit unexpectedly called with "1"`
- `Worker exited unexpectedly`, for a factory error (for example `MetricsPublisher` wired through
  `useClass`).

## Cause

Nest's default `abortOnError` makes a failed bootstrap call `process.exit(1)` instead of throwing.
Vitest intercepts the exit and reports that, so the exception never reaches the test. `createNestApp()`
does not expose `abortOnError`, so a test cannot switch it off.

The real cause appears only in the `[Nest] ERROR` line of the test output, for example:

- `Nest could not find BusinessMetricsPoller element…`
- `Cannot destructure property 'client' of 'undefined'`

## Rule

When a boot test fails with `process.exit` or `Worker exited unexpectedly`, read the `[Nest] ERROR`
line first. Do not debug the exit itself. Background on the wiring rules: [[dependency-injection]].

## Related

- [[dependency-injection]]
- [[testing]]
- [[users-service-design]]
- [[2026-10-02-a-migration-dropped-the-poller-its-plan-specified]]
