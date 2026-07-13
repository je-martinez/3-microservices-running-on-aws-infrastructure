---
title: "ADR-0018: Observability via CloudWatch and OpenObserve"
type: adr
area: shared
status: accepted
id: ADR-0018
created: 2026-07-10
updated: 2026-07-10
deciders: [Jose E. Martinez]
supersedes: ADR-0011
superseded-by: null
tags: [type/adr, area/shared, status/accepted]
related: ["[[ADR-0011-observability-signoz]]", "[[openobserve-cloudwatch]]", "[[signoz-selfhost-migrator-blocker]]", "[[ADR-0007-secrets-parameter-store]]"]
---

# ADR-0018: Observability via CloudWatch and OpenObserve

## Context

[[ADR-0011-observability-signoz]] chose SigNoz as the primary observability interface. Implementing
it, the self-hosted SigNoz stack proved unusable: its schema-migrator reports `versions:[]` and
never creates the ClickHouse tables, so the UI never starts (full diagnosis in
[[signoz-selfhost-migrator-blocker]]). SigNoz's recent versions moved migration logic out of the
standalone migrator; the self-host compose is effectively broken for autonomous bring-up.

The log-capture pipeline itself — an OTel collector with `fluent_forward` and `aws_cloudwatch`
receivers, feeding OTLP — already works and is backend-agnostic. Only the visualization backend
was blocked.

## Decision

Adopt **OpenObserve** as the observability backend for **logs**, superseding SigNoz. Services still
emit to CloudWatch (prod, native Fargate/Lambda) and via Docker's fluentd driver (local); the OTel
collector forwards OTLP to a self-hosted OpenObserve. OpenObserve is the primary observability
interface for engineers.

### Why OpenObserve (verified live)

- Single Rust binary, one container, starts in ~3s (`healthz` returns 200) — exactly where
  SigNoz's multi-container stack failed.
- Ingests OTLP natively (HTTP `:5080` `/api/<org>`, gRPC `:5081`) with no bundled collector needed.
- ~512MB–1.5GB RAM versus SigNoz's 2–4GB.
- Parquet storage, local disk or S3.
- Our existing collector exported real nginx logs from Floci CloudWatch to OpenObserve and they
  were queryable (a `GET /v1/health 200` line among them).

## Consequences

- The change is isolated to the collector's exporter block (`otlp` → SigNoz becomes `otlphttp`/
  `otlp_http` → OpenObserve); the receivers and the services' fluentd logging remain unchanged.
- CloudWatch remains the authoritative log store in prod (retention, alerts); OpenObserve
  availability is not required for services to function.
- **Traces / APM trade-off:** OpenObserve supports traces via OTLP, but its distributed-tracing/APM
  maturity is below SigNoz's. We are logs-only today. If distributed tracing becomes a hard
  requirement, the backend is re-evaluated in a future ADR — this is a "sufficient for now", not a
  closed door.
- Prod deployment (OpenObserve on AWS + the OTLP auth secret from Secrets Manager per
  [[ADR-0007-secrets-parameter-store]]) is documented but deferred — unverifiable against Floci,
  the same boundary JE-36 accepted.

## Related

- [[ADR-0011-observability-signoz]]
- [[openobserve-cloudwatch]]
- [[signoz-selfhost-migrator-blocker]]
- [[ADR-0007-secrets-parameter-store]]
