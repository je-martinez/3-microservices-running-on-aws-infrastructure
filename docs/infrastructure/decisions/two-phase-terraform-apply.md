---
title: "Two-phase Terraform apply: app-users created after infra is live"
type: adr
area: infra
status: accepted
created: 2026-07-28
updated: 2026-07-31
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
  - "[[2026-07-30-post-infra-root-design]]"
  - "[[scripting-language]]"
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

#### Update 2026-07-30 — post-infra root split, moved GRANTs, execution log

Design and plan: [[2026-07-30-post-infra-root-design]] / `docs/superpowers/plans/2026-07-30-post-infra-root.md`.
Three changes to how phase 2 is invoked and provisioned, landing on top of everything above
(the two-root split and the MySQL fix both stand unchanged):

**`make bootstrap` no longer calls phase 2.** Previously `bootstrap` ended its chain by calling
`infra-up-post` (the last of twelve steps) — a failure there was the hardest in the chain to
diagnose, because every service dependency before it had already succeeded. `bootstrap` now ends
after `tracking` comes up, leaving the stack in a state that is *usable* (all three services up,
Orders seeded) but not yet *hardened*. Phase 2 becomes a separate, explicit target,
`make post-infra` (renamed from `infra-up-post`), that a person or agent runs deliberately once
`bootstrap` has succeeded. `post-infra` run without a prior `bootstrap` fails at the
`terraform_remote_state` read against phase 1's state — before any provisioner runs — which is
existing `terraform_remote_state` behavior, not new code; the target's help text and
`infra/environments/local/post/README.md` now state the dependency explicitly so that failure is
expected rather than surprising.

**The provider-enablement GRANTs move to phase 2, where they are actually used.**
`create_mysql_database.py` (phase 1, connecting as MySQL `root` because at that point it is the
only reachable superuser) used to also grant `test` two privileges it does not need for creating
the `tracking` database: `CREATE USER ON *.*` and `SELECT ON mysql.*`. Those two exist solely so
that phase 2's `mysql` provider block can later manage `mysql_user`/`mysql_grant` as `test` —
without them, `post-infra` fails 1227 on `CREATE USER`, then 1142 reading `mysql.user` to diff the
grants it just wrote (the same failure mode this ADR already documents above, in
"Why"). They now live in a new script, `infra/environments/local/post/scripts/grant_mysql_provider_privileges.py`,
run as the first step of `make post-infra`, before the `mysql` provider touches anything.
`create_mysql_database.py` keeps the one GRANT that is genuinely its concern —
`GRANT ALL PRIVILEGES ON \`tracking\`.* TO 'test'@'%' WITH GRANT OPTION` — because that grant is
about the database the script itself creates, not a phase-2 prerequisite smuggled in because the
script happened to have root.

**A DynamoDB execution log records what the four `local-exec` provisioning scripts did — never
to skip re-running them.** `create_mysql_database.py`, the two Cognito scripts
(`create_user_pool_client.py`, `set_pre_token_trigger.py`), `wait_for_db.py`, and now
`grant_mysql_provider_privileges.py` run as `local-exec` provisioners outside Terraform's own
resource lifecycle (the awscli-fallback pattern, [[awscli-fallback-for-floci]]). Nothing recorded
whether any of them ran, against what resource, or whether it succeeded — that evidence
disappeared the instant the terminal scrolled past it. A new `infra.modules.tf-backend`-declared
DynamoDB table, `execution_log`, and a `lib3mrai.execution_log.record_execution(...)` context
manager wrapping each script's existing body fix that, resting on two explicit design rules
that hold this together:

- **It is a log, not a cache.** All four scripts are already idempotent on their own terms
  (`CREATE ... IF NOT EXISTS`, lookup-then-reuse, a declarative `UpdateUserPool`), and `make clean`
  routinely destroys and recreates the underlying resources (the MySQL cluster, the Cognito pool).
  A design that used the record to *skip* re-running a script would read stale history after a
  `make clean`, conclude "already done," and leave the newly recreated resource unprovisioned
  while looking ready — strictly worse than not logging at all. So the wrapper **always** runs the
  wrapped body; it only records the outcome, before and after.
- **It is fail-open.** If DynamoDB is unreachable, `record_execution` warns to stderr (via
  `lib3mrai.console.no`) and lets the wrapped script run anyway — a traceability aid must not make
  provisioning newly fragile because its own logging dependency is down.

