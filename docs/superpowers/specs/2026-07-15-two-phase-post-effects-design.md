---
title: "Two-Phase Post-Effects Apply Design"
type: spec
area: infra
status: draft
created: 2026-07-15
updated: 2026-07-15
tags: [type/spec, area/infra, status/draft]
related:
  - "[[ADR-0004-soft-delete-only]]"
  - "[[ADR-0006-read-write-replicas]]"
  - "[[ADR-0007-secrets-parameter-store]]"
  - "[[ADR-0017-floci-local]]"
  - "[[ADR-0001-terraform-cloudposse-naming]]"
  - "[[floci-rds-apigw-limits]]"
  - "[[local-dev-floci]]"
  - "[[awscli-fallback-for-floci]]"
  - "[[2026-07-15-orders-rds-mysql-design]]"
  - "[[orders-service-design]]"
---

# Two-Phase Post-Effects Apply Design

Design for introducing a **second Terraform apply phase** — a new `environments/local/post/` root with its own state — that runs after the existing `environments/local/` root and creates least-privilege database app-users natively in Terraform, instead of via post-apply bash (`bootstrap.sh`). This resolves the provider chicken-and-egg problem where the `postgresql`/`mysql` providers need a live cluster endpoint that does not exist until after `aws_rds_cluster` is created. The mechanism is prod-first (analogous `environments/production/post/`) but gated per-engine locally, since Floci's MySQL cannot manage users at all.

> [!note] Status
> Draft — this is a design spec, not yet a plan or implemented change.

## Summary

Introduce a two-phase Terraform apply so database app-users (and other resources that can only be created **after** their target infrastructure is live) are managed cleanly by Terraform instead of by post-apply bash. Phase 1 (the existing `environments/local/` root) stands up the base infra. Phase 2 (a new `environments/local/post/` root with its **own** state) runs afterward: it reads phase-1 outputs and the master-credentials secret, configures the `postgresql`/`mysql` providers against now-live endpoints, and creates the least-privilege app-users. This resolves the provider chicken-and-egg problem that today forces `bootstrap.sh` to create `users_app` in bash. The mechanism is prod-first and gated per-engine in local.

## Motivation / current state

- Terraform configures every declared provider **before** creating the resources a plan touches. The `postgresql`/`mysql` providers need the cluster endpoint, which doesn't exist until **after** `aws_rds_cluster` is created on a clean apply — a chicken-and-egg no default resolves. Today `environments/local/providers.tf` omits the `postgresql` provider and `main.tf` sets `manage_app_user = false`; `bootstrap.sh` creates `users_app` post-apply in bash instead.
- The `rds-aurora` module **already** contains the `postgresql_*` app-user resources (role, grants SELECT/INSERT/UPDATE — no DELETE, per [[ADR-0004-soft-delete-only]] — default privileges, app-credentials secret), gated behind `manage_app_user`. It also already outputs `secret_arn` (master creds) and `app_secret_arn`.
- Verified empirically (2026-07-15): Floci's MySQL does **not** support user management — `CREATE USER` errors 1227 via CLI, the `petoju/mysql` Terraform provider **hangs** on `mysql_user`, and Floci has no TLS while `caching_sha2_password` demands it. Floci's Postgres app-user **does** work. So the MySQL branch of phase 2 cannot be validated on Floci; the Postgres branch can. See [[floci-rds-apigw-limits]] and [[ADR-0017-floci-local]] for the broader set of Floci emulation gaps this design must account for, and [[2026-07-15-orders-rds-mysql-design]] for Orders' MySQL provisioning this phase-2 mechanism will eventually need to cover.

## Section 1 — Architecture

Two independent Terraform roots:

