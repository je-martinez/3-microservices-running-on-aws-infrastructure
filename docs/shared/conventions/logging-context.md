---
title: Logging Context
type: convention
area: shared
status: active
created: 2026-07-19
updated: 2026-08-12
tags:
  - type/convention
  - area/shared
  - status/active
related:
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
---

# Logging Context

## The shared log context

Every log line attaches the following fields, identically defined across services:

| Field | Source | Present when |
|---|---|---|
| `trace_id` / `span_id` | OpenTelemetry SDK (W3C) | always, **except events-pipeline** (see below) |
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

> [!warning] events-pipeline has no `trace_id`/`span_id` today
> The events-pipeline Lambda carries no OpenTelemetry SDK — zero `@opentelemetry/*` dependencies
> in `functions/events-pipeline/package.json`, no `OTEL_*` variables in `infra/modules/lambda/`.
> Every other producer/consumer in the shared context table emits `trace_id`/`span_id` on every
> line; this is the one exception. Tracked as [JE-138](https://linear.app/je-martinez/issue/JE-138).

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

Logs (OpenObserve, [[ADR-0018-observability-openobserve]]) and traces (Jaeger,
[[ADR-0019-distributed-tracing-opentelemetry]]) travel over OTLP. Metrics deliberately do not:
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

## What belongs in the log stream

> [!info] Guiding rule
> A request should appear **once**, logged by the layer with the most context. Edge/proxy logs
> are ingested only for failures the application layer cannot observe — 5xx, upstream errors, and
> anything the parser could not classify.

nginx access logs under 500 are dropped by the collector: for a 2xx/3xx/4xx, the service already
logs the same request with the *why*. 5xx are kept — verified by stopping the users container and
hitting its route, which produced `nginx ERROR GET /v1/users/health 502`, a failure no service
could record because none was running to record it.

Non-JSON sources (like nginx's combined log format) need explicit parsing in the collector to
reach the shared schema.

> [!warning] SQLAlchemy's SQL echo goes to its own OpenObserve stream, never the main `logs` one
> Tracking runs with SQL echo on outside production (`Settings.echo_sql`), and a single tracking
> read can emit several `SELECT`s — enough that, mixed into the shared stream, application events
> were buried among the queries that served them and roughly a third of all records carried no
> `service_name` at all and could not be filtered by service. The collector now splits SQL
> statements into a **separate stream**, via two OTel pipelines over the same receivers with
> complementary filters (each record leaves through exactly one, so the filters must stay exact
> complements) and two exporters differing only in the destination stream-name header.
>
> The activation mechanism is the part worth getting right on a new service: echo must be turned
> on by **raising the `sqlalchemy.engine` logger's level**
> (`logging.getLogger("sqlalchemy.engine").setLevel(logging.INFO)`), **never**
> `create_engine(echo=True)`. `echo=True` makes SQLAlchemy attach its own plain-text
> `StreamHandler` at engine-construction time — and because engines are `lru_cached` and built on
> the **first request**, that happens long after `configure_logging()` has already stripped
> library handlers at startup, so SQLAlchemy silently reinstalls one behind the app's back. The
> result was every statement logged **twice**: once as JSON with the full shared context, and once
> as raw text with no `service_name`, with multi-line statements arriving as several unrelated
> records. Setting the logger's level instead routes the same records through the normal logging
> tree — the root JSON handler formats them, the context filter enriches them — and is
> order-independent, since there is no handler left for SQLAlchemy to reinstall. See
> `services/tracking/src/shared/db/engine.py`.

> [!warning] Do not filter or alert on `cloudwatch_log_stream`
> Under the local emulator, the `aws_cloudwatch` receiver substitutes the placeholder
> `THIS IS INVALID STREAM` when it cannot resolve a real stream name. Use `service_name` and
> `cloudwatch_log_group_name` instead.

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

- [[2026-07-19-logging-context-and-tracing-design]]
- [[2026-07-19-logging-context-and-tracing]] — the implementation plan for that design.
- [[ADR-0019-distributed-tracing-opentelemetry]]
- [[ADR-0018-observability-openobserve]]
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
  per-record log line, and why it has no `trace_id`/`span_id` yet (JE-138).
- [[2026-08-05-passwordless-otp-auth-design]] — the entropy reasoning behind the never-log-an-OTP
  rule and the full logging design for `otp_challenge_created`.
- [[2026-08-05-passwordless-otp-auth]] — the implementation plan that shipped it.
- [[passwordless-auth-type]] — the `AuthType`/login-guard decision, whose failure reason
  (`passwordless_user`) is logged but never the credential itself.
- [[2026-08-12-custom-business-metrics-cloudwatch-design]] — the metrics pillar this note's
  "Metrics" section summarizes: the CloudWatch-not-OTLP pipeline, the namespace/dimension
  conventions, and the full detail behind the three Floci/OpenObserve gotchas above.
