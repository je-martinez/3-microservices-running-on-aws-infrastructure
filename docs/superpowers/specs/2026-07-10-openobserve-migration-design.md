---
title: "OpenObserve observability backend migration — Design"
type: spec
area: shared
status: draft
created: 2026-07-10
updated: 2026-07-10
tags: [type/spec, area/shared, status/draft]
related: ["[[ADR-0018-observability-openobserve]]", "[[2026-07-10-signoz-logs-observability-design]]", "[[openobserve-cloudwatch]]", "[[signoz-selfhost-migrator-blocker]]", "[[ADR-0007-secrets-parameter-store]]"]
---

# OpenObserve observability backend migration — Design

## Problem

The SigNoz backend (Tasks 3-4 of [[2026-07-10-signoz-logs-observability-design]]) is blocked: the
self-hosted SigNoz schema-migrator never creates the ClickHouse tables, so the UI never starts
(full diagnosis in [[signoz-selfhost-migrator-blocker]]). This spec designs migrating the backend
to **OpenObserve**. The log-capture pipeline (Tasks 1-2 of the SigNoz plan, committed) stays as-is.

## Scope — what changes vs what doesn't

**Unchanged:**
- The collector's `fluent_forward` and `aws_cloudwatch` receivers.
- The four services' (`users`, `orders`, `tracking`, `events-pipeline`) fluentd logging blocks in
  compose.

**Changes:**
- The collector's exporter: `otlp` (SigNoz) → `otlp_http`/`openobserve` (OpenObserve).
- The backend service: the SigNoz stack (ClickHouse + query-service + UI, multiple containers) →
  a single OpenObserve container.

## Architecture

Same log sources and receivers as [[2026-07-10-signoz-logs-observability-design]]; only the
backend box changes to a single container.

```
services → fluentd / CloudWatch(Floci) → otel-collector
  (receivers unchanged: fluent_forward + aws_cloudwatch)
      │ otlphttp  (Authorization: Basic <base64>, stream-name)
      ▼
  OpenObserve (single container, :5080 UI + OTLP HTTP)  ← behind profiles:[observability]
```

## Components

### OpenObserve

- Image `public.ecr.aws/zinclabs/openobserve:v0.91.1` — **pinned**, not `:latest` (v0.91.1 is the
  current release; pinning follows the same reasoning as the collector's own version pin in
  [[2026-07-10-signoz-logs-observability-design]]).
- Env: `ZO_ROOT_USER_EMAIL` / `ZO_ROOT_USER_PASSWORD` — local dev values set directly in compose;
  prod values come from Secrets Manager per [[ADR-0007-secrets-parameter-store]].
- Behind `profiles: [observability]` (shares the existing profile — see [Open
  questions](#open-questions-for-the-plan)), on the `3mrai-network`, publishes `:5080`.

### The collector exporter (verified config)

```yaml
exporters:
  otlp_http/openobserve:
    endpoint: http://openobserve:5080/api/default
    headers:
      Authorization: "Basic ${env:O2_BASIC_AUTH}"   # base64(email:password)
      stream-name: ecs_logs
```

> [!warning] Use `otlp_http`, not the deprecated `otlphttp` alias
> Verified live: the collector warns that the `otlphttp` exporter alias is deprecated in favor of
> `otlp_http`. The implementation plan must use `otlp_http/openobserve`, matching the same
> deprecated-alias caveat already recorded for the receivers (`aws_cloudwatch`, `fluent_forward`)
> in [[2026-07-10-signoz-logs-observability-design]].

## Verified facts (established, not re-derived)

These were confirmed live today (2026-07-10) against a running OpenObserve container and the
existing collector:

1. OpenObserve starts one-command / one-container / ~3s / `healthz` returns 200 — exactly where
   the SigNoz self-hosted stack failed (see [[signoz-selfhost-migrator-blocker]]).
2. OpenObserve accepts OTLP at `/api/default` (200).
3. Our existing collector's `aws_cloudwatch` receiver ingested 19 nginx LogRecords from Floci
   CloudWatch and they were queryable in OpenObserve — a search returned the `GET /v1/health 200`
   line among them.
4. **`doc_num:0` in OpenObserve's stream-stats API is a lagging counter, not a failure signal.**
   The data is really there: a direct `_search` against the stream returns hits even when
   stream-stats still reports `doc_num:0`. Recorded here so nobody re-chases `doc_num:0` as a bug
   in a future session.

## Auth handling

- **Local:** `ZO_ROOT_USER_EMAIL` / `ZO_ROOT_USER_PASSWORD` fixed in compose; `O2_BASIC_AUTH` is
  the base64 encoding of those same credentials, passed to the collector.
- **Prod:** Secrets Manager, per [[ADR-0007-secrets-parameter-store]] — deferred, same boundary
  [[2026-07-10-signoz-logs-observability-design]] already accepted for prod deployment (unverifiable
  against Floci).

## Error handling / edge cases

- **Collector startup ordering vs OpenObserve** — already covered by the services' existing
  `fluentd-async` setting from [[2026-07-10-signoz-logs-observability-design]]; no new mitigation
  needed.
- **OpenObserve down** → the collector queues/drops per [[ADR-0018-observability-openobserve]];
  CloudWatch remains the store of record in prod, so no data is permanently lost.
- **The deprecated exporter alias** (`otlphttp` vs `otlp_http`) — see the warning above.

## Testing strategy

Live integration only, the same approach used for the Floci chain and for
[[2026-07-10-signoz-logs-observability-design]]: generate an nginx access log, then confirm it is
queryable in OpenObserve via the UI/search. No unit tests — this is infra wiring.

## In scope / Out of scope

**In scope:**
- OpenObserve compose service.
- The collector exporter change (`otlp` → `otlp_http/openobserve`).
- Auth wiring (`ZO_ROOT_USER_*`, `O2_BASIC_AUTH`).
- Live verification per [Testing strategy](#testing-strategy).

**Out of scope (follow-ups):**
- Traces/metrics instrumentation of the services.
- Prod Terraform + Secrets Manager wiring for OpenObserve.

## Open questions for the plan

- The exact stream-name(s): one `ecs_logs` stream for CloudWatch-sourced logs and a separate
  stream for fluentd-sourced service logs, or a single shared stream.
- Whether OpenObserve gets its own compose profile or shares the existing `observability`
  profile — it should share it, consistent with how the collector and (previously) SigNoz were
  grouped in [[2026-07-10-signoz-logs-observability-design]].

## Related

- [[ADR-0018-observability-openobserve]]
- [[2026-07-10-signoz-logs-observability-design]]
- [[openobserve-cloudwatch]]
- [[signoz-selfhost-migrator-blocker]]
- [[ADR-0007-secrets-parameter-store]]
