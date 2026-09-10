---
title: "Activate a propagated context around the continuation that dispatches the handler, not the one that returns first"
type: lesson
area: users
status: active
created: 2026-07-19
updated: 2026-09-07
tags:
  - type/lesson
  - area/users
  - status/active
  - severity/high
  - issue/JE-77
related:
  - "[[2026-07-12-prisma-lazy-promise-als]]"
  - "[[logging-context]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[ADR-0003-grpc-inter-service]]"
---

# Activate a propagated context around the continuation that dispatches the handler, not the one that returns first

## The failure

A cross-service gRPC call (Orders calling Users' `GetUserById`) produced **two disjoint root
traces** instead of one joined trace. Orders' outbound span and Users' server span shared no
`trace_id` — from the trace backend's point of view, they were two unrelated requests.

## Root cause

The Users gRPC server's `x-api-key` interceptor extracts the caller's W3C `traceparent` from the
inbound metadata correctly (`extractParentContext`), but the original code activated it with
`context.with(parentContext, () => mdNext(metadata))` inside **`onReceiveMetadata`**.

`onReceiveMetadata` returns synchronously — calling `mdNext(metadata)` only forwards the metadata
onward through the interceptor chain, it does not run the handler. grpc-js dispatches the actual
async handler (and, with it, the auto-instrumentation that opens the server span) on a **later
tick**. By the time that happens, `context.with`'s callback has already returned and the
AsyncLocalStorage-backed context has already unwound back to whatever was active before — so the
server span opens with no active parent and comes out a ROOT (`refs=0`) instead of a child of the
inbound span.

## The fix

Stash the extracted context, and re-activate it in **`onReceiveHalfClose`** — the continuation
that actually dispatches the handler:

```ts
// onReceiveMetadata: extract and stash, but do NOT activate here — this callback
// returns before grpc-js dispatches the handler, so context.with would unwind
// before the handler (and its auto-instrumented server span) ever runs.
onReceiveMetadata(metadata, mdNext) {
  parentContext = extractParentContext(metadata);
  mdNext(metadata);
},
// onReceiveHalfClose dispatches the handler — activate the parent context HERE.
onReceiveHalfClose(hcNext) {
  context.with(parentContext, () => hcNext());
},
```

## Why

`context.with(ctx, fn)` (AsyncLocalStorage underneath) holds `ctx` active only for `fn`'s
**synchronous** body. Wrapping a callback that merely *schedules* later work — rather than being
the work itself — loses the context at the tick/await boundary between the callback returning and
the scheduled work actually running. This is the same failure family as
[[2026-07-12-prisma-lazy-promise-als]]: a context-propagation primitive that exits the instant its
callback returns synchronously, paired with a callback that only *starts* deferred work rather
than performing or awaiting it.

## Verification and the meta-lesson

Verified end to end: the trace showed `users.v1.Users/GetUserById` as a child of the Orders span
— one joined trace instead of two. Three earlier hypotheses were raised and each was **refuted
with a live diagnostic** before landing on the real cause: a missing `traceparent`, a `sampled=00`
flag, and a missing prerelease gRPC instrumentation package. None held up — the inbound
`traceparent` arrived correct and already sampled (`...-01`); the defect was entirely on the Users
receive side, in *when* the extracted context was activated, not in whether it arrived. A source
comment had asserted that the HTTP client instrumentation "injects the traceparent for gRPC," and
an earlier investigation had blamed the caller — both were wrong.

The transferable lesson: when a cross-service trace splits in two, **instrument the boundary and
read the real value** (what arrived, what got activated, and when) rather than trusting either an
existing comment or a prior investigation's conclusion.

This was originally verified against Jaeger's trace waterfall, before Jaeger was decommissioned on
2026-08-21 in favor of OpenObserve (see [[ADR-0019-distributed-tracing-opentelemetry]]) — the
finding itself does not depend on which backend rendered it. Re-verifying this class of fix today
means reading the trace waterfall in OpenObserve (`localhost:5080`), not Jaeger.

## How to apply

When propagating an OTel/AsyncLocalStorage-backed context through a grpc-js
`ServerInterceptingCall`, activate it around the interceptor continuation that **dispatches the
handler** (`onReceiveHalfClose`'s `hcNext`), never around the metadata callback
(`onReceiveMetadata`'s `mdNext`), which only forwards data and returns before the handler runs.

## Related

- [[2026-07-12-prisma-lazy-promise-als]] — the same "context exits before the real work runs"
  failure family, one layer down: an AsyncLocalStorage scope exiting before a lazy Prisma promise
  is awaited, instead of before grpc-js dispatches a handler.
- [[logging-context]] — the AsyncLocalStorage-based logging/tracing context convention this
  interceptor participates in.
- [[ADR-0019-distributed-tracing-opentelemetry]] — the tracing backend decision; records the
  Jaeger-to-OpenObserve migration this note's verification predates.
- [[ADR-0003-grpc-inter-service]] — the decision to use gRPC for inter-service calls, the surface
  this bug lived on.
