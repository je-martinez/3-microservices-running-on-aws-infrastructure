---
title: Logging Context and Tracing Design
type: spec
area: shared
status: draft
created: 2026-07-19
updated: 2026-07-19
tags:
  - type/spec
  - area/shared
  - status/draft
related:
  - "[[2026-07-19-scripts-to-python-migration-design]]"
  - "[[2026-07-16-structured-logging-and-dashboards-design]]"
  - "[[2026-07-10-openobserve-migration-design]]"
  - "[[ADR-0018-observability-openobserve]]"
  - "[[2026-07-12-prisma-lazy-promise-als]]"
  - "[[2026-07-16-scoped-current-user-context-design]]"
  - "[[testing]]"
  - "[[ADR-0003-grpc-inter-service]]"
---

# Logging Context and Tracing Design

## Summary

Give every log line a shared, cross-service context so a single user's or order's activity
can be filtered end to end; add flow-level logs where they carry diagnostic value; and add
real distributed tracing across the gRPC boundary, compatible with the existing OpenObserve
setup. This is **block 2 of 3** of the "Developer Experience" milestone — block 1 (scripts to
Python) is already implemented, per [[2026-07-19-scripts-to-python-migration-design]]; block 3
(env-file auto-generation) is not yet specced.

## Goal

- Attach a shared, cross-service log context (trace/span id, identity, hashed email, domain
  ids) to every log line, so a single user's or order's activity can be filtered end to end
  across Users and Orders.
- Add explicit flow-level start/success/failure logs only where they carry diagnostic value
  (register, login, create-order), instead of scattering ad-hoc logging or leaving flows silent.
- Add real distributed tracing across the gRPC boundary using the OpenTelemetry SDK, compatible
  with the existing OpenObserve setup and the collector already in place per
  [[2026-07-16-structured-logging-and-dashboards-design]] and [[ADR-0018-observability-openobserve]].

## Current state (verified by reading the code, 2026-07-19)

This is better than the original input assumed — verification against the actual code changed
several planned decisions below.

- **Both services already emit JSON in the same OTel-aligned schema**: `timestamp`,
  `severity_text`, `severity_number`, `service_name`, `deployment_environment`, `message`, plus
  `error_type`/`error_message` on errors. Users via `services/users/src/shared/logging/logger.ts`
  (Pino, custom `formatters.level`/`formatters.log`); Orders via
  `services/orders/src/Orders.Api/Logging/SchemaLogFormatter.cs` (Serilog `ITextFormatter`).
- **`duration_ms` already exists cross-service.** Users emits it in a single `onResponse`
  request log; Orders' formatter renames Serilog's `Elapsed`/`ElapsedMilliseconds` to
  `duration_ms`. The original input asked for `duration_s` (seconds); this design keeps
  **`duration_ms`** instead, because it is what both services already emit and milliseconds is
  the OTel HTTP-semantic-convention unit. Recorded as an explicit deviation from the input.
- **Users' request log is already good**: one log per response with `http_request_method`,
  `http_route`, `http_response_status_code`, `duration_ms`, `trace_id` — it already replaced
  Fastify's default start/end pair.
- **Orders already has caller identity**: `ICurrentCaller` populated by
  `CallerContextMiddleware` from the `x-user-id` header (per
  [[2026-07-16-scoped-current-user-context-design]]); `Program.cs` sets `trace_id` from
  `http.TraceIdentifier`.
- **Users already uses AsyncLocalStorage** — `services/users/src/shared/audit/actor-context.ts`
  propagates the audit actor. The propagation mechanism exists and works; block 2 adds a sibling
  store rather than inventing a new mechanism.
- **No OpenTelemetry packages are installed in either service.** Zero. There is an
  otel-collector (`observability/otel-collector-config.yaml`) but it runs a **logs-only**
  pipeline: `fluent_forward` + `aws_cloudwatch` receivers → `transform/parse_body` (ParseJSON of
  the service's stdout line) + `batch` → `otlp_http/openobserve`.
- **No email is logged anywhere today** (verified). Adding it is a privacy-posture change, not
  an incremental one.
- Users has only ~8 log call sites total — the input's complaint about missing flow logs is real.
- Both services have a `trace_id` today, but from local, non-propagating sources: Fastify's
  `req.id` and ASP.NET's `http.TraceIdentifier`. Neither crosses the gRPC boundary (see
  [[ADR-0003-grpc-inter-service]]), so a cross-service flow cannot be followed today.

