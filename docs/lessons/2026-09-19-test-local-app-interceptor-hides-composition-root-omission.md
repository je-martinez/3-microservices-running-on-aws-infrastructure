---
title: "A test that registers APP_INTERCEPTOR locally cannot see that the composition root omitted it"
type: lesson
area: users
status: active
created: 2026-09-19
updated: 2026-09-19
tags:
  - type/lesson
  - area/users
  - status/active
  - severity/high
related:
  - "[[2026-09-19-users-nestjs-migration-design]]"
  - "[[2026-09-19-users-nestjs-migration]]"
  - "[[cqrs]]"
  - "[[testing]]"
  - "[[users-service-design]]"
  - "[[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]]"
  - "[[2026-08-25-reads-are-not-exempt-from-observability]]"
---

# A test that registers APP_INTERCEPTOR locally cannot see that the composition root omitted it

## Finding

During the Users NestJS migration, **255 unit tests** (and the earlier 247-count suite)
passed while the production app had **no workflow tracing** and turned a routine profile
`404` into a `500`.

Root cause: `WorkflowInterceptor` was never registered in `app.module.ts`. The filter, the
auth guard, and the request-context middleware were wired; the interceptors were not.

`@nestjs/cqrs` does **not** run Nest's `APP_INTERCEPTOR` pipeline on `CommandBus` /
`QueryBus` dispatch. Cross-cutting work therefore happens by wrapping each `@Workflow`
handler's `execute` inside `WorkflowInterceptor.onApplicationBootstrap` — a lifecycle hook
that only runs if Nest **instantiates** the class. Unregistered, two silent effects stacked:

1. The bus emitted **no** workflow spans at all.
2. `RoutineFailure` reached the controller **unwrapped**, so `if (!user)` was truthy for a
   wrapped failure object and `serializeUser` threw on undefined dates — a routine not-found
   surfaced as a 500.

## Why the suite could not see it

Every handler test registers `WorkflowInterceptor` **locally** as an `APP_INTERCEPTOR`
provider inside its own `Test.createTestingModule()`. That makes the unit tests exercise the
interceptor's behaviour correctly — and simultaneously makes them structurally blind to the
question "did the real composition root register it?"

**A test that provides its own `APP_INTERCEPTOR` cannot detect that the real app does not.**
The green suite answered "does the interceptor work when wired?"; it never asked "is it
wired in production?"

This is the same *family* as
[[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]]
(Tracking's unreachable seams), but a Nest-specific shape: the component *is* constructed
in every test module and *absent* from the production module, and Nest's DI does not fail
closed on an unused class that nothing asks for.

## Guard

A **boot-the-whole-app** smoke (compile `AppModule`, hit a real route through the real
pipeline) is what closes this gap. After registering `WorkflowInterceptor` and
`ResponseLogInterceptor` as `APP_INTERCEPTOR` providers in `app.module.ts`:

- `GET /v1/users/me` with an unknown `x-user-id` returns `404 {"error":"not_found"}`
  (byte-identical to the frozen Fastify contract).
- `get_profile` workflow spans are emitted again.

Handler tests may still register the interceptor locally for isolation; that does not
replace a composition-root smoke.

## How to apply

- Treat "interceptor works in a handler test module" and "interceptor is registered in
  `app.module.ts`" as **two different claims**. The first never proves the second.
- For any Nest cross-cutting provider whose work runs only after Nest instantiates it
  (`OnApplicationBootstrap`, module init, global enhancers), add a boot smoke that fails
  when the class is absent from the production module — do not rely on per-handler
  `Test.createTestingModule` wiring.
- Prefer an explicit `CONTRACT:` on the composition-root registration naming the symptom
  (no spans + RoutineFailure unwrapping to 500) so a tidy-up does not drop the provider.

## Related

- [[2026-09-19-users-nestjs-migration-design]] — migration finding #4 (tests must go through the bus).
- [[2026-09-19-users-nestjs-migration]] — plan D7 / R-9 / R-14 on the interceptor pipeline.
- [[cqrs]] — `@nestjs/cqrs` does not run `APP_INTERCEPTOR`; bus wrapping is the pipeline.
- [[testing]] — boot smoke vs handler-module isolation.
- [[users-service-design]] — Users observability composition root.
- [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]] — sibling failure shape in Tracking.
- [[2026-08-25-reads-are-not-exempt-from-observability]] — missing workflow spans are still a defect on reads.
