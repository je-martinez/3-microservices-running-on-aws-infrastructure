---
title: "opentelemetry-instrumentation-asgi spans every ASGI message, so one HTTP response draws two identically-named spans"
type: lesson
area: tracking
status: active
created: 2026-08-21
updated: 2026-08-21
tags:
  - type/lesson
  - area/tracking
  - status/active
  - severity/low
related:
  - "[[tracking-service-design]]"
  - "[[2026-08-18-distributed-tracing-spans-design]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[logging-context]]"
---

# opentelemetry-instrumentation-asgi spans every ASGI message, so one HTTP response draws two identically-named spans

## What happened

Every Tracking endpoint's trace waterfall showed `<route> http send` **twice**, side by side,
under the SERVER span for the same route. It read exactly like a duplicated request — the same
name, two bars, no visible reason for the second one — which is the natural first hypothesis:
something in the handler, a middleware, or a retry was calling the response path twice.

It was not a duplicated call. `opentelemetry-instrumentation-asgi` instruments the ASGI
**transport**, not the HTTP request/response abstraction above it, and a normal HTTP response is
not one ASGI message — it is two: `http.response.start` (status + headers) followed by
`http.response.body` (the payload). The instrumentation opens a span per ASGI message it sees, so
one real HTTP response legitimately produces two spans named after the same `send` event. Measured
on `init_tracking`: 27µs and 6µs — both real, both accounted for, neither a second request.

## Why it looked like a bug

The waterfall gives no structural hint that the two bars are two halves of one transport-level
event rather than two application-level calls. Nothing in the SERVER span's children, in the
route's own code, or in the request count distinguishes "two ASGI messages for one response" from
"the handler ran twice." The only way to tell them apart is to already know this instrumentation
detail going in — reading the two span names side by side does not surface it.

## The fix, and why it lives in the collector, not the source

Dropped via a `filter/drop_asgi_transport_spans` processor in the collector's traces pipeline
(`observability/otel-collector-config.yaml`), matched by the two literal name suffixes
(`http send`, the ASGI transport spans' shared name shape), not by service — so any future ASGI
service in the repo inherits the fix for free.

The library does expose a way to suppress these at the source — `exclude_spans` — but only as a
**Python kwarg** to `instrument_app()`, with no corresponding `OTEL_*` environment variable in the
installed version (`0.65b0`). Using it would require calling `instrument_app()` explicitly in
`src/main.py`, which trades one problem for two worse ones:

1. It puts OTel configuration in the source tree, which
   [[logging-context#OTel configuration belongs in the environment, not in code]] already forbids
   for a documented reason — three prior silent tracing failures in this repo all came from
   configuring the SDK in code instead of environment variables.
2. `instrument_app()` called explicitly, after the module's other imports, instruments **after**
   import — which can silently produce **zero spans at all**, the exact failure shape that
   convention exists to prevent, not fewer of the two extra ones.

Filtering in the collector avoids both: no code change, and the fix survives regardless of import
order or which service adopts ASGI next.

## How to recognize this pattern elsewhere

Any auto-instrumentation library that hooks a **transport-level** protocol (ASGI, WSGI, raw
socket, a chunked/streaming API) rather than an application-level abstraction is a candidate for
this trap: the instrumentation is span-per-frame, not span-per-logical-operation, and a single
logical operation can legitimately be more than one frame. The tell is a waterfall with
identically-named sibling spans and no code path that would explain calling the same thing twice —
check whether the instrumented layer is a transport before assuming a duplicate call.

## Related

- [[tracking-service-design]] — where the fix and the measured durations are recorded, in
  `## Observability — workflow spans`.
- [[2026-08-18-distributed-tracing-spans-design]] — the tracing-spans design this fix landed
  outside the original scope of (see that spec's 2026-08-21 correction note).
- [[ADR-0019-distributed-tracing-opentelemetry]] — the tracing backend and SDK decision this
  instrumentation runs under.
- [[logging-context]] — the OTel-config-in-environment convention this fix's collector-side
  placement follows.
