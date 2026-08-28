---
title: Logging Context
type: convention
area: shared
status: active
created: 2026-07-19
updated: 2026-08-27
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[2026-08-15-request-id-correlation-design]]"
  - "[[2026-07-19-logging-context-and-tracing-design]]"
  - "[[2026-07-19-logging-context-and-tracing]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[ADR-0018-observability-openobserve]]"
  - "[[testing]]"
  - "[[2026-07-12-prisma-lazy-promise-als]]"
  - "[[2026-07-31-contextvars-lost-across-task-boundaries]]"
  - "[[2026-07-31-python-logging-extra-silently-dropped]]"
  - "[[2026-08-12-server-error-middleware-outside-pure-asgi-middleware]]"
  - "[[events-pipeline-design]]"
  - "[[2026-08-05-passwordless-otp-auth-design]]"
  - "[[2026-08-05-passwordless-otp-auth]]"
  - "[[passwordless-auth-type]]"
  - "[[2026-08-12-custom-business-metrics-cloudwatch-design]]"
  - "[[health-check-logging]]"
  - "[[2026-08-18-distributed-tracing-spans-design]]"
  - "[[2026-08-18-distributed-tracing-spans]]"
  - "[[2026-08-27-a-librarys-defaults-encode-assumptions-about-a-generic-service]]"
---

# Logging Context

## The shared log context

Every log line attaches the following fields, identically defined across services:

| Field | Source | Present when |
|---|---|---|
| `request_id` | inbound `x-request-id` if valid, else generated | **always**, every service, every line |
| `trace_id` / `span_id` | OpenTelemetry SDK (W3C) | **always**, all five runtimes (Users, Orders, Tracking, events-pipeline, realtime-events) |
| `cognito_sub` | JWT / `x-user-id` | authenticated request |
| `user_id` | internal resolution (`usr_…`) | once identity resolved |
| `email_hash` | SHA-256 of the trimmed, lowercased email, first 16 hex chars | whenever the email is known |
| `email` | request body, **masked** | auth flows only (register/login) |
| `order_id` | domain operation | Orders operations |
| `duration_ms` | request log | per response |
| `tracking_id` | domain operation | Tracking operations, once a tracking exists |
| `type` | envelope `type` | events-pipeline, every per-record log line |
| `author_actor` | envelope `author.actor` | events-pipeline, every per-record log line |
| `author_user_id` | envelope `author.user_id` | events-pipeline, when a human originated the event |
| `author_cognito_sub` | envelope `author.cognito_sub` | events-pipeline, when a human originated the event and supplied a Cognito sub |

**Rule: unknown fields are OMITTED, never emitted as null.** A `user_id: null` reads as a
resolved value that happens to be null, not as "not applicable to this line" — that ambiguity is
worse than the field's absence.

> [!info] events-pipeline and realtime-events now emit `trace_id`/`span_id` too (JE-138, JE-159)
> The events-pipeline Lambda used to carry no OpenTelemetry SDK at all; it now does, and its
> `trace_id`/`span_id` are no longer the exception this table once carved out for them. Verified
> in a real handler log line: `"trace_id":"fc8807db687455d360d72fe89402fd39",
> "span_id":"6c5a3bb77d629f48"` — 32/16 lowercase hex, the same shape every other service already
> produced. The 4 `functions/realtime-events` WebSocket entry points (`connect`, `disconnect`,
> `default`, `authorizer`) got the SDK in the same milestone (JE-159), so they are no longer an
> exception either. Full design and the packaging constraint that shaped how these Lambdas'
> internal spans are created: [[2026-08-18-distributed-tracing-spans-design]] /
> [[2026-08-18-distributed-tracing-spans]].

> [!note] `author_*` fields — flattened, and prefixed on purpose
> The events-pipeline derives `author_actor`/`author_user_id`/`author_cognito_sub` from the
> envelope's `author` object (`functions/events-pipeline/src/handler.ts`, `envelopeContext`) and
> flattens them into the log context rather than nesting a raw `author` object — a nested object
> would arrive as a structured sub-document the collector cannot filter on directly. The
> `author_` prefix is load-bearing, not cosmetic: the envelope's root `user_id` is the event's
> **subject** (who the event is about); `author_user_id` is **who acted**. An unprefixed
> `user_id` on the author would silently overwrite the subject's `user_id` in the same context —
> a line that reads as correct while attributing the event to the wrong user.
> `author_user_id`/`author_cognito_sub` are **omitted**, never null, when no human originated the
> event (a carrier webhook, a TestMode timer); `author_actor` is always present — every event has
> a producing actor, even a non-human one (e.g. `tracking_api:carrier_status_update`).

