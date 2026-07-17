---
title: Terraform Remote State Backend (S3 + DynamoDB on Floci/AWS) Design
type: spec
area: infra
status: draft
created: 2026-07-17
updated: 2026-07-17
tags:
  - type/spec
  - area/infra
  - status/draft
related:
  - "[[ADR-0017-floci-local]]"
  - "[[floci-rds-apigw-limits]]"
  - "[[ADR-0001-terraform-cloudposse-naming]]"
---


# Terraform Remote State Backend (S3 + DynamoDB on Floci/AWS) Design

## Summary

Move Terraform state off local files onto a remote **S3 backend with DynamoDB locking**, working
against Floci locally (endpoints to `:4566`) and real AWS in prod. Today no backend is declared, so
every root uses a local `terraform.tfstate`. That local state drifts out of sync with Floci — the
concrete failure that motivated this: after `make bootstrap`, Terraform's local state believed an
ECS task definition (`3mrai-local-compute-nginx:1`) existed while Floci reported none
(`list-task-definitions` empty), so `terraform apply` failed reading a resource that wasn't there.
A versioned remote backend with a lock table removes this class of failure and ends the churn of
local `.tfstate` files (which had accumulated numerous `.bak` variants).

The backend itself is created **once** by a dedicated module + root that uses local state (the
chicken-and-egg: the bucket/table that store state cannot live in the state they initialize). Every
other root then points its `backend "s3"` at that bucket, with per-environment connection details
injected via `-backend-config`.

## Goals

- Remote, versioned Terraform state with locking, for both local (Floci) and prod (AWS).
- Solve the backend chicken-and-egg with a create-once module/root that self-excludes (local state).
- Both local roots — phase-1 (`environments/local`) and phase-2 (`environments/local/post`) —
  store state in the backend under distinct keys.
- Integrate cleanly into `make bootstrap` (backend created before the first init/apply).
- End local `.tfstate` file churn and the TF↔Floci drift failures.

## Non-Goals

- Migrating the CURRENT (broken/desynced) local state — it was moved aside to `.desync-bak`; we
  start FRESH in the new backend via a clean `make bootstrap`, not a state migration.
- Standing up the prod environment root (it is empty today). The module and `backend.hcl` pattern
  are made reusable for prod, but prod wiring is deferred.
- Changing any application resource, service, or the /v1/products routing fix (that fix is already
  in the working tree, validated; it will be applied by the clean rebuild this backend enables).

## Background: the chicken-and-egg

A Terraform `backend "s3"` needs its bucket and lock table to already exist before `terraform init`
can use it. Those resources therefore cannot be managed in the same state they hold. The standard
resolution — adopted here — is a separate "bootstrap" root that creates the bucket + table using
**local** state, applied once; thereafter all real roots use the remote backend.

## Design

### 1. Module `infra/modules/tf-backend/`

Creates the state-storage primitives, named via the cloudposse/label module (see
[[ADR-0001-terraform-cloudposse-naming]]):

- An S3 bucket with **versioning enabled** (state history / recovery).
- A DynamoDB table for state locking (`LockID` string hash key, on-demand billing).

Parameterized (bucket name, table name, tags) so it serves both local and prod.

### 2. Root `infra/environments/local/backend/`

- Invokes `module.tf-backend`.
- Uses **local state** (no `backend "s3"` block here) — this is the create-once root that
  self-excludes from the remote backend, resolving the chicken-and-egg.
- Applied once (idempotent: re-applying when the bucket/table already exist is a no-op).
- Targets Floci via the same provider endpoint config as the other local roots (S3 + DynamoDB
  endpoints at `:4566`).

### 3. Remote backend on the existing roots (partial config)

Both `environments/local` (phase-1) and `environments/local/post` (phase-2) declare an empty
partial backend:

```hcl
terraform {
  backend "s3" {}
}
```

Connection details are injected per environment via a `backend.hcl` file passed to
`terraform init -backend-config=backend.hcl`. The local `backend.hcl` mirrors the repo-root
`example.hcl` draft (Floci endpoints, path-style, skip-validation flags):

