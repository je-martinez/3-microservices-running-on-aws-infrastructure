---
title: "ADR-0011: Observability via CloudWatch and SigNoz"
type: adr
area: shared
status: superseded
id: ADR-0011
created: 2026-06-26
updated: 2026-07-10
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: ADR-0018
tags: [type/adr, area/shared, status/superseded]
related: ["[[openobserve-cloudwatch]]"]
---

# ADR-0011: Observability via CloudWatch and SigNoz

> [!warning] Superseded
> Superseded by [[ADR-0018-observability-openobserve]] because the self-hosted SigNoz stack could
> not be brought up (see [[signoz-selfhost-migrator-blocker]]).

## Context

ECS Fargate and Lambda emit logs and metrics to AWS CloudWatch by default. CloudWatch alone offers limited trace correlation and a poor developer experience for distributed tracing across multiple services.

## Decision

All services emit logs and traces to AWS CloudWatch via the native Fargate/Lambda integration. A SigNoz instance ingests and correlates these signals, providing a unified UI for traces, metrics, and logs. SigNoz is the primary observability interface for engineers.

## Consequences

The team gets distributed tracing across all services without instrumenting a separate collector. CloudWatch remains the authoritative log store (retention, alerts). SigNoz must be kept running; its availability is not required for services to function.

## Related

- [[openobserve-cloudwatch]]
- [[ADR-0018-observability-openobserve]]
- [[signoz-selfhost-migrator-blocker]]
