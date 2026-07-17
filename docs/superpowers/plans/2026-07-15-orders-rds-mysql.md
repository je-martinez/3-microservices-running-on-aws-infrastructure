---
title: "Orders RDS MySQL (local)"
type: plan
area: infra
status: draft
created: 2026-07-15
updated: 2026-07-15
tags: [type/plan, area/infra, status/draft]
related: ["[[2026-07-15-orders-rds-mysql-design]]", "[[orders-service-design]]", "[[2026-07-14-orders-service-milestone]]", "[[ADR-0004-soft-delete-only]]", "[[ADR-0006-read-write-replicas]]", "[[ADR-0007-secrets-parameter-store]]", "[[ADR-0017-floci-local]]", "[[floci-rds-apigw-limits]]", "[[local-dev-floci]]", "[[2026-07-15-orders-rds-mysql]]"]
---

# Orders RDS MySQL (local) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision the Orders service's MySQL database in the local Floci Terraform environment at parity with the Users Postgres, so Orders boots against a real provisioned MySQL (not a placeholder port) and its DB URL is mapped into `.env`.

**Architecture:** Reuse the existing engine-agnostic `infra/modules/rds-aurora` module via a SECOND instantiation with `engine = "mysql"` in `environments/local/main.tf`. A least-privilege `orders_app` user (SELECT/INSERT/UPDATE, no DELETE) is created post-apply by extending `bootstrap.sh` to MySQL (the `postgresql`/`mysql` Terraform providers can't be configured before the cluster exists — same chicken-and-egg Users has). New Terraform outputs feed `make env-file` (host-reachable `ORDERS_DATABASE_URL`) and the Orders compose service (real Floci port instead of the `7002` placeholder). Orders migration moves from `SEED_ON_STARTUP` to a Makefile step run as superuser.

**Tech Stack:** Terraform (AWS provider `= 5.31.0`, cloudposse/label naming), Floci local AWS emulator, MySQL 8.0, Docker Compose, .NET EF Core CLI (`dotnet ef`), bash.

## Global Constraints

- **Local only.** Touch `infra/environments/local/**`, `bootstrap.sh`, `Makefile`, `docker-compose.yml`, `services/orders/CLAUDE.md`. Do NOT touch `environments/production` or the shared `rds-aurora` module's own files (reuse it as-is; only if a genuinely Postgres-specific line breaks MySQL do you touch the module, and call it out).
- **Soft-delete at grant level (ADR-0004):** `orders_app` gets `SELECT, INSERT, UPDATE` — NEVER `DELETE`.
- **No hardcoded Floci RDS port.** Floci assigns the RDS proxy port in 7000–7099 at apply time; the Orders MySQL port MUST be discovered from `terraform output`, never hardcoded (the current `7002` is a placeholder to remove).
- **Re-apply = rebuild.** A second in-place `terraform apply` fails on Floci (UpdateTags). All validation is via `make clean` + `make bootstrap` from scratch, never in-place re-apply.
- **Language:** converse in Spanish; write config/comments in English.
- **Naming:** cluster identifiers must start with a letter (use the `mysql-${label}` id trick, as Aurora uses `aurora-${label}`).
- **Implementers write only Terraform/config/source.** Leave work in the working tree; the main session commits. The `git commit` steps mark the intended commit boundary.

---

## Task 1: Second RDS module instantiation (MySQL) + label

**Files:**
- Modify: `infra/environments/local/main.tf` (add `label_orders_db` + `rds_mysql` module blocks)

**Interfaces:**
- Consumes: `module.networking.subnet_ids`, `module.networking.security_group_ids`; the existing `../../modules/label` and `../../modules/rds-aurora` modules.
- Produces: `module.rds_mysql` with outputs `.writer_endpoint`, `.reader_endpoint`, `.port`, `.secret_arn` (same output surface as `module.rds_aurora`); `database_name = "orders"`.

- [ ] **Step 1: Add the label + MySQL module blocks**

Append to `infra/environments/local/main.tf`, right after the `module "rds_aurora"` block (mirror it exactly, swapping engine + label + db name):

```hcl
# ─── Orders MySQL label ─────────────────────────────────────────────────────────
module "label_orders_db" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "orders-db"
}

# ─── Orders MySQL ───────────────────────────────────────────────────────────────
# Second instantiation of the engine-agnostic rds-aurora module, this time with
# engine = "mysql" for the Orders service. Floci runs a real mysql container off
# the cluster alone (no Aurora cluster-instance concept), so the module's
# writer/reader cluster_instances auto-skip via their startswith(engine,"aurora")
# gate — same as the local Postgres above.
#
# Same letter-led-id trick as rds_aurora: module.label_orders_db.id is
# "3mrai-local-orders-db" (digit-leading), and rds-aurora interpolates
# context.id into cluster_identifier which AWS rejects unless it starts with a
# letter — so prefix with "mysql-".
#
# manage_app_user = false LOCAL ONLY: the mysql provider would need the cluster
# endpoint before the cluster exists (chicken-and-egg, same as Postgres). The
# least-privilege orders_app user is created post-apply by bootstrap.sh instead.
module "rds_mysql" {
  source              = "../../modules/rds-aurora"
  context             = { id = "mysql-${module.label_orders_db.id}", tags = module.label_orders_db.tags }
  subnet_ids          = module.networking.subnet_ids
  security_group_ids  = module.networking.security_group_ids
  database_name       = "orders"
  master_username     = var.db_username
  master_password     = var.db_password
  engine              = "mysql"
  engine_version      = "8.0"
  instance_class      = "db.t3.micro"
  skip_final_snapshot = true
  manage_app_user     = false
  create_subnet_group = false
  subnet_group_name   = "default"
}
```

> `engine_version = "8.0"` is the spec's open question resolved to the family version. If a plan/validate error demands a full patch (e.g. `8.0.36`), pin the patch and note it — Floci runs a real `mysql` container, so the value mainly needs to be one the provider accepts.

- [ ] **Step 2: Format and validate**

Run:

```bash
cd infra/environments/local && terraform fmt -recursive && terraform init -backend=false >/dev/null && terraform validate
```

Expected: `terraform fmt` reports the file (or nothing if already formatted), and `terraform validate` prints `Success! The configuration is valid.` — this checks HCL/type correctness without touching Floci.

- [ ] **Step 3: Commit**

```bash
git add infra/environments/local/main.tf
git commit -m "feat(infra): second RDS instantiation (MySQL) for Orders, local only"
```

---

## Task 2: Orders DB Terraform outputs

**Files:**
- Modify: `infra/environments/local/outputs.tf` (add two outputs)

**Interfaces:**
- Consumes: `module.rds_mysql.writer_endpoint`, `module.rds_mysql.reader_endpoint` (Task 1).
- Produces: raw outputs `orders_db_writer_endpoint`, `orders_db_reader_endpoint` — consumed by `make env-file` (Task 4).

- [ ] **Step 1: Add the outputs**

Append to `infra/environments/local/outputs.tf` (mirror the existing `db_writer_endpoint` / `db_reader_endpoint` output style):

```hcl
output "orders_db_writer_endpoint" {
  description = "Orders MySQL cluster writer endpoint (INSERT/UPDATE queries)."
  value       = module.rds_mysql.writer_endpoint
}

output "orders_db_reader_endpoint" {
  description = "Orders MySQL cluster reader endpoint (SELECT queries, per ADR-0006)."
  value       = module.rds_mysql.reader_endpoint
}
```

- [ ] **Step 2: Validate**

Run:

```bash
cd infra/environments/local && terraform validate
```

Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
git add infra/environments/local/outputs.tf
git commit -m "feat(infra): expose Orders MySQL writer/reader endpoints as outputs"
```

---

## Task 3: Least-privilege `orders_app` user via bootstrap.sh (MySQL)

**Files:**
- Modify: `infra/environments/local/bootstrap.sh` (add a `bootstrap_orders_app_db_user` function + call it)

**Interfaces:**
- Consumes: a running Orders MySQL cluster reachable at `floci:<mysql-port>` on the `3mrai_3mrai-network` (after apply).
- Produces: a MySQL user `orders_app` with `SELECT, INSERT, UPDATE` (NO DELETE) on `orders.*`; an idempotent password in a git-ignored `infra/environments/local/.orders-app-db-secret`.

> **Port note:** the existing Users step uses `PG_PORT=7001` because Postgres is the first cluster and has stably taken 7001. The Orders MySQL port is assigned at apply time and is NOT guaranteed. This function reads it from an env var `ORDERS_DB_PORT` (default `7002`), and `make bootstrap` (Task 5) passes the real discovered port in. Do NOT hardcode a port inside the SQL/connection without allowing the override.

- [ ] **Step 1: Add the MySQL app-user function**

In `infra/environments/local/bootstrap.sh`, after the `bootstrap_app_db_user` function definition (the Postgres one) and before the `STEP1_STATUS=0` line, add a sibling function. Mirror the Postgres one's structure (idempotent password file, ephemeral DB container on the compose network, superuser connection, no-DELETE grants):

```bash
# ─── Step 1b: least-privilege Orders app DB user (MySQL) ────────────────────
# MySQL analog of bootstrap_app_db_user. Same rationale: module.rds_mysql's
# app-user resources are disabled locally (manage_app_user = false, chicken-and
# -egg), so create orders_app directly against the running MySQL cluster.
# SELECT/INSERT/UPDATE only — NO DELETE (ADR-0004). Unlike Postgres, MySQL's
# `GRANT ... ON orders.*` already covers future tables, so there is no
# ALTER DEFAULT PRIVILEGES equivalent to run.
ORDERS_DB_HOST="${ORDERS_DB_HOST:-floci}"
ORDERS_DB_PORT="${ORDERS_DB_PORT:-7002}"
ORDERS_DB_SUPERUSER="${ORDERS_DB_SUPERUSER:-test}"
ORDERS_DB_SUPERUSER_PASSWORD="${ORDERS_DB_SUPERUSER_PASSWORD:-test}"
ORDERS_DB_DATABASE="${ORDERS_DB_DATABASE:-orders}"
ORDERS_APP_DB_USER="${ORDERS_APP_DB_USER:-orders_app}"
ORDERS_APP_DB_SECRET_FILE="${ORDERS_APP_DB_SECRET_FILE:-${SCRIPT_DIR}/.orders-app-db-secret}"

bootstrap_orders_app_db_user() {
  echo "== bootstrap: least-privilege Orders app DB user (${ORDERS_APP_DB_USER}) =="

  if [ -f "$ORDERS_APP_DB_SECRET_FILE" ]; then
    ORDERS_APP_DB_PASSWORD="$(cat "$ORDERS_APP_DB_SECRET_FILE")"
    inf "reusing existing local password from ${ORDERS_APP_DB_SECRET_FILE}"
  else
    ORDERS_APP_DB_PASSWORD="$(docker run --rm mysql:8 sh -c 'head -c 18 /dev/urandom | base64' | tr -d '=+/\n' | cut -c1-24)"
    printf '%s' "$ORDERS_APP_DB_PASSWORD" >"$ORDERS_APP_DB_SECRET_FILE"
    chmod 600 "$ORDERS_APP_DB_SECRET_FILE"
    inf "generated a new local-only password (${ORDERS_APP_DB_SECRET_FILE}, not git-tracked)"
  fi

  # CREATE USER IF NOT EXISTS is natively idempotent in MySQL 8. ALTER USER keeps
  # the password in sync on re-runs. Grants are idempotent by nature.
  SQL=$(
    cat <<SQL
CREATE USER IF NOT EXISTS '${ORDERS_APP_DB_USER}'@'%' IDENTIFIED BY '${ORDERS_APP_DB_PASSWORD}';
ALTER USER '${ORDERS_APP_DB_USER}'@'%' IDENTIFIED BY '${ORDERS_APP_DB_PASSWORD}';
GRANT SELECT, INSERT, UPDATE ON ${ORDERS_DB_DATABASE}.* TO '${ORDERS_APP_DB_USER}'@'%';
FLUSH PRIVILEGES;
SQL
  )

  if docker run --rm --network "$NETWORK" mysql:8 \
    mysql -h "$ORDERS_DB_HOST" -P "$ORDERS_DB_PORT" -u "$ORDERS_DB_SUPERUSER" -p"$ORDERS_DB_SUPERUSER_PASSWORD" \
    "$ORDERS_DB_DATABASE" -e "$SQL" >/tmp/bootstrap_mysql.log 2>&1; then
    ok "user '${ORDERS_APP_DB_USER}' ready: SELECT/INSERT/UPDATE (no DELETE) on ${ORDERS_DB_DATABASE}.*"
  else
    no "failed to create/grant Orders app DB user (see /tmp/bootstrap_mysql.log)"
    cat /tmp/bootstrap_mysql.log
    return 1
  fi
}
```

- [ ] **Step 2: Call it alongside the Postgres step**

Find the line `bootstrap_app_db_user || STEP1_STATUS=$?` and add the Orders call right after it, so both app users are created and neither failure aborts the other:

```bash
bootstrap_app_db_user || STEP1_STATUS=$?
bootstrap_orders_app_db_user || STEP1_STATUS=$?
```

- [ ] **Step 3: Ignore the new secret file**

Confirm the git-ignore covers it. Run:

```bash
git check-ignore infra/environments/local/.orders-app-db-secret && echo IGNORED || echo "NEEDS RULE"
```

Expected: `IGNORED`. If it prints `NEEDS RULE`, add `.orders-app-db-secret` next to the existing `.app-db-secret` rule in the relevant `.gitignore` (search: `grep -rn "app-db-secret" --include=.gitignore .`) and re-check.

- [ ] **Step 4: Syntax-check the script**

Run:

```bash
bash -n infra/environments/local/bootstrap.sh && echo "syntax ok"
```

Expected: `syntax ok` (no execution — that happens in Task 5's end-to-end run).

- [ ] **Step 5: Commit**

```bash
git add infra/environments/local/bootstrap.sh
git commit -m "feat(infra): create least-privilege orders_app MySQL user post-apply (no DELETE)"
```

---

## Task 4: Map ORDERS_DATABASE_URL into .env via make env-file

**Files:**
- Modify: `Makefile` (`env-file` target)

**Interfaces:**
- Consumes: `terraform output -raw orders_db_writer_endpoint` (Task 2).
- Produces: an `ORDERS_DATABASE_URL` line in the AUTO-GENERATED block of `./.env`, host-reachable, mirroring `USERS_DATABASE_URL`.

- [ ] **Step 1: Read the current env-file target**

Run:

```bash
grep -nA35 '^env-file:' Makefile
```

Note the two shell variable captures near the top (`pool=`, `client=`, `apiid=`, `dbhost=`) and the `printf` block that writes the AUTO-GENERATED box. You'll add one capture and one printf line.

- [ ] **Step 2: Add the Orders endpoint capture**

In the `env-file` target, next to the existing `dbhost="$$($(TF) output -raw db_writer_endpoint)"; \` line, add:

```make
	ordersdbhost="$$($(TF) output -raw orders_db_writer_endpoint)"; \
```

- [ ] **Step 3: Add the ORDERS_DATABASE_URL printf**

In the same target's `printf` block, right after the `USERS_DATABASE_URL` line, add (the Orders MySQL DSN, host-reachable; port is Floci's proxy port for the Orders cluster — a host contract like `USERS_DATABASE_URL`'s `7001`, discovered and documented in Task 5):

```make
		printf 'ORDERS_DATABASE_URL=mysql://test:test@%s:7002/orders\n' "$$ordersdbhost"; \
```

> The `7002` here is the HOST-side inspection URL port. Unlike compose (in-network `floci:<port>`), this line is for a SQL client on the host and mirrors how `USERS_DATABASE_URL` hardcodes `7001`. Task 5 verifies the real Orders proxy port; if Floci assigned something other than 7002, update this literal to match and note it. (A fully dynamic port would require parsing `describe-db-clusters`; the existing `USERS_DATABASE_URL` accepts the same static-port tradeoff, so match that convention.)

- [ ] **Step 4: Verify the Makefile still parses**

Run:

```bash
make -n env-file >/dev/null 2>&1 && echo "env-file target parses" || echo "check Makefile syntax"
```

Expected: `env-file target parses` (dry-run; it won't actually run terraform here).

- [ ] **Step 5: Commit**

```bash
git add Makefile
git commit -m "feat(infra): map ORDERS_DATABASE_URL into .env from terraform output"
```

---

## Task 5: Wire Orders compose to the real MySQL + move migration to a Makefile step

**Files:**
- Modify: `docker-compose.yml` (orders service: real port, drop `SEED_ON_STARTUP`)
- Modify: `Makefile` (add `migrate-orders`; call it in `bootstrap`)
- Modify: `services/orders/src/Orders.Api/Program.cs` (only if the `SEED_ON_STARTUP` block must be neutralized — see step)

**Interfaces:**
- Consumes: the running Orders MySQL cluster; the `orders_app` user (Task 3).
- Produces: a bootstrap chain where Orders migrates as superuser via `make migrate-orders`, then boots against the real MySQL port.

> **This task requires a live end-to-end run.** Docker/OrbStack + Floci must be available. This is where the design's Risk #1 (Floci supporting a second RDS cluster + the assigned port) is validated empirically.

- [ ] **Step 1: Full clean rebuild to discover the real MySQL port**

Run:

```bash
make clean && make bootstrap
```

While/after it runs, discover the port Floci assigned to the Orders MySQL cluster:

```bash
AWS_ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
  aws --endpoint-url http://localhost:4566 rds describe-db-clusters \
  --query 'DBClusters[].{id:DBClusterIdentifier,ep:Endpoint,port:Port}' --output table
```

Expected: TWO clusters listed — the Users Postgres and the Orders MySQL — each with its proxy port in 7000–7099. Record the Orders MySQL port.

> **STOP POINT (Risk #1):** if `make bootstrap` fails at the second cluster's apply, or only one cluster comes up, STOP and surface it to the user as a decision (per the spec's fallback). Do NOT grind hypotheses. The fallback is to keep Orders on `SEED_ON_STARTUP` + placeholder until the Floci limit is resolved.

- [ ] **Step 2: Reconcile the discovered port across Task 3 and Task 4**

If the discovered Orders MySQL port is NOT `7002`, update the two literals that assumed it:
- `ORDERS_DB_PORT` default in `bootstrap.sh` (Task 3) — or rely on `make bootstrap` passing it in (next step).
- the `ORDERS_DATABASE_URL=...:7002/orders` literal in the `Makefile` `env-file` target (Task 4).

Commit those reconciliations with the rest of this task.

- [ ] **Step 3: Point the Orders compose service at the real port and drop SEED_ON_STARTUP**

In `docker-compose.yml`, under the `orders` service, replace the placeholder `DATABASE_WRITER_URL`/`DATABASE_READER_URL` (`Server=floci;Port=7002;...`) with the discovered port, and REMOVE the `SEED_ON_STARTUP=true` line (migration now runs via `make migrate-orders`):

```yaml
      - DATABASE_WRITER_URL=Server=floci;Port=<REAL_PORT>;Database=orders;User=test;Password=test;
      - DATABASE_READER_URL=Server=floci;Port=<REAL_PORT>;Database=orders;User=test;Password=test;
```

> Keep the master `test/test` credentials for now (the compose service still connects as superuser locally, matching Users' compose which uses `test/test` even though `users_app` exists). Switching the running service to `orders_app` is a separate future task — out of scope here; this task only removes the placeholder and the startup migration.

- [ ] **Step 4: Add the `migrate-orders` Makefile target**

Add to the `Makefile` (near `migrate`), running EF Core migrations as the superuser inside the compose network (mirroring how `make migrate` reuses an in-network container so it doesn't depend on publishing Floci's proxy port to the host):

```make
migrate-orders: ## Apply Orders EF Core migrations + seed against Floci's MySQL (as superuser)
	@# Runs `dotnet ef database update` as the cluster SUPERUSER (test/test):
	@# migrations run DDL and orders_app deliberately has none (ADR-0004). Uses
	@# the orders build image's SDK; connects over the compose network to
	@# floci:<mysql-port>. Superseded the previous SEED_ON_STARTUP path now that a
	@# real cluster exists (parity with Users' `make migrate`).
	docker compose run --rm --no-deps \
		-e DATABASE_WRITER_URL="Server=floci;Port=$(ORDERS_DB_PORT);Database=orders;User=test;Password=test;" \
		-e DATABASE_READER_URL="Server=floci;Port=$(ORDERS_DB_PORT);Database=orders;User=test;Password=test;" \
		-e SEED_ON_STARTUP=true \
		orders dotnet ef database update --project src/Orders.Infrastructure --startup-project src/Orders.Api
```

> `ORDERS_DB_PORT` is a Makefile variable defaulting to the discovered port (add `ORDERS_DB_PORT ?= <REAL_PORT>` near the top of the Makefile with the other vars). If `dotnet ef` isn't available in the orders runtime image, run the migration via the SDK build stage instead (mirror `make migrate`'s `docker build --target <stage>` approach) — adapt and note it. The `SEED_ON_STARTUP=true` env here reuses the existing Program.cs migrate+seed path as the one-shot migration mechanism; if you prefer a pure `dotnet ef` invocation, ensure the seed still runs (ProductSeed + ConfigurationSeed).

- [ ] **Step 5: Insert `migrate-orders` into the bootstrap chain**

In the `Makefile` `bootstrap` target, add `$(MAKE) migrate-orders` AFTER `bash $(TF_LOCAL_DIR)/bootstrap.sh` (so the cluster exists and `orders_app` is created first) and BEFORE the final `$(COMPOSE) up -d --build orders`. Also pass the discovered `ORDERS_DB_PORT` to `bootstrap.sh` if you kept it override-driven (Task 3): e.g. prefix the bootstrap.sh call with `ORDERS_DB_PORT=<REAL_PORT>`.

- [ ] **Step 6: Neutralize SEED_ON_STARTUP as the runtime default (only if needed)**

Since `SEED_ON_STARTUP` is removed from the compose `orders` env (Step 3), the service no longer self-migrates at boot — `Program.cs` already guards that path on the flag, so NO code change is needed. Verify:

```bash
grep -n "SEED_ON_STARTUP" services/orders/src/Orders.Api/Program.cs docker-compose.yml
```

Expected: the flag is referenced in `Program.cs` (guarded) but NO longer set in the `orders` compose service. If it's still set in compose, remove it.

- [ ] **Step 7: Full end-to-end verification**

Run:

```bash
make clean && make bootstrap
curl -sf http://localhost:3001/v1/health && echo " orders healthy"
```

Then verify persistence and the no-DELETE grant:

```bash
# orders_app can SELECT but NOT DELETE (ADR-0004 proof)
docker run --rm --network 3mrai_3mrai-network mysql:8 \
  mysql -h floci -P <REAL_PORT> -u orders_app -p"$(cat infra/environments/local/.orders-app-db-secret)" orders \
  -e "DELETE FROM product LIMIT 1;" 2>&1 | grep -qi "denied" && echo "no-DELETE grant verified" || echo "CHECK: DELETE was not denied"
```

Expected: `orders healthy`, and `no-DELETE grant verified`.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml Makefile
git commit -m "feat(infra): boot Orders against real Floci MySQL; migrate via make, drop SEED_ON_STARTUP"
```

---

## Task 6: Update infra docs (CLAUDE.md + runbook note)

**Files:**
- Modify: `services/orders/CLAUDE.md` (DB is now real, not placeholder)
- Modify: `infra/CLAUDE.md` (note the second RDS cluster + orders_app)

**Interfaces:**
- Consumes: everything above.
- Produces: docs matching reality.

- [ ] **Step 1: Update services/orders/CLAUDE.md**

Update the Orders CLAUDE.md so the DB section reflects: Orders now runs against a provisioned Floci MySQL cluster (not the `7002` placeholder); migrations run via `make migrate-orders` (superuser), not `SEED_ON_STARTUP`; the least-privilege `orders_app` user (no DELETE) exists. Keep it terse and link shared conventions.

- [ ] **Step 2: Update infra/CLAUDE.md**

In `infra/CLAUDE.md`, note under the local-Floci section that there are now TWO RDS clusters (Users Postgres + Orders MySQL), both via the `rds-aurora` module, and that `bootstrap.sh` creates both least-privilege app users post-apply.

- [ ] **Step 3: Commit**

```bash
git add services/orders/CLAUDE.md infra/CLAUDE.md
git commit -m "docs(infra): document the Orders MySQL cluster and orders_app user"
```

---

## Self-review — spec coverage

- §1 Scope: second `rds-aurora` instantiation (Task 1), master secret (module, inherited), new outputs (Task 2), `orders_app` no-DELETE via bootstrap.sh (Task 3), `ORDERS_DATABASE_URL` in .env (Task 4), compose off-placeholder + migration→Makefile (Task 5). ✓
- §2a module instantiation (engine=mysql, letter-led id, manage_app_user=false, subnet_group default) → Task 1. ✓
- §2b orders_app via bootstrap.sh, mysql:8 ephemeral container, no ALTER DEFAULT PRIVILEGES needed, git-ignored secret → Task 3. ✓
- §2c migration moves to Makefile as superuser, remove SEED_ON_STARTUP → Task 5. ✓
- §2d outputs + env-file host-reachable URL + compose real port → Tasks 2, 4, 5. ✓
- §2e Risk #1 (discover port, don't hardcode; stop-and-surface if two-cluster apply fails) → Task 5 Step 1 STOP POINT. ✓
- §3 testing: fmt/validate (Tasks 1-2), end-to-end clean+bootstrap, port discovery, no-DELETE proof, health, persistence → Task 5 Steps 1/7. ✓
- Open questions: engine_version pinned to "8.0" (Task 1, note if patch needed); migrate-orders is a NEW target (Task 5); two-cluster support verified empirically (Task 5 Step 1). ✓

## Related

- [[2026-07-15-orders-rds-mysql-design]]
- [[orders-service-design]]
- [[2026-07-14-orders-service-milestone]]
- [[ADR-0004-soft-delete-only]]
- [[ADR-0006-read-write-replicas]]
- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0017-floci-local]]
- [[floci-rds-apigw-limits]]
- [[local-dev-floci]]