- **Phase 1 — `environments/local/`** (existing): base infra (networking, RDS Postgres + MySQL, cognito, compute, api-gateway). Does **not** create app-users. Already exposes `secret_arn`/`app_secret_arn`/`db_*_endpoint`/`orders_db_*_endpoint` outputs.
- **Phase 2 — `environments/local/post/`** (new): separate root, its **own** state. Runs **after** phase 1. Reads phase-1 outputs + master secret, configures `postgresql`/`mysql` providers with live endpoints, creates the app-users. Separate state means one apply never re-touches the other (sidesteps Floci's second-apply `UpdateTags` quirk — see [[floci-rds-apigw-limits]]).

Flow: `make bootstrap` gains an `infra-up-post` step after phase 1 (and after `bootstrap.sh`, which shrinks to just the docker-native `nginx-stable` alias). Production is analogous with `environments/production/post/`.

## Section 2 — Reading phase-1 state + secret-only

- Phase 2 reads phase-1 outputs via a `terraform_remote_state` data source pointing at phase 1's local backend (`../terraform.tfstate`): gives access to `orders_db_writer_endpoint`, `db_writer_endpoint`, `secret_arn`, `app_secret_arn`. (Alternative considered: direct `aws_rds_cluster`/`aws_secretsmanager_secret` data sources — `terraform_remote_state` is simpler and doesn't re-query Floci.)
- Phase 2 reads the master-credentials secret **by ARN** via an `aws_secretsmanager_secret_version` data source, then `jsondecode`s it in memory to `{username,password,host,port,dbname}`. The `postgresql`/`mysql` provider is configured with `password = local.master.password` from that decode.
- **Secret-only (hard requirement):** never a password in a `variable`, a `.tfvars`, an output, or `.env`. The secret consumed is the `secret_arn` phase 1 **already** produces — no new credentials created or moved; only read where they already live (Secrets Manager, per [[ADR-0007-secrets-parameter-store]]). Identical in local and prod — only the ARN differs; the phase-2 code does not change between environments.
- **Honest security caveat:** a data-source `secret_string` **does** land in phase 2's tfstate (inherent to any Terraform secret data source). Consequences the design accepts:
  1. Phase 2's `terraform.tfstate` must be gitignored like phase 1's.
  2. Each app-user gets its own generated `random_password` that also lives in phase-2 state and is written to its **own** Secrets Manager secret (as the module's `app_credentials` does today) — the app consumes it from there, not from a variable.

  Standard is "nothing in cleartext outside Secrets Manager and gitignored state"; Terraform cannot keep a managed secret out of state, but it can be kept out of variables/outputs/`.env`/the repo.

## Section 3 — Healthcheck gate, per-engine gating, Users migration, testing

### (a) Healthcheck gate

A `terraform_data "wait_for_db"` at the **start** of `post/` with a `local-exec` running `scripts/wait-for-db.sh <host> <port> <engine>` — polls the endpoint (`pg_isready` for Postgres, `mysqladmin ping --ssl-mode=DISABLED` for MySQL) in a loop with a timeout, failing if unreachable. All app-user resources `depends_on = [terraform_data.wait_for_db]`, so none are created until the DB accepts connections. Reuses the `terraform_data` + `local-exec` pattern the cognito module already uses (see [[awscli-fallback-for-floci]]) and the one already established for Floci emulation gaps generally, per [[ADR-0017-floci-local]]. Handles the "cluster created but endpoint not yet accepting connections" timing.

### (b) Per-engine / per-env gating

Phase 2 takes a variable of which app-users to manage.

- **Local:** `postgres`/`users_app` **enabled** (Floci supports it, proven); `mysql`/`orders_app` **disabled** (`count = 0` / `manage_orders_app = false` — Floci hangs the mysql provider).
- **Prod:** **both** enabled.

Gating is a per-environment input (e.g. `enabled_app_users = ["postgres"]` local vs `["postgres","mysql"]` prod), not conditional compilation — same root, different input.

### (c) Users migration (standardization)

Retire `bootstrap_app_db_user` (Postgres) from `bootstrap.sh`; move its logic into phase 2 as `postgresql_role` + grants (SELECT/INSERT/UPDATE, **no** DELETE, [[ADR-0004-soft-delete-only]]) — which is what `rds-aurora` already has gated by `manage_app_user`. Phase 2 re-enables it with the provider configured correctly (live endpoint + secret). `users_app` moves from bash to clean Terraform.

What **stays** in `bootstrap.sh`: only the docker-native `nginx-stable` alias (not Terraform, cannot migrate). `bootstrap.sh` reduces to its irreducibly non-Terraform part.

### (d) Module reuse vs new module

`rds-aurora` already contains the `postgresql_*` app-user resources.

**Proposal:** extract app-user logic into a generic `modules/db-app-user/` (parameterized by engine: postgres|mysql) that phase 2 instantiates per DB. Keeps `rds-aurora` focused on the cluster; makes the app-user reusable for both engines. Follows the same naming discipline as the rest of the module set ([[ADR-0001-terraform-cloudposse-naming]]).

(Alternative: re-instantiate `rds-aurora` in phase 2 just for its `postgresql_*` resources — more coupled; the dedicated module is preferred.)

### (e) Testing / validation

- Static `terraform fmt`/`validate` in `post/`.
- **E2E local** (`make clean && make bootstrap`, per [[local-dev-floci]]): phase 1 applies → gate waits for Postgres → phase 2 creates `users_app` → verify `users_app` can SELECT/INSERT/UPDATE and **fails** on DELETE ([[ADR-0004-soft-delete-only]] proof). `orders_app` (mysql) gated off → verify phase 2 does **not** attempt it locally (does not hang).
- **Regression:** Users flow still healthy (health 200) after moving its app-user from bash to Terraform.
- **Honest limit:** the mysql branch of phase 2 **cannot** be validated on Floci (hangs) — only `terraform validate`, proven for real in AWS, out of local scope.

## Open questions

- Exact `enabled_app_users` variable shape (list of engine strings vs per-user bool flags) — decide at implementation.
- Whether to `terraform_remote_state` the local phase-1 backend or use direct AWS data sources — leaning `terraform_remote_state`; confirm at implementation.
- Whether `db-app-user` is a brand-new module or extracted from `rds-aurora` (and whether extracting touches the Users-facing module in a way that needs its own regression) — decide at implementation.
- Production `environments/production/post/` is analogous but production infra is out of scope for the first implementation (local-first, prod-shaped).

## Related

- [[ADR-0004-soft-delete-only]]
- [[ADR-0006-read-write-replicas]]
- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0017-floci-local]]
- [[ADR-0001-terraform-cloudposse-naming]]
- [[floci-rds-apigw-limits]]
- [[local-dev-floci]]
- [[awscli-fallback-for-floci]]
- [[2026-07-15-orders-rds-mysql-design]]
- [[orders-service-design]]
