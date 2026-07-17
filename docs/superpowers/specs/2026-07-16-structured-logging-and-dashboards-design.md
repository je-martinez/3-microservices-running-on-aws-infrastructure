---
title: Structured Logging & OpenObserve Dashboards Design
type: spec
area: shared
status: draft
created: 2026-07-16
updated: 2026-07-16
tags:
  - type/spec
  - area/shared
  - status/draft
related:
  - "[[ADR-0018-observability-openobserve]]"
  - "[[openobserve-runbook]]"
  - "[[openobserve-cloudwatch]]"
  - "[[local-dev]]"
---

# Structured Logging & OpenObserve Dashboards Design

> [!note] Implementation scope (as of 2026-07-16)
> This design covers all four services, but the **immediate implementation covered `users` +
> `orders` only** — the two services with running code at the time of implementation. `tracking`
> and `events-pipeline` were scaffold-only (empty directories, `CMD` commented out) and had no
> process to instrument. They adopt the same `snake_case` schema and logging approach when built:
> `events-pipeline` reuses the shared Node/Pino module described below, and `tracking` follows the
> FastAPI/Python approach as designed. See [[openobserve-runbook]] for the current dashboard scope.

## Summary

Standardize application logging across the four services (`users`, `orders`, `tracking`,
`events-pipeline`) onto a single OTel-aligned, `snake_case` JSON schema, then build reusable
OpenObserve dashboards on top of that schema. Today each service logs in a different format —
`users` emits raw Pino JSON (`level: 30`), `orders` emits plain text
(`info: Microsoft.Hosting.Lifetime[0]`), and the others follow their framework defaults — so the
logs are inconsistent and hard to query or graph. This design makes every service emit the same
structured fields, parses those fields into queryable columns in the OTel collector, and ships a
per-service + global set of "golden signals" dashboards as version-controlled JSON with an
idempotent bootstrap.

This stays within the logs-only scope of [[ADR-0018-observability-openobserve]]: no metrics,
no distributed tracing. The correlation id is named `trace_id` to leave the door open if OTel
tracing is ever adopted, but it is a per-service request/correlation id, not a distributed trace.

## Goals

- One common structured-log schema, emitted by all four services.
- Automatic request logging (method, route, status, duration) with a propagated correlation id.
- Key business events re-written to the common schema (no new business events invented).
- Collector-side parsing so the JSON body becomes top-level, queryable columns.
- Per-service "golden signals" dashboards + one cross-service overview, as versioned JSON with a
  bootstrap.

## Non-Goals

- Metrics or distributed tracing (out of scope per [[ADR-0018-observability-openobserve]]).
- Changing the log transport: services keep logging to stdout via Docker's `fluentd` driver into
  the collector's `fluent_forward` receiver. No OTLP SDK in the services.
- Prod deployment of dashboards (local Floci only for now; prod is deferred like the rest of the
  observability stack).

## Approach

**Approach A — per-language logging shim + collector-side parsing (chosen).** A small logger
configuration helper per language (one shared by the two Node services, one for .NET, one for
Python), plus a per-service request hook/middleware. The collector parses the JSON `body` into
columns. Dashboards are versioned JSON with an idempotent bootstrap.

Rejected alternatives:

- **B — convention only, no shims.** Each service configures its native logger to match the
  documented schema, and the collector normalizes per-service differences. Less new code, but
  consistency depends on discipline and the collector accumulates fragile per-service
  normalization logic.
- **C — emit native OTLP from each service.** Most "correct" long-term, but changes the transport
  (drops fluentd), is invasive per service, and brushes against the metrics/traces line ADR-0018
  deliberately left out of scope. Over-engineered for now.

## Log Schema (OTel-aligned, snake_case)

Every service emits **one JSON line per event** to stdout. Field names are `snake_case`
(SQL-friendly for OpenObserve) but semantically aligned to OTel semantic conventions.

### Common fields (every log)

| Field | Type | Source | Example |
|---|---|---|---|
| `timestamp` | ISO-8601 or epoch | logger | `2026-07-16T00:35:50.860Z` |
| `severity_text` | string | logger | `INFO`, `ERROR` |
| `severity_number` | int (OTel scale) | logger | `9`, `17` |
| `service_name` | string | config | `users`, `orders`, `tracking`, `events-pipeline` |
| `deployment_environment` | string | env | `local`, `prod` |
| `message` | string | log call | `request completed` |
| `trace_id` | string | correlation | `req-a1b2` |

### HTTP fields (request logs only)

| Field | Type | Example |
|---|---|---|
| `http_request_method` | string | `GET` |
| `http_route` | string | `/users/:id` |
| `http_response_status_code` | int | `200` |
| `duration_ms` | float | `12.4` |

### Error fields (error path only)

| Field | Type | Example |
|---|---|---|
| `error_type` | string | `ValidationError` |
| `error_message` | string | `email is required` |

### Business events

Key domain events use `message` plus service-specific attributes under an `app_*` prefix
(e.g. `app_order_id`), while keeping the common fields. Only **existing** domain events are
re-written to the schema — no new events are invented.

### Rules

- HTTP fields appear only on request logs; `error_*` only on errors. No noisy empty fields.
- `severity_text` / `severity_number` follow the OTel severity scale (e.g. INFO = 9, ERROR = 17).
- `trace_id` is a per-service request/correlation id (generated, or read from an inbound header),
  propagated within the service. Not distributed tracing.

