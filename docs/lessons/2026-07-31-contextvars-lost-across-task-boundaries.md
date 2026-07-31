---
title: "Python contextvars silently drop request identity across two task boundaries"
type: lesson
area: tracking
status: active
created: 2026-07-31
updated: 2026-07-31
tags:
  - type/lesson
  - area/tracking
  - status/active
  - severity/medium
related:
  - "[[2026-07-12-prisma-lazy-promise-als]]"
  - "[[tracking-service-design]]"
  - "[[logging-context]]"
  - "[[user-id-vs-cognito-sub-ownership-key]]"
---

# Python contextvars silently drop request identity across two task boundaries

## What happened

Tracking carries per-request identity (`trace_id`, `cognito_sub`, `user_id` once resolved)
through Python's `contextvars`, the same shape [[logging-context]] establishes for every
service, so every log line in a request can be enriched without threading identity through
every function signature. Wiring this up hit two separate, independently-discovered traps
where the context silently failed to reach the place that needed it — no exception, no error,
the field was simply absent from the log line.

## Trap 1 — `asyncio.to_thread` copies the context; a merge inside it is discarded

`asyncio.to_thread` runs its callable in a fresh thread but hands that thread a **copy** of the
calling context (via `contextvars.copy_context()`), not a live reference to it. Tracking
resolves the caller's internal `user_id` via an outbound gRPC call to Users
([[tracking-service-design#gRPC — outbound client to Users]]), and the first implementation
tried to merge the resolved `user_id` into the request's logging context **from inside** the
`to_thread`-wrapped call. That merge happened on the copy. When control returned to the
awaiting coroutine, the original context — the one every subsequent log call in the request
actually reads from — was untouched. `user_id` never appeared on any log line downstream of
identity resolution, even though the gRPC call itself succeeded and returned the correct id
every time.

**Fix:** merge the resolved value **after** the `await`, in the caller's own context, using
the `to_thread` call's return value — never inside the offloaded callable itself.

## Trap 2 — Starlette's `BaseHTTPMiddleware` runs the app in a different anyio task

Starlette's `BaseHTTPMiddleware` does not call the downstream app in the same task the
middleware itself is running in — internally it spawns the request through a separate anyio
task group so it can stream the response back through the middleware layer. Any `contextvars`
a route handler sets are therefore invisible to a `BaseHTTPMiddleware` running "around" it,
because contextvars only propagate to a task's **children**, and the handler's task is not a
child of the middleware's task in this framework's implementation — they're siblings under a
shared task group. A middleware written to read request-scoped identity that a handler set
(rather than the other way around — middleware setting it before the handler runs) silently
saw nothing.

**Fix:** use pure ASGI middleware (a plain callable taking `scope, receive, send`) for
anything that needs to *set* context a handler or later ASGI layer must observe, instead of
`BaseHTTPMiddleware`. Setting context before dispatch, in the same task the rest of the
request runs in, avoids the task-boundary split entirely.

## Why both are the same underlying pattern

Both traps are instances of one rule: **a `contextvars` value only survives crossing into a
new task/thread if the propagation is explicit at that boundary** — either by not crossing a
boundary that copies rather than shares, or by setting the value before the boundary rather
than after. This is the same shape of bug as [[2026-07-12-prisma-lazy-promise-als]]: there,
`AsyncLocalStorage`'s scope exited before Prisma's lazy promise ever started its work, because
the wrapper returned instead of awaiting inside the scope. Here, the equivalent hazard is a
concurrency boundary (a new task or thread) rather than a synchronous-return timing gap — but
in both cases, the fix is the same shape: do the context-dependent work **inside** the scope
that holds the value, and only hand off already-resolved values across the boundary, never the
context itself.

## Takeaway

When request-scoped context (Python `contextvars`, Node `AsyncLocalStorage`, or equivalent)
needs to reach code on the other side of a task, thread, or framework-internal task-group
boundary, verify — don't assume — that the boundary actually shares the context rather than
copying or losing it. `asyncio.to_thread` copies. `BaseHTTPMiddleware` splits into sibling
tasks. Both look, from the call site, like ordinary sequential code; neither is. The safe
default is to resolve the value on one side, pass it across the boundary as an ordinary return
value or argument, and merge it into context only on the side that will actually read it.

## Related

- [[2026-07-12-prisma-lazy-promise-als]] — the sibling lesson on the Node/Prisma side: a
  different mechanism (`AsyncLocalStorage` + a lazy `PrismaPromise`), the same underlying rule
  that a context-scoped wrapper must keep the scope open until the context-dependent work has
  actually run.
- [[tracking-service-design]] — where the outbound gRPC identity-resolution call (Trap 1) and
  the REST handlers (Trap 2) live.
- [[logging-context]] — the per-service mechanism table this lesson's fix now belongs under
  for Tracking's entry.
- [[user-id-vs-cognito-sub-ownership-key]] — the `user_id` this lesson is about correctly
  reaching the log context is the same value that ADR requires never being confused with
  `cognito_sub`.
