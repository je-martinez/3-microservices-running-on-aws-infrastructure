---
title: "Orders RDS MySQL (local) Design"
type: spec
area: infra
status: draft
created: 2026-07-15
updated: 2026-07-15
tags: [type/spec, area/infra, status/draft]
related:
  - "[[ADR-0006-read-write-replicas]]"
  - "[[ADR-0007-secrets-parameter-store]]"
  - "[[ADR-0004-soft-delete-only]]"
  - "[[soft-delete]]"
  - "[[ADR-0017-floci-local]]"
  - "[[ADR-0001-terraform-cloudposse-naming]]"
  - "[[floci-rds-apigw-limits]]"
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[local-dev-floci]]"
  - "[[orders-service-design]]"
  - "[[2026-07-14-orders-service-milestone-design]]"
---

# Orders RDS MySQL (local) Design

Design for provisioning the Orders service's MySQL database in the **local (Floci) Terraform environment**, at parity with how the Users service's Postgres is provisioned. This unblocks two things: mapping Orders' auto-generated DB URL into `.env` (like `USERS_DATABASE_URL`), and letting the Orders service boot against a real provisioned MySQL instead of the hardcoded placeholder port it uses today. Scope is `environments/local` **only** — production is untouched.

> [!note] Status
> Draft — this is a design spec, not yet a plan or implemented change.

## Summary

Add a second instantiation of the engine-agnostic `rds-aurora` Terraform module with `engine = "mysql"`, producing a real Floci-emulated MySQL cluster for Orders, a least-privilege `orders_app` database user, and the `.env`/compose wiring needed for the Orders service to boot against it instead of its current placeholder configuration.

## Context / current state

- The `infra/modules/rds-aurora` module is already engine-agnostic: it has `var.engine`/`var.engine_version`, and its `aws_rds_cluster_instance` writer/reader resources are gated by `count = startswith(var.engine, "aurora") ? 1 : 0`. Locally, Floci runs a real postgres/mysql container "off the cluster alone" (no Aurora cluster-instance concept), so `engine = "postgres"` (and, for Orders, `engine = "mysql"`) needs no cluster instances.
- Users provisions its DB via a first instantiation `module "rds_aurora"` with `engine = "postgres"`, `database_name = "users"`, `create_subnet_group = false` + `subnet_group_name = "default"`, `manage_app_user = false`.
- Users' least-privilege app user (`users_app`, SELECT/INSERT/UPDATE, **no** DELETE per [[ADR-0004-soft-delete-only]] / [[soft-delete]]) is **not** created by Terraform locally — the `postgresql` provider chicken-and-egg problem means it must be configured with the cluster endpoint before the cluster exists. Instead `bootstrap.sh`'s `bootstrap_app_db_user` creates it post-apply against the running cluster, with an idempotent password in a git-ignored `.app-db-secret`.
- Today the Orders compose service points at a placeholder `Server=floci;Port=7002;...` and migrates itself on startup via `SEED_ON_STARTUP` (EF Core `MigrateAsync` + `ProductSeed`) because no MySQL cluster existed. `make env-file` writes `USERS_DATABASE_URL` from `terraform output db_writer_endpoint` but has no Orders equivalent.
- Floci assigns the RDS proxy port in the 7000-7099 range at apply time; Postgres took 7001 as the first cluster. Known limitation, per [[floci-rds-apigw-limits]]: a second `terraform apply` fails (Floci `UpdateTags` for API GW v2 / RDS) — re-apply is done via `make clean` + `make bootstrap` from scratch, never in-place.

See [[ADR-0017-floci-local]] for the broader set of Floci quirks and workarounds this design must account for, and [[floci-vs-ministack-spike-findings]] for the empirical basis behind choosing Floci as the local emulator. [[local-dev-floci]] is the runbook for the full `make bootstrap` lifecycle this design's end-to-end validation runs against.

## Section 1 — Scope

**In scope:**

