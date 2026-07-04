---
title: "JE-36 — Compose environments/local + apply on Floci — Plan"
type: plan
area: infra
status: draft
created: 2026-07-04
updated: 2026-07-04
tags: [type/plan, area/infra, status/draft, issue/JE-36]
related: ["[[2026-07-04-je36-local-env-compose-design]]", "[[users-service-milestone]]", "[[ADR-0017-floci-local]]", "[[local-dev]]"]
---

# JE-36 — Compose environments/local + apply Users chain on Floci Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose the six existing Terraform modules into `infra/environments/local`, apply against Floci, attach the stable nginx DNS alias, run the Prisma migration, and prove `GET /v1/health` → 200 through the API Gateway invoke URL.

**Architecture:** A new root Terraform module (`environments/local`) instantiates and wires `label`/`networking`/`rds-aurora`/`cognito`/`compute`/`api-gateway` (already Floci-aligned). nginx (compute) proxies to the real `users` service via a stable Docker DNS alias (`nginx-stable`). Makefile targets orchestrate apply → alias → migrate → health-check. Terraform/config edits by the main session (or `infra-impl`); doc/Linear text-sync by `obsidian-vault`/`linear-pm`.

**Tech Stack:** Terraform (AWS provider against Floci `:4566`), Floci local emulator, Docker Compose, Prisma migrate (pnpm), GNU Make.

## Global Constraints

