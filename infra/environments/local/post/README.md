# Phase 2 — post-effects apply (`environments/local/post/`)

Second Terraform apply that creates the least-privilege **DB app-users** against
the now-live phase-1 endpoints. It replaces the old bash `bootstrap_app_db_user`
step and has its **own** state, so it never re-touches phase 1 (which would trip
Floci's second-apply `UpdateTags` limit — see
[`floci-rds-apigw-limits`](../../../../docs/lessons/floci-rds-apigw-limits.md)).

## What it reads

- **Phase-1 outputs** via `terraform_remote_state` (`../terraform.tfstate`):
  `db_writer_endpoint`, `orders_db_writer_endpoint`, `secret_arn`.
- **Master credentials by ARN** via `aws_secretsmanager_secret_version` (the
  `secret_arn` output above), `jsondecode`d in memory to configure the
  `postgresql`/`mysql` providers. **Secret-only:** no DB password ever lives in a
  variable, `.tfvars`, output, or `.env`. Each app-user gets a fresh
  `random_password` written to its own Secrets Manager secret. This root's
  `terraform.tfstate` is **gitignored**.

## The gate

`gate.tf` (`terraform_data.wait_for_db` + `scripts/wait-for-db.sh`) probes each
enabled engine over `3mrai_3mrai-network` (host = the `floci` service name;
`pg_isready` / `mysqladmin ping --ssl-mode=DISABLED`) and blocks app-user
creation until the DB accepts connections. The `db-app-user` modules
`depends_on` it.

## Per-engine gating (`enabled_app_users`)

- **Local and prod:** `["postgres","mysql"]` — `users_app` (Postgres) plus
  `orders_app` and `tracking_app`, which share the MySQL cluster but are each
  granted on their own database (`orders`.* / `tracking`.*) so neither can read
  the other's schema.
- The old local-only `["postgres"]` gating is gone. It existed because the
  petoju/mysql provider hung against Floci; re-verified on 2026-07-30, the
  provider creates a user + grants in ~10s and a second plan reports no drift.

Grants are `SELECT, INSERT, UPDATE` — **never DELETE** (soft-delete only,
[ADR-0004](../../../../docs/shared/decisions/ADR-0004-soft-delete-only.md)).
Verified live: the created user can `SELECT` but `DELETE` returns `ERROR 1142`.

## Services do not use these MySQL users yet

The generated `DATABASE_WRITER_URL` / `DATABASE_READER_URL` for Orders and
Tracking still point at the cluster superuser (`test`). Wiring them to
`orders_app` / `tracking_app` is **blocked on ordering**, not on the provider:
`generate_env_files.py` runs in phase 1, while these users are created in phase
2, and both `make migrate-tracking` and Orders' self-migration read that same
`DATABASE_WRITER_URL` to run **DDL**, which the app-users deliberately cannot do.
Splitting the migration URL from the runtime URL is the prerequisite.

## Run

```bash
make post-infra             # REQUIRES a successful `make bootstrap` first
# or, raw:
cd infra/environments/local/post && terraform init && terraform apply -auto-approve
```

`make bootstrap` does **not** run this phase. It leaves the stack usable (all
three services up, Orders seeded) but not hardened; `post-infra` is the separate,
explicit step that hardens it. Run without a prior successful `bootstrap`, it
fails at the `terraform_remote_state` read of phase 1's state — before any
provisioner runs — which is ordinary `terraform_remote_state` behavior, not a
guard this root implements.

Its first step grants the `test` identity the two MySQL privileges the `mysql`
provider needs to manage users at all (`CREATE USER ON *.*`, `SELECT ON mysql.*`).
Those moved here from phase 1's `create_mysql_database.py`, which issued them only
because it happens to connect as root; they are phase-2 prerequisites, so they now
live where they are used (`scripts/grant_mysql_provider_privileges.py`, run by
`grants.tf`). Without them this apply fails 1227 on `CREATE USER`, then 1142
diffing the grants it just wrote.

Every provisioning script here records its run to the DynamoDB table exposed as
the backend root's `execution_log_table_name` output — for **traceability, never
to skip a re-run**. The scripts are already idempotent and `make clean` recreates
the resources they act on, so a record that caused a skip would leave a recreated
resource unprovisioned while looking done. Recording is also fail-open: an
unreachable table warns on stderr and the script runs anyway.

`host = "localhost"` in the providers because phase 2 runs on the **host** and
reaches Floci's published proxy ports. Those ports are **discovered per-engine**,
not fixed: Floci assigns them (7000-7099) by cluster creation order, which is not
stable across applies, so Postgres/MySQL can flip between 7001/7002. `make
post-infra` discovers the Postgres port (via `../scripts/discover_db_port.py`,
which reads `describe-db-clusters` per `Engine`) and passes it as `-var pg_port`;
the `pg_port`/`mysql_port` variables keep 7001/7002 defaults only as a fallback.
The gate uses `floci` because it runs a probe container **on** the compose
network. Prod reads host/port from the master secret directly.
