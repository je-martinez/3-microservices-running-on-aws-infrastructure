---
name: logging-and-pii
description: Every log line carries the shared cross-service context; never log passwords, tokens, request bodies, or plaintext emails. OpenTelemetry is configured through environment variables, never in code.
paths:
  - "**/*.ts"
  - "**/*.js"
  - "**/*.py"
  - "**/*.cs"
---

# Logging, tracing, and PII

## Shared cross-service context

Every log line carries the same context fields:

`trace_id`, `cognito_sub`, `user_id`, `email_hash`, `order_id`, `duration_ms`

Unknown fields are **omitted, never null**. A `null` in a log field is
indistinguishable from a bug that failed to populate it.

## Never log

- passwords
- tokens
- full request bodies
- **plaintext email addresses**

Auth flows log a **masked** email (`jo*****e@gmail.com`). Everything else uses
`email_hash`.

## Flow events

Flow logs carry `app_event`, valued `<flow>_started`, `<flow>_succeeded`, or
`<flow>_failed`, plus a `reason` on failures.

There is **no SUCCESS severity** — SUCCESS is not an OpenTelemetry level.
Success is `INFO` plus `app_event=*_succeeded`.

## Which endpoints owe a flow log — READS INCLUDED

**Every endpoint gets a workflow span and at least one flow log. A read is not
exempt.** This was got wrong once, on the strength of an unverified claim that
reads carry no flow logs, so it is worth stating plainly. The *shape* differs
between reads and writes, and that difference is the whole point:

- **Reads** (e.g. `list_my_orders`, `read_cart`) get a span plus **one
  `_succeeded` line carrying a count** — no `_started` twin, no `_failed`
  branch. There is no intermediate step at which `_started` could be the last
  line seen, and the method names no failure of its own: a DB fault throws out
  of the workflow wrapper, which already records it on the span. Inventing a
  `reason` for a branch the code does not have is exactly what this convention
  forbids.
- **Writes** (e.g. `create_order`, `update_cart`, `delete_cart`) get the full
  `_started` / `_succeeded` / `_failed` triad plus `reason` on failures, because
  they *do* have real intermediate steps at which `_started` can be the last
  thing seen.

### Emit the line inside the activity

The `_succeeded` line must be written **inside** the workflow span so it carries
that span's `span_id`. The outer per-request completion line is written under the
framework's own HTTP span and cannot serve a span-scoped log lookup — a query
joining logs to a workflow span will simply not find it.

### Never re-pass identity at a call site

Do not pass `cognito_sub` / `user_id` again where an enricher already attaches
them to every line (in the Orders service, Serilog's `LogContextEnricher`).
Duplicating them is how a PII-adjacent field ends up somewhere nobody audits.
Pass only the count or the flow-specific field.

### Instrument the entry point, not a shared helper

Put the span on the **endpoint's entry point**, not on a helper it happens to
call. A helper reused by the write path — in Orders, `CartReadService.BuildAsync`
renders the response for the write path too — emits a spurious nested *read* span
inside every write when instrumented. The span belongs on `GetMyCartAsync`, the
entry point, not on the shared builder.

## OpenTelemetry configuration lives in environment variables, not code

Endpoint, protocol, and the disabling of the metrics/logs exporters all go in
the standard OTLP environment variables. **Do not configure the SDK in code** —
three separate silent failures in this repo came from exactly that: an
SDK option left `undefined` loses to auto-detection, and nothing reports an
error.

A new service needs no endpoint code at all, only the environment variables.