- A second instantiation of `rds-aurora` with `engine = "mysql"` for Orders.
- The master-credentials secret already produced by the module (per [[ADR-0007-secrets-parameter-store]]).
- New outputs: `orders_db_writer_endpoint`, `orders_db_reader_endpoint`.
- A least-privilege `orders_app` user (SELECT/INSERT/UPDATE, no DELETE — [[ADR-0004-soft-delete-only]]) created post-apply by extending `bootstrap.sh` to MySQL.
- `make env-file` writing a host-reachable `ORDERS_DATABASE_URL`.
- The Orders compose service switching off the placeholder port to the real endpoint, and moving migration from `SEED_ON_STARTUP` to a `make migrate`-style step.

**Out of scope:**

- Production changes — only `environments/local` is touched.
- Refactoring `rds-aurora` into a generic multi-engine module (it is already engine-agnostic enough for this need).

## Section 2 — Technical detail

### (a) Module instantiation

A second `module "rds_mysql"` in `environments/local/main.tf`, mirroring the `rds_aurora` block:

- `engine = "mysql"`, `engine_version` = a MySQL 8.0.x version (exact patch TBD at implementation — see [[#Open questions]]).
- Cluster instances auto-skipped via the existing `startswith(var.engine, "aurora")` gate — no code change needed to the module itself.
- A new `module "label_orders_db"` (name = `"orders-db"`) supplies the label. `context = { id = "mysql-${module.label_orders_db.id}", tags = ... }` uses the same letter-led-id trick the Aurora instantiation uses (the label wrapper doesn't expose `label_order`, and the cluster identifier must start with a letter) — see [[ADR-0001-terraform-cloudposse-naming]] for the naming convention this pattern extends.
- `database_name = "orders"`, `master_username`/`master_password = test/test`, `create_subnet_group = false` + `subnet_group_name = "default"`, `manage_app_user = false`.

### (b) App user `orders_app` (chicken-and-egg → bootstrap.sh)

Extend `bootstrap.sh` with a `bootstrap_orders_app_db_user` function that runs against MySQL via an ephemeral `mysql:8` container on the compose network (analogous to the existing `postgres:14.6-alpine` step for Users). SQL:

```sql
CREATE USER IF NOT EXISTS 'orders_app'@'%' IDENTIFIED BY '<pwd>';
GRANT SELECT, INSERT, UPDATE ON orders.* TO 'orders_app'@'%';  -- NO DELETE (ADR-0004)
```

Idempotent password in a git-ignored `.orders-app-db-secret`, mirroring `.app-db-secret`. This is the same infrastructure-level enforcement of [[ADR-0004-soft-delete-only]] / [[soft-delete]] that Users applies to Postgres.

> [!note] MySQL grants cover future tables automatically
> In MySQL, `GRANT ... ON orders.*` covers **future** tables in the schema automatically — there is no need for a Postgres-style `ALTER DEFAULT PRIVILEGES` equivalent. This is simpler than the Postgres path Users uses.

### (c) How Orders migrates now

With a real cluster, align Orders with Users: a `make migrate-orders` step (or an extension of `make migrate` — see [[#Open questions]]) runs `dotnet ef database update` plus the seed against Floci's MySQL **as the superuser** (DDL), ordered before the `orders_app` bootstrap. Remove `SEED_ON_STARTUP` from compose. This respects [[ADR-0004-soft-delete-only]]: the service runs as `orders_app` (no DDL); migrations run as superuser.

### (d) Outputs + `.env` + compose

- New `orders_db_writer_endpoint` / `orders_db_reader_endpoint` outputs in `environments/local/outputs.tf`.
- `make env-file` adds `ORDERS_DATABASE_URL=mysql://test:test@${orders_db_writer_endpoint}:<port>/orders` to the auto-generated block — host-reachable, mirroring `USERS_DATABASE_URL`, for a host SQL client.
- The Orders compose service's `DATABASE_WRITER_URL`/`DATABASE_READER_URL` switch from the `7002` placeholder to `Server=floci;Port=<real>;...` with the real Floci port. Locally both writer and reader point at the same endpoint (no Aurora read replica emulation), per [[ADR-0006-read-write-replicas]] and consistent with how [[2026-07-14-orders-service-milestone-design]] already describes Orders' local infra.

### (e) Known risk #1 (highest uncertainty)

Floci assigns the RDS proxy port at apply time in the 7000-7099 range; the Orders MySQL will take a **different** port (likely 7002 but **not guaranteed**). The design **must** discover the MySQL port from `terraform output`, never hardcode it.

Adding a second RDS cluster does not reintroduce the second-apply problem (the environment is still rebuilt from scratch), but it **is** more RDS surface on Floci — a fragile area already documented in [[floci-rds-apigw-limits]]. If applying the second cluster fails at plan/apply, the fallback is to surface the blocker to the user after 1-2 attempts (do not grind hypotheses), and keep Orders on `SEED_ON_STARTUP` + the placeholder port until the upstream Floci limit is resolved.

## Section 3 — Testing & validation

### (a) Static

`terraform fmt -recursive` clean and `terraform validate` OK in `environments/local` after adding the second module, label, and outputs.

### (b) End-to-end via `make clean` + `make bootstrap` from scratch

1. **The MySQL cluster comes up** — `make infra-output` prints the two Orders endpoints without error; the Orders MySQL cluster appears alongside the Users Postgres. (Validates risk #1: Floci supporting two simultaneous RDS clusters and assigning a distinct port.)
2. **The port is discovered** — confirm which proxy port Floci assigned to MySQL (from output / `describe-db-clusters`) and that `.env` and compose receive it from the output, not hardcoded.
3. **`orders_app` connects with the right privileges** — from an ephemeral `mysql:8` container: `orders_app` can `SELECT`/`INSERT`/`UPDATE` on `orders.*` and **fails** on `DELETE` (the [[ADR-0004-soft-delete-only]] proof).
4. **Orders migrates + boots** — `make migrate-orders` applies the EF Core schema as superuser; the `orders` service boots against the real MySQL and `curl http://localhost:3001/v1/health` returns `{"status":"ok"}`.
5. **Real persistence** — create an order via `POST /v1/orders` and confirm the row lands in Floci's MySQL. This step exists specifically to avoid a "mocks hide schema bugs" failure mode: verify against the live DB, not just mocked tests.

### (c) Done criterion

`make clean && make bootstrap` completes with no manual intervention, Orders serving against its own MySQL, `orders_app` without DELETE. If step 1 or 2 fails on a Floci two-cluster limit, **stop** and surface it as a decision; the fallback keeps Orders on `SEED_ON_STARTUP` + the placeholder.

### (d) Honest limitation

Everything here is validated against Floci, which emulates RDS imperfectly (documented quirks — see [[floci-rds-apigw-limits]] and [[ADR-0017-floci-local]]). Passing on Floci does **not** guarantee the same module applies identically against real AWS — but that is true of all the repo's local infra and is out of scope here (local only).

## Open questions

- Exact MySQL `engine_version` patch (8.0.x) to pin — decide at implementation.
- Whether `make migrate-orders` is a new Makefile target or an extension of the existing `make migrate`.
- Whether Floci reliably supports two concurrent RDS clusters — to be verified empirically at first apply (risk #1, [[#Section 2 — Technical detail|Section 2(e)]]).

## Related

- [[ADR-0006-read-write-replicas]]
- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0004-soft-delete-only]]
- [[soft-delete]]
- [[ADR-0017-floci-local]]
- [[ADR-0001-terraform-cloudposse-naming]]
- [[floci-rds-apigw-limits]]
- [[floci-vs-ministack-spike-findings]]
- [[local-dev-floci]]
- [[orders-service-design]]
- [[2026-07-14-orders-service-milestone-design]]
