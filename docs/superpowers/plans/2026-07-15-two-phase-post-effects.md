---
title: "Two-Phase Post-Effects Apply"
type: plan
area: infra
status: draft
created: 2026-07-15
updated: 2026-07-15
tags: [type/plan, area/infra, status/draft]
related: ["[[2026-07-15-two-phase-post-effects-design]]", "[[2026-07-15-orders-rds-mysql-design]]", "[[orders-service-design]]", "[[ADR-0004-soft-delete-only]]", "[[ADR-0006-read-write-replicas]]", "[[ADR-0007-secrets-parameter-store]]", "[[ADR-0017-floci-local]]", "[[floci-rds-apigw-limits]]", "[[local-dev-floci]]"]
---

# Two-Phase Post-Effects Apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second Terraform apply phase (`environments/local/post/`) that creates database app-users cleanly in Terraform against now-live endpoints, replacing the bash `bootstrap_app_db_user` step, prod-first and gated per-engine in local.

**Architecture:** A new `modules/db-app-user/` (engine-parameterized: postgres|mysql) holds the least-privilege app-user resources. A new `environments/local/post/` root reads phase-1 outputs via `terraform_remote_state` and the master secret via `aws_secretsmanager_secret_version`, waits for the DB with a `terraform_data`+`local-exec` gate, then instantiates `db-app-user` per enabled engine. `make bootstrap` runs phase 2 after phase 1. Local enables only postgres (Floci hangs the mysql provider); prod enables both.

**Tech Stack:** Terraform (AWS provider `= 5.31.0`, `cyrilgdn/postgresql ~> 1.22`, `petoju/mysql ~> 3.0`), Floci, bash, `pg_isready`/`mysqladmin`.

## Global Constraints

