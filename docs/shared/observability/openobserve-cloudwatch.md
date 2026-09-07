---
title: OpenObserve via CloudWatch
type: convention
area: shared
status: active
created: 2026-07-10
updated: 2026-09-06
tags: [type/convention, area/shared, status/active]
related: ["[[ADR-0018-observability-openobserve]]", "[[cqrs]]", "[[2026-07-10-signoz-logs-observability-design]]", "[[2026-07-10-openobserve-migration-design]]", "[[2026-09-06-address-geocoding-proxy-design]]"]
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

## Selective access logging as a metering pattern

[[2026-09-06-address-geocoding-proxy-design]] uses this pipeline to meter a third-party free
tier rather than to trace a request: `apps/web/nginx.conf` sets `access_log off` globally and
re-enables it for one `location` only (`/geocode/`), in a JSON `log_format` carrying
`service_name`/`severity_text`/`severity_number` in the same shape every other service emits.
This is a reusable pattern for counting calls to an external dependency without instrumenting
application code — as long as static-file logging stays off, since nginx's default combined
format carries no `service_name` and would otherwise land in the `unclassified` stream.

> [!warning] JE-253 — stack-wide log ingestion gap on a long-running stack
> Verifying the geocode call count surfaced a defect that is NOT specific to that feature: on a
> stack that has been up for a while, the OpenObserve collector reports "Too old data, only last
> 5 hours can be ingested" and drops thousands of records. Confirmed against Users too. Any
> count or query run against OpenObserve on a long-running stack is unreliable until
> [JE-253](https://linear.app/je-martinez/issue/JE-253) (High) is fixed — a low count can mean
> either "few calls" or "the collector dropped them," and today there is no way to tell which
> from the query alone.

## Related

- [[ADR-0018-observability-openobserve]]
- [[cqrs]] — handler-level boundaries that logs follow across services.
- [[2026-07-10-signoz-logs-observability-design]] — the design spec that first specified the collector/receivers this convention documents.
- [[2026-07-10-openobserve-migration-design]] — the design spec that repointed the exporter to OpenObserve.
- [[2026-09-06-address-geocoding-proxy-design]] — the selective-logging metering pattern and the
  JE-253 ingestion gap it surfaced.