## Decisions

### 1. Shared log context (identical field set in both services)

Attached automatically to every log line of a request:

| Field | Source | Present when |
|---|---|---|
| `trace_id` / `span_id` | OTel SDK (W3C) | always |
| `cognito_sub` | JWT / `x-user-id` | authenticated request |
| `user_id` | internal resolution (`usr_…`) | once identity resolved |
| `email_hash` | SHA-256 of the lowercased email, truncated | whenever the email is known |
| `email` | request body | login/register only |
| `order_id` | domain operation | Orders operations |
| `duration_ms` | request log | per response |
| `tracking_id`, `type` | — | reserved, not emitted yet |

### 2. Email is hashed, except in auth flows (deviation from the input, deliberate)

The input asked to filter by email everywhere. Instead: `email_hash` (SHA-256, lowercased,
truncated) rides on every log — filterable and stable without being PII. Plaintext `email`
appears only in login/register, where no `user_id` exists yet and the email is the only real
diagnostic key.

Rationale: no email is logged today, and seeding PII across OpenObserve, CloudWatch, and every
backup is hard to reverse and is what GDPR erasure requests trip over. The input itself already
says not to log sensitive data. Never log passwords, tokens, or full request bodies.

### 3. Context propagates without changing any function signature

- **Users:** add `shared/logging/log-context.ts`, an AsyncLocalStorage sibling to the existing
  `actor-context.ts`. Populated in an `onRequest` hook, enriched when identity resolves. A
  `formatters.log` addition in `logger.ts` merges the store into every line.

  > [!warning] Critical pitfall — Prisma lazy promises break ALS
  > Prisma promises are lazy — any `await` must happen **inside** the ALS callback or the
  > context is lost. This bit the repo before; see [[2026-07-12-prisma-lazy-promise-als]].

- **Orders:** add a Serilog `ILogEventEnricher` reading the existing `ICurrentCaller` via
  `IHttpContextAccessor`, attaching the same fields. `SchemaLogFormatter` needs no change — it
  already serializes structured properties with correct JSON types.

### Reconciling with ADR-0018 (tracing was previously out of scope)

Distributed tracing was **deliberately excluded** by prior decisions, and this spec reopens that:

- [[2026-07-16-structured-logging-and-dashboards-design]] lists under Non-Goals: "Metrics or
  distributed tracing (out of scope per ADR-0018)".
- [[ADR-0018-observability-openobserve]] records the trade-off verbatim: *"OpenObserve supports
  traces via OTLP, but its distributed-tracing/APM maturity is below SigNoz's. We are logs-only
  today. If distributed tracing becomes a hard requirement, the backend is re-evaluated in a
  future ADR — this is a 'sufficient for now', not a closed door."*

This block makes tracing a hard requirement, which is exactly the condition ADR-0018 named. The
re-evaluation it calls for happens here, and the outcome is:

**Decision: keep OpenObserve, accept the weaker APM UI, and record it in a NEW ADR.**

Reasoning:

- OpenObserve's weakness is in the **APM exploration UI** (waterfalls, service maps, latency
  breakdowns), not in OTLP trace **ingest**, which is a standard protocol. Traces will arrive and
  be queryable; exploring them is simply less ergonomic than SigNoz or Jaeger would be.
- One backend for both logs and traces keeps the local stack small and keeps the join key
  (`trace_id`) inside a single system, which is worth more here than a richer waterfall view.
- This is a reversible decision: the collector's trace pipeline is a standard OTLP exporter, so
  pointing it at a different backend later is a config change, not a re-instrumentation.
- Adding a second backend (e.g. Jaeger for traces only) was considered and rejected for now: it
  splits logs and traces across two UIs and adds a compose service, for exploration ergonomics we
  do not yet know we need.

A new ADR (continuous global numbering in `shared/decisions/`) will record this, superseding
**only the tracing/logs-only stance** of ADR-0018 (its OpenObserve-over-SigNoz backend choice
stands) and the tracing Non-Goal of the 2026-07-16 structured-logging spec. Writing that ADR is
an implementation-time deliverable of the tracing layer below, not part of this spec.

### 4. Full OpenTelemetry SDK — real traces, not just correlation

This decision is what triggers the ADR-0018 re-evaluation above: it turns distributed tracing
from a documented non-goal into a hard requirement, so the trade-off ADR-0018 flagged is now
resolved (see "Reconciling with ADR-0018" above) rather than deferred.