```hcl
bucket                      = "<state-bucket>"
key                         = "local/phase1/terraform.tfstate"   # phase-2 uses local/phase2/...
region                      = "us-east-1"
dynamodb_table              = "<lock-table>"
endpoint                    = "http://localhost:4566"
sts_endpoint                = "http://localhost:4566"
dynamodb_endpoint           = "http://localhost:4566"
skip_credentials_validation = true
skip_metadata_api_check     = true
skip_region_validation      = true
use_path_style              = true
```

- **Distinct keys, same bucket:** `local/phase1/terraform.tfstate` and
  `local/phase2/terraform.tfstate` — the two roots never collide.
- **prod** gets its own `backend.hcl` (real AWS: no custom endpoints, real credentials) when the
  prod root is built — same code, different injected config.
- phase-2 currently reads phase-1 outputs via `terraform_remote_state` from the local file; it is
  updated to read from the **s3 backend** (phase-1's key), so the cross-phase dependency also goes
  through the remote backend.

The repo-root `example.hcl` draft is superseded by the per-environment `backend.hcl` files and is
removed.

### 4. `make` integration

- New target **`backend-up`**: `terraform -chdir=environments/local/backend apply -auto-approve`
  (local state), creating the bucket + lock table in Floci. Idempotent.
- Inserted as the **first infra step of `bootstrap`**, after `docker compose up -d floci` and before
  `infra-init`.
- `infra-init` (and the phase-2 init in `infra-up-post`) pass
  `-backend-config=<env>/backend.hcl` so `terraform init` wires the remote backend.
- Updated `bootstrap` order: `floci up` → **`backend-up`** → `infra-init` (with backend-config) →
  `infra-up` (phase-1 apply) → `env-file` → `migrate` → build/start `users` → `bootstrap.sh` →
  `infra-up-post` (phase-2, with backend-config) → services.

### 5. Prod (reusable, not wired today)

The `tf-backend` module and the `backend.hcl` partial-config pattern are prod-ready: prod will get
its own `backend/` invocation (or a shared backend with a `prod/…` key namespace) and a prod
`backend.hcl` pointing at real AWS S3 + DynamoDB. This spec does NOT create the prod root
(`environments/production` is empty) — it only ensures nothing here is local-only by design.

## Risks & Open Points

- **Floci S3 versioning + DynamoDB lock end-to-end:** DynamoDB already responds locally
  (`list-tables` works); confirm S3 bucket versioning and that Terraform's lock acquire/release
  against Floci's DynamoDB works during `init`/`apply`. Fallback if locking misbehaves on Floci:
  `-lock=false` locally (documented), never in prod.
- **Provider pin (`= 5.31.0`):** the `backend "s3"` with `endpoint`/`dynamodb_endpoint`/`sts_endpoint`
  keys is valid for this Terraform/provider era (matches `example.hcl`). Confirm `terraform init`
  accepts these keys with the pinned versions; newer Terraform moved some under an `endpoints {}`
  block — use whichever form the pinned version accepts.
- **Bootstrap idempotency:** `backend-up` must not fail when the bucket/table already exist (either
  rely on the resources being unchanged, or guard). A second `apply` of the backend root should be a
  no-op — this root is tiny and not subject to the Floci second-apply RDS/APIGW limit
  (see [[floci-rds-apigw-limits]]), but verify.
- **Clean-slate start:** the current `.desync-bak` states are abandoned, not migrated. The first
  `make bootstrap` on the new backend builds everything fresh; verify the full chain completes and
  `/v1/products` works end-to-end through the gateway afterward.

## Verification

- `make backend-up` creates the bucket + lock table in Floci (idempotent on re-run).
- `terraform init -backend-config=backend.hcl` in phase-1 and phase-2 initializes the s3 backend;
  `terraform plan` reads/writes state to S3 and acquires the DynamoDB lock.
- A full `make bootstrap` from clean completes end-to-end with state in S3 (no local `.tfstate` for
  the real roots), and `GET /v1/products` through the API gateway returns 401 (no header) / 200
  (with `x-user-id`).
- No `terraform.tfstate` file churn remains in the real roots (only the backend root keeps local
  state, by design).

## Related

- [[ADR-0017-floci-local]]
- [[floci-rds-apigw-limits]]
- [[ADR-0001-terraform-cloudposse-naming]]
