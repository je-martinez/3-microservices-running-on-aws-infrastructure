---
title: OpenObserve via CloudWatch
type: convention
area: shared
status: active
created: 2026-07-10
updated: 2026-07-28
tags: [type/convention, area/shared, status/active]
related: ["[[ADR-0018-observability-openobserve]]", "[[cqrs]]", "[[2026-07-10-signoz-logs-observability-design]]", "[[2026-07-10-openobserve-migration-design]]"]
---

# OpenObserve via CloudWatch

## Rule

Logs are captured through **AWS CloudWatch** (prod ECS/Lambda) and Docker's **fluentd** driver
(local compose services), collected by an **OpenTelemetry collector**, and forwarded via **OTLP**
to **OpenObserve** — the backend for querying logs across services.

## Rationale

CloudWatch is the natural collection point on AWS and the authoritative store; the fluentd driver
covers local compose containers that don't reach CloudWatch; OpenObserve gives a single,
lightweight (single-binary) pane of glass. The same OTLP interface makes the backend swappable, as
demonstrated by the SigNoz → OpenObserve migration in [[ADR-0018-observability-openobserve]].

## Related

- [[ADR-0018-observability-openobserve]]
- [[cqrs]] — handler-level boundaries that logs follow across services.
- [[2026-07-10-signoz-logs-observability-design]] — the design spec that first specified the collector/receivers this convention documents.
- [[2026-07-10-openobserve-migration-design]] — the design spec that repointed the exporter to OpenObserve.
