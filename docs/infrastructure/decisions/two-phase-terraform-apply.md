---
title: "Two-phase Terraform apply: app-users created after infra is live"
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
  - "[[ADR-0004-soft-delete-only]]"
  - "[[ADR-0007-secrets-parameter-store]]"
  - "[[ADR-0017-floci-local]]"
  - "[[2026-07-15-two-phase-post-effects-design]]"
  - "[[2026-07-15-two-phase-post-effects]]"
  - "[[rds-aurora-engine-switchable-floci]]"
  - "[[awscli-fallback-for-floci]]"
  - "[[terraform-modules]]"
  - "[[local-dev-floci]]"
---

# Two-phase Terraform apply: app-users created after infra is live

## Decision

Local (and, prospectively, production) infrastructure is applied in **two independent
Terraform roots with separate state**:

- **Phase 1 — `environments/local/`** (existing): base infra (networking, RDS clusters,
  Cognito, compute, API Gateway). Does not create database app-users.
- **Phase 2 — `environments/local/post/`** (new): runs after phase 1. Reads phase-1 outputs
  (`terraform_remote_state`) and the master-credentials secret (by ARN, via
  `aws_secretsmanager_secret_version`), configures the `postgresql`/`mysql` Terraform providers
  against the now-live cluster endpoint, and creates least-privilege app-users natively via a
  new `infra/modules/db-app-user/` (engine-parameterized). A `terraform_data` + `local-exec`
  healthcheck gate (`wait_for_db`) blocks app-user creation until the DB actually accepts
  connections.

App-user management is gated **per engine, per environment**: locally only `postgres` is
enabled (`users_app`); `mysql` (`orders_app`) stays disabled, created outside Terraform. In
production both are enabled. `make bootstrap` runs phase 2 after phase 1; `bootstrap.sh` shrinks
to only its irreducibly non-Terraform step (the `nginx-stable` Docker alias).

## Why

Terraform configures every declared provider **before** creating the resources a plan touches.
The `postgresql`/`mysql` providers need a live cluster endpoint that does not exist until
**after** `aws_rds_cluster` is created — a chicken-and-egg no single-apply default resolves.
Before this decision, `users_app` was created post-apply by bash in `bootstrap.sh`, outside
Terraform's management entirely.

Splitting into two state roots — rather than `-target`-ing a single apply in stages — means
neither apply ever re-touches the other's resources, sidestepping Floci's second-apply
`UpdateTags` failure (see [[floci-rds-apigw-limits]], referenced from
[[rds-aurora-engine-switchable-floci]]) for the phase-1 resources.

**MySQL cannot be validated locally.** Verified empirically (2026-07-15): Floci's MySQL does
not support user management at all — `CREATE USER` fails with CLI error 1227, the
`petoju/mysql` Terraform provider **hangs** on `mysql_user`, and Floci's MySQL has no TLS while
`caching_sha2_password` requires it. Floci's Postgres app-user creation **does** work. So the
`mysql` branch of phase 2 is gated off locally (`enabled_app_users` excludes it) and can only be
`terraform validate`d, not applied — the MySQL app-user (`orders_app`) is created by the older
bash mechanism until this gap is resolved or a different local MySQL path is found.

## Consequences

- **`users_app` moves from bash to Terraform**, closing a gap where a security-relevant
  resource (a least-privilege DB role) lived outside IaC.
- **Secret-only, never a variable.** No DB password appears in a `variable`, `.tfvars`, output,
  or `.env` — the phase-2 code reads the master secret by ARN (already produced by phase 1 per
  [[ADR-0007-secrets-parameter-store]]) and writes each app-user's generated password to its own
  Secrets Manager secret, identical in shape between local and prod (only the ARN differs).
  Accepted caveat: a Terraform secret data source's value lands in phase-2 state regardless, so
  phase-2 `terraform.tfstate` must be gitignored exactly like phase-1's.
- **Soft-delete enforced at the grant level** for every managed app-user, consistent with
  [[ADR-0004-soft-delete-only]]: `SELECT, INSERT, UPDATE`, never `DELETE`.
- **`bootstrap.sh` reduces to its irreducible non-Terraform part** — attaching the
  `nginx-stable` Docker network alias, which cannot itself become a Terraform resource. This is
  the same class of "wrap what Terraform can't do" pattern already used for the Cognito
  awscli-fallback scripts (see [[awscli-fallback-for-floci]]).
- **Production-shaped from day one.** The mechanism (two roots, per-engine gating) is designed
  to work identically in `environments/production/post/`; only the enabled-engines list differs
  (both enabled). Standing up the production root itself is a separate, later piece of work.

## Related

- [[ADR-0004-soft-delete-only]]
- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0017-floci-local]]
- [[2026-07-15-two-phase-post-effects-design]]
- [[2026-07-15-two-phase-post-effects]]
- [[rds-aurora-engine-switchable-floci]]
- [[awscli-fallback-for-floci]]
- [[terraform-modules]]
- [[local-dev-floci]]