## `request_id` — cross-service correlation without an OTel SDK

> [!info] Implemented and verified end to end (2026-08-15)
> Full design: [[2026-08-15-request-id-correlation-design]]. One request id followed across all
> four services in a single flow: users (3 lines) → orders (12) → tracking (13) →
> events-pipeline (3), confirming all three propagation hops (HTTP, gRPC, SQS). Test counts after
> the change: users 353, orders 164, tracking 630, events-pipeline 210.

Format: `req_` + a 24-character Nano ID drawn from the custom letters+digits alphabet (28
characters stored total), following the `prefix_nanoid` shape [[nano-id]] already establishes for
entity ids (`ord_`, `usr_`, …). See [[nano-id#Format change (2026-08-15) — custom alphabet, 28
characters stored]] for the full rationale.

**Why it coexists with `trace_id` rather than replacing it.** At the time this field was designed,
the events-pipeline ran no OTel SDK at all, and neither did the realtime WebSocket Lambdas — so
`trace_id` was absent exactly where cross-service correlation was hardest. Both now carry
`trace_id`/`span_id` too (see the info callout above; JE-138, JE-159), so that gap has closed —
but `request_id` remains valuable independently of that: it has no SDK dependency and works
identically in all five runtimes (Node, .NET, Python, Lambda) whether or not OTel is wired up,
and it survives the one hop `trace_id` cannot cross — the WebSocket frame to the browser client
(see [[2026-08-18-distributed-tracing-spans-design#Decision 6 — realtime-events: IN scope|Decision 6]]'s
honest limitation on that). The two fields answer different questions and neither replaces
the other: a service with full OTel coverage still carries both on the same line.

**Rule, applied once at the outermost ingress point of each service:**

```
x-request-id present AND valid?  -> use it
otherwise                        -> generate req_<nanoid>
```

**Validation is a security control, not a format check.** Only `^req_[A-Za-z0-9]{24}$` is
accepted (the pattern derived from [[nano-id]]'s config, per its "every regex is derived, never
hand-written" rule); anything else is **discarded** and a fresh id is minted, silently — never a
`400`.
`x-request-id` is untrusted input that lands on every log line for the rest of that request and is
forwarded downstream, so an unvalidated value could inject adversarial content into the log
stream's most pervasively-present field. Rejecting silently (rather than failing the request) is
equally deliberate: a correlation header is a convenience, not a contract the caller must honor —
it must never be able to fail an otherwise valid request.

**Propagation across the three hops:**

| Hop | Mechanism |
|---|---|
| orders → tracking | HTTP `x-request-id` header |
| tracking → users | gRPC `x-request-id` metadata entry |
| orders/tracking → events-pipeline | root `request_id` field on the SQS envelope |

**The envelope field is `.optional()` with `.min(1)`.** A message already queued at deploy time
carries none, and a required field would fail Zod validation as a `PermanentError` — dead-lettering
the message and silently losing the notification email it was meant to trigger. Absent means the
key is **omitted**, never null, on the consumer's log line — the same omitted-never-null rule the
shared context table already follows.

### Three implementation traps (all found by tests, all likely to recur on a new service)

> [!warning] (1) Seed the id BEFORE the auth guard, not after
> In Users the id was originally seeded after the auth guard, and that guard short-circuits a
> `401` with `return` rather than `done()` — so `401`s, the requests people actually investigate,
> had no `request_id` at all. Orders had the same trap. Seed correlation context at the very first
> hook/middleware, before anything that can short-circuit the response.

> [!warning] (2) .NET: `AsyncLocal` is only visible to frames BELOW the writer
> Orders seeded the id in `CallerContextMiddleware`, but `UseSerilogRequestLogging` is the
> **outermost** middleware and writes its `request completed` line on the way back out — by then
> the inner frame that set the `AsyncLocal` value is already gone, so the single most useful log
> line would have been the only one without an id. Fixed by installing a mutable holder in the
> outermost middleware and filling it from within an inner one.

> [!warning] (3) Tracking: an allow-list and a `break` both silently drop the field
> Tracking's `_ALLOWED_KEYS` gates what reaches a log line; without adding `request_id` there,
> `_clean` dropped it silently, with no error. Separately, its middleware's header-reading loop
> `break`ed on the first header match — with two headers to read (e.g. `x-request-id` alongside
> `x-user-id`), it lost whichever one arrived second.

## PII rules

- `email_hash` = SHA-256 of the trimmed, lowercased email, hex-encoded, **first 16 characters**.
  This is a **cross-service contract**: Users' `hashEmail` and Orders' `EmailHash.Compute` must
  agree exactly on normalization and truncation, or cross-service filtering by email silently
  fails to correlate instead of erroring. Both pin the literal `b4c9a289323b21a0` for
  `user@example.com` in a test, so a drift fails in CI rather than silently returning no results.
- Plaintext email is **never** logged. Auth flows (register/login) log a **partially masked**
  form instead: `john.doe@gmail.com` → `jo*****e@gmail.com` — local part masked (first 2 and
  last 1 character visible), domain fully visible because it carries operational signal (e.g.
  which provider is failing) and identifies nobody on its own.
- Never log passwords, tokens, or full request bodies.
- **Never log an OTP code — not masked, not hashed, not truncated.** Email masking
  (`jo*****e@gmail.com`) works because an email is a high-entropy identifier: knowing the masked
  form doesn't materially help guess the real one. A 6-digit OTP code has only ~1,000,000
  possibilities — revealing half (`12****`) collapses the search space to 1,000 candidates, and
  even a truncated hash of the full code is brute-forceable offline in milliseconds. The code
  stays valid for its whole TTL, so any log access during that window becomes a live
  authentication vector for as long as the entry exists. The one OTP-related log line
  (`otp_challenge_created`, `email_hash` + `challenge_id` + `ttl_seconds`) gives full
  traceability with none of the risk — the code must never appear in it, nor in a `reason` string
  or a validation-error message that echoes the offending input. See
  [[2026-08-05-passwordless-otp-auth-design]] and [[passwordless-auth-type]].

> [!warning] Every PII rule above applies equally to span attributes, not just log fields
> A workflow span's attributes are exported to OpenObserve the same way a log line is — both
> signals share the one backend (see [[ADR-0019-distributed-tracing-opentelemetry]] Amendment,
> 2026-08-21) — so there is no separate, laxer rule for spans. Never a plaintext email on a span
> attribute (masked form or `email_hash` only, same as logs), and never an OTP code, in any form,
> on a span attribute or a span's `reason`/status message. [[2026-08-18-distributed-tracing-spans-design]]
> follows this by construction: workflow spans carry the same attribute set as the flow's log
> line, so a producer that keeps the log clean keeps the span clean too — but it is stated here
> explicitly because "the log rule" and "the span rule" are easy to treat as two separate things
> to remember, and they are one rule applied to two exporters.
>
> This includes **library-level instrumentation, not just spans this repo writes by hand**:
> Tracking's `otelsql` wrapper records `db.query.text` — the literal SQL, including bound
> values — by default, and had to be explicitly disabled once a real instrumented `UPDATE` was
> observed emitting `shipping_address` in plaintext on the span. A database-instrumentation
> library's defaults assume a generic service; verify them against what your service's queries
> actually carry. See
> [[2026-08-27-a-librarys-defaults-encode-assumptions-about-a-generic-service]].

> [!warning] Pitfall — mask at the call site, not in the ambient context
> The masked email goes on the **log call site**, not in the AsyncLocalStorage context. Putting
> it in the ambient per-request context leaked it onto every later line of the request, including
> the unrelated `request completed` line.

## Flow logs

Only flows with real diagnostic value get explicit logs: `register`, `login`, `create-order`.
Trivial CRUD keeps only the automatic request log — noise is what makes logs unread.

Pattern: `<flow>_started` / `<flow>_succeeded` / `<flow>_failed` in an `app_event` field, plus a
`reason` field on failures, one branch per failure mode **that actually exists in the code** (not
a speculative list).

> [!info] The workflow span carries the SAME `app_event`/`reason` as the flow's log line
> Each of the 11 flows with a full `app_event` triad also gets a manual `INTERNAL` workflow span
> (`register`, `create_order`, `init_tracking`, …), carrying the exact same attributes as the
> log line at the same point — `app_event`, `reason` on failure, plus whatever domain id the log
> already has (`order_id`, `user_id`, …). Trace and logs tell the same story this way, and neither
> needs the other to be understood; a `*_failed` span sets `ERROR` status with the identical
> `reason` string the log carries, not a paraphrase of it. Full design:
> [[2026-08-18-distributed-tracing-spans-design]].

**There is no `SUCCESS` severity, by design.** The original input asked for a `[SUCCESS]` level;
it is not an OpenTelemetry severity (the spec defines `TRACE`/`DEBUG`/`INFO`/`WARN`/`ERROR`/
`FATAL`), and inventing one would break the alignment that makes `severity` color correctly and
lets standard severity filters work. Success is `INFO` + `app_event=*_succeeded`. Query patterns:

```sql
SELECT * FROM logs WHERE app_event LIKE '%_succeeded'
SELECT app_event, count(*) FROM logs WHERE app_event LIKE 'register_%' GROUP BY app_event
```

## OTel configuration belongs in the environment, not in code

Three separate faults traced back to configuring the SDK in code when the OTLP spec already
defines an environment variable for it. **Each failed silently** — spans were produced, nothing
arrived at the collector, and nothing complained.

| Setting | What went wrong | Rule |
|---|---|---|
| Endpoint path | Orders POSTed to the collector root, got a 404 | `OTEL_EXPORTER_OTLP_ENDPOINT` is a **base** URL; the SDK appends `/v1/traces` itself. Never hand-build the full path. |
| Protocol | .NET defaulted to gRPC (`4317`) against the HTTP port (`4318`) | Always set `OTEL_EXPORTER_OTLP_PROTOCOL` explicitly — Node and .NET default to different protocols. |
| Metrics/logs exporters | `NodeSDK` auto-detects both from the endpoint; the collector only serves `/v1/traces` | Set `OTEL_METRICS_EXPORTER=none` and `OTEL_LOGS_EXPORTER=none`. An `undefined` SDK option reads as "not overridden," so auto-detection still wins — this cannot be fixed from code. |

**Rule: reach for the standard environment variable first; write code only for what has no
variable.** A new service needs **no** endpoint or protocol code — only these env vars set in
`docker-compose.yml`. Also enable the SDK's own diagnostics (`diag.setLogger` /
`OTEL_DIAGNOSTICS__LOGLEVEL`) on any new integration — a silently-dropped exporter is how all
three of the faults above went unnoticed for as long as they did.

**ESM note (Users):** Users is `"type": "module"`, where static imports are hoisted and resolved
before any module body runs. The OTel SDK must be loaded via `node --import`, not imported
"first" inside the entrypoint file — otherwise instrumented libraries are already in the module
graph before `sdk.start()` runs, and their instrumentation silently never patches.

## Metrics — the third pillar, and why it does NOT go over OTLP

Logs ([[ADR-0018-observability-openobserve]]) and traces
([[ADR-0019-distributed-tracing-opentelemetry]]) both travel over OTLP into OpenObserve — the
single backend for both signals since Jaeger's removal (Amendment, 2026-08-21). Metrics
deliberately do not:
`OTEL_METRICS_EXPORTER=none` in every service is **correct and remains in place** — turning it on
would open a second, parallel metrics path with different semantics for the same numbers. Instead,
metrics are custom business/error counters and gauges published straight to **Amazon CloudWatch**
(`PutMetricData`), which the collector's existing `aws_cloudwatch` receiver polls
(`GetMetricData`) and re-exports into OpenObserve as its own signal, alongside logs and traces but
through a different mechanism. Full design and the spike that established it:
[[2026-08-12-custom-business-metrics-cloudwatch-design]].

**Namespace and dimensions.** Every metric in every service publishes under the single namespace
`3MRAI`. `Service` is a dimension (`users`, `orders`, `tracking`, `events-pipeline`), never a
namespace split — this keeps discovery and dashboard queries uniform. Dimensions are low-cardinality
labels only — never a user id, email, or order id.

**Publishers never break the operation that produced the metric.** Every metric-publishing call is
log-and-swallow on failure, the same stance `SqsEventPublisher`/the events-pipeline's producers
already take for event publishing (see [[events-pipeline-design#Producers and their
publish-failure policy]]) — a metrics backend being down must never fail a registration, an order,
or an email.

### Three verified Floci/OpenObserve gotchas for metrics (load-bearing)

> [!warning] (a) Floci's CloudWatch does NOT aggregate across dimensions — and fails silently
> A metric published with a given dimension set (e.g. `Service=orders`) is only readable by
> querying that **exact** dimension set. Querying the same metric name with a different or omitted
> dimension set does not error — it returns `Values: []` with `StatusCode: "Complete"`, i.e. "query
> fine, no data." Real CloudWatch would aggregate across the dimension; Floci does not. Two
> consequences: every dashboard query must name the exact published dimension set, and **a "total"
> across a breakdown must be published as its own series** with a sentinel dimension value (e.g.
> `EmailType=ALL`), never derived by omitting a dimension at query time.

> [!warning] (b) OpenObserve prefixes and lowercases dimensions, and sanitizes the metric name into the stream name
> A CloudWatch dimension `Service=orders` arrives in OpenObserve as **`dimensions_service`**
> (prefixed with `dimensions_` and lowercased) — the unprefixed `Service` form only applies on the
> CloudWatch side (`GetMetricData`, the collector's `queries` block). The metric name is sanitized
> into the stream name the same way: `amazonaws.com/3MRAI/orders_total` becomes the stream
> `amazonaws_com_3mrai_orders_total`. Every dashboard query must use the OpenObserve-side prefixed,
> lowercased, sanitized names — the CloudWatch-side names will silently return nothing there.

> [!warning] (c) Query gauges with `max()`, counters with `sum()` — never the other way round
> A gauge published once per collection window has exactly one sample in that window, so `max()`
> (CloudWatch stat `Maximum`) returns that sample's value. Using `sum()`/`Sum` on a gauge **adds**
> every sample that landed in the window — if two publishes land in one window, the reported value
> is a multiple of the real count, not the real count. This is the single easiest way to produce a
> plausible-looking wrong number on a dashboard here. Counters use `sum()`/`Sum`, as usual for a
> range query over an incrementing value.

> [!warning] (d) A metrics dashboard panel must use PromQL, not SQL
> The OpenObserve UI dispatches on the panel's `queryType`: it reaches metric streams through
> `prometheus/api/v1/query_range`, while the SQL path is built for log streams. A metrics panel
> declaring `queryType: "sql"` renders **"Error Loading Data" and never issues a search request at
> all** — the access log shows the dashboard being fetched and then nothing.
>
> The trap is that **the SQL is not wrong**: it returns correct rows through the
> `_search?type=metrics` API, which is the right way to verify the *ingest pipeline*. Verifying
> there proves the data arrived; it does **not** prove the panel renders. The query path and the
> render path fail independently.

These four, plus the receiver's `delay` (10m default — real AWS latency compensation Floci does
not have, and which must be `0s` locally or nothing appears for the first ten minutes) and the
`collection_interval >= period` startup validation, are recorded in full with worked examples in
[[2026-08-12-custom-business-metrics-cloudwatch-design]] — this section is the short form referenced
by every service's metrics section rather than restated in each one.

> [!info] Dashboard authoring is documented separately
> The panel-level rules — the **192-column** grid (not 24), the **required `fields.x`/`fields.y`**
> declarations that `customQuery: true` does *not* exempt, and the difference between
> "Error Loading Data" and "No Data" — live in `observability/dashboards/README.md`, beside the
> dashboards themselves. Each of those cost a debugging session because the README previously
> stated the wrong value.

## Severity must reach the record's native fields

Writing `severity_text`/`severity_number` only as log attributes leaves them queryable but
invisible in dashboards: OpenObserve colors charts from the record's own native `severity` field,
which was `0` (`UNSPECIFIED`) for every row across the system. Every chart rendered as one
undifferentiated color. The collector now mirrors both values onto the native fields so severity
coloring and filters work as expected.

> [!info] Both Lambda producers now emit the shared severity/service fields too
> `realtime-events` (`functions/realtime-events/src/shared/logging/logger.ts`) and the Cognito
> `CUSTOM_AUTH` `otp-challenge-lambda` trigger (`infra/modules/cognito/otp-challenge-lambda/index.mjs`)
> emit `severity_text`/`severity_number` (OTel's scale) and `service_name` like every other
> producer in this table. Previously:
> - `realtime-events` emitted Pino's own numeric `level` (30/40/50…) and a bare `service` field —
>   neither matches the shared schema, so its lines (including a genuine WARN like
>   `ws_connect_denied`) arrived in OpenObserve at severity 0, indistinguishable from INFO in
>   every severity filter and unattributable by a `service_name` filter.
> - The Cognito trigger hardcoded `level: "info"` on **every** line, so a wrong OTP code and a
>   successful challenge were the same severity — a failure that looked as loud as a success.
>
> Both now build the pair from a real severity decision at the call site, translated to OTel's
> numeric scale (`INFO` → 9, etc.) — the same translate-at-the-producer principle the rest of this
> note follows for every other source.

> [!info] Compliance is enforced by an automated test
> `e2e/tests/observability/unclassified-logs.spec.ts` fails whenever any record reaches
> OpenObserve's `unclassified` stream, so a producer that stops emitting `service_name` and
> `severity_text`/`severity_number` per this convention breaks CI instead of silently going
> invisible. See [[openobserve-runbook#The unclassified stream — the 7th stream, and it should
> be empty]] for what that stream is and how to read it.

## What belongs in the log stream

> [!info] Guiding rule
> A request should appear **once**, logged by the layer with the most context. Edge/proxy logs
> are ingested only for failures the application layer cannot observe — 5xx, upstream errors, and
> anything the parser could not classify.

A succeeding health-check probe is the other deliberate exception to "every request gets a
`request completed` line": it is exempted while it returns 2xx, and logged like any other request
otherwise. Full rule and per-service mechanism: [[health-check-logging]].

nginx access logs under 500 are dropped by the collector: for a 2xx/3xx/4xx, the service already
logs the same request with the *why*. 5xx are kept — verified by stopping the users container and
hitting its route, which produced `nginx ERROR GET /v1/users/health 502`, a failure no service
could record because none was running to record it.

Non-JSON sources (like nginx's combined log format) need explicit parsing in the collector to
reach the shared schema.

> [!warning] Users' Prisma statements and the events-pipeline's Mongo commands also leave `logs`
> The SQLAlchemy split below is not Tracking-only. **Users' Prisma statements** go to the `sql`
> stream too (`services/users/src/shared/db/sql-logging.ts`), routed by the collector's `sql`
> pipeline first branch: the statement text itself IS the log message (`logger.info({duration_ms},
> event.query)`), matching the same `^(SELECT|INSERT|...)` pattern SQLAlchemy's echo does. **The
> events-pipeline's Mongo commands** go to `docdb` instead, via a `db_statement` attribute
> (`functions/events-pipeline/src/shared/db/command-logger.ts`) — deliberately **not** named
> `commandText`, because that is the attribute the `sql` pipeline claims records by, and a record
> carrying both names would be matched by both pipelines and stored twice. Neither producer logs
> parameter/bound values or document bodies: for Users that is emails, reset codes and tokens; for
> the events-pipeline it is the event payloads themselves. See [[openobserve-runbook]] for the
> full per-stream routing table and the `resource.attributes[...]` pitfalls that make these
> filters easy to write wrong.

> [!warning] Historical (Python/SQLAlchemy) — SQL echo went to its own OpenObserve stream, never the main `logs` one
> The Python Tracking service ran with SQL echo on outside production (`Settings.echo_sql`), and
> a single tracking read could emit several `SELECT`s — enough that, mixed into the shared stream,
> application events were buried among the queries that served them and roughly a third of all
> records carried no `service_name` at all and could not be filtered by service. The collector's
> `sql` pipeline (still present, see [[openobserve-runbook]]) splits statements matching
> `^(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)` or carrying `commandText` into a
> **separate stream**, via two OTel pipelines over the same receivers with complementary filters
> and two exporters differing only in the destination stream-name header — and Users' Prisma
> statements and Orders' EF Core commands still route through it (see the warning above).
>
> **This does not apply to the Go Tracking service.** `services/tracking-go/` instruments queries
> with `otelsql`, which attaches `db.query.text` as a **span attribute**, not a log record — so it
> was never going to match the `sql` pipeline's log-based filter, and the question the SQLAlchemy
> activation mechanism answered (raise the `sqlalchemy.engine` logger's level, never
> `create_engine(echo=True)`, to avoid a duplicate plain-text handler) does not have a Go
> equivalent to get right. Go's version of "don't leak this into observability" is a different
> risk in a different place: `otelsql` records `db.query.text` **by default**, which is a PII
> concern (a captured `shipping_address`) rather than a log-duplication one, and the fix is
> `otelsql.DisableQuery`, not a logger level — see `services/tracking-go/CLAUDE.md` §11 and
> [PII rules](#pii-rules) below.

> [!warning] Do not filter or alert on `cloudwatch_log_stream`
> Under the local emulator, the `aws_cloudwatch` receiver substitutes the placeholder
> `THIS IS INVALID STREAM` when it cannot resolve a real stream name. Use `service_name` and
> `cloudwatch_log_group_name` instead.

## Which spans answer OpenObserve's "View Logs" — and which never will

> [!info] JE-179
> Filed after "View Logs" on a span in OpenObserve repeatedly returned nothing, read each time as
> a new bug. It isn't one: most spans in a trace belong to third-party instrumentation where our
> code never runs, so there is no log line to return. This section exists so the empty result
> reads as expected, not as a regression.

**"View Logs" filters by `trace_id` AND `span_id`, with no fallback.** Per OpenObserve's own
docs on the traces view (https://openobserve.ai/docs/user-guide/data-exploration/traces/traces/):
"Select View Logs. The Logs page opens, filtered to the current trace_id and span_id." A span with
no log line carrying that exact pair returns an empty page — this is the button working correctly,
not a broken link. `trace_id_field_name`/`span_id_field_name` (this repo's organization settings)
only rename which fields the filter targets; they are already correct here. `cross_links` is for
linking a span to an *external* system, not for this. **There is no configuration knob that makes
a third-party span's page non-empty** — the fix is not to look for one.

**Measured on one real `create_order` trace** (`87a65b0cc3f1a30ffd177d9769461546`, spanning all
four services):

| | Count |
|---|---|
| Total spans | 49 |
| With at least one log line | 7 |
| With none | 42 |

Of the 42 with no log line:

| Group | Count | Examples |
|---|---|---|
| Third-party instrumentation — our code never runs inside them | 39 | `prisma:client:operation`, `prisma:client:serialize`, `prisma:client:db_query`, `pg-pool.connect`, `pg.connect`, EF Core internals, AWS SDK client spans (`SQS.SendMessage`, `HttpRequest`, `CredentialsRetrieval`), FastAPI's `http send`/`http receive` pair, `dns.lookup`, `tcp.connect` |
| Ours, and have since been fixed (JE-179) | 3 | `sqs.publish order_created` (orders), `ses SendEmail` (events-pipeline), the gRPC client span for `/users.v1.Users/GetUserById` (tracking) |

The 39 are not an oversight to close. Logging inside each of them would mean a line per DNS
lookup and per connection-pool checkout — precisely the noise this convention already argues
against elsewhere in this document (see [[health-check-logging]] and the health-check exemption
above: 353 of 368 lines in one hour were a single health-check route). A span existing is not the
same claim as "our code ran here"; only the second implies a log line.

**The rule going forward:** every span **our own code** creates must emit at least one log line
within its scope, or the exception is written down explicitly (as this section now does for the
39 third-party spans). This repo currently creates spans at 33 call sites across five runtimes —
users 15, orders 6, tracking 1, events-pipeline 7, realtime-events 4
([[2026-08-18-distributed-tracing-spans-design]]) — and JE-179 closed the gap on the last 3 that
had none.

> [!warning] Measurement trap — a stale trace id looks like 0/49, not 42/49
> The first attempt at counting "spans with a log line" against this same trace returned **zero**
> matches for all 49 spans, which looked like every producer was broken at once. It wasn't: the
> log lines had already aged out of OpenObserve's retention window while the trace itself was
> still live in Jaeger (traces and logs did not share a retention clock — Jaeger has since been
> removed, see [[ADR-0019-distributed-tracing-opentelemetry]] Amendment, so both signals now share
> OpenObserve's one retention config; a fresh trace id is still the reliable habit regardless).
> Re-running against fresh traffic — not a reused, already-old `trace_id` — produced the real
> 7/49. Anyone re-measuring this should generate a new trace, not query an old id and conclude the
> pipeline regressed.

## Per-service mechanism

- **Users:** an AsyncLocalStorage store (`shared/logging/log-context.ts`), a sibling to the audit
  `actor-context.ts`, merged into every record by Pino's `formatters.log`.
  > [!warning] Pitfall — Prisma's lazy promises break ALS
  > Prisma promises are lazy; any `await` must happen **inside** the ALS callback, or the context
  > is already gone by the time the query runs. See [[2026-07-12-prisma-lazy-promise-als]].
- **Orders:** a Serilog `ILogEventEnricher` reading `ICurrentCaller` via `IHttpContextAccessor`.
  The caller is read on **every** event, never cached — the internal `usr_` id resolves lazily
  and is absent early in a request.
- **Tracking:** Python `contextvars`, merged into every record via a `logging.Formatter`
  subclass that explicitly emits the record's extra attributes — the stdlib default formatter
  does not. See [[2026-07-31-python-logging-extra-silently-dropped]].
  > [!warning] Pitfall — contextvars don't survive every task/thread boundary
  > `asyncio.to_thread` copies the context rather than sharing it, so a merge performed inside
  > the offloaded call is discarded on return; Starlette's `BaseHTTPMiddleware` runs the app in
  > a sibling anyio task, so context a handler sets is invisible to that middleware. See
  > [[2026-07-31-contextvars-lost-across-task-boundaries]].
  > [!warning] Pitfall — pure-ASGI middleware never sees a 5xx from an unhandled exception
  > A `send` wrapper only observes responses that pass back down through it; an unhandled
  > exception propagates up and out to Starlette's `ServerErrorMiddleware`, which sits outside
  > every `add_middleware` layer. A metrics/log hook watching `send` alone silently never counts
  > the 5xx unless it also catches `Exception` (never `BaseException` — that would count client
  > disconnects) at its own boundary and re-raises. See
  > [[2026-08-12-server-error-middleware-outside-pure-asgi-middleware]].

## Related

- [[2026-08-15-request-id-correlation-design]] — the full design for `request_id`: format,
  validation rationale, propagation mechanics, and the three implementation traps summarized
  above.
- [[2026-07-19-logging-context-and-tracing-design]]
- [[2026-07-19-logging-context-and-tracing]] — the implementation plan for that design.
- [[ADR-0019-distributed-tracing-opentelemetry]]
- [[ADR-0018-observability-openobserve]]
- [[openobserve-runbook]] — the per-stream routing table (`logs`/`sql`/`redis`/`docdb`/`nginx`/
  `rds`) that the SQL/Mongo statement notes above route into.
- [[testing]]
- [[2026-07-12-prisma-lazy-promise-als]]
- [[2026-07-31-contextvars-lost-across-task-boundaries]] — Tracking's contextvars sibling to
  the Prisma/ALS lesson above.
- [[2026-07-31-python-logging-extra-silently-dropped]] — why Tracking needed a custom
  formatter for `extra=` fields to reach the output at all.
- [[2026-08-12-server-error-middleware-outside-pure-asgi-middleware]] — why Tracking's pure-ASGI
  `LogContextMiddleware` needed an explicit `except Exception: ...; raise` to count 5xx from
  unhandled exceptions at all.
- [[events-pipeline-design]] — the `type` and `author_*` fields the pipeline emits on every
  per-record log line; it now emits `trace_id`/`span_id` too (JE-138), see the info callout above.
- [[2026-08-18-distributed-tracing-spans-design]] — the manual-spans design that closed JE-138
  (events-pipeline) and JE-159 (realtime-events), and established that workflow spans carry the
  same `app_event`/`reason` attributes as the flow log line.
- [[2026-08-18-distributed-tracing-spans]] — the implementation plan; verified end to end
- [[2026-08-27-a-librarys-defaults-encode-assumptions-about-a-generic-service]] — `otelsql`'s
  `db.query.text` default (a PII leak onto spans) and `driver.ErrSkip` default (a false error on
  every ordinary query), and the generalised lesson that a library's instrumentation defaults
  assume a generic service.
  against a real Jaeger trace.
- [[2026-08-05-passwordless-otp-auth-design]] — the entropy reasoning behind the never-log-an-OTP
  rule and the full logging design for `otp_challenge_created`.
- [[2026-08-05-passwordless-otp-auth]] — the implementation plan that shipped it.
- [[passwordless-auth-type]] — the `AuthType`/login-guard decision, whose failure reason
  (`passwordless_user`) is logged but never the credential itself.
- [[2026-08-12-custom-business-metrics-cloudwatch-design]] — the metrics pillar this note's
  "Metrics" section summarizes: the CloudWatch-not-OTLP pipeline, the namespace/dimension
  conventions, and the full detail behind the three Floci/OpenObserve gotchas above.
- [[health-check-logging]] — the health-check exemption from the `request completed` line while
  the probe succeeds, and why it is scoped by status rather than by suppressing the route.
- [[2026-08-25-reads-are-not-exempt-from-observability]] — a read endpoint (`GET /v1/cart`)
  and a small write (`DELETE /v1/cart`) shipped with no span or log line at all; the
  read/write log-shape distinction (one `_succeeded` line with a count for reads, the full
  triad for writes) that resulted.
