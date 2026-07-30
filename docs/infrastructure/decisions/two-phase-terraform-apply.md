---
title: "Two-phase Terraform apply: app-users created after infra is live"
type: adr
area: infra
status: accepted
created: 2026-07-28
updated: 2026-07-30
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

App-user management is gated **per engine, per environment** via `enabled_app_users` in
`infra/environments/local/post/`. As of 2026-07-30 this defaults to `["postgres", "mysql"]` —
both engines are managed by Terraform locally, and a `tracking_app` module now joins
`orders_app` on the shared MySQL cluster (see
[Update 2026-07-30 — the MySQL provider no longer hangs](#update-2026-07-30--the-mysql-provider-no-longer-hangs)
below for why this changed from the postgres-only default this ADR originally recorded). In
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

**MySQL could not be validated locally, as of 2026-07-15.** Verified empirically at the time:
Floci's MySQL appeared not to support user management at all — `CREATE USER` failed with CLI
error 1227, and the `petoju/mysql` Terraform provider **hung** on `mysql_user` for over two
minutes. Floci's Postgres app-user creation worked. So the `mysql` branch of phase 2 was gated
off locally (`enabled_app_users` excluded it) and could only be `terraform validate`d, not
applied — the MySQL app-user (`orders_app`) was created by the older bash mechanism.
**This is no longer the current state — see the update below.**

#### Update 2026-07-30 — the MySQL provider no longer hangs

Re-verified live against the local Floci cluster on 2026-07-30, not inferred from the earlier
symptom: creating a MySQL user plus its grants via `petoju/mysql` (still pinned `~> 3.0`, locked
at `3.0.94` — the same version, no upgrade) completed in **~10 seconds**, and a second `plan`
reported no drift.

**Root cause of the 2026-07-15 hang, now identified:** the user Terraform tried to create used
`caching_sha2_password`, MySQL's default authentication plugin since 8.0. `caching_sha2_password`
requires TLS for a full (non-cached) handshake, and Floci does not terminate TLS on its MySQL
proxy — so the connection stalled indefinitely rather than failing fast. The half-created user was
also unusable even where the hang eventually resolved. Switching the user to
`mysql_native_password` (which does not require TLS) resolves the hang entirely; this is
unrelated to Floci's general "no user management" reputation, which was itself a symptom of the
same TLS mismatch rather than a separate limitation. The created user authenticated, read its own
database, and was correctly denied `DELETE` with `ERROR 1142` — the soft-delete-only model of
[[ADR-0004-soft-delete-only]] holds for MySQL exactly as it does for Postgres.

As a result, `enabled_app_users` in `infra/environments/local/post/` now defaults to
`["postgres", "mysql"]`, and a `tracking_app` module joins `orders_app` on the shared MySQL
cluster. Committed as `6a45d5a`.

> [!warning] Still connecting as the cluster superuser — not fully switched over
> The modules now **validate**, but phase 2 has not been **applied**, so `orders_app` and
> `tracking_app` do not exist in the local database yet. And even once applied, the services
> still connect as the cluster superuser: the same `DATABASE_WRITER_URL` also drives Alembic and
> EF Core migrations, and the app users deliberately hold no DDL grant (per this ADR's own
> chicken-and-egg reasoning above), so pointing runtime traffic at the least-privilege users would
> break the migrations that create the schema in the first place. Separating a dedicated migration
> URL from a runtime URL is a follow-up, not done as of this update.

This finding is worth generalizing beyond MySQL: a Terraform provider that appears to hang against
Floci may be waiting on a TLS handshake Floci never completes, rather than genuinely unsupported
functionality. Check the authentication/negotiation mechanism before concluding the emulator
cannot do something.

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