- **Target Floci** (`localhost:4566`), not Ministack. Provider `endpoints` block per `spike-floci/providers.tf`. (spec: Context)
- **Do NOT rewrite the six modules** — compose and wire only; adapt wiring only if apply reveals a concrete gap. (spec: Non-goals)
- **nginx → real `users` service**: `backend_service_name = "users"`, `backend_port = 3000`. (spec: Goals)
- **api-gateway integration URI = `http://nginx-stable/`** (the spike's proven stable-DNS approach). The `api-gateway` module's `nginx_integration_uri` variable description still mentions the old IP-patch approach, but its resource just uses the passed value — pass the stable alias URI. (spec: Components §6; verified in module main.tf)
- **`master_password` is required** (no default in rds-aurora) — supply from `environments/local/variables.tf`. (verified)
- **`context` is an object `{ id = string, tags = map(string) }`** built from `module.label.id` + `module.label.tags` — NOT `module.label.context`. Each module needs its OWN label instance (distinct `name`) so resource ids differ. (verified: label outputs `id`/`tags`; consumers want `context`)
- **cognito `issuer` output** is AWS-format (`https://cognito-idp.<region>.amazonaws.com/<pool-id>`) — correct for Floci too. (verified)
- **Honest stop point:** if Aurora Postgres on Floci can't be migrated, STOP and report — do NOT fake the migration or claim /v1/health passed. (spec: Risks)
- **Branch:** fresh `feat/JE-36-local-env-compose` off `feature/users-service`; the stale `feat/JE-36-local-env-apply` is archived, not reused. One PR into `feature/users-service`. (spec: Write ownership)
- **Writes under `docs/` → `obsidian-vault`; Linear → `linear-pm` (user confirms). Vault content English; Node under `nvm use`. Commit via A/B/C/D/E menu (`AskUserQuestion`), never unprompted.** (repo rules; [[git-workflow]])

---

## Verified module facts (use these EXACT names)

Outputs:
- `label` → `id` (string), `tags` (map)
- `networking` → `vpc_id`, `subnet_ids` (list), `security_group_ids` (list)
- `rds-aurora` → `writer_endpoint`, `reader_endpoint`, `secret_arn`, `cluster_identifier`, `port`
- `cognito` → `user_pool_id`, `client_id`, `issuer`
- `compute` → `cluster_name`, `cluster_arn`, `service_name`, `task_definition_family`, `log_group_name` (NOTE: compute does NOT output an integration URI)
- `api-gateway` → `api_id`, `invoke_url`, `integration_id`

Key inputs:
- `label(namespace=3mrai default, environment, stage default "", name, attributes, tags)`
- `networking(context, vpc_cidr, subnets)`
- `rds-aurora(context, subnet_ids, security_group_ids, database_name, master_username, master_password [required], engine_version, instance_class, skip_final_snapshot)`
- `cognito(context, region, password_minimum_length)`
- `compute(context, vpc_id, subnet_ids, security_group_ids, backend_service_name, backend_port, cpu, memory, log_retention_days, region)`
- `api-gateway(context, cognito_issuer, cognito_audience, nginx_integration_uri, enable_e2e_cleanup_route)`

`context` is built inline per module: `context = { id = module.label_<x>.id, tags = module.label_<x>.tags }`.

---

## File Structure

| File | Action | Writer | Responsibility |
| --- | --- | --- | --- |
| `infra/environments/local/providers.tf` | Create | main session | AWS provider + Floci endpoints block. |
| `infra/environments/local/terraform.tf` | Create | main session | required_providers + required_version. |
| `infra/environments/local/variables.tf` | Create | main session | Env inputs + local-dev defaults (db creds, cidr). |
| `infra/environments/local/main.tf` | Create | main session | Instantiate + wire the six modules. |
| `infra/environments/local/outputs.tf` | Create | main session | invoke_url, cognito ids, db endpoints. |
| `infra/environments/local/bootstrap.sh` | Create | main session | Attach `nginx-stable` Docker alias (adapt spike). |
| `Makefile` | Modify | main session | Repoint infra-* to environments/local; add `db-migrate`; extend `bootstrap`. |
| `docs/plans/users-service-milestone.md` | Modify | `obsidian-vault` | JE-36 row: Ministack→Floci wording. |
| JE-36 title/description (Linear) | Modify | `linear-pm` | Ministack→Floci text sync (user confirms). |

**Ordering:** Compose Terraform first (Tasks 1–2), get a clean `validate`/`plan` (Task 2), then apply + bootstrap + migrate as the integration task with the honest stop point (Task 3), then Makefile wiring (Task 4), then text sync (Task 5), then final validation (Task 6). Terraform correctness is gated at `plan` (Task 2) BEFORE any apply, so a broken graph is caught cheaply.

---

### Task 1: Scaffold environments/local (providers, terraform, variables)

**Files:**
- Create: `infra/environments/local/providers.tf`, `infra/environments/local/terraform.tf`, `infra/environments/local/variables.tf`

**Writer:** main session.

**Interfaces:**
- Produces: a provider targeting Floci and the input variables consumed by `main.tf` (Task 2): `environment`, `image_tag`, `vpc_cidr`, `subnets`, `db_name`, `db_username`, `db_password`.

- [ ] **Step 1: Copy the proven provider config**

Create `infra/environments/local/providers.tf` from `infra/environments/local/spike-floci/providers.tf` (proven), and ADD the `rds` endpoint (the spike didn't exercise RDS; rds-aurora needs it):

```hcl
provider "aws" {
  region     = "us-east-1"
  access_key = "test"
  secret_key = "test"

  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  endpoints {
    apigateway       = "http://localhost:4566"
    apigatewayv2     = "http://localhost:4566"
    cognitoidp       = "http://localhost:4566"
    ec2              = "http://localhost:4566"
    ecs              = "http://localhost:4566"
    elbv2            = "http://localhost:4566"
    iam              = "http://localhost:4566"
    logs             = "http://localhost:4566"
    rds              = "http://localhost:4566"
    route53          = "http://localhost:4566"
    servicediscovery = "http://localhost:4566"
    secretsmanager   = "http://localhost:4566"
    sts              = "http://localhost:4566"
  }
}
```

(Include `secretsmanager` because rds-aurora emits a `secret_arn` — confirm in Task 2 whether the module actually creates a Secrets Manager secret; if not, drop that endpoint. The plan surfaces this rather than guessing silently.)

- [ ] **Step 2: Create terraform.tf**

Copy the `required_providers`/`required_version` from `spike-floci/terraform.tf` verbatim (same AWS provider pin the modules were validated against):

```bash
cp infra/environments/local/spike-floci/terraform.tf infra/environments/local/terraform.tf
```
Then open it and confirm it has no spike-specific resource refs (it should be pure provider requirements). If it references spike variables, strip those lines.

- [ ] **Step 3: Create variables.tf**

```hcl
variable "environment" {
  description = "Environment name component (label)."
  type        = string
  default     = "local"
}

variable "image_tag" {
  description = "Container image tag for the compute service."
  type        = string
  default     = "latest"
}

variable "vpc_cidr" {
  description = "CIDR block for the local VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnets" {
  description = "Subnet CIDRs for the local VPC."
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "db_name" {
  description = "Aurora Postgres database name."
  type        = string
  default     = "users"
}

variable "db_username" {
  description = "Aurora master username."
  type        = string
  default     = "test"
}

variable "db_password" {
  description = "Aurora master password (test default for local Floci)."
  type        = string
  default     = "test"
  sensitive   = true
}
```

(Defaults match the compose `DATABASE_WRITER_URL=postgres://test:test@.../users`.)

- [ ] **Step 4: Terraform fmt + init (no apply)**

Run:
```bash
terraform -chdir=infra/environments/local fmt
terraform -chdir=infra/environments/local init
```
Expected: `fmt` leaves files formatted; `init` succeeds (downloads AWS provider, no backend errors). It's fine that `main.tf` doesn't exist yet — init works on the provider config alone.

- [ ] **Step 5: Commit** (propose via the A/B/C/D/E menu)

Proposed message:
```
feat(infra): scaffold environments/local provider + vars for Floci (JE-36)
```

---

### Task 2: Compose and wire the six modules (main.tf + outputs.tf), gate at `plan`

**Files:**
- Create: `infra/environments/local/main.tf`, `infra/environments/local/outputs.tf`

**Writer:** main session.

**Interfaces:**
- Consumes: the variables from Task 1.
- Produces: outputs `api_invoke_url`, `cognito_user_pool_id`, `cognito_client_id`, `db_writer_endpoint`, `db_reader_endpoint` (consumed by Task 3 migrate + health check and Task 4 Makefile).

- [ ] **Step 1: Write main.tf wiring the six modules**

Create `infra/environments/local/main.tf`. Each module gets its own `label` instance (distinct `name`) so resource ids differ; `context` is the `{id, tags}` object:

```hcl
locals {
  region = "us-east-1"
}

module "label_net" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "net"
}
module "label_db" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "aurora"
}
module "label_cognito" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "cognito"
}
module "label_compute" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "compute"
}
module "label_api" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "api"
}

module "networking" {
  source   = "../../modules/networking"
  context  = { id = module.label_net.id, tags = module.label_net.tags }
  vpc_cidr = var.vpc_cidr
  subnets  = var.subnets
}

module "rds_aurora" {
  source              = "../../modules/rds-aurora"
  context             = { id = module.label_db.id, tags = module.label_db.tags }
  subnet_ids          = module.networking.subnet_ids
  security_group_ids  = module.networking.security_group_ids
  database_name       = var.db_name
  master_username     = var.db_username
  master_password     = var.db_password
  skip_final_snapshot = true
}

module "cognito" {
  source  = "../../modules/cognito"
  context = { id = module.label_cognito.id, tags = module.label_cognito.tags }
  region  = local.region
}

module "compute" {
  source               = "../../modules/compute"
  context              = { id = module.label_compute.id, tags = module.label_compute.tags }
  vpc_id               = module.networking.vpc_id
  subnet_ids           = module.networking.subnet_ids
  security_group_ids   = module.networking.security_group_ids
  backend_service_name = "users"
  backend_port         = 3000
  region               = local.region
}

module "api_gateway" {
  source                   = "../../modules/api-gateway"
  context                  = { id = module.label_api.id, tags = module.label_api.tags }
  cognito_issuer           = module.cognito.issuer
  cognito_audience         = module.cognito.client_id
  nginx_integration_uri    = "http://nginx-stable/"
  enable_e2e_cleanup_route = true
}
```

- [ ] **Step 2: Write outputs.tf**

```hcl
output "api_invoke_url" {
  description = "API Gateway invoke URL (hit /v1/health through this)."
  value       = module.api_gateway.invoke_url
}
output "cognito_user_pool_id" {
  value = module.cognito.user_pool_id
}
output "cognito_client_id" {
  value = module.cognito.client_id
}
output "db_writer_endpoint" {
  value = module.rds_aurora.writer_endpoint
}
output "db_reader_endpoint" {
  value = module.rds_aurora.reader_endpoint
}
```

- [ ] **Step 3: Reconcile any wiring mismatch against the real module variables**

Before validate, cross-check every module argument above against the module's `variables.tf` for required inputs with no default that this composition omits. Run:
```bash
for m in networking rds-aurora cognito compute api-gateway; do
  echo "=== $m required (no default) vars ==="
  awk '/^variable/{v=$2} /default/{d=1} /^}/{if(!d && v)print v; v=""; d=0}' infra/modules/$m/variables.tf
done
```
For each required var printed that is NOT set in `main.tf`, add it (with a sane local-dev value) — e.g. if `compute` requires `cpu`/`memory`/`log_retention_days` with no default, set `cpu = 256`, `memory = 512`, `log_retention_days = 1`. Do NOT leave a required var unset (apply would fail). Record what you added.

- [ ] **Step 4: fmt, validate, plan — the gate**

Run:
```bash
terraform -chdir=infra/environments/local fmt
terraform -chdir=infra/environments/local validate
terraform -chdir=infra/environments/local plan
```
Expected: `validate` → "Success! The configuration is valid." `plan` produces a graph containing resources from all six modules with no errors (Floci need not be running for `plan` to succeed — it doesn't call the API). If `plan` errors on a missing/mismatched output attribute, fix the reference to match the module's real `outputs.tf` and re-run.

- [ ] **Step 5: Commit** (propose via the A/B/C/D/E menu)

Proposed message:
```
feat(infra): compose six modules into environments/local for Floci (JE-36)
```

---

---

# Revision 2 — Floci emulation gaps + discrete app DB user

> The first apply (original Task 3) failed on real Floci gaps. These tasks (R1–R4) are the
> revised path, per the spec's "Revision 2" section. They run AFTER the completed Tasks 1–2
> (scaffold + compose) and REPLACE the original Task 3 below (kept for reference, marked
> superseded). Module edits are additive + backward-compatible: defaults preserve prod behavior.

## Verified facts for Revision 2 (use these EXACT values)

- Floci runs real DB containers for engine `postgres`/`mysql`/`mariadb` only (NOT
  `aurora-postgresql`), on a proxy port `localhost:7000-7099` (official RDS docs).
- Cognito client quirk: `lifecycle { ignore_changes = [analytics_configuration] }` (floci skill #2).
- Cognito issuer contradiction (AWS-format vs `http://localhost:4566/<pool-id>`) → validate LIVE.
- Master secret shape in rds-aurora (replicate for app user):
  `jsonencode({ username, password, host, port, dbname })`; secret name
  `"${var.context.id}/aurora/credentials"`.
- rds-aurora has NO postgresql provider yet — R3 adds `cyrilgdn/postgresql` to the module's
  required_providers.
- App-user grants (the module's documented SQL): `CONNECT` on db, `USAGE` on `public`,
  `SELECT, INSERT, UPDATE` on tables (NO DELETE), `ALTER DEFAULT PRIVILEGES` for future tables.

---

### Task R1: RDS engine switchable (module rds-aurora)

**Files:**
- Modify: `infra/modules/rds-aurora/variables.tf` (add `engine` var), `infra/modules/rds-aurora/main.tf` (use it)
- Modify: `infra/environments/local/main.tf` (pass `engine = "postgres"`, `instance_class = "db.t3.micro"`)

**Writer:** `infra-impl`.

**Interfaces:**
- Produces: `rds-aurora` accepts an `engine` input; local composition creates a Floci-compatible Postgres cluster.

- [ ] **Step 1: Add the `engine` variable to rds-aurora**

In `infra/modules/rds-aurora/variables.tf`, add (backward-compatible default = current hardcoded value):
```hcl
variable "engine" {
  description = "DB engine. Default aurora-postgresql for real AWS; local Floci passes 'postgres' (Floci runs real postgres/mysql/mariadb containers, not Aurora)."
  type        = string
  default     = "aurora-postgresql"
}
```

- [ ] **Step 2: Use the variable in the cluster resource + make cluster instances conditional**

In `infra/modules/rds-aurora/main.tf`, change the hardcoded `engine = "aurora-postgresql"` line in `resource "aws_rds_cluster" "this"` to:
```hcl
  engine = var.engine
```
Leave `engine_version` as-is (its default `14.6` is valid for both; if Floci rejects it at apply, the stop point in R4 catches it).

**Also** (discovered during implementation): `aws_rds_cluster_instance` only accepts Aurora engines (`aurora-mysql`/`aurora-postgresql`), so `engine = "postgres"` breaks the writer/reader instances. Floci runs a real postgres container from the `aws_rds_cluster` alone and does NOT use Aurora-style instances. Make both instances conditional:
```hcl
resource "aws_rds_cluster_instance" "writer" {
  count = startswith(var.engine, "aurora") ? 1 : 0
  ...
}
resource "aws_rds_cluster_instance" "reader" {
  count = startswith(var.engine, "aurora") ? 1 : 0
  ...
}
```
This is safe: the `writer_endpoint`/`reader_endpoint` outputs already reference `aws_rds_cluster.this.endpoint`/`.reader_endpoint` (the CLUSTER, not the instances), so they don't break. For `aurora-postgresql` (prod) both instances create exactly as before; for `postgres` (Floci) neither is created.

- [ ] **Step 3: Pass Floci values from environments/local**

In `infra/environments/local/main.tf`, in the `module "rds_aurora"` block, add:
```hcl
  engine         = "postgres"
  instance_class = "db.t3.micro"
```

- [ ] **Step 4: fmt + validate + plan (gate, no apply)**

Run:
```bash
terraform -chdir=infra/environments/local fmt
terraform -chdir=infra/environments/local validate
terraform -chdir=infra/environments/local plan
```
Expected: validate Success; plan shows the rds_aurora cluster with `engine = "postgres"`, no errors. (Floci not needed for plan.)

- [ ] **Step 5: Commit** (propose via the A/B/C/D/E menu)

```
feat(infra): make rds-aurora engine switchable for Floci postgres (JE-36)
```

---

### Task R2: Cognito Floci compatibility (module cognito)

**Files:**
- Modify: `infra/modules/cognito/main.tf` (ignore_changes), `infra/modules/cognito/variables.tf` + `outputs.tf` (switchable issuer)
- Modify: `infra/environments/local/main.tf` (pass Floci issuer style)

**Writer:** `infra-impl`.

**Interfaces:**
- Produces: cognito client applies cleanly on Floci; `issuer` output is switchable per env.

- [ ] **Step 1: Add ignore_changes to the client**

In `infra/modules/cognito/main.tf`, add to `resource "aws_cognito_user_pool_client" "this"` a lifecycle block:
```hcl
  lifecycle {
    ignore_changes = [analytics_configuration]
  }
```
(Floci returns `AnalyticsConfiguration: {}` which the provider misreads as a changed block; the client is created and functional regardless.)

- [ ] **Step 2: Make the issuer switchable**

In `infra/modules/cognito/variables.tf`, add:
```hcl
variable "issuer_style" {
  description = "JWT issuer URL style. 'aws' → https://cognito-idp.<region>.amazonaws.com/<pool-id> (real AWS/Ministack). 'floci' → http://localhost:4566/<pool-id> (Floci local, per floci skill quirk #5)."
  type        = string
  default     = "aws"
  validation {
    condition     = contains(["aws", "floci"], var.issuer_style)
    error_message = "issuer_style must be 'aws' or 'floci'."
  }
}
```
In `infra/modules/cognito/outputs.tf`, change the `issuer` output value to select by style:
```hcl
  value = var.issuer_style == "floci" ? "http://localhost:4566/${aws_cognito_user_pool.this.id}" : "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.this.id}"
```
(Keep the existing description but note both styles.)

- [ ] **Step 3: Pass the Floci style from environments/local**

In `infra/environments/local/main.tf`, in the `module "cognito"` block, add:
```hcl
  issuer_style = "floci"
```

- [ ] **Step 4: fmt + validate + plan**

Run the same three commands as R1 Step 4. Expected: validate Success; plan clean; the api_gateway authorizer's `issuer` now resolves to the Floci-style URL. (The 200-vs-401 truth is validated at apply in R4 — the plan can't prove it.)

- [ ] **Step 5: Commit** (propose via the A/B/C/D/E menu)

```
feat(infra): cognito Floci compat — ignore analytics_configuration + switchable issuer (JE-36)
```

---

### Task R3: Least-privilege application DB user (module rds-aurora)

**Files:**
- Modify: `infra/modules/rds-aurora/terraform.tf` (or a new `providers.tf` in the module) — add `cyrilgdn/postgresql` to required_providers
- Modify: `infra/modules/rds-aurora/variables.tf` (add `manage_app_user`, `app_username`), `main.tf` (role + grants + secret)
- Modify: `infra/modules/rds-aurora/outputs.tf` (expose app-user secret ARN)
- Modify: `infra/environments/local/main.tf` (`manage_app_user = true`), `outputs.tf` (expose it)

**Writer:** `infra-impl`.

**Interfaces:**
- Consumes: the Postgres cluster from R1.
- Produces: an app DB user with `SELECT, INSERT, UPDATE` (NO DELETE) and its credentials in a secret; local exposes the secret so the migration/container use the app creds.

- [ ] **Step 1: Add the postgresql provider to required_providers**

In the rds-aurora module's terraform block (add `infra/modules/rds-aurora/terraform.tf` if absent, else edit it), add alongside `aws`:
```hcl
    postgresql = {
      source  = "cyrilgdn/postgresql"
      version = "~> 1.22"
    }
```

- [ ] **Step 2: Add the module variables**

In `infra/modules/rds-aurora/variables.tf`:
```hcl
variable "manage_app_user" {
  description = "Create a least-privilege application DB user (SELECT/INSERT/UPDATE, no DELETE) with credentials in Secrets Manager. Default off; envs opt in."
  type        = bool
  default     = false
}

variable "app_username" {
  description = "Name of the least-privilege application DB user."
  type        = string
  default     = "users_app"
}
```

- [ ] **Step 3: Create the role, grants, password, and secret (all gated by manage_app_user)**

In `infra/modules/rds-aurora/main.tf`, add (using `count = var.manage_app_user ? 1 : 0`):
```hcl
resource "random_password" "app_user" {
  count   = var.manage_app_user ? 1 : 0
  length  = 24
  special = false
}

resource "postgresql_role" "app_user" {
  count    = var.manage_app_user ? 1 : 0
  name     = var.app_username
  login    = true
  password = random_password.app_user[0].result
}

# CONNECT on the database
resource "postgresql_grant" "app_connect" {
  count       = var.manage_app_user ? 1 : 0
  role        = postgresql_role.app_user[0].name
  database    = var.database_name
  object_type = "database"
  privileges  = ["CONNECT"]
}

# USAGE on schema public
resource "postgresql_grant" "app_usage" {
  count       = var.manage_app_user ? 1 : 0
  role        = postgresql_role.app_user[0].name
  database    = var.database_name
  schema      = "public"
  object_type = "schema"
  privileges  = ["USAGE"]
}

# SELECT, INSERT, UPDATE (NO DELETE) on existing tables
resource "postgresql_grant" "app_tables" {
  count       = var.manage_app_user ? 1 : 0
  role        = postgresql_role.app_user[0].name
  database    = var.database_name
  schema      = "public"
  object_type = "table"
  objects     = [] # all tables in schema
  privileges  = ["SELECT", "INSERT", "UPDATE"]
}

# Default privileges so future tables inherit the same grants (no DELETE)
resource "postgresql_default_privileges" "app_future_tables" {
  count       = var.manage_app_user ? 1 : 0
  role        = postgresql_role.app_user[0].name
  database    = var.database_name
  schema      = "public"
  owner       = var.master_username
  object_type = "table"
  privileges  = ["SELECT", "INSERT", "UPDATE"]
}

resource "aws_secretsmanager_secret" "app_credentials" {
  count       = var.manage_app_user ? 1 : 0
  name        = "${var.context.id}/aurora/app-credentials"
  description = "Least-privilege app DB credentials for ${var.context.id}"
  tags        = merge(var.context.tags, { Name = "${var.context.id}-aurora-app-credentials" })
}

resource "aws_secretsmanager_secret_version" "app_credentials" {
  count     = var.manage_app_user ? 1 : 0
  secret_id = aws_secretsmanager_secret.app_credentials[0].id
  secret_string = jsonencode({
    username = var.app_username
    password = random_password.app_user[0].result
    host     = aws_rds_cluster.this.endpoint
    port     = aws_rds_cluster.this.port
    dbname   = var.database_name
  })
}
```

- [ ] **Step 4: Expose the app-user secret from the module and the env**

In `infra/modules/rds-aurora/outputs.tf`:
```hcl
output "app_secret_arn" {
  description = "ARN of the least-privilege app-user credentials secret (null if not managed)."
  value       = var.manage_app_user ? aws_secretsmanager_secret.app_credentials[0].arn : null
}
```
In `infra/environments/local/main.tf`, set `manage_app_user = true` in the `module "rds_aurora"` block. In `infra/environments/local/outputs.tf`, add:
```hcl
output "app_secret_arn" {
  value = module.rds_aurora.app_secret_arn
}
```

- [ ] **Step 5: Configure the postgresql provider in environments/local**

The `postgresql` provider needs connection details for the running cluster. In `infra/environments/local/providers.tf` (or main.tf), add a `provider "postgresql"` block pointing at the cluster. Because Floci's proxy port is only known post-creation, this is the ordering unknown — see R4's validation. Initial attempt:
```hcl
provider "postgresql" {
  host      = "localhost"
  port      = 4566          # placeholder; R4 discovers the real proxy port and reconciles
  username  = var.db_username
  password  = var.db_password
  database  = var.db_name
  sslmode   = "disable"
  superuser = false
}
```
Then `terraform -chdir=infra/environments/local init` (to install the postgresql provider) and `... validate`. Do NOT apply here — R4 handles apply + the ordering decision.

- [ ] **Step 6: Commit** (propose via the A/B/C/D/E menu)

```
feat(infra): least-privilege app DB user (SELECT/INSERT/UPDATE, no DELETE) + secret (JE-36)
```

---

### Task R4: Apply on Floci, discover endpoint, app user, migrate, validate (honest stop points)

This REPLACES the original Task 3. It uses the adapted modules (R1–R3) + the `bootstrap.sh`
already written. It carries the same stop-point discipline: STOP and report rather than fake.

**Files:** none new (bootstrap.sh already exists from the earlier Task 3 work).

**Writer:** main session (a real apply with live decisions — not delegated).

- [ ] **Step 1: Bring the stack up**

```bash
make up
docker compose ps        # floci + users Up
curl -sf http://localhost:3000/v1/health   # {"status":"ok"} — app is fine locally
```

- [ ] **Step 2: Apply the AWS resources first (defer the postgresql provider)**

The postgresql provider can't connect until the cluster exists and its proxy port is known.
Apply the AWS-side resources first with `-target`, EXCLUDING the postgresql_* resources:
```bash
terraform -chdir=infra/environments/local apply \
  -target=module.networking -target=module.rds_aurora.aws_rds_cluster.this \
  -target=module.rds_aurora.aws_rds_cluster_instance.writer \
  -target=module.rds_aurora.aws_rds_cluster_instance.reader
```
**STOP POINT (Aurora/Postgres on Floci):** if the cluster still fails to create with
`engine=postgres`, STOP and report the exact error — do NOT fake it. This is the primary risk.

- [ ] **Step 3: Discover the real DB endpoint (Floci proxy port)**

```bash
aws --endpoint-url http://localhost:4566 rds describe-db-instances \
  --query 'DBInstances[].Endpoint' --output json
```
Record the real `Address:Port` Floci assigned (proxy range 7000-7099). This is the connectable
endpoint — NOT the Terraform `writer_endpoint` (AWS-format hostname).

- [ ] **Step 4: Reconcile the postgresql provider port, then apply the app user**

Update `provider "postgresql"` in environments/local with the discovered host/port from Step 3,
then apply the postgresql_* + remaining resources:
```bash
terraform -chdir=infra/environments/local apply
```
**STOP POINT (provider connect):** if the postgresql provider cannot connect even with the
discovered endpoint, STOP and report — do NOT silently drop the app-user requirement. (Two-step
split is already in effect; if it still fails, it's a genuine blocker to surface.)

- [ ] **Step 5: Verify the app user has the right grants (NO DELETE)**

Connect as master (discovered endpoint) and check:
```bash
# psql against the discovered host:port, db=users, user=<master>
# \du  and:
SELECT grantee, privilege_type FROM information_schema.role_table_grants
  WHERE grantee = 'users_app' ORDER BY privilege_type;
```
Expected: rows for `SELECT`, `INSERT`, `UPDATE` — and **NO `DELETE`**. If DELETE appears, the
grant is wrong — fix R3 and re-apply.

- [ ] **Step 6: Migrate using the APP user credentials (from the secret)**

Read the app secret, build the DATABASE_URL with the discovered endpoint + app creds, migrate:
```bash
APPSECRET=$(terraform -chdir=infra/environments/local output -raw app_secret_arn)
# fetch the secret JSON via: aws --endpoint-url http://localhost:4566 secretsmanager get-secret-value --secret-id "$APPSECRET"
# build DATABASE_URL=postgres://users_app:<pw>@<discovered-host>:<port>/users
DATABASE_URL="postgres://users_app:<pw>@<host>:<port>/users" \
  pnpm --filter @3mrai/users prisma migrate deploy
```
**STOP POINT (migration):** if migrate fails against the discovered endpoint / app creds, STOP
and report — do NOT fake success. (Note: `prisma migrate deploy` needs CREATE on the schema for
the migration itself — if the least-privilege app user lacks DDL rights, run the migration as the
MASTER user and let the app user only do runtime DML. Decide from the real error; document which
user ran the migration.)

- [ ] **Step 7: Attach nginx-stable alias + acceptance (health through gateway)**

```bash
infra/environments/local/bootstrap.sh          # attach nginx-stable
API=$(terraform -chdir=infra/environments/local output -raw api_invoke_url)
curl -sf -o /dev/null -w "%{http_code}\n" "${API}/v1/health"
```
Expected: `200` (JE-36 acceptance). Do NOT claim pass without the 200.

- [ ] **Step 8: Validate the issuer style empirically (200 vs 401 on a protected route)**

Get a token (register+login a user through the gateway or via cognito), then hit a PROTECTED
route (e.g. `GET /v1/users/me` with the Bearer token). If 200 → the Floci issuer style is
correct. If 401 → the issuer style is wrong; flip `issuer_style` (aws↔floci) in R2, re-apply the
api-gateway/cognito, and re-test. Record which style actually worked (this settles the
module-vs-skill contradiction with real evidence).

- [ ] **Step 9: Commit** (propose via the A/B/C/D/E menu)

```
feat(infra): apply Users chain on Floci — app user, migrate, health 200 (JE-36)
```

---

### Task 3 (ORIGINAL — SUPERSEDED by R4 above; kept for reference)

**Files:**
- Create: `infra/environments/local/bootstrap.sh`

**Writer:** main session.

**Interfaces:**
- Consumes: the Task 2 composition + outputs; a running Floci (`make up`).
- Produces: a running local stack and the migrated `users` table; proves the acceptance criterion.

- [ ] **Step 1: Adapt the stable-DNS bootstrap script**

Create `infra/environments/local/bootstrap.sh` from `spike-floci/bootstrap.sh` (attach the `nginx-stable` Docker network alias to the running nginx ECS container; idempotent). Keep it byte-faithful except any spike-only paths. Confirm it uses network `3mrai_3mrai-network` and alias `nginx-stable` (matching the `http://nginx-stable/` integration URI in Task 2). Make it executable:
```bash
chmod +x infra/environments/local/bootstrap.sh
```

- [ ] **Step 2: Bring Floci + users up**

Run:
```bash
make up
docker compose ps
```
Expected: `floci` and `users` are Up. (users health locally: `curl -sf http://localhost:3000/v1/health` → `{"status":"ok"}` — proves the app itself is fine before we route through the gateway.)

- [ ] **Step 3: terraform apply against Floci**

Run:
```bash
terraform -chdir=infra/environments/local apply
```
Review the plan, approve. Expected: apply completes with no errors and prints the outputs (`api_invoke_url`, `db_writer_endpoint`, etc.).

**STOP POINT (rds-aurora on Floci):** If apply fails inside the `rds_aurora` module (Floci can't create/emulate the Aurora Postgres cluster), STOP. Do NOT comment out the module to force a green apply. Report the exact error and surface the fallback decision (use the compose Postgres for the migration, or a Floci RDS workaround) to the user. This is the spec's highest-risk unknown.

- [ ] **Step 4: Attach the nginx-stable alias**

Run:
```bash
infra/environments/local/bootstrap.sh
```
Expected: the alias `nginx-stable` is attached to the running nginx ECS container (idempotent output). Now `http://nginx-stable/` resolves from Floci's API Gateway container.

- [ ] **Step 5: Run the Prisma migration against the writer endpoint**

Get the writer endpoint and run the migration:
```bash
WRITER=$(terraform -chdir=infra/environments/local output -raw db_writer_endpoint)
echo "writer: $WRITER"
DATABASE_URL="postgres://test:test@${WRITER}/users" nvm use && \
  DATABASE_URL="postgres://test:test@${WRITER}/users" pnpm --filter @3mrai/users prisma migrate deploy
```
Expected: "migration(s) applied" and the `users` table (with `tags` column) created.

**STOP POINT (migration):** If the writer endpoint isn't connectable or `migrate deploy` fails against Floci's RDS emulation, STOP and report — do NOT fake success. (This is the same risk surfaced in Step 3.)

- [ ] **Step 6: Acceptance — GET /v1/health through API Gateway → 200**

Run:
```bash
API=$(terraform -chdir=infra/environments/local output -raw api_invoke_url)
echo "api: $API"
curl -sf -o /dev/null -w "%{http_code}\n" "${API}/v1/health"
```
Expected: `200`. This is the JE-36 acceptance criterion (health through the gateway → nginx-stable → users). If it's not 200, debug the chain (alias attached? nginx task running? integration URI correct?) — do NOT claim pass without the 200.

- [ ] **Step 7: Commit** (propose via the A/B/C/D/E menu)

Proposed message:
```
feat(infra): nginx-stable bootstrap + apply Users chain on Floci (JE-36)
```

---

### Task 4: Wire the flow into the Makefile

**Files:**
- Modify: `Makefile`

**Writer:** main session.

**Interfaces:**
- Consumes: Task 1–3 (the environments/local dir, bootstrap.sh, outputs).
- Produces: `infra-*` targeting environments/local, a `db-migrate` target, an extended `bootstrap`.

- [ ] **Step 1: Repoint the Terraform dir and add targets**

In `Makefile`, change `TF_LOCAL_DIR` from `spike-floci` to the real compose:
```makefile
TF_LOCAL_DIR := infra/environments/local
```
Add a `db-migrate` target and a `nginx-alias` target, and extend `bootstrap`. Add them to `.PHONY`:
```makefile
nginx-alias: ## Attach the stable nginx-stable Docker DNS alias (run after apply)
	infra/environments/local/bootstrap.sh

db-migrate: ## Run Prisma migrate deploy against the Terraform writer endpoint
	@WRITER=$$($(TF) output -raw db_writer_endpoint); \
		echo "writer: $$WRITER"; \
		DATABASE_URL="postgres://test:test@$$WRITER/users" pnpm --filter @3mrai/users prisma migrate deploy
```
Update the `bootstrap` recipe to run the full chain after Floci is up:
```makefile
bootstrap: up ## Bring everything up: compose, Floci, apply infra, alias, migrate
	@echo "Waiting for Floci at $(FLOCI_URL) ..."
	@for i in $$(seq 1 30); do \
		if curl -sf -o /dev/null "$(FLOCI_URL)"; then echo "Floci is up."; break; fi; \
		if [ $$i -eq 30 ]; then echo "Floci did not become ready in time." >&2; exit 1; fi; \
		sleep 1; \
	done
	$(MAKE) infra-init
	$(MAKE) infra-up
	$(MAKE) nginx-alias
	$(MAKE) db-migrate
```

- [ ] **Step 2: Verify make targets resolve**

Run:
```bash
make            # help lists db-migrate, nginx-alias
make -n bootstrap   # shows apply → nginx-alias → db-migrate chain
make -n db-migrate  # shows the terraform output + prisma migrate line
```
Expected: `help` lists the new targets; dry-runs resolve `$(TF)` to `terraform -chdir=infra/environments/local` and show the chain. Nothing executes.

- [ ] **Step 3: Commit** (propose via the A/B/C/D/E menu)

Proposed message:
```
build(infra): Makefile targets for environments/local apply + migrate (JE-36)
```

---

### Task 5: Ministack → Floci text sync (docs + Linear)

**Files:**
- Modify: `docs/plans/users-service-milestone.md` (JE-36 wording) — `obsidian-vault`
- Modify: JE-36 title/description in Linear — `linear-pm` (user confirms)

- [ ] **Step 1: Dispatch `obsidian-vault` to update the milestone plan**

In `docs/plans/users-service-milestone.md`, update the JE-36 references from "Ministack" to "Floci" (the Apply phase row and the JE-36 task-sequence row). Keep everything else; only the emulator name/wording changes. Reference [[ADR-0017-floci-local]] where appropriate. Then run `nvm use && node scripts/validate-vault.mjs` (must PASS).

- [ ] **Step 2: Dispatch `linear-pm` to PROPOSE the JE-36 text update**

Have `linear-pm` propose (NOT execute) updating JE-36's title and description: replace "Ministack" with "Floci", and note the `environments/local` composition applies against Floci per [[ADR-0017-floci-local]]. Present the proposed new title/description to the user; execute the Linear write ONLY after explicit user confirmation (repo rule).

- [ ] **Step 3: Commit the doc change** (propose via the A/B/C/D/E menu)

Proposed message:
```
docs(vault): sync JE-36 milestone wording Ministack→Floci
```
(The Linear update is not a git commit; it's a separate confirmed write.)

---

### Task 6: Final validation and integration handoff

**Files:** none (verification only).

- [ ] **Step 1: Terraform + vault validation**

Run:
```bash
terraform -chdir=infra/environments/local validate
nvm use && node scripts/validate-vault.mjs
```
Expected: TF valid; vault PASS.

- [ ] **Step 2: Re-confirm the acceptance criterion is demonstrably met**

Confirm from Task 3's evidence that `curl <api_invoke_url>/v1/health` returned **200** and the migration created the `users` table. If either was blocked by the Floci/RDS stop point, the handoff must SAY SO — do not report JE-36 done if the acceptance criterion wasn't actually met.

- [ ] **Step 3: Scope check**

Run:
```bash
git status --porcelain
```
Expected: only `infra/environments/local/*` (new), `Makefile` (M), `docs/plans/users-service-milestone.md` (M), and the spec/plan under `docs/superpowers/`. No module rewrites, no `spike*/` changes, no service source.

- [ ] **Step 4: Integration handoff**

Branch `feat/JE-36-local-env-compose` off `feature/users-service`. Propose (via the A/B/C/D/E menu) one PR into `feature/users-service` with a `## References` section (spec, plan, JE-36 linked, [[local-dev]]). After merge, `linear-pm` moves JE-36 → Done (user confirms). Do NOT open/merge unprompted.

Proposed PR title:
```
feat(infra): compose environments/local + apply Users chain on Floci (JE-36)
```

---

## Self-Review

**Spec coverage:**
- *Compose 6 modules in environments/local* → Tasks 1 (scaffold) + 2 (main/outputs).
- *nginx → real users (:3000)* → Task 2 (`backend_service_name="users"`, `backend_port=3000`).
- *terraform apply on Floci* → Task 3 Step 3 (+ stop point).
- *stable nginx DNS alias* → Task 3 Steps 1,4 (bootstrap.sh).
- *prisma migrate deploy* → Task 3 Step 5 (+ stop point).
- *GET /v1/health → 200 via API GW* → Task 3 Step 6 (acceptance).
- *Makefile orchestration (db-migrate, bootstrap)* → Task 4.
- *Ministack→Floci text sync (Linear + vault)* → Task 5.
- *Honest stop points (Aurora on Floci)* → Task 3 Steps 3 & 5, Task 6 Step 2.
- *Write ownership* → per-task Writer lines; docs → obsidian-vault, Linear → linear-pm, TF/Makefile → main session.
- *Non-goals (no module rewrites, no JE-37/38, no spike edits, archive old branch)* → Global Constraints + Task 6 scope check.

No gaps.

**Placeholder scan:** No TBD/TODO. Every TF block is concrete with verified output/input names. The two "confirm in Task 2/reconcile" steps (secretsmanager endpoint, required-var reconcile) are explicit verification steps with commands, not deferred hand-waving.

**Type/name consistency:** Module output names used in wiring (`module.networking.security_group_ids`, `module.cognito.issuer`/`.client_id`, `module.api_gateway.invoke_url`, `module.rds_aurora.writer_endpoint`) match the verified `outputs.tf`. `context = {id, tags}` object shape matches every module's `context` variable. `nginx-stable` alias in bootstrap matches `http://nginx-stable/` in Task 2 and `nginx-alias` Makefile target in Task 4. `db_writer_endpoint` output name is identical in Task 2, Task 3 Step 5, and Task 4 db-migrate.

## Related

- [[2026-07-04-je36-local-env-compose-design]]
- [[users-service-milestone]]
- [[ADR-0017-floci-local]]
- [[local-dev]]
