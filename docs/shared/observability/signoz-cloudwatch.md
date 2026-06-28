---
title: SigNoz via CloudWatch
type: convention
area: shared
status: active
created: 2026-06-26
updated: 2026-06-26
tags: [type/convention, area/shared, status/active]
related: []
---

# SigNoz via CloudWatch

## Rule

Logs and traces are captured through **AWS CloudWatch** and forwarded to a **SigNoz** instance, which is our observability backend for querying logs, traces, and metrics across services.

## Rationale

CloudWatch is the natural collection point on AWS, while SigNoz gives us a single, open-source pane of glass for correlated logs and distributed traces across all services and the events pipeline. Forwarding from CloudWatch to SigNoz keeps ingestion close to the platform while centralizing analysis. See the [SigNoz documentation](https://signoz.io/docs/introduction/) for the platform.

## Related

- [[cqrs]] — handler-level boundaries that traces follow across services.