- **Local only** for this implementation: `infra/modules/db-app-user/**`, `infra/environments/local/post/**`, `infra/environments/local/bootstrap.sh`, `Makefile`, docs. Production `post/` is analogous but OUT of scope (local-first, prod-shaped).
- **Secret-only:** NEVER a DB password in a `variable`, `.tfvars`, output, or `.env`. Read the master secret by ARN via a data source; generate each app-user password with `random_password` written to its own Secrets Manager secret. Phase-2 tfstate MUST be gitignored.
- **Soft-delete at grant level (ADR-0004):** app-users get `SELECT, INSERT, UPDATE` — NEVER `DELETE`.
- **Per-engine gating:** local enables postgres only (Floci's mysql provider HANGS — see the Floci MySQL limit lesson); prod enables both. Gating is a per-environment input, not conditional compilation.
- **Re-apply = rebuild** on Floci; validate via `make clean` + `make bootstrap`. Phase 2 has its OWN state so it never re-touches phase 1.
- **Language:** converse in Spanish; write config/comments in English.
- **Implementers write only Terraform/config/bash.** Leave work in the working tree; the main session commits.

---

## Task 1: `modules/db-app-user/` — engine-parameterized least-privilege user

**Files:**
- Create: `infra/modules/db-app-user/terraform.tf`
- Create: `infra/modules/db-app-user/variables.tf`
- Create: `infra/modules/db-app-user/main.tf`
- Create: `infra/modules/db-app-user/outputs.tf`

**Interfaces:**
- Consumes: `var.engine` ("postgres"|"mysql"), `var.database_name`, `var.app_username`, `var.master_username` (owner for default privileges), `var.context` ({id, tags}). Providers `postgresql`/`mysql` are configured by the CALLER (phase-2 root) and passed in.
- Produces: the app role/user with SELECT/INSERT/UPDATE (no DELETE); output `app_secret_arn` (its generated credentials in Secrets Manager).

- [ ] **Step 1: Provider requirements**

Create `infra/modules/db-app-user/terraform.tf`:

```hcl
terraform {
  required_providers {
    aws        = { source = "hashicorp/aws" }
    postgresql = { source = "cyrilgdn/postgresql", version = "~> 1.22" }
    mysql      = { source = "petoju/mysql", version = "~> 3.0" }
    random     = { source = "hashicorp/random" }
  }
}
```

- [ ] **Step 2: Variables**

Create `infra/modules/db-app-user/variables.tf`:

```hcl
variable "context" {
  type = object({ id = string, tags = map(string) })
}
variable "engine" {
  description = "postgres | mysql — selects which provider's resources apply."
  type        = string
  validation {
    condition     = contains(["postgres", "mysql"], var.engine)
    error_message = "engine must be postgres or mysql."
  }
}
variable "database_name" {
  type = string
}
variable "app_username" {
  type = string
}
variable "master_username" {
  description = "Master/owner username — used as the owner for Postgres default privileges."
  type        = string
}
variable "db_host" {
  type = string
}
variable "db_port" {
  type = number
}
```

- [ ] **Step 3: The app-user resources (both engines, count-gated)**

Create `infra/modules/db-app-user/main.tf`. This is the app-user logic extracted from `rds-aurora` (Postgres) plus a MySQL sibling, each gated by `var.engine`. Grants are SELECT/INSERT/UPDATE, NO DELETE (ADR-0004):

```hcl
locals {
  is_pg    = var.engine == "postgres"
  is_mysql = var.engine == "mysql"
}

resource "random_password" "app" {
  length  = 24
  special = false
}

# ── Postgres branch ──────────────────────────────────────────────────────────
resource "postgresql_role" "app" {
  count    = local.is_pg ? 1 : 0
  name     = var.app_username
  login    = true
  password = random_password.app.result
}

resource "postgresql_grant" "connect" {
  count       = local.is_pg ? 1 : 0
  role        = postgresql_role.app[0].name
  database    = var.database_name
  object_type = "database"
  privileges  = ["CONNECT"]
}

resource "postgresql_grant" "usage" {
  count       = local.is_pg ? 1 : 0
  role        = postgresql_role.app[0].name
  database    = var.database_name
  schema      = "public"
  object_type = "schema"
  privileges  = ["USAGE"]
}

resource "postgresql_grant" "tables" {
  count       = local.is_pg ? 1 : 0
  role        = postgresql_role.app[0].name
  database    = var.database_name
  schema      = "public"
  object_type = "table"
  objects     = []
  privileges  = ["SELECT", "INSERT", "UPDATE"]
}

resource "postgresql_default_privileges" "future_tables" {
  count       = local.is_pg ? 1 : 0
  role        = postgresql_role.app[0].name
  database    = var.database_name
  schema      = "public"
  owner       = var.master_username
  object_type = "table"
  privileges  = ["SELECT", "INSERT", "UPDATE"]
}

# ── MySQL branch (prod only; Floci hangs this — see the Floci MySQL limit) ────
resource "mysql_user" "app" {
  count              = local.is_mysql ? 1 : 0
  user               = var.app_username
  host               = "%"
  plaintext_password = random_password.app.result
}

resource "mysql_grant" "app" {
  count      = local.is_mysql ? 1 : 0
  user       = mysql_user.app[0].user
  host       = mysql_user.app[0].host
  database   = var.database_name
  privileges = ["SELECT", "INSERT", "UPDATE"]
}

# ── Generated app credentials → Secrets Manager (secret-only consumption) ─────
resource "aws_secretsmanager_secret" "app" {
  name        = "${var.context.id}/db-app-user/${var.app_username}"
  description = "Least-privilege app DB credentials for ${var.app_username}"
  tags        = merge(var.context.tags, { Name = "${var.context.id}-${var.app_username}-credentials" })
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    username = var.app_username
    password = random_password.app.result
    host     = var.db_host
    port     = var.db_port
    dbname   = var.database_name
  })
}
```

- [ ] **Step 4: Output**

Create `infra/modules/db-app-user/outputs.tf`:

```hcl
output "app_secret_arn" {
  description = "ARN of the least-privilege app-user credentials secret."
  value       = aws_secretsmanager_secret.app.arn
  sensitive   = true
}
```

- [ ] **Step 5: Validate the module in isolation**

Run:

```bash
cd infra/modules/db-app-user && terraform init -backend=false >/dev/null && terraform validate
```

Expected: `Success! The configuration is valid.`

- [ ] **Step 6: Commit**

```bash
git add infra/modules/db-app-user
git commit -m "feat(infra): db-app-user module (engine-parameterized least-privilege user, no DELETE)"
```

---

## Task 2: `environments/local/post/` root — remote state, secret, provider config

**Files:**
- Create: `infra/environments/local/post/terraform.tf`
- Create: `infra/environments/local/post/providers.tf`
- Create: `infra/environments/local/post/variables.tf`
- Create: `infra/environments/local/post/data.tf`

**Interfaces:**
- Consumes: phase-1 state at `../terraform.tfstate` (outputs `db_writer_endpoint`, `orders_db_writer_endpoint`, `secret_arn`); phase-1 master secret by ARN.
- Produces: configured `postgresql`/`mysql` providers pointed at live endpoints with credentials from the secret; `local.pg` / `local.mysql` connection facts for later tasks.

- [ ] **Step 1: Provider requirements**

Create `infra/environments/local/post/terraform.tf`:

```hcl
terraform {
  required_version = ">= 1.7"
  required_providers {
    aws        = { source = "hashicorp/aws", version = "= 5.31.0" }
    postgresql = { source = "cyrilgdn/postgresql", version = "~> 1.22" }
    mysql      = { source = "petoju/mysql", version = "~> 3.0" }
    random     = { source = "hashicorp/random" }
  }
}
```

- [ ] **Step 2: Read phase-1 state + master secret**

Create `infra/environments/local/post/data.tf`:

```hcl
# Phase-1 outputs (endpoints + master secret ARN). Local backend file.
data "terraform_remote_state" "phase1" {
  backend = "local"
  config  = { path = "../terraform.tfstate" }
}

# Master credentials, read BY ARN — never passed as a variable. jsondecoded in
# memory to configure the providers below. The secret_string lands in THIS
# root's (gitignored) state — inherent to any Terraform secret data source.
data "aws_secretsmanager_secret_version" "master" {
  secret_id = data.terraform_remote_state.phase1.outputs.secret_arn
}

locals {
  master = jsondecode(data.aws_secretsmanager_secret_version.master.secret_string)

  pg_host    = data.terraform_remote_state.phase1.outputs.db_writer_endpoint
  mysql_host = data.terraform_remote_state.phase1.outputs.orders_db_writer_endpoint

  # Floci proxy ports (7000-7099, assigned at apply time). Postgres = 7001,
  # Orders MySQL = 7002 (verified). These are Floci-local; prod reads host/port
  # from the secret itself (local.master.host / local.master.port).
  pg_port    = var.pg_port
  mysql_port = var.mysql_port
}
```

> On Floci the master secret's `host`/`port` are the RDS proxy values; if they differ from the live proxy port, prefer the phase-1 endpoint output + the known Floci port (var-driven). In prod, use `local.master.host`/`local.master.port` directly. Keep both paths documented.

- [ ] **Step 3: Variables (gating + ports)**

Create `infra/environments/local/post/variables.tf`:

```hcl
variable "enabled_app_users" {
  description = "Which engines to manage app-users for. Local: [\"postgres\"] (Floci hangs mysql). Prod: [\"postgres\",\"mysql\"]."
  type        = list(string)
  default     = ["postgres"]
}
variable "pg_port" {
  type    = number
  default = 7001
}
variable "mysql_port" {
  type    = number
  default = 7002
}
variable "pg_database" {
  type    = string
  default = "users"
}
variable "mysql_database" {
  type    = string
  default = "orders"
}
variable "master_username" {
  type    = string
  default = "test"
}
```

- [ ] **Step 4: Configure the providers from the secret**

Create `infra/environments/local/post/providers.tf`:

```hcl
provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  endpoints {
    rds            = "http://localhost:4566"
    secretsmanager = "http://localhost:4566"
    sts            = "http://localhost:4566"
  }
}

# Configured with the master password from the secret (local.master) — never a
# variable. Host/port are the Floci-proxied endpoint.
provider "postgresql" {
  host     = "localhost"
  port     = local.pg_port
  database = var.pg_database
  username = local.master.username
  password = local.master.password
  sslmode  = "disable"
  superuser = false
}

provider "mysql" {
  endpoint = "localhost:${local.mysql_port}"
  username = local.master.username
  password = local.master.password
  tls      = "false"
}
```

> `host = "localhost"` because phase 2 runs on the HOST (make step), reaching Floci's published proxy port. If phase 2 ever runs in-network, switch to `floci`. Document the choice.

- [ ] **Step 5: Init + validate**

Run:

```bash
cd infra/environments/local/post && terraform init -backend=false >/dev/null && terraform validate
```

Expected: `Success! The configuration is valid.` (validate does not connect; it checks config/types.)

- [ ] **Step 6: Ensure phase-2 state is gitignored**

Run:

```bash
git check-ignore infra/environments/local/post/terraform.tfstate && echo IGNORED || echo "NEEDS RULE"
```

Expected: `IGNORED` (the existing `*.tfstate` rule should cover it). If `NEEDS RULE`, add `infra/environments/local/post/terraform.tfstate*` to the relevant `.gitignore`.

- [ ] **Step 7: Commit**

```bash
git add infra/environments/local/post/terraform.tf infra/environments/local/post/providers.tf infra/environments/local/post/variables.tf infra/environments/local/post/data.tf
git commit -m "feat(infra): phase-2 post-effects root — remote state, secret-by-ARN, provider config"
```

---

## Task 3: wait-for-db healthcheck gate

**Files:**
- Create: `infra/environments/local/post/scripts/wait-for-db.sh`
- Create: `infra/environments/local/post/gate.tf`

**Interfaces:**
- Consumes: `local.pg_host`/`local.pg_port` etc.
- Produces: `terraform_data.wait_for_db["postgres"|"mysql"]` that later app-user modules `depends_on`.

- [ ] **Step 1: The wait-for-db script**

Create `infra/environments/local/post/scripts/wait-for-db.sh`:

```bash
#!/usr/bin/env bash
# Polls a DB endpoint until it accepts connections, or fails after a timeout.
# Usage: wait-for-db.sh <host> <port> <engine:postgres|mysql>
set -euo pipefail
HOST="$1"; PORT="$2"; ENGINE="$3"
ATTEMPTS="${WAIT_ATTEMPTS:-30}"; SLEEP="${WAIT_SLEEP:-2}"

for i in $(seq 1 "$ATTEMPTS"); do
  case "$ENGINE" in
    postgres)
      if docker run --rm --network 3mrai_3mrai-network postgres:14.6-alpine \
        pg_isready -h "$HOST" -p "$PORT" >/dev/null 2>&1; then
        echo "postgres at $HOST:$PORT ready"; exit 0
      fi ;;
    mysql)
      if docker run --rm --network 3mrai_3mrai-network mysql:8 \
        mysqladmin ping --ssl-mode=DISABLED -h "$HOST" -P "$PORT" --silent >/dev/null 2>&1; then
        echo "mysql at $HOST:$PORT ready"; exit 0
      fi ;;
    *) echo "unknown engine: $ENGINE" >&2; exit 2 ;;
  esac
  echo "waiting for $ENGINE at $HOST:$PORT ($i/$ATTEMPTS)…"; sleep "$SLEEP"
done
echo "timed out waiting for $ENGINE at $HOST:$PORT" >&2
exit 1
```

> The gate uses the compose service name `floci` as host (in-network `docker run`), not `localhost` — the check runs a container ON the network. Pass `floci` as the host for the gate even though the providers use `localhost` (host-side). Reconcile in gate.tf: the gate's host is `floci`, its port the same Floci proxy port.

- [ ] **Step 2: The gate resource**

Create `infra/environments/local/post/gate.tf`:

```hcl
# Wait for each enabled engine's DB to accept connections before creating any
# app-user. Reuses the terraform_data + local-exec pattern from modules/cognito.
resource "terraform_data" "wait_for_db" {
  for_each = toset(var.enabled_app_users)

  input = {
    host   = each.key == "postgres" ? "floci" : "floci"
    port   = each.key == "postgres" ? local.pg_port : local.mysql_port
    engine = each.key
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/wait-for-db.sh ${self.input.host} ${self.input.port} ${self.input.engine}"
    interpreter = ["/usr/bin/env", "bash"]
  }
}
```

- [ ] **Step 3: Make the script executable + syntax check**

Run:

```bash
chmod +x infra/environments/local/post/scripts/wait-for-db.sh
bash -n infra/environments/local/post/scripts/wait-for-db.sh && echo "syntax ok"
cd infra/environments/local/post && terraform validate
```

Expected: `syntax ok` and `Success! The configuration is valid.`

- [ ] **Step 4: Commit**

```bash
git add infra/environments/local/post/scripts/wait-for-db.sh infra/environments/local/post/gate.tf
git commit -m "feat(infra): wait-for-db healthcheck gate for the post-effects phase"
```

---

## Task 4: Instantiate db-app-user per enabled engine

**Files:**
- Create: `infra/environments/local/post/main.tf`

**Interfaces:**
- Consumes: `modules/db-app-user` (Task 1), the gate (Task 3), the configured providers (Task 2).
- Produces: `module.users_app` (postgres) when enabled; `module.orders_app` (mysql) when enabled.

- [ ] **Step 1: The module instantiations**

Create `infra/environments/local/post/main.tf`:

```hcl
# Label for the post-effects resources' secret names/tags.
module "label_post" {
  source      = "../../../modules/label"
  namespace   = "3mrai"
  environment = "local"
  name        = "post"
}

# Users app-user (Postgres). Enabled locally — Floci supports it.
module "users_app" {
  count  = contains(var.enabled_app_users, "postgres") ? 1 : 0
  source = "../../../modules/db-app-user"

  context         = { id = "post-${module.label_post.id}", tags = module.label_post.tags }
  engine          = "postgres"
  database_name   = var.pg_database
  app_username    = "users_app"
  master_username = var.master_username
  db_host         = local.pg_host
  db_port         = local.pg_port

  depends_on = [terraform_data.wait_for_db]
}

# Orders app-user (MySQL). DISABLED locally (Floci hangs the mysql provider);
# enabled in prod via enabled_app_users = ["postgres","mysql"].
module "orders_app" {
  count  = contains(var.enabled_app_users, "mysql") ? 1 : 0
  source = "../../../modules/db-app-user"

  context         = { id = "post-${module.label_post.id}", tags = module.label_post.tags }
  engine          = "mysql"
  database_name   = var.mysql_database
  app_username    = "orders_app"
  master_username = var.master_username
  db_host         = local.mysql_host
  db_port         = local.mysql_port

  depends_on = [terraform_data.wait_for_db]
}
```

- [ ] **Step 2: Validate**

Run:

```bash
cd infra/environments/local/post && terraform validate
```

Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
git add infra/environments/local/post/main.tf
git commit -m "feat(infra): instantiate db-app-user per enabled engine (postgres local, mysql prod)"
```

---

## Task 5: Wire phase 2 into the Makefile + shrink bootstrap.sh

**Files:**
- Modify: `Makefile` (add `infra-up-post`; call it in `bootstrap`)
- Modify: `infra/environments/local/bootstrap.sh` (retire `bootstrap_app_db_user`; keep nginx alias)

**Interfaces:**
- Produces: a bootstrap chain where phase 2 creates `users_app` in Terraform after phase 1.

> **This task requires a live Floci run** (phase-2 postgres apply). Docker + Floci available.

- [ ] **Step 1: Add the `infra-up-post` target**

Add to the `Makefile`:

```make
infra-up-post: ## Phase 2: create DB app-users in Terraform (post-effects), after phase 1
	cd $(TF_LOCAL_DIR)/post && terraform init >/dev/null && terraform apply -auto-approve
```

> `TF_LOCAL_DIR` is the existing Makefile var for `infra/environments/local`. Confirm its value and that `post/` sits under it.

- [ ] **Step 2: Retire the Postgres app-user step from bootstrap.sh**

In `infra/environments/local/bootstrap.sh`, remove (or neutralize) the `bootstrap_app_db_user` CALL (`bootstrap_app_db_user || STEP1_STATUS=$?`) and the already-skipped `bootstrap_orders_app_db_user` call — phase 2 now owns app-users. KEEP the function definitions for reference OR delete them; prefer deleting the calls and leaving a comment pointing to `environments/local/post/`. The nginx-stable alias logic (step 2 of the script) STAYS untouched.

```bash
# App DB users are now created by the phase-2 post-effects apply
# (environments/local/post/), not here. This script now only manages the
# docker-native nginx-stable alias below.
```

- [ ] **Step 3: Insert phase 2 into the bootstrap chain**

In the `Makefile` `bootstrap` target, add `$(MAKE) infra-up-post` AFTER `bash $(TF_LOCAL_DIR)/bootstrap.sh` (cluster + endpoints exist; the gate waits for readiness) and BEFORE the service `up` steps that need the app-user. Order: phase1 apply → env-file → migrate → bootstrap.sh (nginx alias) → **infra-up-post** → services.

- [ ] **Step 4: Full end-to-end run**

Run:

```bash
make clean && make bootstrap
```

Expected: phase 1 applies, the gate waits for Postgres, phase 2 applies creating `users_app`. Watch for the phase-2 apply completing without hanging (postgres only; mysql is gated off locally).

> **STOP POINT:** if phase-2 postgres apply fails or hangs, STOP and surface it (per the spec + the Floci-blocker guidance). Do not grind.

- [ ] **Step 5: Verify users_app works and cannot DELETE**

Run:

```bash
# users_app can SELECT (from the phase-2 generated secret)
PGSECRET=$(aws --endpoint-url http://localhost:4566 secretsmanager get-secret-value \
  --secret-id "$(cd infra/environments/local/post && terraform output -raw users_app_secret_arn 2>/dev/null)" \
  --query SecretString --output text 2>/dev/null)
echo "resolved users_app secret: ${PGSECRET:+yes}"
```

> If a convenient `users_app_secret_arn` output isn't wired, verify via `psql` as `users_app` that SELECT works and `DELETE` is denied (ADR-0004), mirroring how Users' bootstrap was verified. Add the output to `post/outputs.tf` if useful.

- [ ] **Step 6: Commit**

```bash
git add Makefile infra/environments/local/bootstrap.sh
git commit -m "feat(infra): run post-effects phase in bootstrap; move users_app from bash to Terraform"
```

---

## Task 6: Docs

**Files:**
- Modify: `infra/CLAUDE.md` (document the two-phase apply)
- Create: `infra/environments/local/post/README.md` (what phase 2 is, how to run it)

**Interfaces:**
- Produces: docs matching reality.

- [ ] **Step 1: Update infra/CLAUDE.md**

Add a subsection under the local-Floci section: the bootstrap now runs a PHASE 2 (`environments/local/post/`) that creates DB app-users in Terraform (postgres locally, mysql prod-only — Floci hangs mysql). Note the secret-only pattern and the wait-for-db gate. Update the `make bootstrap` order description to include `infra-up-post`.

- [ ] **Step 2: Add post/README.md**

Create a short `infra/environments/local/post/README.md`: purpose (post-effects two-phase apply), what it reads (phase-1 remote state + master secret by ARN), the gate, the per-engine gating (`enabled_app_users`), and the run command (`make infra-up-post` or the raw terraform). Note the Floci mysql limit and that prod enables both engines.

- [ ] **Step 3: Commit**

```bash
git add infra/CLAUDE.md infra/environments/local/post/README.md
git commit -m "docs(infra): document the two-phase post-effects apply"
```

---

## Self-review — spec coverage

- §1 Architecture (two roots, phase 2 own state, runs after phase 1) → Tasks 2, 5. ✓
- §2 remote_state + secret-by-ARN + jsondecode + secret-only + gitignored state → Task 2 (data.tf, providers.tf, Step 6). ✓
- §3a wait-for-db gate (terraform_data + local-exec, depends_on) → Task 3. ✓
- §3b per-engine gating (enabled_app_users, postgres local / both prod) → Task 2 (var), Task 4 (count). ✓
- §3c Users migration (retire bootstrap_app_db_user, keep nginx alias) → Task 5 Step 2. ✓
- §3d db-app-user extracted module (engine-parameterized) → Task 1. ✓
- §3e testing (fmt/validate per task; e2e clean+bootstrap; users_app no-DELETE; mysql gated off doesn't hang) → Tasks 1-4 validate, Task 5 Steps 4-5. ✓
- Open questions: enabled_app_users = list of engine strings (Task 2); terraform_remote_state chosen (Task 2); db-app-user is a NEW extracted module (Task 1); prod post/ analogous but out of scope (Global Constraints). ✓

## Related

- [[2026-07-15-two-phase-post-effects-design]]
- [[2026-07-15-orders-rds-mysql-design]]
- [[orders-service-design]]
- [[ADR-0004-soft-delete-only]]
- [[ADR-0006-read-write-replicas]]
- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0017-floci-local]]
- [[floci-rds-apigw-limits]]
- [[local-dev-floci]]
