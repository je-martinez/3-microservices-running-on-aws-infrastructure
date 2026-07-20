---
title: "ADR-0019: Distributed Tracing via OpenTelemetry, Split from OpenObserve to Jaeger"
type: adr
area: shared
status: accepted
id: ADR-0019
created: 2026-07-19
updated: 2026-07-19
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags:
  - type/adr
  - area/shared
  - status/accepted
related:
  - "[[ADR-0018-observability-openobserve]]"
  - "[[2026-07-16-structured-logging-and-dashboards-design]]"
  - "[[2026-07-19-logging-context-and-tracing-design]]"
  - "[[logging-context]]"
  - "[[ADR-0003-grpc-inter-service]]"
---

# ADR-0019: Distributed Tracing via OpenTelemetry, Split from OpenObserve to Jaeger

## Context

[[ADR-0018-observability-openobserve]] chose OpenObserve over SigNoz for logs and put distributed
tracing out of scope, recording the trade-off verbatim:

> [!quote] ADR-0018, verbatim
> OpenObserve supports traces via OTLP, but its distributed-tracing/APM maturity is below
> SigNoz's. We are logs-only today. If distributed tracing becomes a hard requirement, the
> backend is re-evaluated in a future ADR — this is a "sufficient for now", not a closed door.

[[2026-07-16-structured-logging-and-dashboards-design]] listed tracing under Non-Goals for the
same reason ("Metrics or distributed tracing (out of scope per ADR-0018)"). Block 2 of the
Developer Experience milestone ([[2026-07-19-logging-context-and-tracing-design]]) made tracing a
hard requirement, triggering exactly the re-evaluation ADR-0018 called for.

## Decision

Adopt the OpenTelemetry SDK in both services (`@opentelemetry/sdk-node` in Users,
`OpenTelemetry.*` in Orders), exporting OTLP to the existing collector. **Traces go to Jaeger;
logs stay in OpenObserve.**

> [!important] This differs from what was planned — recorded honestly
> The intent going in ([[2026-07-19-logging-context-and-tracing-design]]) was to keep
> OpenObserve for both signals, accepting a weaker APM UI in exchange for one backend. That did
> not hold up against the real ingest. OpenObserve's trace ingest **rejected every batch the
> collector sent with HTTP 400**, while a hand-rolled OTLP-JSON POST to the same endpoint
> returned 206 — so the route and auth were correct, and the disagreement was between the
> collector's serialization and that build's parser. Setting `encoding: json` on the exporter did
> not reconcile it. Rather than keep guessing at a third party's ingest behavior, traces were
> pointed at Jaeger, which speaks OTLP natively and ships a real waterfall UI. This is the
> concrete form the ADR-0018 re-evaluation took: the APM-maturity weakness ADR-0018 flagged as a
> risk is exactly what materialized, just earlier and more concretely (a hard ingest rejection,
> not merely a weaker UI) than that ADR anticipated.

## Consequences

- Logs (OpenObserve) and traces (Jaeger) now live in two separate backends, joined by
  `trace_id`, which every log line carries per [[logging-context]]. Two UIs instead of one is the
  accepted cost of this split.
- Jaeger runs under the `observability` Docker Compose profile alongside the collector and
  OpenObserve — it does **not** start with a plain `docker compose up`; the profile must be
  requested explicitly.
- **Reversible:** the collector's trace pipeline is a standard OTLP exporter. Re-pointing it at
  another backend — including OpenObserve, if a future build's ingest improves — is a
  configuration change, not a re-instrumentation of either service.
- **Known limitation, stated honestly:** cross-service traces do **not** yet join. Both services
  export spans, and the Users gRPC server span now exists, but the W3C `traceparent` is not
  propagating across the Orders → Users gRPC boundary (see [[ADR-0003-grpc-inter-service]]), so
  each service still produces its own, separate trace for what is really one user-facing flow.
  Logs still correlate per-service via `trace_id` per [[logging-context]]. Tracked as a follow-up
  in [JE-77](https://linear.app/je-martinez/issue/JE-77).

## Supersedes

- The **tracing / logs-only stance** of [[ADR-0018-observability-openobserve]] — its
  OpenObserve-over-SigNoz **backend choice for logs stands unchanged**; only the "traces are out
  of scope" position is superseded.
- The tracing Non-Goal of [[2026-07-16-structured-logging-and-dashboards-design]].

## Related

- [[ADR-0018-observability-openobserve]]
- [[2026-07-16-structured-logging-and-dashboards-design]]
- [[2026-07-19-logging-context-and-tracing-design]]
- [[logging-context]]
- [[ADR-0003-grpc-inter-service]]
