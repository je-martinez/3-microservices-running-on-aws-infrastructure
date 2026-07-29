---
title: Terraform Modules
type: spec
area: infra
status: active
created: 2026-06-26
updated: 2026-07-28
tags: [type/spec, area/infra, status/active]
related:
  - ADR-0001-terraform-cloudposse-naming
  - "[[ADR-0017-floci-local]]"
  - "[[local-dev-floci]]"
  - "[[cognito-pre-token-lambda]]"
  - "[[awscli-fallback-for-floci]]"
  - "[[rds-aurora-engine-switchable-floci]]"
  - "[[two-phase-terraform-apply]]"
  - "[[terraform-remote-state-backend]]"
  - "[[local-gateway-per-route-integrations]]"
  - "[[nginx-njs-x-user-id-injection]]"
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

### Local composition and its follow-on decisions

`infra/environments/local` composes `label`, `networking`, `rds-aurora`, `cognito`, `compute`,
and `api-gateway` against Floci. Several decisions layered on top of that initial composition:

- **`rds-aurora` has a switchable engine** (`var.engine`, default `aurora-postgresql`) so local
  can instantiate real Floci Postgres/MySQL containers instead of Aurora, which Floci does not
  emulate — see [[rds-aurora-engine-switchable-floci]].
- **A second Terraform apply phase** (`environments/local/post/`) creates least-privilege
  database app-users natively, after the base infra is live, resolving the provider
  chicken-and-egg that previously pushed this into bash — see [[two-phase-terraform-apply]].
- **State moved to a remote S3 + DynamoDB backend** (a create-once bootstrap root +
  per-environment `backend.hcl`), ending local `.tfstate` drift against Floci — see
  [[terraform-remote-state-backend]].
- **The local API Gateway uses per-route integrations**, and the local nginx reverse proxy
  injects `x-user-id` via njs — both are Floci-only workarounds for gaps in the emulator; see
  [[local-gateway-per-route-integrations]] and [[nginx-njs-x-user-id-injection]].

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
- [[rds-aurora-engine-switchable-floci]]
- [[two-phase-terraform-apply]]
- [[terraform-remote-state-backend]]
- [[local-gateway-per-route-integrations]]
- [[nginx-njs-x-user-id-injection]]