- **Users:** `@opentelemetry/sdk-node` with auto-instrumentation for Fastify, gRPC, and Prisma.
- **Orders:** `OpenTelemetry.Instrumentation.AspNetCore` + `.GrpcNetClient` +
  `.EntityFrameworkCore`.
- Both export OTLP to the collector that already exists; the collector gains a `traces`
  pipeline alongside its `logs` pipeline, exporting to the same OpenObserve instance.
- W3C `traceparent` propagates over gRPC automatically, so the Orders → Users
  identity-resolution call appears as one trace with parent/child spans.
- The local `trace_id` sources (`req.id`, `TraceIdentifier`) are replaced by OTel's real trace
  id — that is the join key between logs and traces.

### 5. Flow logs only where they carry value

Only `register`, `login`, and `create-order` get explicit start → success/failure logs, one
branch per distinguishable failure mode, following the input's examples:

```
[INFO]  Starting user registration                              app_event=register_started
[INFO]  User registration completed                             app_event=register_succeeded user_id=usr_…
[ERROR] User registration failed: email already exists          app_event=register_failed reason=duplicate_email
[ERROR] User registration failed: Cognito rejected the user     app_event=register_failed reason=cognito_error
```

Trivial CRUD endpoints keep only the automatic request log. Rationale: noise is what makes
logs unread.

### 6. Request logs are kept, and Orders aligns to Users' shape (deviation from the input)

The input proposed removing the request started/completed logs because they differ between
services. Instead we keep them and align Orders to Users' already-correct shape (one log per
response, `http_request_method`/`http_route`/`http_response_status_code`/`duration_ms`/
`trace_id`). They are the systematic source of latency and error-rate signal; deleting them
would lose it. The input's underlying complaint — inconsistency — is addressed by alignment,
not deletion.

### 7. Reserved fields for services that don't exist yet

`tracking_id` and `type` are documented as part of the standard context but emitted by nothing
today (no null columns). The contract is fixed now so `tracking` and `events-pipeline` comply
at birth.

## Implementation shape — three layers, in order

The issues are structured by layer, not by service, so the shared schema is defined once and
both services adopt it together instead of diverging:

1. **Context layer** — shared field definitions, ALS in Users, Serilog enricher in Orders,
   `email_hash` helper.
2. **Flow-log layer** — register, login, create-order; Orders request-log alignment.
3. **Tracing layer** — OTel SDK in both services, collector traces pipeline, gRPC propagation
   verified end to end; **write the ADR recording the tracing decision** (new ADR number,
   superseding the tracing/logs-only stance of ADR-0018 and the tracing Non-Goal of the
   2026-07-16 structured-logging spec — see "Reconciling with ADR-0018" above).

Layer 3 is deliberately last and isolable: layers 1 and 2 deliver value on their own if tracing
proves troublesome.

## Verification

Per [[testing]], this block changes no HTTP endpoint contracts, so no new endpoints need the
three-layer treatment; existing E2E must keep passing (baseline: 35 passed). Specific checks:

- A single request's logs all carry the same `trace_id` and the expected context fields.
- A cross-service flow (create-order, which calls Users over gRPC for identity) produces one
  trace spanning both services, with parent/child spans, visible in OpenObserve.
- No plaintext email appears in any log outside login/register; grep the log stream to prove it.
- No passwords or tokens in any log.
- `duration_ms` present on every request log in both services.

## Risks / Open Points

- Adding the OTel SDK touches both services' startup paths — the highest-risk part of the block.
- The collector currently runs a logs-only pipeline; the traces pipeline and OpenObserve's trace
  ingest need verifying against the local Floci stack.
- AsyncLocalStorage context loss is a real, previously-encountered failure mode with lazy Prisma
  promises — awaits must stay inside the ALS callback.
- Auto-instrumentation can be chatty; span sampling/filtering may need tuning so local dev is
  not drowned.
- `email_hash` must be computed identically in both services (same normalization, same
  truncation) or cross-service filtering silently fails to correlate.

## Related

- [[2026-07-19-scripts-to-python-migration-design]]
- [[2026-07-16-structured-logging-and-dashboards-design]]
- [[2026-07-10-openobserve-migration-design]]
- [[ADR-0018-observability-openobserve]]
- [[2026-07-12-prisma-lazy-promise-als]]
- [[2026-07-16-scoped-current-user-context-design]]
- [[testing]]
- [[ADR-0003-grpc-inter-service]]