**Table location and key.** The table is declared in `infra/modules/tf-backend/` — the same module
that already creates `3mrai-local-tfstate-lock` and runs first, via `make backend-up`, before
phase 1 — not inside the post-infra root, because phase-1 scripts (the Cognito ones,
`create_mysql_database.py`) run before `environments/local/post/` exists as a Terraform root at
all; a table declared there would be a chicken-and-egg unavailable to the scripts that need it
first. Key: partition key `script_name`, sort key `run_key` = `<resource_id>#<start timestamp,
ISO 8601>` — the resource identity (cluster id, user pool id) is folded into the sort key itself
so that a resource recreated by `make clean` starts a fresh, distinguishable history rather than
having its records collide with its predecessor's under the same key.

Implemented and committed so far: `bc9720c` (the `execution_log` table plus
`infra/scripts/lib3mrai/execution_log.py`, 5 tests covering the success, failure, and
DynamoDB-unreachable cases). **Not yet applied against Floci** (`make backend-up` has not run
since this change landed) and **the Makefile split is not yet implemented** — this update records
the design decision and its reasoning, not a live-verified end state.

##### The GRANT OPTION asymmetry between `orders` and `tracking`

Running phase 2 end to end (below) uncovered a pre-existing gap nothing had exercised before. The
two MySQL databases are created by different paths:

- `tracking` is created by `create_mysql_database.py`, which grants it to `test` **WITH GRANT
  OPTION**.
- `orders` is created by the cluster resource itself (`aws_rds_cluster.database_name`), and Floci
  grants it to `test` **without** that option.

So phase 2 tried to create `orders_app` acting as `test` and failed with:
`Error 1044 (42000): Access denied for user 'test'@'%' to database 'orders'` — privileges cannot be
delegated with GRANT OPTION by a grantee who doesn't hold it. Fix:
`grant_mysql_provider_privileges.py` (which runs as root, the only identity that can) now also
emits `GRANT ALL PRIVILEGES ON \`orders\`.* TO 'test'@'%' WITH GRANT OPTION` alongside the two
grants it had already relocated there.

This is a **pre-existing gap, not a regression from moving the GRANTs**: the `orders_app` path
against a clean Floci had never been exercised before, because phase 2 never got that far. Commit:
`2584e77`.

##### Live verification (2026-07-31)

- The `3mrai-local-tfstate-execution-log` table exists in Floci alongside
  `3mrai-local-tfstate-lock`.
- All five provisioning scripts record under their real resource identity:
  `create_mysql_database.py`, `create_user_pool_client.py`, `set_pre_token_trigger.py`,
  `wait_for_db.py` (two entries, one per engine — `floci:7001` MySQL and `floci:7002` Postgres),
  and `grant_mysql_provider_privileges.py`.
- `make post-infra` completes, and a second `terraform plan` reports `No changes.`
- `SHOW GRANTS` confirms WITH GRANT OPTION on both `orders` and `tracking`; `orders_app` and
  `tracking_app` exist.

##### The log demonstrating its own design

After fixing the grants script, `make post-infra` failed again with the same 1044 error. The log
explained why: there was **one** recorded run of `grant_mysql_provider_privileges.py` where two
were expected. `terraform_data` keys off its `input` (host and port), which hadn't changed, so
Terraform treated the resource as up to date and never re-ran the provisioner despite the script
change — `terraform apply -replace` was needed to force it.

This is exactly the scenario the "record, never skip" rule (above) exists for: the log made a
non-run visible. Had the design instead let recorded history skip re-execution, it would have
**hidden** this exact case rather than exposing it.

##### `post-infra` without `bootstrap` — an observed nuance

The design predicts a failure reading `terraform_remote_state`, before any provisioner runs.
Verified, with one nuance: because `make clean` also stops Floci, in practice the failure happens
even earlier — a connection failure against `localhost:4566`, not a `terraform_remote_state` error.
The underlying guarantee still holds (**no provisioner runs**), but the error an operator actually
sees is a connection error, not a remote-state one — worth knowing so it isn't mistaken for a
different problem.

> [!info] Why `execution_log_table_name` isn't in `env-files.md`
> The table name is not threaded through the `.env.local.*` generator described in [[env-files]].
> `infra/environments/local/backend/` (the root that declares this table) holds **local** state by
> design and cannot itself be read via `terraform_remote_state` — the repo already consumes that
> root's bucket and lock-table names as literal strings for the same reason, and
> `3mrai-local-tfstate-execution-log` follows that existing convention rather than a new one. This
> plan's `propagates-to: [[env-files]]` target is therefore intentionally left unapplied.

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
- [[2026-07-30-post-infra-root-design]]
- [[scripting-language]]
