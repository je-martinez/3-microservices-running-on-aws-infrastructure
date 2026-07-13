---
title: "Prisma's lazy PrismaPromise silently broke AsyncLocalStorage-scoped audit actors"
type: lesson
area: users
status: active
created: 2026-07-12
updated: 2026-07-12
tags:
  - type/lesson
  - area/users
  - status/active
  - severity/high
  - issue/JE-39
related:
  - "[[audit-fields]]"
  - "[[2026-07-12-audit-actor-enum-design]]"
---

# Prisma's lazy PrismaPromise silently broke AsyncLocalStorage-scoped audit actors

## What happened

The Users service stamps `createdBy`/`updatedBy`/`deletedBy` via a Prisma `$allModels` extension
that reads the current actor from an `AsyncLocalStorage` (ALS) store (see [[audit-fields]]). Write
paths that need a semantic actor (e.g. self-registration) wrap the write in a helper,
`runAsActor(AuditActor.X, () => db.user.create({...}))`, meant to locally override the per-request
actor for the duration of that one write.

In practice this silently stamped the **wrong actor**:

- On the unauthenticated `POST /register` (no `x-user-id` header), rows were created with
  `createdBy = null` instead of the intended `users_api:register`.
- On an **authenticated** write using the same pattern, the row was stamped with the caller's raw
  Cognito `sub` instead of the intended semantic `AuditActor` value — a silent substitution, not a
  crash or a null, so nothing in normal testing or logs flagged it as wrong.

This is data corruption in the audit trail, not merely a missing value: `createdBy`/`updatedBy`
recorded a plausible-looking but incorrect actor, which is worse than an obvious null because it
looks correct on casual inspection.

## Why it was missed

The existing unit tests for these write paths used a mocked Prisma client, and passed. Mocked
Prisma clients return **eager** promises/thenables — calling `.create()` on a mock resolves (or at
least starts) immediately, which happens to work correctly with a synchronous
`ALS.run(store, () => promise)` wrapper regardless of the bug, because there's no real deferred
query execution for the ALS store's lifetime to race against. The bug only manifests against a
**real** Prisma client backed by a real query engine, where `create`/`update`/`deleteMany` don't
start any work until awaited. The mocked tests could not have caught this class of bug no matter
how thoroughly the mock's call arguments were asserted — the defect is about *when* execution
happens relative to the ALS scope, a property mocks don't reproduce.

The bug was only found by verifying persistence behavior against a live Postgres instance and
inspecting the actually-written `createdBy` values, rather than trusting that "the mock was called
with the right actor" as proof of correctness.

## The mechanism

1. Prisma's `create`/`update`/`deleteMany` return a **lazy `PrismaPromise`** — a thenable, not a
   native `Promise`. Constructing it starts **no work**; the query (and therefore the audit
   extension's `getActor()` call, which reads the ALS store) only runs when the promise is
   **awaited**.
2. `AsyncLocalStorage.run(store, fn)` exits its store the moment `fn` returns **synchronously**.
3. The original `runAsActor` was written as a non-`async` function whose callback was itself a
   non-`async` arrow: `runAsActor(Actor.X, () => db.user.create({...}))`. That arrow *returns* the
   un-started `PrismaPromise` synchronously — it never awaits it — so `ALS.run` sees a synchronous
   return and exits the store immediately, before the query (and the extension's actor read) ever
   runs.
4. The query later executes when its caller eventually awaits it, but by then the ALS store has
   already reverted to whatever was active at that **await site** — in this codebase, the
   per-request `onRequest`-populated store — not the semantic actor `runAsActor` was meant to
   inject.

## The fix

`runAsActor` now awaits the callback's result *inside* the ALS scope:

```ts
actorContext.run({ actor }, async () => await fn());
```

Awaiting inside keeps the ALS store alive for the full duration of the underlying query, regardless
of whether the caller's callback itself is `async` or returns a bare lazy `PrismaPromise`. Call
sites need no special form — the fix is entirely inside the wrapper, which is the right place for
it since callers shouldn't need to know about Prisma's laziness to use `runAsActor` correctly.

A regression test was added (`tests/shared/audit/actor-context.test.ts`) that models a real lazy
thenable — an object whose executor doesn't run until `.then()` is called — to reproduce the
ALS-exits-before-await-completes race without needing a live database for the unit test itself.

## Takeaway

When wrapping a call in an `AsyncLocalStorage` scope, the wrapper must **await the callee's result
inside** the scope — never just return whatever the callee hands back. This matters most for any
library that returns a **lazy thenable** rather than an eagerly-started native `Promise`: Prisma's
`PrismaPromise` is one example, but the same hazard applies to any deferred/lazy async primitive
(streams, cold observables, other lazy thenables). A callback that "returns a promise" is not
proof that the promise's underlying work has started, and `ALS.run` cares about synchronous
return, not about whether the returned value happens to be thenable.

More generally: mocks that eagerly resolve hide exactly this class of timing bug. Any test that
asserts ALS/context-propagation correctness around a real async dependency (a DB client, an HTTP
client, a queue client) must be verified against the real dependency's actual execution timing —
or, at minimum, a test double that faithfully reproduces its laziness — not a mock that resolves
immediately.

## Related

- [[audit-fields]] — the audit-stamping convention and the pitfall subsection this lesson expands on.
- [[2026-07-12-audit-actor-enum-design]] — design of the semantic `AuditActor` enum that `runAsActor` injects.
