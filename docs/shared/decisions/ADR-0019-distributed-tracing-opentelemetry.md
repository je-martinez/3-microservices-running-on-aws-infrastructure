---
title: "ADR-0019: Distributed Tracing via OpenTelemetry, Split from OpenObserve to Jaeger"
type: adr
area: shared
status: accepted
id: ADR-0019
created: 2026-07-19
updated: 2026-08-21
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
  - "[[2026-07-19-logging-context-and-tracing]]"
  - "[[logging-context]]"
  - "[[ADR-0003-grpc-inter-service]]"
  - "[[2026-07-12-prisma-lazy-promise-als]]"
  - "[[developer-experience-milestone]]"
  - "[[2026-08-18-distributed-tracing-spans-design]]"
  - "[[2026-08-18-distributed-tracing-spans]]"
  - "[[events-pipeline-design]]"
  - "[[users-service-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[openobserve-runbook]]"
  - "[[observability-telemetry-milestone]]"
  - "[[2026-08-21-verify-in-the-viewer-not-the-api]]"
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
- **Resolved: cross-service traces now join into one trace.** The create-order flow
  (Orders → Users gRPC identity call, see [[ADR-0003-grpc-inter-service]]) produces a single
  8-span Jaeger trace, with the Users `users.v1.Users/GetUserById` server span a **child** of the
  Orders span, not a second root. The root cause was on the Users **receive** side, not on
  Orders' injection side: the `x-api-key` gRPC interceptor extracted the caller's W3C
  `traceparent` correctly, but activated it in `onReceiveMetadata` via
  `context.with(parent, () => mdNext(metadata))` — that callback returns synchronously, while
  grpc-js dispatches the async handler on a **later tick**, so the AsyncLocalStorage scope had
  already unwound by the time the server span was created, leaving it parentless (`refs=0`).
  Same failure family as [[2026-07-12-prisma-lazy-promise-als|the Prisma-lazy-promise/ALS
  pitfall]]. The fix stashes the extracted context and re-activates it in
  `onReceiveHalfClose` — the continuation that actually dispatches the handler
  (`context.with(parentContext, () => hcNext())`) — with the propagation logic extracted into a
  pure, unit-tested `extractParentContext(metadata)` helper. An earlier diagnosis blamed Orders
  for not injecting the `traceparent` (and considered adding the prerelease
  `OpenTelemetry.Instrumentation.GrpcNetClient` package) — a live dump of the inbound gRPC
  metadata on the Users side proved that wrong: the `traceparent` arrived correct and sampled
  (`00-<traceid>-<spanid>-01`); Orders' instrumentation was never the problem. Verified with 188
  Users tests (184 baseline + 4 new regression), lint, build, and 17/17 gateway E2E all green.
  Fixed and verified in commit `a62c5fb` on `feature/developer-experience`;
  [JE-77](https://linear.app/je-martinez/issue/JE-77) is Done.

> [!info] Update (2026-08-19) — business spans, the SQS hop, and full Lambda coverage, verified
> [[2026-08-18-distributed-tracing-spans-design]] and its implementation plan
> [[2026-08-18-distributed-tracing-spans]] closed the remaining gaps this ADR left open. 10 of 11
> issues shipped (JE-138, JE-152 through JE-160); only JE-161 (E2E) remains.
>
> - **Business spans on all 11 flows.** Every flow that already had a full `*_started`/
>   `*_succeeded`/`*_failed` log triad (7 in Users, 1 in Orders, 3 in Tracking) now gets a manual
>   `INTERNAL` workflow span carrying the same `app_event`/`reason` attributes as its log line —
>   see [[logging-context#Flow logs]]. A real Jaeger trace for `POST /v1/users/register` shows the
>   resulting cascade (54 spans total):
>   ```
>   POST — 209.4ms
>     register — 203.1ms
>       prisma:client:operation — 102.9ms
>         prisma:client:connect — 46.2ms
>         prisma:client:db_query — 25.5ms
>           pg.query:INSERT users — 9.8ms
>       CognitoIdentityProvider.AdminCreateUser — 13.7ms
>       3mrai-local-events-events send — 11.3ms
>   ```
> - **The SQS hop now propagates trace context.** All 3 publishers (Users, Orders, Tracking)
>   inject `traceparent` into SQS `MessageAttributes` (never the envelope body — that stays a
>   Zod-validated domain contract). The events-pipeline consumer does **not** create a
>   parent-child relationship for it — an SQS batch carries messages from distinct origin traces,
>   so a single parent would force picking one and lying about the rest. It uses **span links**
>   instead: one `events-queue process` `CONSUMER` span links to the N origin traces in its batch,
>   and each record's own `process_record` `INTERNAL` span links to its own origin trace. Verified:
>   ```
>   events-queue process (569ms)  refs=0
>     process_record (491ms)      refs=2
>        -> CHILD_OF     SAME trace
>        -> FOLLOWS_FROM ANOTHER trace   <- link to the origin
>   ```
>   and a `metrics-tick` span (the EventBridge 1-minute tick) with `refs=0` — a timer has no origin
>   trace to link to, so it correctly starts a new one.
> - **Honest limitation, kept as such rather than smoothed over:** in Jaeger, a span link does
>   **not** draw the linked span's bar inside the origin trace's own waterfall as if it were a
>   child — it renders as a navigable reference instead. Choosing links over a fabricated
>   parent-child relationship on a batch consumer was a deliberate trade of visual continuity for
>   not lying about the hierarchy.
> - **All 5 Lambda runtimes now carry the OTel SDK**, closing the gap this ADR never covered:
>   `functions/events-pipeline` (JE-138) and all 4 `functions/realtime-events` entry points —
>   `connect`, `disconnect`, `default`, `authorizer` (JE-159).
> - **Auto-instrumentation does not survive an esbuild bundle — a mid-design correction.** Both
>   Lambda packages ship as esbuild-bundled, single-file CJS output with the AWS SDK and other
>   deps inlined (`bundle: true`, `format: "cjs"` — ESM fails on the real `nodejs20.x` runtime with
>   `ERR_REQUIRE_CYCLE_MODULE`, verified empirically). OTel auto-instrumentation patches modules at
>   `require()`/resolution time; once esbuild inlines `@aws-sdk/client-ses`, `mongodb`, and
>   `@aws-sdk/client-apigatewaymanagementapi` into one file, there is no module boundary left to
>   patch. Registering `getNodeAutoInstrumentations()` in either Lambda would have produced
>   **zero spans, silently** — the same silent-failure shape [[logging-context#OTel configuration
>   belongs in the environment, not in code]] already documents three times over. The spec's own
>   Decision 5 diagram originally marked these internal spans `auto-instr.`; that was found
>   factually wrong while writing the implementation plan and corrected in place. Every internal
>   Lambda span (DocumentDB insert, SES send, WebSocket publish) is therefore **manual**, by
>   packaging necessity, not by style choice.

> [!important] Amendment (2026-08-21) — Jaeger removed; OpenObserve is now the single backend for logs and traces
> **What changed.** The HTTP 400 on trace **ingest** that motivated the original split no longer
> reproduces on OpenObserve v0.91.1. Traces have been ingesting correctly — 48,764 spans measured
> in the `app_traces` stream. The reason Jaeger was introduced is gone, so the split it caused is
> reversed, exactly as the original Consequences section called "reversible."
>
> **What was done.** Jaeger removed entirely: the `jaeger` service in `docker-compose.yml`, the
> `otlp/jaeger` exporter and its entry in the collector's traces pipeline in
> `observability/otel-collector-config.yaml`, and every reference in the `Makefile`
> (`observability-up`, `observability-down`, the UI echo line). The traces pipeline now exports to
> `otlp_http/openobserve_traces` alone — see [[openobserve-runbook#Traces]].
>
> **Why this is better, not just simpler.** Logs and traces in one backend means "show me the
> logs for this span" is one query in one system, joined by the `trace_id` every log line already
> carries per [[logging-context]]. That correlation was the original motivation for choosing
> OpenObserve in [[ADR-0018-observability-openobserve]], and a second backend for traces could
> never provide it — a Jaeger trace and an OpenObserve log both carrying the same `trace_id` still
> required two UIs and a manual copy-paste to correlate.
>
> **A DIFFERENT HTTP 400 exists and must not be confused with the one above.** OpenObserve's
> trace-detail view (the waterfall) calls `/api/{org}/{stream}/traces/{trace_id}/dag`, and that
> endpoint SELECTs `gen_ai_operation_name` — a column belonging to its LLM-tracing feature that
> nothing in this repo emits. When the field is absent from the stream's inferred schema the query
> fails with `code 20004, "Search field not found"`, and it fails for **every** trace, so the
> waterfall is entirely unavailable. This is a **query-side** failure against data that arrived
> fine — not the ingest-side rejection this ADR originally documented. Full detail, the fix, and
> the reproduction steps: [[openobserve-runbook#Traces]].
>
> **Reversibility used exactly as designed.** The original Consequences section below promised
> "re-pointing [the collector] at another backend... is a configuration change, not a
> re-instrumentation of either service." That promise held: no service code changed to make this
> switch, only the collector config, compose file, and Makefile.

## Supersedes

- The **tracing / logs-only stance** of [[ADR-0018-observability-openobserve]] — its
  OpenObserve-over-SigNoz **backend choice for logs stands unchanged**; only the "traces are out
  of scope" position is superseded.
- The tracing Non-Goal of [[2026-07-16-structured-logging-and-dashboards-design]].

## Related

- [[ADR-0018-observability-openobserve]]
- [[2026-07-16-structured-logging-and-dashboards-design]]
- [[2026-07-19-logging-context-and-tracing-design]]
- [[2026-07-19-logging-context-and-tracing]] — the implementation plan for that design.
- [[logging-context]]
- [[ADR-0003-grpc-inter-service]]
- [[2026-07-12-prisma-lazy-promise-als]] — same ALS-scope-unwinding failure family as the JE-77 root cause.
- [[developer-experience-milestone]] — Block 2 status, now closed at 11/11 with JE-77 fixed.
- [[2026-08-18-distributed-tracing-spans-design]] — business spans on the 11 flows, the SQS
  traceparent+links hop, and full Lambda SDK coverage; see the 2026-08-19 Consequences update
  above.
- [[2026-08-18-distributed-tracing-spans]] — the implementation plan, verified against a real
  Jaeger trace.
- [[events-pipeline-design]] — the CONSUMER→INTERNAL span structure with links, and why the
  Lambda's internal spans are manual.
- [[users-service-design]], [[orders-service-design]], [[tracking-service-design]] — the
  per-service workflow spans this update added.
- [[openobserve-runbook]] — the Traces section documents the waterfall's `gen_ai_operation_name`
  400, `make observability-traces-schema`, and how to open a trace now that both signals share
  one backend.
- [[observability-telemetry-milestone]] — the active milestone during which this Amendment landed.
- [[2026-08-21-verify-in-the-viewer-not-the-api]] — the verification-discipline lesson from the
  same session: confirming data reached OpenObserve via `_search` is not confirming the trace
  waterfall (`/dag`) actually renders it, which is exactly the `gen_ai_operation_name` gap this
  Amendment documents.
