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

- **Local:** `["postgres"]` — only `users_app` is created. Floci **hangs** the
  mysql provider (see the Floci MySQL limit lesson), so `orders_app` is gated
  off here.
- **Prod:** `["postgres","mysql"]` — both `users_app` and `orders_app`.

Grants are `SELECT, INSERT, UPDATE` — **never DELETE** (soft-delete only,
[ADR-0004](../../../../docs/shared/decisions/ADR-0004-soft-delete-only.md)).

## Run

```bash
make infra-up-post          # runs as part of `make bootstrap`, after phase 1
# or, raw:
cd infra/environments/local/post && terraform init && terraform apply -auto-approve
```

`host = "localhost"` in the providers because phase 2 runs on the **host** and
reaches Floci's published proxy ports (Postgres 7001, MySQL 7002). The gate uses
`floci` because it runs a probe container **on** the compose network. Prod reads
host/port from the master secret directly.
