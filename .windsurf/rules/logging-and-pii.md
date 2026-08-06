---
trigger: manual
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

## OpenTelemetry configuration lives in environment variables, not code

Endpoint, protocol, and the disabling of the metrics/logs exporters all go in
the standard OTLP environment variables. **Do not configure the SDK in code** —
three separate silent failures in this repo came from exactly that: an
SDK option left `undefined` loses to auto-detection, and nothing reports an
error.

A new service needs no endpoint code at all, only the environment variables.