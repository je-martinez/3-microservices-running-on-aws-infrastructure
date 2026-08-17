---
title: Custom Business Metrics via CloudWatch Design
type: spec
area: shared
status: draft
created: 2026-08-12
updated: 2026-08-12
tags:
  - type/spec
  - area/shared
  - status/draft
propagates-to:
  - "[[logging-context]]"
  - "[[users-service-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[testing]]"
related:
  - "[[ADR-0018-observability-openobserve]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[ADR-0017-floci-local]]"
  - "[[logging-context]]"
  - "[[email-templates]]"
  - "[[env-files]]"
  - "[[testing]]"
---

# Custom Business Metrics via CloudWatch Design

## Goal

Add the **third observability pillar** — metrics — to 3MRAI, covering both custom business
metrics (registrations, orders, emails) and technical error-rate metrics (HTTP status classes).
Metrics are published to **Amazon CloudWatch** (Floci locally), scraped by the OpenTelemetry
collector, and exported to **OpenObserve**, where they feed dashboards alongside the existing
logs.

Today the repo has logs (OpenObserve, [[ADR-0018-observability-openobserve]]) and traces
(Jaeger, [[ADR-0019-distributed-tracing-opentelemetry]]). Metrics are explicitly **disabled**:
every service sets `OTEL_METRICS_EXPORTER=none` per [[logging-context]]. This design turns that
pillar on, through CloudWatch rather than through the OTLP metrics path.

## Approved decisions

### The pipeline: CloudWatch is the source of truth

```
services ──PutMetricData──> CloudWatch (Floci) ──GetMetricData──> OTel collector ──> OpenObserve
                                    │                                                     │
                                    └── alarms (PutMetricAlarm)                      dashboards
```

Each service publishes with `PutMetricData` to CloudWatch. The collector's existing
`aws_cloudwatch` receiver polls with `GetMetricData` and emits OTel metrics into a new metrics
pipeline exported to OpenObserve.

**Why CloudWatch as the intermediary rather than OTLP direct-to-OpenObserve.** This repo's
purpose is exercising AWS infrastructure. Routing metrics through CloudWatch means the same
`PutMetricData` calls, the same namespaces and dimensions, and the same alarm surface that
production would use — the local emulator is the only thing that changes. The cost is polling
latency (one `collection_interval`) rather than push, which is the same trade real CloudWatch
imposes.

