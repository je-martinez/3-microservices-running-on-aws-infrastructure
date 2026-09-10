---
title: "A green mocked-Prisma test suite cannot catch a wrong assumption about the schema"
type: lesson
area: users
status: active
created: 2026-07-12
updated: 2026-09-07
tags:
  - type/lesson
  - area/users
  - status/active
  - severity/high
  - issue/JE-38
related:
  - "[[2026-07-12-prisma-lazy-promise-als]]"
  - "[[audit-fields]]"
  - "[[testing]]"
---

# A green mocked-Prisma test suite cannot catch a wrong assumption about the schema

## The failure

In JE-38, three real defects passed **every** mocked unit test and were caught only once the same
code ran against live Floci Postgres:

1. A NOT NULL foreign key made the command's event-first insert impossible — the mock had no FK
   to violate, so nothing in the test ever exercised the constraint.
2. Prisma's generated create-input type requires an explicit `id` (no `@default`) — the plan's
   "omit `id`, the extension stamps it" assumption did not even compile against the real client.
3. The P2002 duplicate-key guard read `err.meta.target`, which is `undefined` under Prisma v7's
   driver adapter — the real shape is
   `err.meta.driverAdapterError.cause.constraint.fields`. Retries threw an unhandled 500 instead
   of returning the intended `duplicate` result.

A fourth, related defect (2026-07-12, see [[2026-07-12-prisma-lazy-promise-als]]): the audit actor
persisted as `null` because Prisma's promises are lazy and the AsyncLocalStorage store had already
exited by the time the query actually ran. Mocks return eagerly, so **all 108 unit tests passed**
while live Postgres silently persisted nulls.

## Why

A mock encodes its author's assumptions about the database — its constraints, its generated
types, its driver's error shapes, its execution timing. It can only ever be as correct as those
assumptions, so it structurally cannot catch a *wrong* assumption: the mock and the code under
test share the same blind spot by construction. A green mocked suite is **necessary but not
sufficient** proof of correctness for anything that touches the schema, a driver adapter, or a
constraint.

## How to apply

For any task with a persistence path, before accepting the per-task review: run the real command
or route against live Postgres and exercise every branch it has (captured / duplicate / error),
not just the happy path. When a real error shape or constraint is discovered, update the mock to
match the **real** shape — so that reverting the fix makes the test fail, rather than leaving the
mock encoding the same wrong assumption that let the bug through the first time.

## Related

- [[2026-07-12-prisma-lazy-promise-als]] — the fourth defect in this list in full detail: an
  eager mock hiding a lazy-promise/AsyncLocalStorage timing bug that only a live Prisma client
  could reproduce.
- [[audit-fields]] — the audit-stamping convention the fourth defect broke.
- [[testing]] — the three-test-layers convention (unit/integration, internal E2E, gateway E2E);
  this lesson is the reason layer one is necessary but never sufficient on its own for anything
  touching persistence.
