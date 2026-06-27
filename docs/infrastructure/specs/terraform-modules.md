---
title: Terraform Modules
type: spec
area: infra
status: active
created: 2026-06-26
updated: 2026-06-26
tags: [type/spec, area/infra, status/active]
related:
  - ADR-0001-terraform-cloudposse-naming
---

# Terraform Modules

## Summary

This spec describes the custom Terraform module structure used to provision the 3MRAI AWS
infrastructure. All modules follow the `cloudposse/label/null` naming convention, enforced
globally via [[ADR-0001-terraform-cloudposse-naming]].

## Stack & Data Store

- **IaC tool:** Terraform (>= 1.7).
- **State backend:** S3 + DynamoDB lock table per environment (`dev`, `staging`, `prod`).
- **Module registry:** private, co-located under `infra/modules/`.
- **Naming root:** `cloudposse/label/null` — every resource receives a deterministic name
  derived from `namespace`, `environment`, `stage`, `name`, and optional `attributes`.

## Module Inventory

| Module path | Responsibility |
|---|---|
| `infra/modules/networking` | VPC, subnets, security groups, Route 53 zones |
| `infra/modules/ecs-service` | ECS Fargate cluster + service + task definition |
| `infra/modules/rds-aurora` | Aurora cluster (Postgres / MySQL) with read/write replicas |
| `infra/modules/sqs-lambda` | SQS queue wired to a Lambda function (CQRS handler) |
| `infra/modules/documentdb` | DocumentDB cluster for event-sourcing store |
| `infra/modules/cognito` | Cognito User Pool + App Client |
| `infra/modules/secrets` | Secret Manager secrets + Parameter Store parameters |
| `infra/modules/ecr` | ECR repositories per service |

## Naming Convention

Every module instantiation passes a `context` object sourced from the root
`cloudposse/label/null` context:

```hcl
module "label" {
  source    = "cloudposse/label/null"
  version   = "0.25.0"

  namespace   = "3mrai"
  environment = var.environment   # dev | staging | prod
  stage       = var.stage         # e.g. blue | green
  name        = var.service_name  # users | orders | tracking | events-pipeline
}
```

Resource names are derived via `module.label.id` (e.g. `3mrai-prod-users`). Tags inherit
`module.label.tags` automatically.

## Cross-cutting rules

- All modules expose a `context` input (the label context) so parent compositions control
  naming without duplicating variables.
- Outputs from every module include `name`, `arn`, and `tags` for downstream consumption.
- Sensitive outputs (passwords, tokens) are marked `sensitive = true` and never logged.
- See [[ADR-0001-terraform-cloudposse-naming]] for the full naming rationale.

## Related

- [[ADR-0001-terraform-cloudposse-naming]]
- [[networking]]
- [[aws-resources]]
