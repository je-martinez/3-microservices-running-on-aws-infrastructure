---
title: "ADR-0009: API Gateway → ALB → ECS Fargate in Production"
type: adr
area: shared
status: accepted
id: ADR-0009
created: 2026-06-26
updated: 2026-06-26
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags: [type/adr, area/shared, status/accepted]
related:
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
---

# ADR-0009: API Gateway → ALB → ECS Fargate in Production

## Context

Services need to be reachable by external clients with authentication, rate limiting, and TLS termination handled at the edge. Containers must scale independently without managing EC2 instances. Local development must mirror the production topology without requiring a full AWS account.

## Decision

In production, all external traffic enters through AWS API Gateway (with Cognito authoriser), is forwarded to an Application Load Balancer, and routed to ECS Fargate tasks per service. Locally, services run in Docker containers with Docker Watch for live reload, bypassing API Gateway and ALB.

## Consequences

Authentication and throttling are enforced at the edge for all external calls without changes to service code. Fargate removes the need to manage host infrastructure. The local/prod gap (no API Gateway locally) must be documented in the local dev runbook.

## Related

- [[ADR-0001-terraform-cloudposse-naming]]
- [[ADR-0010-cognito-auth]]
- [[ADR-0012-ministack-local]]
- [[ADR-0016-local-apigw-nginx-ecs]] — local override: Ministack's ALB emulator does not support ECS `ip`/`instance` target types, so the local environment replaces ALB with an Nginx ECS reverse proxy. This ADR governs production only.
