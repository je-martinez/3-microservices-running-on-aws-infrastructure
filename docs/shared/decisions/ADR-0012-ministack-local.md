---
title: "ADR-0012: Ministack for Local AWS Emulation"
type: adr
area: shared
status: accepted
id: ADR-0012
created: 2026-06-26
updated: 2026-06-26
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags: [type/adr, area/shared, status/accepted]
related: []
---

# ADR-0012: Ministack for Local AWS Emulation

## Context

Developing against real AWS services is slow (deployment latency), costly, and requires network access. Developers need a local environment that faithfully emulates the AWS services the system depends on — SQS, S3, Secrets Manager, Parameter Store — without a live AWS account.

## Decision

Local development uses [Ministack](https://ministack.org/docs/) to emulate AWS services. All services run in Docker containers with Docker Watch for live reload. Parameters and secrets are synced locally from Ministack instances. The local Ministack endpoint replaces the AWS SDK endpoint via environment variable.

## Consequences

Developers can work fully offline for most workflows. The local/cloud parity is high but not perfect — differences must be tracked in the local dev runbook. Ministack becomes a required local dependency; its setup is documented in the infra runbook.

## Related

- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0009-apigw-alb-fargate]]
