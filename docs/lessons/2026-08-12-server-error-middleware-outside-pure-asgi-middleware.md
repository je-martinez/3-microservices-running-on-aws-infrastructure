---
title: "Starlette's ServerErrorMiddleware sits outside every add_middleware layer, so pure-ASGI middleware never sees a 5xx"
type: lesson
area: tracking
status: active
created: 2026-08-12
updated: 2026-08-12
tags:
  - type/lesson
  - area/tracking
  - status/active
  - severity/medium
related:
  - "[[2026-07-31-contextvars-lost-across-task-boundaries]]"
  - "[[tracking-service-design]]"
  - "[[logging-context]]"
  - "[[testing]]"
---

# Starlette's ServerErrorMiddleware sits outside every add_middleware layer, so pure-ASGI middleware never sees a 5xx

## What happened

Tracking's `LogContextMiddleware`
(`services/tracking/src/shared/http/log_context_middleware.py`) is deliberately pure ASGI — a
plain `scope, receive, send` callable, not `BaseHTTPMiddleware`, for the reason already
documented in that file and covered in
[[2026-07-31-contextvars-lost-across-task-boundaries]]: `BaseHTTPMiddleware` runs the app in a
sibling anyio task, making handler `contextvars` invisible to it. To count HTTP errors as a
metric, the middleware wraps `send` and inspects every outgoing message, reading
`message["status"]` off `message["type"] == "http.response.start"`.

That worked for every status the **application itself** returns, 4xx included. It did not work
for an unhandled exception. Starlette installs `ServerErrorMiddleware` **outside** every
middleware added via `add_middleware` (and outside the whole ASGI app the ASGI middleware wraps).
When a handler raises, the exception propagates **out through** `LogContextMiddleware` first —
`send_wrapper` never receives an `http.response.start` at all — and the 500 response is built
**above** it, by `ServerErrorMiddleware`, after the exception has already left every layer the
service controls. The metric read "no server errors" while the service was actively returning
500s. A test asserting the 5xx case is what caught it; the 4xx-path test had been green all
along and gave no signal that the 5xx path was untested.

## Why this happens

Layer order for a Starlette/FastAPI app, outermost first:

```
ServerErrorMiddleware        <- installed by Starlette itself, not via add_middleware
  user middleware (add_middleware, in registration order)
    LogContextMiddleware     <- pure ASGI, wraps `send`
      route handler          <- raises
```

`ServerErrorMiddleware` exists specifically to catch anything user code did not catch and turn it
into a response — that is its entire job, and it can only do that job by sitting above
everything else, including everything installed via `add_middleware`. A `send` wrapper inside any
`add_middleware`-registered layer sees only what passes back down **through** that layer. An
unhandled exception never passes back down through it — it propagates as an exception, up and
out, and the response object appears for the first time one layer above where the wrapper is
watching.

This is the same shape of gap as `extra=` on a Python `logging.LogRecord`
([[2026-07-31-python-logging-extra-silently-dropped]]) and the two `contextvars` boundaries
above it: a mechanism that is correct for the common path and silently absent for one specific
path, with no exception or warning marking the gap — only a test that exercises exactly that
path proves it either way.

## The fix

Catch the exception at the ASGI callable's own boundary and publish the metric there, then
**re-raise immediately** so the exception still reaches `ServerErrorMiddleware` and the client
still gets its 500:

```python
try:
    await self.app(scope, receive, send_wrapper)
except Exception:
    self._record_status(500)
    raise
```

Two details are load-bearing:

- **`except Exception`, never `BaseException`.** A client disconnecting mid-request surfaces as
  `asyncio.CancelledError`, which subclasses `BaseException`, not `Exception`. Catching
  `BaseException` here would count every client-side disconnect as a server error, inflating the
  5xx series with events that were never a server fault.
- **The `raise` is not optional.** Swallowing the exception after recording it would produce a
  worse bug than the one being fixed — the request would return no response at all instead of a
  500, because `ServerErrorMiddleware` would never see the exception to build one.

## A second trap from the same task — settings validation crashing existing tests

The metrics feature's fallback publisher resolution originally went through `get_settings()`.
The REST test suite builds its app against an intentionally incomplete environment (no metrics
backend configured), and `get_settings()` raises Pydantic `ValidationError` on that environment —
so every 401/404/422 assertion across 60 pre-existing tests started crashing during app
construction, unrelated to what each test was actually checking. Gating on the env-direct
`metrics_enabled()` flag instead — the same pattern `e2e_testing_enabled()` already uses and
documents — avoided touching `get_settings()` (and its validation) at all when metrics are off.

The general lesson: a new cross-cutting feature that reads configuration through the
**validating** settings path can break tests that never mention the feature, if those tests'
environment happens to be incomplete for a setting the feature now touches. Prefer reading a
single env-direct flag to gate the feature, over pulling in the full validated settings object,
when the feature is optional and the rest of the app must keep working with it off.

## Takeaway

Pure-ASGI middleware that inspects outgoing messages by wrapping `send` only sees responses that
pass back down **through** it. An unhandled exception does not do that — it propagates up and
out, past every `add_middleware` layer, to `ServerErrorMiddleware`, which sits outside all of
them and builds the 5xx response after the fact. Any mechanism that counts or logs based on
`send` alone needs an explicit `except Exception: ...; raise` at its own boundary to see the
error path at all, and a test that actually forces a 5xx — not just 4xx — is the only thing that
proves the gap is closed.

## Related

- [[2026-07-31-contextvars-lost-across-task-boundaries]] — the reason `LogContextMiddleware` is
  pure ASGI rather than `BaseHTTPMiddleware` in the first place; this lesson is the next trap
  found in that same pure-ASGI middleware.
- [[tracking-service-design]] — where `LogContextMiddleware` and its metrics responsibility are
  specified.
- [[logging-context]] — the per-service mechanism table this lesson's Tracking entry extends.
- [[testing]] — the three-layer testing convention; the 5xx path here was only caught because a
  test specifically forced it, not by the 4xx tests that had passed all along.