**Why not a Metric Stream.** In real AWS, `CreateMetricStream` → Firehose is the canonical way
to get CloudWatch metrics into a third-party backend. **Floci does not implement
`CreateMetricStream`** (verified: absent from its CloudWatch service page, which documents
`PutMetricData`, `ListMetrics`, `GetMetricStatistics`, `GetMetricData`, and the alarm actions).
The receiver's `GetMetricData` polling is the supported path and works today; see
[Spike findings](#spike-findings).

**The `aws_cloudwatch` receiver already in the collector does metrics as well as logs.** No new
component: `receiver/awscloudwatchreceiver` in collector-contrib v0.156.0 registers both
`WithLogs` and `WithMetrics`. This is a second config block on the receiver the collector
already runs for CloudWatch Logs.

### Spike findings

A spike was run against Floci v1.5.28 before committing to this design, using the real
`otel/opentelemetry-collector-contrib:0.156.0` binary. **The pipeline works end to end**:
metrics published with `PutMetricData` were scraped by the receiver and emitted as OTel metrics
(`amazonaws.com/3MRAI/Spike/OrdersCreated`, two consecutive 60s windows, no errors), and the full
chain through to OpenObserve was verified separately (finding #3). Four findings constrain the
design.

#### 1. Floci does not aggregate across dimensions — and fails silently

A metric published with `Dimensions=[{Service: orders}]` is **only** readable by querying that
exact dimension set. Querying the same metric name without dimensions returns
`Values: []` with `StatusCode: "Complete"` — "query fine, no data" — rather than an error.
Real CloudWatch would aggregate across the dimension.

| Query | Result |
|---|---|
| `OrdersCreated` + `Service=orders`, `Sum` | `14.0` ✅ |
| `OrdersCreated` + `Service=orders`, `Average` | `4.67` ✅ (14/3, correct) |
| `OrdersCreated` + `Service=orders`, `SampleCount` | `3.0` ✅ |
| `OrdersCreated`, **no dimensions** | `[]` ❌ silently empty |
| `NoDims` published without dimensions, queried without | `9.0` ✅ |

The rule is **exact dimension-set match**, not "dimensions break queries".

**Two consequences, both binding:**

- Every dashboard query must name the exact dimension set the metric was published with. A
  query written against real-AWS aggregation semantics renders green and empty here.
- **A "total" cannot be derived by omitting a dimension.** Where a total is wanted across a
  breakdown (emails by type), the total is published as its **own series** with a sentinel
  dimension value (`EmailType=ALL`), not inferred. See [Email metrics](#events-pipeline).

#### 2. The receiver's `delay` defaults to 10 minutes

`delay` shifts the query window back from now, compensating for real CloudWatch's 3–10 minute
publication latency. Floci has no such latency, so the default means **nothing appears for the
first 10 minutes** — indistinguishable from a broken integration.

**Local sets `delay: 0s`. Real AWS keeps the default.** This belongs in the collector config
with a comment, because the failure it prevents looks exactly like a wiring bug.

#### 3. OpenObserve accepts metrics ingest, and renames dimensions on the way in

The full chain was verified end to end — `PutMetricData` → Floci → collector → OpenObserve — not
just the CloudWatch half. This mattered because OpenObserve's **trace** ingest rejected every
collector batch with HTTP 400 ([[ADR-0019-distributed-tracing-opentelemetry]]); its metrics ingest
does **not** have that problem. A stream `amazonaws_com_3mrai_orders_total` was created and the
data point was queryable:

```json
{ "value": 42.0, "metricname": "orders_total", "namespace": "3MRAI",
  "dimensions_service": "orders", "stat": "Sum", "cloud_region": "us-east-1" }
```

**Dimensions arrive prefixed with `dimensions_`.** A CloudWatch dimension `Service=orders` is
queried in OpenObserve as **`dimensions_service`** (prefixed and lowercased), not `Service`. Every
dashboard query must use the prefixed, lowercased name; the CloudWatch-side name only applies to
`GetMetricData` and the collector's `queries` block. The metric name also becomes the stream name,
prefixed and sanitized: `amazonaws.com/3MRAI/orders_total` → `amazonaws_com_3mrai_orders_total`.

Also note `flag: "DATA_POINT_FLAGS_DO_NOT_USE"` in every record — that is the OTLP default (no
flags set), not an error, and it must not be filtered on.

#### 4. `collection_interval` must be ≥ `period`

Enforced by the receiver at startup, and it fails loudly (`invalid configuration: metrics
collection_interval must be greater than or equal to period`) rather than silently. See
[Polling intervals](#polling-intervals) for the values.

### Polling intervals

Three separate intervals compose into the end-to-end latency, and they differ between local and
real AWS:

| Interval | Local | Real AWS | What it controls |
|---|---|---|---|
| Service publish task | **15s** | 60s | how often a service `COUNT(*)`s and calls `PutMetricData` |
| `collection_interval` | **15s** | 60s | how often the collector polls CloudWatch |
| `period` | **15s** | 60s | CloudWatch's aggregation window (the width of one data point) |
| `delay` | **0s** | 10m (default) | how far back the query window is shifted from now |

**Worst-case end-to-end latency for a gauge: ~30s locally** (up to 15s waiting for the publish
task, plus up to 15s waiting for the next scrape), against ~2 minutes at 60s intervals and ~12
minutes in real AWS with the default `delay`. Counters — registrations, emails, HTTP errors — are
published at the moment of the event, so they pay only the scrape leg: ~15s locally.

**Why local is faster.** Local is a development loop: the question being asked is "does my metric
work at all", and a two-minute answer makes that loop unusable. Nothing local depends on matching
production's cadence, because the values are the same either way — only their freshness differs.

**Why 15s and not lower.** `period` is CloudWatch's aggregation window; shrinking it past the
publish interval starts producing empty windows between publications, which read as gaps in a
dashboard rather than as fast updates. 15s keeps the publish task and the window aligned with
room to spare.

**Why real AWS stays at 60s.** CloudWatch's standard resolution *is* 60s — anything finer
requires high-resolution metrics (1s), which cost more per metric. `PutMetricData` is also billed
per call, so a 4× faster publish task is a 4× larger bill for state that does not change that
fast. The local override buys developer feedback speed where there is no bill and no such floor.

These values live in the collector config and the services' env files ([[env-files]]), not
hardcoded — the local/AWS split is a configuration difference, not two code paths.

### The metrics

Namespace: **`3MRAI`** for all metrics, across all four services. `Service` is a dimension, not a
namespace split — one namespace keeps discovery and dashboard queries uniform.

#### Users

| Metric | Type | Dimensions |
|---|---|---|
| `users_registered_total` | counter | `Service=users` |
| `users_total` | gauge | `Service=users`, `HasPassword=true\|false` |
| `password_resets_total` | counter | `Service=users` |

`users_registered_total` is a **counter** incremented at registration — it answers "how many
registered in a time range", which is what was asked, and a range query over a counter is exactly
what `GetMetricData` with `Stat: Sum` does.

`users_total` is a **gauge**, split by whether the user has a password. This covers "users created
with and without a password" — the passwordless flow ([[2026-08-05-passwordless-otp-auth-design]])
creates users with no password at all, so the split is a real distinction in the data, not a
derived one.

#### Orders

| Metric | Type | Dimensions |
|---|---|---|
| `orders_total` | gauge | `Service=orders` |

The true total of orders, from Orders' own table.

#### Tracking

| Metric | Type | Dimensions |
|---|---|---|
| `orders_by_tracking_status_total` | gauge | `Service=tracking`, `Status=DELIVERED\|IN_PROGRESS` |

**Finished vs unfinished orders, keyed on tracking status.** `DELIVERED` is the terminal status
of Tracking's forward-only state machine (`TERMINAL_STATUS`,
`services/tracking/src/features/tracking/domain/status.py`) — nothing follows it and no update is
accepted against it. So "finished" is the domain's own invariant, not a convention invented for
this metric. `IN_PROGRESS` is every tracking whose status is `!= DELIVERED` (`PLACED`,
`PROCESSING`, `SHIPPED`, `OUT_FOR_DELIVERY`).

Counting trackings is counting orders without double-counting: `tracking.order_id` carries
`UniqueConstraint("order_id", name="uq_tracking_order_id")` — strictly one tracking per order.

**Why the metric is named `orders_by_tracking_status_total` and not `orders_total`.** Orders also
publishes `orders_total`. In CloudWatch, same metric name + same namespace + different dimensions
is a *different series*, so both would coexist — but a dashboard query that named the wrong
dimension set would return a plausible number that answers a different question. Distinct names
make that class of mistake impossible to write.

**Why both Orders and Tracking publish a total.** In the normal flow there is no gap: Orders calls
`POST /v1/trackings/init-tracking` during order creation and the tracking is born at `PLACED`. But
the gap is a **designed-for failure mode**, documented verbatim in
`services/orders/src/Orders.Application/Tracking/TrackingInitResult.cs`:

> We accept orders that may temporarily lack a tracking row, and we make that observable through
> the returned outcome and a logged failure rather than through a failed HTTP response.

Four of the six `TrackingInitOutcome` values (`UnknownUser`, `Unauthorized`, `Failed`,
`Unreachable`) leave a committed order with no tracking, deliberately — failing the order after
stock was decremented would invite a double purchase.

So `orders_total − (DELIVERED + IN_PROGRESS)` is **a health indicator for the Orders↔Tracking
integration**. In normal operation it is 0. A non-zero value means Tracking was failing and there
are orphaned orders that nothing will backfill. The comment above promises this is observable
through a log; this metric makes it visible at a glance and alarmable.

#### events-pipeline

| Metric | Type | Dimensions |
|---|---|---|
| `emails_sent_total` | counter | `EmailType=<template>` |
| `emails_sent_total` | counter | `EmailType=ALL` |
| `emails_failed_total` | counter | `EmailType=<template>`, `FailureKind=permanent\|transient` |
| `emails_failed_total` | counter | `EmailType=ALL`, `FailureKind=permanent\|transient` |

`EmailType` takes the **template key**, of which there are nine: `user-created`,
`order-created`, `auth-otp-requested`, `password-reset-requested`, and the five
`tracking-status-changed` variants (one per status — `TRACKING_STATUS_CHANGED` fans out to five
templates keyed by `payload.status`, see `#handlers/tracking-status-changed`). Template keys
rather than event types, because the template is what was actually rendered and sent.

**`EmailType=ALL` is a separately published series, not a query-time aggregate** — a direct
consequence of spike finding #1. Publishing only per-type series and expecting the total from a
dimensionless query would return empty.

**`FailureKind` mirrors a distinction that already exists in the code**, and it is the one that
matters operationally:

- **`permanent`** — `PermanentError` (e.g. missing template, `src/email/renderer.ts:22`). Not
  retried: **the email is lost**. Any non-zero value is a real incident.
- **`transient`** — `TransientError` (SES send failure, `src/email/sender.ts:86`). SQS retries the
  record, so it most likely arrived. Small numbers are expected noise.

Without the split, "5 emails failed" conflates "5 customers never got their receipt" with "SES
hiccuped and the retry worked".

> [!warning] This measures handoff to SES, not inbox delivery
> A `sent` count means SES accepted the message. Bounces and complaints are invisible here; they
> would require SES event notifications, which are **out of scope** for this milestone. A
> dashboard reading "1,000 sent" must not be read as "1,000 delivered".

#### All four services

| Metric | Type | Dimensions |
|---|---|---|
| `http_errors_total` | counter | `Service`, `StatusClass=4xx\|5xx` |

Two series per service. `StatusClass` rather than the exact code: it is enough to alarm on ("5xx
are rising"), and given spike finding #1 every extra dimension value is another exact query a
dashboard has to spell out. Per-code detail remains available in the logs, which already carry
`http_response_status_code`.

The events-pipeline is a Lambda with no HTTP surface; its `http_errors_total` is **not**
published. The metric covers Users, Orders, and Tracking.

### How metrics are published

**Gauges: a periodic task inside each owning service.** Every service runs an internal job — 15s
locally, 60s in real AWS ([Polling intervals](#polling-intervals)) — that issues a `COUNT(*)`
against **its own** database and publishes with `PutMetricData`.

- Users → `users_total`
- Orders → `orders_total`
- Tracking → `orders_by_tracking_status_total`

Each service queries only its own database, so no component needs credentials to three databases
and the service boundary holds. Tracking already runs an in-process `asyncio` background task for
TestMode progression, so this is an established pattern there rather than a new one.

**Why gauges rather than counters for state.** "Orders not yet delivered" is a question about
current state. As a counter it would need to *decrement* when a tracking reaches `DELIVERED` —
something a counter cannot do — and the reported value would drift from the database with no way
to explain the difference. The same applies to `users_total` by password and to `orders_total`.

**Counters: incremented at the event.** `users_registered_total`, `password_resets_total`,
`emails_sent_total`, `emails_failed_total`, and `http_errors_total` are published at the moment
the thing happens.

**The events-pipeline has no periodic task**, because it is a Lambda — there is no long-lived
process to host one. All of its metrics are counters published during invocation, which fits:
sending email is an event, not a state.

> [!warning] Local testing of the Lambda requires `terraform apply`, not `update-function-code`
> Per Floci quirk 16, a relaunched Lambda comes back from the zip Terraform deployed and silently
> discards any later `update-function-code`. Metric code changes must be redeployed with
> `pnpm run build` + `terraform apply`. See [[floci-sqs-lambda-docdb-support]].

### Collector configuration

A new `metrics` block on the existing `aws_cloudwatch` receiver, plus a new metrics pipeline. The
logs pipelines are untouched.

```yaml
receivers:
  aws_cloudwatch:
    region: ${env:AWS_REGION}
    logs: { ... }            # unchanged
    metrics:
      collection_interval: 15s   # LOCAL. 60s in real AWS — see "Polling intervals".
                                 # MUST be >= period (receiver validates at startup)
      period: 15s                # LOCAL. 60s in real AWS (CloudWatch's standard resolution)
      delay: 0s                  # LOCAL ONLY. Default is 10m, which compensates for real
                                 # CloudWatch publication latency Floci does not have —
                                 # leaving the default here means NOTHING appears for the
                                 # first 10 minutes, looking exactly like a broken pipeline.
      queries:
        - namespace: "3MRAI"
          metric_name: "users_registered_total"
          dimensions: { Service: users }   # a MAP, not a list of {Name, Value}
          stats: [Sum]
        # ... one entry per (metric, dimension-set) pair
```

`dimensions` is a **map** in this receiver's schema (`{Service: users}`), unlike the AWS CLI's
list-of-objects form. With `stats` omitted the receiver fetches all four statistics and emits an
OTel Summary; naming `stats` explicitly emits a Gauge per statistic with a `stat` attribute.

Queries are declared explicitly rather than using `discovery`, so a dashboard's dimension set and
the collector's are written in one place and can be reviewed together.

An OpenObserve metrics exporter is added, following the existing `otlp_http/openobserve` pattern
with a metrics stream name.

## Non-goals

- **Metric Streams / Firehose** — not implemented by Floci; the polling receiver is the path.
- **OTLP metrics direct from the SDKs.** `OTEL_METRICS_EXPORTER=none` stays as it is. Turning it
  on would create a second, parallel metrics path with different semantics for the same numbers.
- **CloudWatch alarms.** `PutMetricAlarm` works in Floci and is the natural follow-up, but this
  milestone delivers metrics and dashboards. Alarms are a separate scope.
- **SES bounce/complaint tracking** — see the warning above.
- **Per-route or per-status-code error metrics** — `StatusClass` only; the logs already carry the
  detail.
- **Infrastructure metrics** (CPU, memory, connection pools). Business and error metrics only.

## Testing

Per [[testing]], but adapted — these are not HTTP endpoints, so the three-layer rule maps as:

1. **Unit** — the publishing helper in each service: correct namespace, metric name, and exact
   dimension set. The dimension set is the part that silently breaks dashboards, so it is asserted
   literally rather than through a builder.
2. **Integration** — publish against Floci, then read back with `GetMetricData` **using the same
   dimension set the dashboard will use**. This is the test that would have caught spike finding
   #1, and it must assert a **non-empty value**, never just `StatusCode: Complete` — the silent
   failure mode returns `Complete` with an empty list.
3. **Pipeline verification** — with the observability profile up, confirm the metric arrives in
   OpenObserve. Observe across **at least two** `collection_interval` windows — ≥30s at the local
   15s interval — never one: a check whose duration equals the export period can pass or fail
   purely on where it lands in the cycle, which has produced false PASSes in this repo before. The
   spike verified two consecutive windows for exactly this reason. Derive the wait from the
   configured interval rather than hardcoding seconds, so lowering the interval does not silently
   turn the check back into a single-window one.

Gauge correctness is verified against the database: the published value must equal the
`COUNT(*)` it claims to report, asserted with a known fixture rather than a self-referential
query.

## Open questions

None blocking. Two deferred by choice: alarm thresholds (out of scope, above) and whether the
`orders_total − (DELIVERED + IN_PROGRESS)` health indicator deserves its own derived metric rather
than being computed in the dashboard — worth revisiting once there is data on how often it is
non-zero.

## Related

- [[ADR-0018-observability-openobserve]] — the logs backend these dashboards live beside.
- [[ADR-0019-distributed-tracing-opentelemetry]] — the traces pillar; this design adds the third.
- [[ADR-0017-floci-local]] — the local emulator the spike was run against.
- [[logging-context]] — the `OTEL_METRICS_EXPORTER=none` rule this design deliberately leaves in
  place, and the OTel-config-in-environment convention.
- [[email-templates]] — the template catalog whose keys become the `EmailType` dimension.
- [[testing]] — the three-layer rule, adapted above for non-HTTP surfaces.
- [[env-files]] — where any new configuration for the publishers belongs.
