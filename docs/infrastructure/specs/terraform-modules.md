---
title: Terraform Modules
type: spec
area: infra
status: active
created: 2026-06-26
updated: 2026-07-12
tags: [type/spec, area/infra, status/active]
related:
  - ADR-0001-terraform-cloudposse-naming
  - "[[ADR-0017-floci-local]]"
  - "[[local-dev-floci]]"
  - "[[cognito-pre-token-lambda]]"
  - "[[awscli-fallback-for-floci]]"
---

# Terraform Modules

## Summary

This spec describes the custom Terraform module structure used to provision the 3MRAI AWS
infrastructure. All modules follow the `cloudposse/label/null` naming convention, enforced
globally via [[ADR-0001-terraform-cloudposse-naming]].

## Stack & Data Store

- **IaC tool:** Terraform (>= 1.7).
- **State backend:** **local** (`terraform.tfstate` on disk under each environment directory) —
  there is no S3/DynamoDB remote-state backend configured today. `infra/environments/local/`
  keeps `terraform.tfstate` in-tree.
- **Module registry:** private, co-located under `infra/modules/`.
- **Naming root:** `cloudposse/label/null` — every resource receives a deterministic name
  derived from `namespace`, `environment`, `stage`, `name`, and optional `attributes`.
- **Environments:** `infra/environments/{local,production}` — not `dev`/`staging`/`prod`. The
  `local` environment targets Floci ([[ADR-0017-floci-local]]; bootstrap flow: [[local-dev-floci]]).

## Module Inventory

The real module inventory under `infra/modules/`:

| Module path | Responsibility |
|---|---|
| `infra/modules/label` | `cloudposse/label` wrapper providing the naming context |
| `infra/modules/networking` | VPC, subnets, security group |
| `infra/modules/compute` | nginx on ECS — the local reverse proxy that injects `x-user-id` via njs (see [[ADR-0016-local-apigw-nginx-ecs]]) |
| `infra/modules/api-gateway` | API Gateway v2, per-route `HTTP_PROXY` integrations, JWT authorizer |
| `infra/modules/cognito` | Cognito User Pool (+ `custom:app_user_id` attribute), App Client, and the repo's first Lambda (Pre-Token-Generation V2 — see [[cognito-pre-token-lambda]]) |
| `infra/modules/rds-aurora` | Aurora cluster (writer + reader endpoints) |
| `infra/modules/database` | empty placeholder (`.gitkeep` only) — not yet implemented |
| `infra/modules/messaging` | empty placeholder (`.gitkeep` only) — not yet implemented |

There is no `ecs-service`, `sqs-lambda`, `documentdb`, `secrets`, or `ecr` module — those are
not part of the current inventory.

Two Cognito resources are wired against Floci via the **awscli-fallback pattern**
(`terraform_data` + `local-exec` + an idempotent script, outside Terraform's normal resource
lifecycle) because the native Terraform resource cannot apply against Floci at the pinned
provider version: the Cognito App Client and the Pre-Token-Generation V2 trigger. See
[[awscli-fallback-for-floci]] for the pattern and why each case needed it.

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
- [[ADR-0017-floci-local]]
- [[local-dev-floci]]
- [[cognito-pre-token-lambda]]
- [[awscli-fallback-for-floci]]
- [[networking]]
- [[aws-resources]]
