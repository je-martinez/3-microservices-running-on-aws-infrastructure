---
title: "Python's logging module silently discards extra= without a formatter that emits it"
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
  - "[[logging-context]]"
  - "[[tracking-service-design]]"
---

# Python's logging module silently discards extra= without a formatter that emits it

## What happened

Tracking's REST routers had been passing `order_id` and `user_id` correctly for weeks —
`logger.info("tracking created", extra={"order_id": order_id, "user_id": user_id})` — the call
sites were right. Every one of those fields was silently discarded. The log line that actually
reached stdout was uvicorn's default plain-text access-log format, with no trace of either
value anywhere in it.

## Why this happens

Python's standard `logging` module attaches `extra` keys as **attributes on the
`LogRecord` object**, not as part of the message string and not automatically surfaced by any
default formatter. `logging.Formatter`'s default format string
(`"%(asctime)s %(levelname)s %(message)s"`, or whatever uvicorn configures) only ever reads
the attributes it explicitly names. An `extra` key that isn't named in the active format
string — which is every key, under the stdlib's plain-text default — is set on the record and
then never read by anything. There is no warning, no `KeyError`, no indication in the output
that a field was supplied and dropped. The call succeeds, the record is emitted, and the data
simply isn't in it.

This is different from (and easier to miss than) a `KeyError` from referencing an `extra` key
*that collides with a built-in LogRecord attribute* (a documented, well-known pitfall). This
failure mode has no error path at all — it is a pure silent loss of already-correct data.

## The fix

A formatter (or, in Tracking's case, a `logging.Formatter` subclass used for structured JSON
output) must **explicitly read and emit** the record's extra attributes — either by
enumerating known field names to pull off the record, or by diffing the record's `__dict__`
against the stdlib's base `LogRecord` attribute set and emitting whatever remains. Passing
`extra=` at the call site is necessary but not sufficient; the formatter is where the data
either becomes visible or evaporates.

## Takeaway

`extra=` on a Python `logging` call is not "attach this data to the log line" — it is "attach
this data to the `LogRecord` object, to be read by whatever formatter happens to be
configured, if it happens to look for it." A change to logging behavior (adding a new
structured field, switching to JSON output, adding a collector) must be verified by inspecting
the **actual emitted output**, not by confirming the call site passes the right arguments —
the call site being correct is exactly what made this bug invisible for as long as it was.
This generalizes to any logging setup (Python `logging`, but the same shape of gap applies
anywhere a "structured" call sits in front of an unstructured or misconfigured sink): check
the sink, not just the call.

## Related

- [[logging-context]] — the shared cross-service log-context convention `order_id` and
  `user_id` belong to; this lesson is why Tracking's emission had to be re-verified against
  live output rather than trusted from the call sites.
- [[tracking-service-design]] — the REST routers whose calls were silently losing these
  fields.
