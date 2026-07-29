---
title: "Terraform remote state: S3 + DynamoDB, bootstrap root, per-environment backend.hcl"
type: adr
area: infra
status: accepted
created: 2026-07-28
updated: 2026-07-28
tags:
  - type/adr
  - area/infra
  - status/accepted
related:
  - "[[ADR-0017-floci-local]]"
  - "[[ADR-0001-terraform-cloudposse-naming]]"
  - "[[floci-rds-apigw-limits]]"
  - "[[2026-07-17-terraform-remote-state-backend-design]]"
  - "[[2026-07-17-terraform-remote-state-backend]]"
  - "[[two-phase-terraform-apply]]"
  - "[[terraform-modules]]"
---

# Terraform remote state: S3 + DynamoDB, bootstrap root, per-environment backend.hcl

## Decision

Terraform state moves off local `.tfstate` files onto a **remote S3 backend with DynamoDB
locking**, for both local (Floci) and production (real AWS), replacing the previous
"local state on disk under each environment directory" approach recorded in
[[terraform-modules]].

- A new `infra/modules/tf-backend/` module creates the storage primitives: a versioned S3
  bucket and a DynamoDB lock table (`LockID` string hash key, on-demand billing).
- A dedicated `infra/environments/local/backend/` root invokes that module and **keeps local
  state itself** — the create-once, self-excluding root that resolves the chicken-and-egg (the
  bucket/table that hold state cannot live in the state they initialize). Applied once via a new
  `make backend-up` target, idempotent.
- The existing phase-1 (`environments/local`) and phase-2 (`environments/local/post`, see
  [[two-phase-terraform-apply]]) roots declare an empty partial `backend "s3" {}` block and are
  `terraform init -backend-config=<env>/backend.hcl`'d, injecting connection details (bucket,
  distinct state key per root, region, Floci endpoints, path-style) per environment. Production
  gets its own `backend.hcl` (real AWS, no custom endpoints) when its root is built.
- `make bootstrap`'s order gains **`backend-up`** as the first infra step, before `infra-init`.

## Why

With no backend declared, every root used local `terraform.tfstate`, which drifted out of sync
with Floci: the concrete failure was Terraform's local state believing an ECS task definition
existed while Floci reported none, so `terraform apply` failed reading a resource that wasn't
there. Local `.tfstate` files had also accumulated numerous stale `.bak` variants. A versioned
remote backend with a lock table removes this class of drift and ends that churn.

## Consequences

- **Distinct state keys, one bucket.** `local/phase1/terraform.tfstate` and
  `local/phase2/terraform.tfstate` never collide; phase 2's `terraform_remote_state` read of
  phase 1 (already required per [[two-phase-terraform-apply]]) now reads through the S3 backend
  instead of a local state file, so the cross-phase dependency goes through the same remote
  mechanism as everything else.
- **The repo-root `example.hcl` draft is retired**, superseded by the real per-environment
  `backend.hcl` files this decision introduces.
- **Fresh start, not a migration.** The prior desynced local state was set aside
  (`.desync-bak`), not migrated — the first `make bootstrap` on the new backend rebuilds
  everything from a clean slate.
- **Naming follows [[ADR-0001-terraform-cloudposse-naming]]** for the bucket/table like every
  other resource in the repo.
- **Backend root is exempt from the Floci second-apply RDS/API-GW tag-update failure**
  documented in [[floci-rds-apigw-limits]] — it manages only S3/DynamoDB, not RDS or API Gateway
  v2, so `backend-up` is expected to be a safe no-op on re-run, unlike phase 1/phase 2.
- **Provider version constraint carried forward.** The pinned AWS provider (`= 5.31.0`, required
  for Floci compatibility per [[ADR-0017-floci-local]]) determines which backend config keys
  (`endpoint`/`dynamodb_endpoint`/`sts_endpoint` vs a newer `endpoints {}` block) are accepted —
  confirmed at implementation against the pinned version, not assumed.
- **Fallback if Floci's DynamoDB locking misbehaves:** `-lock=false` is permitted **locally
  only**, documented as such — never in production.

## Related

- [[ADR-0017-floci-local]]
- [[ADR-0001-terraform-cloudposse-naming]]
- [[floci-rds-apigw-limits]]
- [[2026-07-17-terraform-remote-state-backend-design]]
- [[2026-07-17-terraform-remote-state-backend]]
- [[two-phase-terraform-apply]]
- [[terraform-modules]]
