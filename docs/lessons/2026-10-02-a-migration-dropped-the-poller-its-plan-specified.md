---
title: "A migration dropped the poller its plan specified, and a green suite could not see it"
type: lesson
area: users
status: active
created: 2026-10-02
updated: 2026-10-02
tags:
  - type/lesson
  - area/users
  - status/active
  - severity/high
related:
  - "[[users-service-design]]"
  - "[[2026-09-19-users-nestjs-migration-design]]"
---

# A migration dropped the poller its plan specified, and a green suite could not see it

## Symptom

On 2026-10-02 the OpenObserve "Business Metrics" dashboard showed
`Search stream not found: amazonaws_com_3mrai_users_total` on the Users, Password login and Email
OTP cards. Every other card rendered. The stream did not exist in org `3mrai`, and the running
Users container (up 44 hours) had zero `metrics_tick_succeeded` log lines.

## Cause

Commit `f24da7be` (2026-09-18, "feat(users)!: delete the Fastify implementation, NestJS is now
the service") deleted the Fastify `server.ts`, which was the only place calling
`businessMetricsPoller.start()`. The Nest `main.ts` started only `NotificationConsumerService`,
and `BusinessMetricsPoller` was not even registered as a Nest provider. The same commit deleted
the poller's unit test (`tests/shared/metrics/business-metrics.test.ts`) and its
`capture-app-logs` helper, so nothing failed: the type checker has no opinion on a `start()` call
that no longer exists, and the suite no longer contained the test that would have noticed.

## It was specified, not forgotten at design time

- The migration spec [[2026-09-19-users-nestjs-migration-design]] (Surface 6, Metrics) says the
  poller's `start()` must happen from `main.ts`, and calls this "a design constraint worth
  stating as its own line item during implementation review".
- The migration plan carried the exact code in Task 23 Step 5 ("Start both in main.ts"), a module
  test asserting the poller resolves and does NOT start on compile, and Task 24: a boot smoke
  test (`tests/nest/boot-smoke.test.ts`) written precisely to "catch the provider Nest only
  misses at bootstrap".
- None of those reached the repo. This is the same shape as
  [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] and
  [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]], this
  time in Users, and a close relative of
  [[2026-09-19-test-local-app-interceptor-hides-composition-root-omission]].

## Blast radius

Event-driven increments kept working: a registration still published `users_registered_total`
from its command, and the other counters likewise. What stopped was everything the poller itself
publishes:

- the `users_total` gauge, all three `HasPassword` series (`true`, `false`, `ALL`);
- the per-tick zero-seeds for `users_registered_total`, `password_resets_total`,
  `users_deleted_total`, `http_errors_total` (4xx/5xx) and `cache_requests_total`
  (hit/miss/bypass).

Of the seeded series, only `users_registered_total`, `password_resets_total` and
`http_errors_total` (Users) are scraped into OpenObserve, so those are the ones whose quiet-window
zeros disappeared from the dashboards. The others never reached OpenObserve anyway (see the first
follow-up below). It went undetected for about two weeks.

## Fix

PR #91 (squash `d9f93604`):

- `MetricsModule` provides `BusinessMetricsPoller` via a factory.
- `main.ts` starts it beside the consumer and stops it on `SIGTERM`.
- The 13 poller tests and the helper are restored.
- A new `metrics-module.test.ts` was verified to fail when the provider registration is removed.

## Open follow-ups (not fixed)

- `observability/otel-collector-config.yaml` scrapes none of `users_deleted_total`,
  `cache_requests_total` and `cache_operation_duration_ms` (no `metric_name` entry for any of
  them, and OpenObserve org `3mrai` has no stream for them). Users publishes them to CloudWatch,
  but they never reach OpenObserve. Whether that is intentional is not established.
- A follow-up audit found that the cut-over deleted tests for 14 still-live modules, none of which
  has a test importing it today: api-key-interceptor, cognito-auth-provider, prisma-extensions,
  current-user, email-hash, email-mask, nano-id, workflow-tracing, request-span,
  websocket-publisher, event-publisher, sql-logging, request-id, and the grpc address helper.
- The Task 24 boot smoke test is still missing.
- The "does not start on compile" test is still missing.

## Rules

- **When a migration replaces a composition root, diff the OLD entrypoint's start-up side effects
  (timers, consumers, servers) line by line against the new one.** A type checker and a green
  suite cannot see a `start()` call that no longer exists.
- **Do NOT delete a test whose subject still exists in `src`** without porting it or stating why
  in the commit. A deleted test for a live module is a red flag, not clean-up.
- **A plan task with a specified test that is absent from the repo is a gap**, regardless of the
  suite being green. Check the plan's tests against the repo before closing a migration.

## Related

- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] — the original: a specified
  requirement dropped in implementation, with review checking the diff rather than the spec.
- [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]] — the
  same shape (fully tested, never run), originally in Tracking.
- [[2026-09-19-test-local-app-interceptor-hides-composition-root-omission]] — a composition-root
  omission hidden by test wiring, from the same NestJS migration.
- [[users-service-design]] — the Metrics section, corrected in the same pass.
- [[2026-08-12-custom-business-metrics-cloudwatch-design]] — the design of the poller and the
  metrics it publishes.
- [[2026-09-19-users-nestjs-migration-design]] — the migration spec that stated the constraint.
- [[dependency-injection]] — the DI pattern the poller's factory provider follows.
- [[testing]] — the testing convention this gap slipped through.
