---
title: "ADR-0001: Terraform with cloudposse/label Naming"
type: adr
area: shared
status: accepted
id: ADR-0001
created: 2026-06-26
updated: 2026-06-26
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags: [type/adr, area/shared, status/accepted]
related: []
---

# ADR-0001: Terraform with cloudposse/label Naming

## Context

The project provisions all AWS resources via Terraform. Without a consistent naming convention, resource names across environments and modules become unpredictable, making cross-service references and auditing difficult.

## Decision

All infrastructure is managed through custom Terraform modules. Every resource name is derived from the `cloudposse/terraform-null-label` module, which composes a deterministic name from `namespace`, `environment`, `stage`, and `name` components. No resource is named outside this convention.

## Consequences

Resource names are predictable and environment-scoped (e.g. `3mrai-prod-users-ecs`). Adding a new environment requires only a new variable set. The `cloudposse/label` module becomes a mandatory dependency in every Terraform module in the repo.

## Related

- [[ADR-0009-apigw-alb-fargate]]