## Per-Service Implementation

Each service gets a logger-config helper that maps to the `snake_case` schema, plus a request
hook/middleware. Business-event logs are re-written to the schema in place.

### Node — `users` + `events-pipeline` (shared Pino module)

- A shared Pino configuration module: `formatters` that rewrite Pino's numeric `level` to
  `severity_text` / `severity_number`, rename fields to `snake_case`, and set `service_name` /
  `deployment_environment`.
- `users` (Fastify): `onResponse` hook logs each request (method, route, status, `duration_ms`);
  `genReqId` supplies `trace_id`. Replaces the current bare `Fastify({ logger: true })`.
- `events-pipeline` (SQS → Lambda): a handler wrapper logs start/end of each message with
  `trace_id` = messageId and the outcome (ok/error).

### orders — .NET (Serilog)

- Add **Serilog** (confirmed dependency) with a compact JSON formatter and enrichers that emit the
  `snake_case` schema. Replaces the default plain-text Microsoft.Extensions.Logging console output.
- Request-logging middleware (method, route, status, `duration_ms`) plus a `correlation_id` from an
  inbound header or generated, surfaced as `trace_id`.

### tracking — FastAPI (Python)

- A stdlib-`logging` (or `structlog`) JSON formatter emitting the `snake_case` schema.
- An ASGI middleware for request logging + correlation id.
- Reconfigure/rename the `uvicorn` access logger so it does not emit its own unstructured format.

## Collector-Side Parsing

Today the service JSON arrives as a **string** inside `body`. Add parsing to the collector's logs
pipeline so those fields become top-level columns.

- Add a processor to the logs pipeline (before `batch`) — candidate: `transform` (OTTL) with
  `ParseJSON` on `body`; `logstransform` is the fallback if OTTL parsing is unavailable.
- The processor detects that `body` is JSON, parses it, and promotes the schema fields
  (`severity_text`, `http_route`, `http_response_status_code`, `duration_ms`, `trace_id`, …) to
  top-level attributes/columns, leaving a readable `message`.
- Because services already emit `snake_case`, the processor **flattens only** — no per-service
  renaming logic (ideally zero).
- Env-parameterized like the rest of `observability/otel-collector-config.yaml` (serves local and,
  later, prod).

**Result:** the `logs` stream in OpenObserve gains queryable columns
(`http_response_status_code`, `duration_ms`, `service_name`, …) instead of a JSON blob in `body`,
which is what makes the dashboards possible.

> [!warning] Verify the processor against the pinned image
> Confirm the chosen processor (`transform`/OTTL vs `logstransform`) exists in
> `otel/opentelemetry-collector-contrib:0.156.0` and that parsing works end-to-end. Validate with
> the same `_search` method used in the [[openobserve-runbook]] — do not trust the lagging
> stream-stats `doc_num` counter.

## Dashboards

Stored as version-controlled JSON in `observability/dashboards/*.json`, next to the collector
config. All panels are derived from the structured logs (no metrics, per ADR-0018).

### Per-service dashboards (×4, filtered by `service_name`)

Each service gets a "golden signals" dashboard:

- **Request rate** — requests/min (timeseries).
- **Errors** — rate and count by `http_response_status_code` (4xx / 5xx).
- **Latency** — p50 / p95 / p99 of `duration_ms`.
- **Top routes** — by volume and by latency (`http_route`).
- **Recent errors** — table of logs with `error_type` / `error_message`.
- **Business panels** — service-specific (e.g. orders: orders created/min; events-pipeline: events
  processed vs failed).

### Global overview dashboard (×1, cross-service)

- Request volume per service (side by side).
- Error rate compared across the four services.
- p95 latency compared.
- Overall health (error count per service, last hour).

### Bootstrap

- A `make observability-dashboards` target (or folded into `observability-up`) imports the JSON via
  the OpenObserve dashboards API (`POST /api/{org}/dashboards`), using the same Basic credentials as
  the runbook.
- Idempotent: if a dashboard already exists, update it rather than duplicate.
- A small script under `scripts/` (bash or `.mjs`, matching existing repo tooling).

> [!warning] Capture the real dashboard JSON schema first
> The OpenObserve v0.91.1 dashboard JSON format must be captured by creating one minimal dashboard
> in the UI and exporting it, then using that real schema as the template. Do not invent the format.

## Verification

- Each service's logs, viewed in OpenObserve, show the common `snake_case` columns populated
  (verified via `_search`, not stream-stats).
- A request to each service produces a request log with `http_*` fields and a `trace_id`.
- The collector parsing promotes `body` JSON to top-level columns for all four services.
- Each dashboard renders with live data after `make observability-dashboards`.
- The global overview shows all four services side by side.

## Risks & Open Points

- **Collector processor availability** — validate `transform`/OTTL `ParseJSON` in the pinned image
  (see callout above).
- **Dashboard JSON format** — capture from a UI export before authoring (see callout above).
- **uvicorn / framework default loggers** — each framework has a default access logger that must be
  silenced or reformatted so it doesn't bypass the schema.
- **`orders` is the largest change** — it moves from plain text to Serilog JSON; the request
  middleware and enrichers are net-new there.

## Related

- [[ADR-0018-observability-openobserve]]
- [[openobserve-runbook]]
- [[openobserve-cloudwatch]]
- [[local-dev]]
