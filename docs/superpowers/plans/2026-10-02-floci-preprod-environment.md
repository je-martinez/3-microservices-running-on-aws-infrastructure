---
title: "Floci Pre-Production Environment Implementation Plan"
type: plan
area: infra
status: accepted
created: 2026-10-02
updated: 2026-10-03
tags:
  - type/plan
  - area/infra
  - status/accepted
propagates-to:
  - "[[local-dev-floci]]"
  - "[[local-dev]]"
  - "[[aws-resources]]"
  - "[[terraform-modules]]"
  - "[[env-files]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[2026-10-02-floci-preprod-environment-design]]"
  - "[[ADR-0022-preprod-ecs-on-floci]]"
  - "[[environment-exclusivity]]"
  - "[[preprod]]"
  - "[[2026-10-03-floci-preprod-alb-and-ecs-behaviours]]"
related:
  - "[[2026-10-02-floci-preprod-environment-design]]"
  - "[[2026-10-02-dev-stack-floci-2-1]]"
  - "[[local-dev-floci]]"
  - "[[local-dev]]"
  - "[[aws-resources]]"
  - "[[terraform-modules]]"
  - "[[env-files]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
---

# Floci Pre-Production Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `make preprod-up` environment whose only compose image is Floci 2.1.0, running users/orders/tracking/web/otel-collector/openobserve/mailpit as ECS services pulled from Floci's ECR, configured exclusively from SSM Parameter Store and Secrets Manager, reached through API Gateway → ALB with no nginx.

**Architecture:** A new Terraform root `infra/environments/preprod` (local state) reuses the existing data-plane modules and adds `ecr`, `app-config`, `alb` and `ecs-service`. A host-side Makefile drives everything: exclusivity guard → Floci → apply (data plane, `deploy_services=false`) → build and push images → apply (`deploy_services=true`) → migrations → aliases → smoke. Each service owns its own ALB listener port; API Gateway integrates per route with `request_parameters` doing what the nginx task did.

**Tech Stack:** Floci 2.1.0, Terraform (AWS provider `= 5.31.0`, `hashicorp/random`), Python 3.11 (`lib3mrai`, boto3, pytest), Docker, GNU Make, Playwright, Gatling JS.

**Spec:** `docs/superpowers/specs/2026-10-02-floci-preprod-environment-design.md`

**Prerequisite:** `docs/superpowers/plans/2026-10-02-dev-stack-floci-2-1.md` merged (Floci 2.1.0, `stop_signal: SIGKILL`, `floci_heal.py`, `doctor.backing_state`).

## Spec amendments this plan makes (route back to the spec in Task 17)

1. **One ALB listener per service instead of path rules on `:9091`.** Services also call each other over HTTP (`ORDERS_BASE_URL`, `TRACKING_BASE_URL`, cascade and cache-invalidation endpoints) on paths outside the gateway's route map; a dedicated port per service needs no rule maintenance. Ports: users `9101`, orders `9102`, tracking `9103`, users-gRPC `9151` (if Task 9 passes), web `9090`, OpenObserve `5080`, Mailpit UI `8025`, OTLP `4318`/`4319`. `9101-9103` are published to the host so the existing E2E global-setup and internal layer reach them.
2. **Public routes strip `x-user-id`.** Verified on 2.1.0: `overwrite:header.x-user-id = $context.authorizer.claims.sub` on a route WITHOUT the authorizer leaves a client-sent value intact (`SPOOFED` passed through); `remove:header.x-user-id` removes it. Auth routes overwrite, public routes remove.
3. **Local Terraform state** for the pre-prod root (no S3 backend bucket inside a disposable emulator).
4. **RDS proxy ports from `data "aws_rds_cluster"`** (same API `discover_port` reads), not from a discovery script.
5. `O2_ENDPOINT` (collector → OpenObserve) and `OTLP_RUM_UPSTREAM` (web `/otlp/` → collector) become env-configured; dev keeps today's values as defaults.

## Execution notes (as built)

Rulings made during execution that changed tasks as written; the spec carries the amended
decisions in [[2026-10-02-floci-preprod-environment-design]] (section "Spec amendments (as built)"):

- **Healthcheck:** Task 2's compose healthcheck is `GET /_floci/health HTTP/1.1` with `Host`
  (the text above is already amended).
- **Task 8:** `preprod-up` builds only the images that exist so far (`PP_IMAGES`), extended by
  Tasks 12-14.
- **Task 9:** gRPC goes through the `users-grpc` alias, not the ALB; the `preprod-aliases` target
  moved into Task 10.
- **Task 10 and 14:** rollout criterion relaxed to the measured ~1-2 s of `503`; wait logic counts
  only RUNNING tasks; stale ALB targets are deregistered (`preprod_targets.py`).
- **Task 15:** Users accepts an empty body without `Content-Type`; the collector drops the
  platform's own log groups; the full Gatling load is a known local capacity limit and the smoke
  run is the load criterion.
- **Final review fixes:** `preprod-down` refuses while dev runs (`env_guard.py --check-other`) and
  removes the `.terraform-*` directories; heal and targets treat a task as dead only when
  STOPPED; `ENV_ONLY=1` applies `module.app_config` before forcing the deployment; `preprod-up`
  refuses on a live environment (`preprod_live.py`); `build_push.py` skips a tag already in ECR;
  the E2E runner exports `WEBHOOK_SECRET` and `EVENTS_QUEUE_URL`.
- **Tasks 11-13:** the dev-regression checks ran as static validation (`terraform validate`,
  `otelcol-contrib validate`, rendered nginx and compose config) because dev was down.

Operational detail: [[preprod]]; decision: [[ADR-0022-preprod-ecs-on-floci]]; Floci behaviours:
[[2026-10-03-floci-preprod-alb-and-ecs-behaviours]]; exclusivity: [[environment-exclusivity]].

## Global Constraints

- Floci image `floci/floci:2.1.0`, `stop_signal: SIGKILL`, `FLOCI_STORAGE_MODE=persistent`.
- Compose project `3mrai-preprod`, network `3mrai-preprod_preprod-network`; Floci must own host port `4566` (ECR URIs are always `…localhost:4566`).
- Dev and pre-prod are mutually exclusive; starting one while the other runs prompts *drop the other / do nothing*; without a TTY it aborts.
- AWS provider `= 5.31.0`; every service the root touches has an `endpoints {}` entry.
- Image tags are immutable: `<git-sha>` or `<git-sha>-dirty-<epoch-seconds>`; never `latest`.
- Service configuration only via SSM (`/3mrai-preprod/<svc>/<VAR>`) and Secrets Manager (`3mrai-preprod/<svc>/<VAR>`); no `.env.local.*` file is read by any pre-prod workload.
- Stripe stays disabled in pre-prod (`STRIPE_ENABLED=false`, `NG_APP_STRIPE_ENABLED=false`); geocoding disabled (`NG_APP_GEOCODE_ENABLED=false`).
- Python scripts run as `$(PY)` (`.venv/bin/python`), use `lib3mrai.aws.client` and `lib3mrai.console`; tests under `infra/scripts/tests/` or `infra/environments/preprod/scripts/tests/` (add the latter to `testpaths` in `infra/scripts/pyproject.toml`).
- Comment tags/tense per [[code-comments]]; `make lint-comments` green. `nvm use` before Node; pnpm only.
- Implementers never run git writes; vault writes only through `obsidian-vault`.

## Review Focus

1. **No TTY while the other environment runs** (CI, an agent, a piped `make`) — the guard must abort with a message, never default to dropping. Pinned in Task 1: `test_no_tty_aborts_without_dropping`.
2. **Client-forged `x-user-id` on a public route** — must not reach the service. Pinned in Task 11: the spoof check in Step 6.
3. **Two dirty redeploys within the same second/minute** — must still produce distinct tags, or ECS keeps the old code while reporting success. Pinned in Task 7: `test_dirty_tags_differ_across_seconds` plus the content-hash suffix.
4. **A task self-heals mid-test and loses its alias** (`mailpit`, possibly `users-grpc`) — email specs then fail as "no mail". `preprod-doctor` must report a missing alias; `preprod-heal` re-applies it. Pinned in Task 14: `test_alias_missing_is_reported`.
5. **Redeploy of one service must not touch the others** — a full apply would also re-tag the gateway stage (quirk 9 risk). Pinned in Task 10 Step 4: `preprod-deploy` targets only `module.service["<svc>"]` and the verification counts `0 changed` for every other module.

---

## Phase F1 — Skeleton

### Task 1: Environment exclusivity guard

**Files:**
- Create: `infra/scripts/env_guard.py`
- Create: `infra/scripts/tests/test_env_guard.py`
- Modify: `Makefile` — first step of `up` (L137), `bootstrap` (L487), `bootstrap-provision` (L546)

**Interfaces:**
- Produces: `ENVIRONMENTS = {"dev": ("3mrai", "clean"), "preprod": ("3mrai-preprod", "preprod-down")}`; `running(project, run=docker) -> bool`; `guard(target: str, *, run=docker, ask=input, isatty=sys.stdin.isatty, make=run_make) -> int` (0 = proceed, 1 = abort); CLI `env_guard.py <dev|preprod>`.

- [x] **Step 1: Write the failing tests**

```python
"""Tests for env_guard.py — dev and pre-prod never run at the same time."""

import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "env_guard.py"
sys.path.insert(0, str(SCRIPT.parent))
_spec = importlib.util.spec_from_file_location("env_guard", SCRIPT)
guard_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard_mod)


def docker_with(running_project):
    def run(*args):
        label = next(a for a in args if a.startswith("label="))
        return "abc123\n" if label.endswith(f"={running_project}") else ""
    return run


def test_proceeds_when_other_is_down():
    made = []
    rc = guard_mod.guard("preprod", run=docker_with(None), ask=lambda _: "d",
                         isatty=lambda: True, make=made.append)
    assert rc == 0 and made == []


def test_drop_tears_down_the_other_then_proceeds():
    made = []
    rc = guard_mod.guard("preprod", run=docker_with("3mrai"), ask=lambda _: "d",
                         isatty=lambda: True, make=made.append)
    assert rc == 0 and made == ["clean"]


def test_nothing_aborts():
    made = []
    rc = guard_mod.guard("dev", run=docker_with("3mrai-preprod"), ask=lambda _: "n",
                         isatty=lambda: True, make=made.append)
    assert rc == 1 and made == []


def test_no_tty_aborts_without_dropping():
    made = []
    rc = guard_mod.guard("preprod", run=docker_with("3mrai"),
                         ask=lambda _: (_ for _ in ()).throw(AssertionError("asked")),
                         isatty=lambda: False, make=made.append)
    assert rc == 1 and made == []


def test_project_match_is_exact():
    # "3mrai" must not match the "3mrai-preprod" project label.
    assert guard_mod.running("3mrai", run=docker_with("3mrai-preprod")) is False
```

- [x] **Step 2: Run to verify failure**

Run: `.venv/bin/python -m pytest infra/scripts/tests/test_env_guard.py -v`
Expected: FAIL (`env_guard.py` missing).

- [x] **Step 3: Implement**

```python
"""Refuse to start one local environment while the other one runs.

CONTRACT: Dev and pre-prod both need host port 4566 and the fixed-name
`floci-ecr-registry` container; ECR URIs always point at :4566, so with both up
the daemon pulls images from the WRONG Floci (observed: NoSuchBucket on pull).
Without a TTY this aborts — it never drops an environment nobody confirmed.
See [[environment-exclusivity]]
"""

from __future__ import annotations

import subprocess
import sys

from lib3mrai.console import inf, no, ok

ENVIRONMENTS = {"dev": ("3mrai", "clean"), "preprod": ("3mrai-preprod", "preprod-down")}


def docker(*args: str) -> str:
    return subprocess.run(["docker", *args], capture_output=True, text=True).stdout


def run_make(target: str) -> None:
    subprocess.run(["make", "--no-print-directory", target], check=True)


def running(project: str, run=docker) -> bool:
    out = run("ps", "-q", "--filter", f"label=com.docker.compose.project={project}")
    return bool(out.strip())


def guard(target: str, *, run=docker, ask=input, isatty=sys.stdin.isatty, make=run_make) -> int:
    other = next(name for name in ENVIRONMENTS if name != target)
    project, teardown = ENVIRONMENTS[other]
    if not running(project, run):
        return 0
    if not isatty():
        no(f"{other} is running; refusing to start {target} without a TTY to confirm.")
        inf(f"    run `make {teardown}` first, then retry")
        return 1
    answer = ask(f"{other} is running. [d]rop {other} and start {target}, or do [n]othing? ")
    if answer.strip().lower().startswith("d"):
        make(teardown)
        ok(f"{other} dropped")
        return 0
    inf(f"    nothing done; {other} left running")
    return 1


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ENVIRONMENTS:
        no("usage: env_guard.py <dev|preprod>")
        sys.exit(2)
    sys.exit(guard(sys.argv[1]))
```

- [x] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest infra/scripts/tests/test_env_guard.py -v` → 5 passed.

- [x] **Step 5: Wire the dev side**

Add as the FIRST recipe line of `up`, `bootstrap` and `bootstrap-provision` (after their `scripts-setup` prerequisite; add `scripts-setup` to `up`'s prerequisites):

```make
	@$(PY) infra/scripts/env_guard.py dev
```

- [x] **Step 6: Hand over for commit** — `feat(infra): refuse to run dev and pre-prod at the same time`

---

### Task 2: Compose file, Terraform root skeleton, `preprod-down`

**Files:**
- Create: `docker-compose.preprod.yml`
- Create: `infra/environments/preprod/{terraform.tf,providers.tf,variables.tf,main.tf,outputs.tf}`
- Create: `infra/environments/preprod/.gitignore`
- Modify: `Makefile` (new `## ── Pre-production ──` section at the end)
- Modify: `infra/scripts/lib3mrai/db.py` (network from env)
- Test: `infra/scripts/tests/test_db_network.py`

**Interfaces:**
- Produces: Make variables `PP_COMPOSE`, `PP_TF`, `PP_NETWORK`; targets `preprod-floci-up`, `preprod-down`; `lib3mrai.db.compose_network() -> str` (reads `FLOCI_NETWORK`, default `3mrai_3mrai-network`); root outputs `vpc_id`, `subnet_ids`, `security_group_ids`.

- [x] **Step 1: Failing test for the network parameter**

```python
from lib3mrai import db


def test_default_network_is_dev(monkeypatch):
    monkeypatch.delenv("FLOCI_NETWORK", raising=False)
    assert db.compose_network() == "3mrai_3mrai-network"


def test_network_from_env(monkeypatch):
    monkeypatch.setenv("FLOCI_NETWORK", "3mrai-preprod_preprod-network")
    assert db.compose_network() == "3mrai-preprod_preprod-network"
    assert "3mrai-preprod_preprod-network" in db._probe_command("postgres", "floci", 7001)
```

Run: `.venv/bin/python -m pytest infra/scripts/tests/test_db_network.py -v` → FAIL.

- [x] **Step 2: Implement in `lib3mrai/db.py`**

Replace the `COMPOSE_NETWORK = "3mrai_3mrai-network"` constant and its uses:

```python
import os

DEFAULT_NETWORK = "3mrai_3mrai-network"
# Kept for importers that read the dev network name directly (doctor.py).
COMPOSE_NETWORK = DEFAULT_NETWORK


def compose_network() -> str:
    """The Floci compose network; pre-prod exports FLOCI_NETWORK."""
    return os.environ.get("FLOCI_NETWORK", DEFAULT_NETWORK)
```

In `_probe_command`, replace both `COMPOSE_NETWORK` with `compose_network()`. Re-run → 2 passed.

- [x] **Step 3: `docker-compose.preprod.yml`**

```yaml
# Pre-production: Floci is the ONLY image. Every workload runs inside it as an
# ECS service pulled from Floci's ECR. See [[2026-10-02-floci-preprod-environment-design]]
name: 3mrai-preprod

networks:
  preprod-network:
    driver: bridge

volumes:
  floci-state:

services:
  floci:
    image: floci/floci:2.1.0
    # CONTRACT: SIGKILL — Floci's graceful shutdown deletes its DocumentDB and
    # ElastiCache containers. See [[floci-recreate-destroys-backing-containers]]
    stop_signal: SIGKILL
    ports:
      - "4566:4566"            # AWS APIs + ECR (ECR URIs are always :4566)
      - "9090:9090"            # ALB → web
      - "9101-9103:9101-9103"  # ALB → users / orders / tracking (E2E internal layer)
      - "5080:5080"            # ALB → OpenObserve UI
      - "8025:8025"            # ALB → Mailpit UI + API
    environment:
      - FLOCI_SERVICES_DOCKER_NETWORK=3mrai-preprod_preprod-network
      - FLOCI_SERVICES_ECS_DOCKER_NETWORK=3mrai-preprod_preprod-network
      - FLOCI_STORAGE_MODE=persistent
      - FLOCI_STORAGE_PERSISTENT_PATH=/app/data
      # WHY: `mailpit` is a Docker alias on the Mailpit ECS task (preprod_aliases.py).
      - FLOCI_SERVICES_SES_SMTP_HOST=mailpit
      - FLOCI_SERVICES_SES_SMTP_PORT=1025
    volumes:
      - floci-state:/app/data
      - /var/run/docker.sock:/var/run/docker.sock
    networks: [preprod-network]
    healthcheck:
      test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/4566 && printf 'GET /_floci/health HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3 && read -r status <&3 && [[ $$status == *' 200 '* ]]"]
      interval: 10s
      timeout: 3s
      retries: 5
```

- [x] **Step 4: Terraform root skeleton**

`infra/environments/preprod/terraform.tf`:

```hcl
terraform {
  required_version = ">= 1.7"
  # WHY: Local state — the emulator dies with every preprod-down, so a backend
  # bucket inside it would only add a bootstrap step.
  backend "local" {}
  required_providers {
    aws    = { source = "hashicorp/aws", version = "= 5.31.0" }
    local  = { source = "hashicorp/local" }
    random = { source = "hashicorp/random" }
  }
}
```

`providers.tf` — copy `infra/environments/local/providers.tf` verbatim, then make the `endpoints {}` block contain exactly: `apigateway, apigatewayv2, cloudwatch, cognitoidp, dynamodb, ec2, ecr, ecs, elasticache, elbv2, events, iam, lambda, logs, rds, route53, s3, secretsmanager, servicediscovery, ses, sns, sqs, ssm, sts`, each `= "http://localhost:4566"`.

`variables.tf`:

```hcl
variable "environment" {
  type    = string
  default = "preprod"
}

variable "vpc_cidr" {
  type    = string
  default = "10.1.0.0/16"
}

variable "db_username" {
  type    = string
  default = "test"
}

variable "db_password" {
  type      = string
  default   = "test"
  sensitive = true
}

variable "docdb_password" {
  type      = string
  default   = "test"
  sensitive = true
}

variable "ses_from_address" {
  type    = string
  default = "no-reply@3mrai.local"
}

variable "python_bin" {
  type        = string
  description = "Absolute path to the repo venv python (Makefile passes $(PY))."
}

variable "deploy_services" {
  type        = bool
  default     = false
  description = "false = data plane only (apply A); true = ECS services, ALB listeners, gateway (apply B)."
}

variable "image_tags" {
  type        = map(string)
  default     = {}
  description = "service -> immutable tag, written by build_push.py to image-tags.auto.tfvars.json."
}

variable "users_grpc_via_alb" {
  type        = bool
  default     = true
  description = "Task 9 decides: true = USERS_GRPC_URL through ALB :9151, false = Docker alias users-grpc:50051."
}
```

`main.tf` (skeleton; later tasks append):

```hcl
locals {
  region  = "us-east-1"
  network = "3mrai-preprod_preprod-network"
}

module "label_net" {
  source      = "../../modules/label"
  environment = var.environment
  name        = "net"
}

module "networking" {
  source   = "../../modules/networking"
  context  = { id = module.label_net.id, tags = module.label_net.tags }
  vpc_cidr = var.vpc_cidr
}
```

`outputs.tf`:

```hcl
output "vpc_id" { value = module.networking.vpc_id }
output "subnet_ids" { value = module.networking.subnet_ids }
output "security_group_ids" { value = module.networking.security_group_ids }
```

`.gitignore`:

```
.terraform/
terraform.tfstate
terraform.tfstate.backup
image-tags.auto.tfvars.json
.state/
```

- [x] **Step 5: Makefile section**

Append:

```make
## ── Pre-production (Floci-only, see docs/infrastructure/runbooks/preprod.md) ──
PP_COMPOSE := docker compose -f docker-compose.preprod.yml
PP_TF_DIR  := infra/environments/preprod
PP_TF      := terraform -chdir=$(PP_TF_DIR)
PP_NETWORK := 3mrai-preprod_preprod-network
PP_TF_VARS := -var python_bin=$(PY)

preprod-floci-up: scripts-setup ## Pre-prod: exclusivity guard, then Floci alone
	@$(PY) infra/scripts/env_guard.py preprod
	$(PP_COMPOSE) up -d --wait floci

preprod-down: ## Pre-prod: full wipe (Floci, its children, ECR registry, Floci volumes, TF state)
	$(PP_COMPOSE) down -v --remove-orphans
	@# CONTRACT: Floci-launched containers and volumes carry no compose label, and the
	@# ECR registry survives Floci's own shutdown; kept, the next apply fails with
	@# RepositoryAlreadyExists and DocumentDB/ElastiCache come back as phantoms.
	@docker ps -aq --filter "name=^floci-" | xargs -r docker rm -f 2>/dev/null || true
	@docker volume ls -q --filter label=floci=true | xargs -r docker volume rm -f 2>/dev/null || true
	@docker volume rm -f floci-ecr-registry-data 2>/dev/null || true
	@docker network rm $(PP_NETWORK) 2>/dev/null || true
	@rm -rf $(PP_TF_DIR)/.terraform $(PP_TF_DIR)/terraform.tfstate* $(PP_TF_DIR)/image-tags.auto.tfvars.json $(PP_TF_DIR)/.state
```

- [x] **Step 6: Verify the skeleton end to end**

```bash
make preprod-floci-up
terraform -chdir=infra/environments/preprod init && \
  terraform -chdir=infra/environments/preprod apply -auto-approve -var python_bin=$PWD/.venv/bin/python
make preprod-down
docker ps -a --format '{{.Names}}' | grep -cE '^(floci-|3mrai-preprod)'; docker volume ls -q | grep -c floci-ecr
```
Expected: apply `3 added` (or the networking module's count); after down both counts are `0`.

- [x] **Step 7: Hand over for commit** — `feat(infra): add the pre-prod compose file and Terraform root skeleton`

---

## Phase F2 — Data plane, images, services

### Task 3: Data plane in the pre-prod root

**Files:**
- Modify: `infra/environments/preprod/main.tf`, `outputs.tf`

**Interfaces:**
- Consumes: Task 2 skeleton.
- Produces (outputs used by Tasks 6, 8, 11, 13, 15): `cognito_user_pool_id`, `cognito_client_id`, `cognito_issuer`, `pg_port`, `mysql_port`, `redis_host`, `redis_port`, `events_topic_arn`, `notifications_queue_url`, `events_query_url`, `ws_url`, `ws_management_endpoint`, `ws_connections_table`, `ws_connections_gsi`, `assets_base_url`, `docdb_host`.

- [x] **Step 1: Copy the data-plane blocks from the local root**

Copy these blocks from `infra/environments/local/main.tf` into `infra/environments/preprod/main.tf`, verbatim, in this order: label modules L15-56 and L95-100 (`label_db` … `label_cache`, `label_orders_db`; skip `label_compute`), `rds_aurora` L73-92, `rds_mysql` L108-123, `terraform_data.tracking_database` L135-152, `cognito` L160-189, `messaging` L208-211, `docdb` L223-240, `redis` L254-271, `ws_connections` L276-279, `api_gateway_ws` L284-325, `aws_ses_email_identity` L336-338, `lambda_events_pipeline` L343-443, the EventBridge rule/target/permission L453-480.

Then apply exactly these substitutions inside the copied text:

| Find | Replace |
|---|---|
| `var.db_name` | `"users"` |
| `var.execution_log_table` | `""` |
| `abspath("${path.module}/../../../.venv/bin/python")` (or any venv path expression) | `var.python_bin` |
| `"http://otel-collector:4318"` | `"http://floci:4318"` |
| `var.assets_base_url` | `module.assets_bucket.public_base_url` |
| `var.e2e_query_token` | `random_password.e2e_query_token.result` |

Skip `module "compute"` (L194-203) and `module "api_gateway"` (L488-502) — Tasks 6 and 11 replace them.

- [x] **Step 2: Add the assets bucket, secrets and RDS port lookups**

```hcl
module "label_post" {
  source      = "../../modules/label"
  environment = var.environment
  name        = "assets"
}

module "assets_bucket" {
  source       = "../../modules/assets-bucket"
  context      = { id = "assets-${module.label_post.id}", tags = module.label_post.tags }
  public_read  = true
  endpoint_url = "http://localhost:4566"
}

resource "terraform_data" "assets_sync" {
  triggers_replace = {
    bucket   = module.assets_bucket.bucket_name
    base_url = module.assets_bucket.public_base_url
  }
  provisioner "local-exec" {
    command = join(" ", [
      var.python_bin,
      abspath("${path.module}/../../modules/assets-bucket/scripts/sync_assets.py"),
      "--bucket", self.triggers_replace.bucket,
      "--base-url", self.triggers_replace.base_url,
    ])
    interpreter = ["/usr/bin/env", "bash", "-c"]
  }
}

resource "random_password" "internal_api_key" {
  length  = 40
  special = false
}

resource "random_password" "carrier_api_key" {
  length  = 40
  special = false
}

resource "random_password" "webhook_secret" {
  length  = 40
  special = false
}

resource "random_password" "e2e_query_token" {
  length  = 40
  special = false
}

resource "random_password" "openobserve_root" {
  length           = 24
  special          = true
  override_special = "#"
}

# WHY: The proxy port Floci assigns per cluster (7000-7099, by creation order) is
# what describe-db-clusters reports — the same value discover_db_port.py reads.
data "aws_rds_cluster" "pg" {
  cluster_identifier = module.rds_aurora.cluster_identifier
}

data "aws_rds_cluster" "mysql" {
  cluster_identifier = module.rds_mysql.cluster_identifier
}
```

- [x] **Step 3: Outputs**

```hcl
output "cognito_user_pool_id" { value = module.cognito.user_pool_id }
output "cognito_client_id" { value = module.cognito.client_id }
output "cognito_issuer" { value = module.cognito.issuer }
output "pg_port" { value = data.aws_rds_cluster.pg.port }
output "mysql_port" { value = data.aws_rds_cluster.mysql.port }
output "redis_host" { value = module.redis.redis_host }
output "redis_port" { value = module.redis.redis_port }
output "events_topic_arn" { value = module.messaging.topic_arn }
output "notifications_queue_url" { value = module.messaging.notifications_queue_url }
output "events_query_url" { value = module.lambda_events_pipeline.function_url }
output "ws_url" { value = module.api_gateway_ws.ws_url_local }
output "ws_management_endpoint" { value = module.api_gateway_ws.management_endpoint_local }
output "ws_connections_table" { value = module.ws_connections.table_name }
output "ws_connections_gsi" { value = module.ws_connections.gsi_name }
output "assets_base_url" { value = module.assets_bucket.public_base_url }
output "docdb_host" { value = "floci-docdb-${module.docdb.cluster_identifier}" }
output "internal_api_key" {
  value     = random_password.internal_api_key.result
  sensitive = true
}
output "carrier_api_key" {
  value     = random_password.carrier_api_key.result
  sensitive = true
}
output "e2e_query_token" {
  value     = random_password.e2e_query_token.result
  sensitive = true
}
output "openobserve_root_password" {
  value     = random_password.openobserve_root.result
  sensitive = true
}
```

- [x] **Step 4: Build bundles, apply, verify the RDS ports are the proxy ports**

```bash
make lambda-bundles
make preprod-floci-up
terraform -chdir=infra/environments/preprod init
terraform -chdir=infra/environments/preprod apply -auto-approve -var python_bin=$PWD/.venv/bin/python
terraform -chdir=infra/environments/preprod output pg_port mysql_port
AWS_ENDPOINT_URL=http://localhost:4566 .venv/bin/python infra/environments/local/scripts/discover_db_port.py postgres
```
Expected: apply succeeds; `pg_port` equals the discover script's value (both in 7000-7099). If `pg_port` prints `5432`, stop and report — Amendment 4 is then wrong and the root must call `discover_db_port.py` through an `external` data source instead.

- [x] **Step 5: Hand over for commit** — `feat(infra): provision the pre-prod data plane`

---

### Task 4: `ecr` and `app-config` modules

**Files:**
- Create: `infra/modules/ecr/{main.tf,variables.tf,outputs.tf}`
- Create: `infra/modules/app-config/{main.tf,variables.tf,outputs.tf}`
- Modify: `infra/environments/preprod/main.tf`, `outputs.tf`

**Interfaces:**
- Produces: `module.ecr.repository_urls` (`map(string)`, service → URL); `module.app_config.refs` (`map(list(object({name=string, valueFrom=string})))`, service → ECS `secrets` entries); root output `ecr_repository_urls`.

- [x] **Step 1: `modules/ecr`**

`variables.tf`:

```hcl
variable "context" {
  type = object({ id = string, tags = map(string) })
}

variable "repositories" {
  type        = set(string)
  description = "Short service names; each becomes <context.id>/<name>."
}
```

`main.tf`:

```hcl
resource "aws_ecr_repository" "this" {
  for_each             = var.repositories
  name                 = "${var.context.id}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true
  tags                 = var.context.tags
}
```

`outputs.tf`:

```hcl
output "repository_urls" {
  value = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}
```

- [x] **Step 2: `modules/app-config`**

`variables.tf`:

```hcl
variable "prefix" {
  type        = string
  description = "e.g. 3mrai-preprod → SSM /3mrai-preprod/<svc>/<VAR>, secret 3mrai-preprod/<svc>/<VAR>."
}

variable "parameters" {
  type    = map(map(string))
  default = {}
}

variable "secrets" {
  type      = map(map(string))
  default   = {}
  sensitive = true
}
```

`main.tf`:

```hcl
locals {
  params = merge([
    for svc, kv in var.parameters : { for k, v in kv : "${svc}/${k}" => { svc = svc, key = k, value = v } }
  ]...)
  secret_entries = merge([
    for svc, kv in var.secrets : { for k, v in kv : "${svc}/${k}" => { svc = svc, key = k, value = v } }
  ]...)
  # WHY: for_each keys may not be sensitive; the names are not secret, the values are.
  secret_keys = nonsensitive(toset(keys(local.secret_entries)))
}

resource "aws_ssm_parameter" "this" {
  for_each = local.params
  name     = "/${var.prefix}/${each.key}"
  type     = "String"
  value    = each.value.value
}

resource "aws_secretsmanager_secret" "this" {
  for_each                = local.secret_keys
  name                    = "${var.prefix}/${each.key}"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "this" {
  for_each      = local.secret_keys
  secret_id     = aws_secretsmanager_secret.this[each.key].id
  secret_string = local.secret_entries[each.key].value
}
```

`outputs.tf`:

```hcl
output "refs" {
  value = {
    for svc in distinct(concat(
      [for k, p in local.params : p.svc],
      [for k in local.secret_keys : split("/", k)[0]],
      )) : svc => concat(
      [for k, p in local.params : { name = p.key, valueFrom = aws_ssm_parameter.this[k].arn } if p.svc == svc],
      [for k in local.secret_keys : { name = split("/", k)[1], valueFrom = aws_secretsmanager_secret.this[k].arn } if split("/", k)[0] == svc],
    )
  }
}
```

- [x] **Step 3: Wire both into the root**

```hcl
module "label_app" {
  source      = "../../modules/label"
  environment = var.environment
  name        = "app"
}

locals {
  images = toset(["users", "orders", "tracking", "web", "otel-collector", "openobserve", "mailpit"])
}

module "ecr" {
  source       = "../../modules/ecr"
  context      = { id = module.label_app.id, tags = module.label_app.tags }
  repositories = local.images
}

output "ecr_repository_urls" { value = module.ecr.repository_urls }
```

(`module.app_config` is added in Task 6, where the per-service maps are defined.)

- [x] **Step 4: Verify**

```bash
terraform -chdir=infra/environments/preprod apply -auto-approve -var python_bin=$PWD/.venv/bin/python
terraform -chdir=infra/environments/preprod output -json ecr_repository_urls
```
Expected: 7 URLs of the form `000000000000.dkr.ecr.us-east-1.localhost:4566/3mrai-preprod-app/<svc>`.

- [x] **Step 5: Hand over for commit** — `feat(infra): add ecr and app-config modules`

---

### Task 5: `alb` and `ecs-service` modules

**Files:**
- Create: `infra/modules/alb/{main.tf,variables.tf,outputs.tf}`
- Create: `infra/modules/ecs-service/{main.tf,variables.tf,outputs.tf}`

**Interfaces:**
- Produces: `module.alb.arn`, `module.alb.vpc_id`; `ecs-service` inputs `context, name, cluster_arn, execution_role_arn, image, cpu, memory, container_port, extra_ports, secrets, listeners, alb_arn, vpc_id, subnet_ids, security_group_ids, desired_count, region`; outputs `service_name`, `task_family`, `target_group_arns` (`map(string)` listener key → ARN).

- [x] **Step 1: `modules/alb`**

```hcl
# variables.tf
variable "context" {
  type = object({ id = string, tags = map(string) })
}
variable "subnet_ids" { type = list(string) }
variable "security_group_ids" { type = list(string) }
variable "vpc_id" { type = string }
```

```hcl
# main.tf
resource "aws_lb" "this" {
  name               = "${var.context.id}-alb"
  internal           = true
  load_balancer_type = "application"
  subnets            = var.subnet_ids
  security_groups    = var.security_group_ids
  tags               = var.context.tags
}
```

```hcl
# outputs.tf
output "arn" { value = aws_lb.this.arn }
output "vpc_id" { value = var.vpc_id }
```

- [x] **Step 2: `modules/ecs-service/variables.tf`**

```hcl
variable "context" {
  type = object({ id = string, tags = map(string) })
}
variable "name" { type = string }
variable "cluster_arn" { type = string }
variable "execution_role_arn" { type = string }
variable "image" { type = string }
variable "cpu" {
  type    = number
  default = 256
}
variable "memory" {
  type    = number
  default = 512
}
variable "container_port" { type = number }
variable "extra_ports" {
  type    = list(number)
  default = []
}
variable "secrets" {
  type        = list(object({ name = string, valueFrom = string }))
  description = "From module.app_config.refs[<svc>]; ECS resolves them at task start."
}
variable "listeners" {
  type = map(object({
    port             = number
    container_port   = number
    protocol_version = optional(string, "HTTP1")
    health_path      = optional(string, "/")
  }))
  default = {}
}
variable "alb_arn" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "security_group_ids" { type = list(string) }
variable "desired_count" {
  type    = number
  default = 1
}
variable "region" { type = string }
```

- [x] **Step 3: `modules/ecs-service/main.tf`**

```hcl
locals {
  family = "${var.context.id}-${var.name}"
  ports  = distinct(concat([var.container_port], var.extra_ports, [for l in values(var.listeners) : l.container_port]))
}

# WARNING: Floci ignores `awslogs-group` and writes to /ecs/<family>; the group is
# named that way so both agree. See [[2026-10-02-floci-preprod-environment-design]]
resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${local.family}"
  retention_in_days = 1
}

resource "aws_ecs_task_definition" "this" {
  family                   = local.family
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  execution_role_arn       = var.execution_role_arn
  container_definitions = jsonencode([{
    name         = var.name
    image        = var.image
    essential    = true
    portMappings = [for p in local.ports : { containerPort = p, protocol = "tcp" }]
    secrets      = var.secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = var.name
      }
    }
  }])
  tags = var.context.tags
}

resource "aws_lb_target_group" "this" {
  for_each         = var.listeners
  # WHY: TG names cap at 32 chars; a short hash of the context keeps them unique
  # without truncating "otel-collector-otlp" and "-rum" into the same name.
  name             = "${substr(md5(var.context.id), 0, 6)}-${var.name}-${each.key}"
  port             = each.value.container_port
  protocol         = "HTTP"
  protocol_version = each.value.protocol_version
  target_type      = "ip"
  vpc_id           = var.vpc_id
  health_check {
    path    = each.value.health_path
    matcher = each.value.protocol_version == "GRPC" ? "0-99" : "200-499"
  }
}

resource "aws_lb_listener" "this" {
  for_each          = var.listeners
  load_balancer_arn = var.alb_arn
  port              = each.value.port
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[each.key].arn
  }
}

resource "aws_ecs_service" "this" {
  name            = var.name
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"
  propagate_tags  = "NONE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = true
  }

  dynamic "load_balancer" {
    for_each = var.listeners
    content {
      target_group_arn = aws_lb_target_group.this[load_balancer.key].arn
      container_name   = var.name
      container_port   = load_balancer.value.container_port
    }
  }

  depends_on = [aws_lb_listener.this]
}
```

- [x] **Step 4: `modules/ecs-service/outputs.tf`**

```hcl
output "service_name" { value = aws_ecs_service.this.name }
output "task_family" { value = local.family }
output "target_group_arns" {
  value = { for k, tg in aws_lb_target_group.this : k => tg.arn }
}
```

- [x] **Step 5: Validate**

Run, for each of `alb` and `ecs-service`:
`terraform -chdir=infra/modules/<m> init -backend=false && terraform -chdir=infra/modules/<m> validate`, then `terraform fmt -check -recursive infra`.
Expected: `Success! The configuration is valid.` twice, no fmt diff.

- [x] **Step 6: Hand over for commit** — `feat(infra): add alb and ecs-service modules`

---

### Task 6: Service configuration and the services map

**Files:**
- Create: `infra/environments/preprod/services.tf`
- Modify: `infra/environments/preprod/outputs.tf`

**Interfaces:**
- Consumes: Task 3 outputs, `module.ecr.repository_urls`, `module.alb`, `module "ecs-service"`, `module "app-config"`.
- Produces: `module.service["<svc>"]` for `users, orders, tracking` (web/otel-collector/openobserve/mailpit are added to the same maps in Tasks 12-14); root outputs `ecs_cluster_name`, `service_ports`.

- [x] **Step 1: Write `services.tf`**

```hcl
module "label_ecs" {
  source      = "../../modules/label"
  environment = var.environment
  name        = "ecs"
}

resource "aws_ecs_cluster" "this" {
  name = "${module.label_ecs.id}-cluster"
}

resource "aws_iam_role" "ecs_execution" {
  name = "${module.label_ecs.id}-execution"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "ecs-tasks.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

module "alb" {
  source             = "../../modules/alb"
  context            = { id = module.label_ecs.id, tags = module.label_ecs.tags }
  subnet_ids         = module.networking.subnet_ids
  security_group_ids = module.networking.security_group_ids
  vpc_id             = module.networking.vpc_id
}

locals {
  pg_port    = data.aws_rds_cluster.pg.port
  mysql_port = data.aws_rds_cluster.mysql.port

  aws_common = {
    AWS_ENDPOINT_URL      = "http://floci:4566"
    AWS_REGION            = local.region
    AWS_ACCESS_KEY_ID     = "test"
    AWS_SECRET_ACCESS_KEY = "test"
  }
  otel_common = {
    OTEL_EXPORTER_OTLP_ENDPOINT = "http://floci:4318"
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
    OTEL_METRICS_EXPORTER       = "none"
    OTEL_LOGS_EXPORTER          = "none"
  }
  users_grpc_url = var.users_grpc_via_alb ? "http://floci:9151" : "http://users-grpc:50051"

  parameters = {
    users = merge(local.aws_common, local.otel_common, {
      COGNITO_USER_POOL_ID    = module.cognito.user_pool_id
      COGNITO_CLIENT_ID       = module.cognito.client_id
      ORDERS_BASE_URL         = "http://floci:9102"
      TRACKING_BASE_URL       = "http://floci:9103"
      EVENTS_TOPIC_ARN        = module.messaging.topic_arn
      NOTIFICATIONS_QUEUE_URL = module.messaging.notifications_queue_url
      WS_MANAGEMENT_ENDPOINT  = module.api_gateway_ws.management_endpoint_local
      WS_CONNECTIONS_TABLE    = module.ws_connections.table_name
      WS_CONNECTIONS_GSI      = module.ws_connections.gsi_name
      REDIS_HOST              = module.redis.redis_host
      REDIS_PORT              = tostring(module.redis.redis_port)
      PORT                    = "3000"
      GRPC_PORT               = "50051"
      E2E_TESTING_ENABLED     = "true"
      CACHE_ENABLED           = "true"
      STRIPE_ENABLED          = "false"
      DEPLOYMENT_ENVIRONMENT  = "preprod"
      METRICS_INTERVAL_MS     = "60000"
    })
    orders = merge(local.aws_common, {
      OTEL_EXPORTER_OTLP_ENDPOINT = "http://floci:4318"
      OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
      OTEL_DIAGNOSTICS__LOGLEVEL  = "Error"
      USERS_GRPC_URL              = local.users_grpc_url
      TRACKING_BASE_URL           = "http://floci:9103"
      REDIS_HOST                  = module.redis.redis_host
      REDIS_PORT                  = tostring(module.redis.redis_port)
      EVENTS_TOPIC_ARN            = module.messaging.topic_arn
      ASSETS_BASE_URL             = module.assets_bucket.public_base_url
      CACHE_ENABLED               = "true"
      STRIPE_ENABLED              = "false"
      SEED_ON_STARTUP             = "true"
      E2E_TESTING_ENABLED         = "true"
      DEPLOYMENT_ENVIRONMENT      = "preprod"
      METRICS_INTERVAL_MS         = "60000"
    })
    tracking = merge(local.aws_common, local.otel_common, {
      USERS_GRPC_URL               = local.users_grpc_url
      ORDERS_BASE_URL              = "http://floci:9102"
      EVENTS_TOPIC_ARN             = module.messaging.topic_arn
      REDIS_HOST                   = module.redis.redis_host
      REDIS_PORT                   = tostring(module.redis.redis_port)
      PORT                         = "8000"
      ENVIRONMENT                  = "development"
      E2E_TESTING_ENABLED          = "true"
      CACHE_ENABLED                = "true"
      METRICS_ENABLED              = "true"
      METRICS_INTERVAL_SECONDS     = "60"
      PROGRESSION_INTERVAL_SECONDS = "5"
      DEPLOYMENT_ENVIRONMENT       = "preprod"
    })
  }

  secrets = {
    users = {
      DATABASE_WRITER_URL = "postgres://${var.db_username}:${var.db_password}@floci:${local.pg_port}/users"
      DATABASE_READER_URL = "postgres://${var.db_username}:${var.db_password}@floci:${local.pg_port}/users"
      WEBHOOK_SECRET      = random_password.webhook_secret.result
      INTERNAL_API_KEY    = random_password.internal_api_key.result
    }
    orders = {
      DATABASE_WRITER_URL = "Server=floci;Port=${local.mysql_port};Database=orders;User=${var.db_username};Password=${var.db_password};SslMode=None;"
      DATABASE_READER_URL = "Server=floci;Port=${local.mysql_port};Database=orders;User=${var.db_username};Password=${var.db_password};SslMode=None;"
      INTERNAL_API_KEY    = random_password.internal_api_key.result
    }
    tracking = {
      DATABASE_WRITER_URL      = "mysql+pymysql://${var.db_username}:${var.db_password}@floci:${local.mysql_port}/tracking?charset=utf8mb4"
      DATABASE_READER_URL      = "mysql+pymysql://${var.db_username}:${var.db_password}@floci:${local.mysql_port}/tracking?charset=utf8mb4"
      INTERNAL_API_KEY         = random_password.internal_api_key.result
      TRACKING_CARRIER_API_KEY = random_password.carrier_api_key.result
    }
  }

  services = {
    users = {
      port = 3000, cpu = 512, memory = 1024, extra_ports = [50051]
      listeners = merge(
        { http = { port = 9101, container_port = 3000, health_path = "/v1/health" } },
        var.users_grpc_via_alb ? { grpc = { port = 9151, container_port = 50051, protocol_version = "GRPC", health_path = "/" } } : {},
      )
    }
    orders = {
      port = 8080, cpu = 512, memory = 1024, extra_ports = []
      listeners = { http = { port = 9102, container_port = 8080, health_path = "/v1/health" } }
    }
    tracking = {
      port = 8000, cpu = 256, memory = 512, extra_ports = []
      listeners = { http = { port = 9103, container_port = 8000, health_path = "/v1/health" } }
    }
  }
}

module "app_config" {
  source     = "../../modules/app-config"
  prefix     = "3mrai-${var.environment}"
  parameters = local.parameters
  secrets    = local.secrets
}

module "service" {
  source   = "../../modules/ecs-service"
  for_each = var.deploy_services ? local.services : {}

  context            = { id = module.label_ecs.id, tags = module.label_ecs.tags }
  name               = each.key
  cluster_arn        = aws_ecs_cluster.this.arn
  execution_role_arn = aws_iam_role.ecs_execution.arn
  image              = "${module.ecr.repository_urls[each.key]}:${var.image_tags[each.key]}"
  cpu                = each.value.cpu
  memory             = each.value.memory
  container_port     = each.value.port
  extra_ports        = each.value.extra_ports
  secrets            = module.app_config.refs[each.key]
  listeners          = each.value.listeners
  alb_arn            = module.alb.arn
  vpc_id             = module.networking.vpc_id
  subnet_ids         = module.networking.subnet_ids
  security_group_ids = module.networking.security_group_ids
  region             = local.region
}
```

- [x] **Step 2: Outputs**

```hcl
output "ecs_cluster_name" { value = aws_ecs_cluster.this.name }
output "service_ports" {
  value = { for k, s in local.services : k => { for lk, l in s.listeners : lk => l.port } }
}
```

- [x] **Step 3: Apply A and verify config landed**

```bash
terraform -chdir=infra/environments/preprod apply -auto-approve -var python_bin=$PWD/.venv/bin/python
aws --endpoint-url http://localhost:4566 ssm get-parameters-by-path --path /3mrai-preprod/users --recursive --query 'length(Parameters)'
aws --endpoint-url http://localhost:4566 secretsmanager list-secrets --query 'length(SecretList)'
```
Expected: users parameter count = 26; secret count = 11 (4 users + 3 orders + 4 tracking).

- [x] **Step 4: Hand over for commit** — `feat(infra): configure the pre-prod services through SSM and Secrets Manager`

---

### Task 7: `build_push.py` — immutable tags, build, push

**Files:**
- Create: `infra/environments/preprod/scripts/build_push.py`
- Create: `infra/environments/preprod/scripts/tests/test_build_push.py`
- Modify: `infra/scripts/pyproject.toml` (`testpaths` += `"../environments/preprod/scripts/tests"`)

**Interfaces:**
- Consumes: root output `ecr_repository_urls`, `cognito_*`, `ws_url`.
- Produces: `image_tag(sha: str, dirty: bool, now: float, content_hash: str = "") -> str`; `commands_for(service: str, url: str, tag: str, build_args: dict[str, str]) -> list[list[str]]`; `update_tags(path: Path, new: dict[str, str]) -> dict[str, str]`; CLI `build_push.py --tf-dir DIR --services users,orders|all`; writes `<tf-dir>/image-tags.auto.tfvars.json` as `{"image_tags": {...}}`.

- [x] **Step 1: Failing tests**

```python
"""Tests for build_push.py — pre-prod image tags and docker command plans."""

import importlib.util
import json
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "build_push.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
_spec = importlib.util.spec_from_file_location("build_push", SCRIPT)
bp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bp)

URL = "000000000000.dkr.ecr.us-east-1.localhost:4566/3mrai-preprod-app/users"


def test_clean_tree_tag_is_short_sha():
    assert bp.image_tag("abcdef1234567890", False, 0) == "abcdef123456"


def test_dirty_tags_differ_across_seconds():
    a = bp.image_tag("abcdef1234567890", True, 1000.0, "h1")
    b = bp.image_tag("abcdef1234567890", True, 1001.0, "h1")
    assert a != b and a.startswith("abcdef123456-dirty-")


def test_dirty_tags_differ_on_content_within_a_second():
    a = bp.image_tag("abcdef1234567890", True, 1000.0, "h1")
    b = bp.image_tag("abcdef1234567890", True, 1000.0, "h2")
    assert a != b


def test_built_service_commands():
    cmds = bp.commands_for("users", URL, "t1", {})
    assert cmds[0][:2] == ["docker", "build"]
    assert "services/users/Dockerfile" in cmds[0]
    assert cmds[-1] == ["docker", "push", f"{URL}:t1"]


def test_web_gets_build_args():
    cmds = bp.commands_for("web", URL, "t1", {"NG_APP_WS_URL": "ws://x"})
    assert "--build-arg" in cmds[0] and "NG_APP_WS_URL=ws://x" in cmds[0]


def test_retagged_service_pulls_then_tags():
    cmds = bp.commands_for("mailpit", URL, "t1", {})
    assert cmds[0] == ["docker", "pull", "axllent/mailpit:v1.20"]
    assert cmds[1] == ["docker", "tag", "axllent/mailpit:v1.20", f"{URL}:t1"]


def test_update_tags_merges(tmp_path):
    path = tmp_path / "image-tags.auto.tfvars.json"
    path.write_text(json.dumps({"image_tags": {"users": "old", "orders": "o1"}}))
    assert bp.update_tags(path, {"users": "new"}) == {"users": "new", "orders": "o1"}
    assert json.loads(path.read_text())["image_tags"]["users"] == "new"
```

Run: `.venv/bin/python -m pytest infra/environments/preprod/scripts/tests -v` → FAIL.

- [x] **Step 2: Implement**

```python
"""Build (or retag) pre-prod images and push them to Floci's ECR.

CONTRACT: Tags are immutable and unique per content — a reused tag leaves ECS on
the old task definition while the deploy reports success.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

from lib3mrai.aws import client
from lib3mrai.console import inf, ok
from lib3mrai.envfile import terraform_output

ROOT = Path(__file__).resolve().parents[4]

BUILDS = {
    "users": (".", "services/users/Dockerfile"),
    "orders": (".", "services/orders/Dockerfile"),
    "tracking": ("services/tracking-go", "services/tracking-go/Dockerfile"),
    "web": (".", "apps/web/Dockerfile"),
    "otel-collector": (".", "observability/collector.Dockerfile"),
}
RETAGS = {
    "openobserve": "public.ecr.aws/zinclabs/openobserve:v0.91.1",
    "mailpit": "axllent/mailpit:v1.20",
}
ALL = list(BUILDS) + list(RETAGS)


def image_tag(sha: str, dirty: bool, now: float, content_hash: str = "") -> str:
    short = sha[:12]
    if not dirty:
        return short
    return f"{short}-dirty-{int(now)}-{content_hash[:8]}"


def commands_for(service: str, url: str, tag: str, build_args: dict[str, str]) -> list[list[str]]:
    ref = f"{url}:{tag}"
    if service in RETAGS:
        src = RETAGS[service]
        return [["docker", "pull", src], ["docker", "tag", src, ref], ["docker", "push", ref]]
    context, dockerfile = BUILDS[service]
    build = ["docker", "build", "-f", dockerfile, "-t", ref]
    for key, value in build_args.items():
        build += ["--build-arg", f"{key}={value}"]
    return [build + [context], ["docker", "push", ref]]


def update_tags(path: Path, new: dict[str, str]) -> dict[str, str]:
    current = json.loads(path.read_text())["image_tags"] if path.exists() else {}
    current.update(new)
    path.write_text(json.dumps({"image_tags": current}, indent=2) + "\n")
    return current


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()


def _ecr_login(registry: str) -> None:
    token = client("ecr").get_authorization_token()["authorizationData"][0]["authorizationToken"]
    password = base64.b64decode(token).decode().split(":", 1)[1]
    subprocess.run(["docker", "login", "-u", "AWS", "--password-stdin", registry],
                   input=password, text=True, check=True, capture_output=True)


def _build_args(service: str, tf_dir: Path) -> dict[str, str]:
    if service == "web":
        return {
            "NG_APP_API_GATEWAY_URL": "/v1",
            "NG_APP_WS_URL": terraform_output(tf_dir, "ws_url"),
            "NG_APP_STRIPE_ENABLED": "false",
            "NG_APP_GEOCODE_ENABLED": "false",
            "NG_APP_RUM_ENABLED": "false",
        }
    if service == "orders":
        has_cache = subprocess.run(["docker", "image", "inspect", "3mrai-nuget-cache:latest"],
                                   capture_output=True).returncode == 0
        return {"SDK_IMAGE": "3mrai-nuget-cache:latest"} if has_cache else {}
    return {}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tf-dir", type=Path, required=True)
    parser.add_argument("--services", default="all")
    args = parser.parse_args(argv)
    services = ALL if args.services == "all" else args.services.split(",")

    urls = json.loads(subprocess.run(
        ["terraform", f"-chdir={args.tf_dir}", "output", "-json", "ecr_repository_urls"],
        capture_output=True, text=True, check=True).stdout)
    dirty = bool(_git("status", "--porcelain"))
    content = hashlib.sha256(_git("diff", "HEAD").encode()).hexdigest() if dirty else ""
    tag = image_tag(_git("rev-parse", "HEAD"), dirty, time.time(), content)
    _ecr_login(next(iter(urls.values())).split("/", 1)[0])

    for service in services:
        inf(f"    {service} → {urls[service]}:{tag}")
        for cmd in commands_for(service, urls[service], tag, _build_args(service, args.tf_dir)):
            subprocess.run(cmd, cwd=ROOT, check=True)
        ok(f"pushed {service}:{tag}")

    update_tags(args.tf_dir / "image-tags.auto.tfvars.json", {s: tag for s in services})
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [x] **Step 3: Run tests** — `.venv/bin/python -m pytest infra/environments/preprod/scripts/tests -v` → 7 passed.

- [x] **Step 4: Hand over for commit** — `feat(infra): build and push pre-prod images with immutable tags`

---

### Task 8: `preprod-up` orchestration, migrations, readiness

**Files:**
- Create: `infra/environments/preprod/scripts/wait_services.py`
- Create: `infra/environments/preprod/scripts/tests/test_wait_services.py`
- Modify: `Makefile` (pre-prod section)

**Interfaces:**
- Consumes: Tasks 2-7; `floci_heal.wake_ecs`.
- Produces: `converged(services: list[dict]) -> list[str]` (names not yet at `runningCount == desiredCount`); targets `preprod-up`, `preprod-migrate`; CLI `wait_services.py --cluster NAME [--timeout 600]`.

- [x] **Step 1: Failing test**

```python
import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "wait_services.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
_spec = importlib.util.spec_from_file_location("wait_services", SCRIPT)
ws = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ws)


def test_converged_lists_lagging_services():
    services = [
        {"serviceName": "users", "runningCount": 1, "desiredCount": 1},
        {"serviceName": "orders", "runningCount": 0, "desiredCount": 1},
    ]
    assert ws.converged(services) == ["orders"]
```

- [x] **Step 2: Implement**

```python
"""Block until every ECS service in a cluster runs its desired count.

WARNING: runningCount can report 1 with no task container behind it right after
a Floci restart; the wait also requires a container per task. See [[2026-10-02-floci-preprod-environment-design]]
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time

from lib3mrai.aws import client
from lib3mrai.console import no, ok


def converged(services: list[dict]) -> list[str]:
    return [s["serviceName"] for s in services if s["runningCount"] < s["desiredCount"]]


def _task_containers_exist(ecs, cluster: str) -> bool:
    ids = [a.rsplit("/", 1)[-1] for a in ecs.list_tasks(cluster=cluster)["taskArns"]]
    names = subprocess.run(["docker", "ps", "--format", "{{.Names}}"],
                           capture_output=True, text=True).stdout
    return all(f"floci-ecs-{i}-" in names for i in ids)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cluster", required=True)
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args(argv)
    ecs = client("ecs")
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        arns = ecs.list_services(cluster=args.cluster)["serviceArns"]
        services = ecs.describe_services(cluster=args.cluster, services=arns)["services"] if arns else []
        lagging = converged(services)
        if services and not lagging and _task_containers_exist(ecs, args.cluster):
            ok(f"{len(services)} service(s) running")
            return 0
        time.sleep(5)
    no(f"timed out; still converging: {', '.join(lagging) or 'task containers'}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
```

Run the test → 1 passed.

- [x] **Step 3: Makefile targets**

```make
preprod-migrate: scripts-setup ## Pre-prod: Prisma (users) + golang-migrate (tracking) against Floci's RDS
	docker build --target deps -t 3mrai-users:deps -f services/users/Dockerfile .
	@pg="$$($(PP_TF) output -raw pg_port)"; \
	docker run --rm --network $(PP_NETWORK) \
	    -e DATABASE_WRITER_URL="postgres://test:test@floci:$$pg/users" \
	    -w /app/services/users 3mrai-users:deps \
	    node node_modules/prisma/build/index.js migrate deploy --schema=./prisma/schema.prisma
	@my="$$($(PP_TF) output -raw mysql_port)"; \
	docker run --rm --network $(PP_NETWORK) -v $(REPO_ROOT)/services/tracking-go/migrations:/migrations \
	    migrate/migrate:v4.17.1 -path=/migrations \
	    -database "mysql://test:test@tcp(floci:$$my)/tracking?tls=false&multiStatements=true" up

preprod-up: preprod-floci-up lambda-bundles ## Pre-prod: everything, from scratch
	$(PP_TF) init -input=false
	$(PP_TF) apply -auto-approve -input=false $(PP_TF_VARS) -var deploy_services=false
	$(PY) $(PP_TF_DIR)/scripts/build_push.py --tf-dir $(PP_TF_DIR) --services all
	$(MAKE) --no-print-directory preprod-migrate
	$(PP_TF) apply -auto-approve -input=false $(PP_TF_VARS) -var deploy_services=true
	$(PY) $(PP_TF_DIR)/scripts/wait_services.py --cluster "$$($(PP_TF) output -raw ecs_cluster_name)"
	$(MAKE) --no-print-directory preprod-smoke

preprod-smoke: ## Pre-prod: health of every service through its ALB listener
	@for p in 9101 9102 9103; do curl -fsS -o /dev/null -w "$$p %{http_code}\n" http://localhost:$$p/v1/health || exit 1; done
```

Before writing `preprod-migrate`, open `Makefile` L387-444 (`migrate-tracking`) and copy its exact `-database` DSN shape and the `force 1` guard if the `schema_migrations` table is absent; the line above follows the dev target's `migrate/migrate:v4.17.1` image and must match its DSN parameters.

- [x] **Step 4: Verify**

Run: `make preprod-down && make preprod-up`
Expected: ends with `9101 200`, `9102 200`, `9103 200`.

- [x] **Step 5: Hand over for commit** — `feat(infra): orchestrate pre-prod from scratch with make preprod-up`

---

### Task 9: Users gRPC — ALB or alias (decision task)

**Files:**
- Create: `infra/environments/preprod/scripts/preprod_aliases.py`
- Create: `infra/environments/preprod/scripts/tests/test_preprod_aliases.py`
- Modify: `infra/environments/preprod/variables.tf` (the default of `users_grpc_via_alb`, per the result)

**Interfaces:**
- Produces: `ALIASES: dict[str, tuple[str, str]]` (alias → (service, container)); `container_for(task_ids: set[str], names: list[str], container: str) -> str | None`; `main(argv) -> int` with `--cluster`, `--network`, `--check` (report only, exit 1 if an alias is missing).

- [x] **Step 1: Failing tests**

```python
import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "preprod_aliases.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
_spec = importlib.util.spec_from_file_location("preprod_aliases", SCRIPT)
al = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(al)

TID = "0" * 32


def test_container_for_picks_the_live_task():
    names = [f"floci-ecs-{TID}-mailpit", f"floci-ecs-{'1' * 32}-mailpit"]
    assert al.container_for({TID}, names, "mailpit") == f"floci-ecs-{TID}-mailpit"


def test_container_for_none_when_absent():
    assert al.container_for({TID}, [], "mailpit") is None


def test_alias_missing_is_reported():
    assert al.missing_aliases({"mailpit": []}, ["mailpit"]) == ["mailpit"]
    assert al.missing_aliases({"mailpit": ["mailpit"]}, ["mailpit"]) == []
```

- [x] **Step 2: Implement**

```python
"""Attach stable Docker-network aliases to pre-prod ECS task containers.

WORKAROUND(local): Floci gives ECS tasks random names and Cloud Map does not
resolve them; non-HTTP clients (Floci's SES relay → Mailpit SMTP, possibly gRPC
to Users) need a fixed name. A self-healed task loses its alias until this runs
again — preprod-heal does. See [[2026-10-02-floci-preprod-environment-design]]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

from lib3mrai.aws import client
from lib3mrai.console import no, ok

ALIASES = {"mailpit": ("mailpit", "mailpit"), "users-grpc": ("users", "users")}


def docker(*args: str) -> str:
    return subprocess.run(["docker", *args], capture_output=True, text=True).stdout


def container_for(task_ids: set[str], names: list[str], container: str) -> str | None:
    for name in names:
        if name.endswith(f"-{container}") and name.split("-")[2] in task_ids:
            return name
    return None


def missing_aliases(current: dict[str, list[str]], wanted: list[str]) -> list[str]:
    return [a for a in wanted if a not in current.get(a, [])]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cluster", required=True)
    parser.add_argument("--network", required=True)
    parser.add_argument("--aliases", default="mailpit")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    ecs = client("ecs")
    names = docker("ps", "--format", "{{.Names}}").split()
    failures = 0
    for alias in args.aliases.split(","):
        service, container = ALIASES[alias]
        arns = ecs.list_tasks(cluster=args.cluster, serviceName=service)["taskArns"]
        target = container_for({a.rsplit("/", 1)[-1] for a in arns}, names, container)
        if target is None:
            no(f"{alias}: no running task for service {service}")
            failures += 1
            continue
        nets = json.loads(docker("inspect", target, "-f", "{{json .NetworkSettings.Networks}}") or "{}")
        current = {alias: (nets.get(args.network) or {}).get("Aliases") or []}
        if not missing_aliases(current, [alias]):
            ok(f"{alias} → {target}")
            continue
        if args.check:
            no(f"{alias} missing on {target} — run make preprod-heal")
            failures += 1
            continue
        docker("network", "disconnect", args.network, target)
        docker("network", "connect", "--alias", alias, args.network, target)
        ok(f"{alias} attached to {target}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
```

Run tests → 3 passed.

- [x] **Step 3: Verify gRPC through the ALB with the real Users image**

With the stack from Task 8 up (`users_grpc_via_alb = true`):

```bash
docker run --rm --network 3mrai-preprod_preprod-network fullstorydev/grpcurl:v1.9.1 \
  -plaintext -max-time 5 floci:9151 list
```
Then create an order end to end once Task 11 exists (`POST /v1/orders` through the gateway, which makes Orders call Users over gRPC).

Decision rule — record the result in the task handover:
- `grpcurl` returns a service list, or an `Unimplemented`/`Unauthenticated` gRPC status (the transport works) → keep `default = true`.
- `grpcurl` reports `malformed header`, `503`, `connection reset` or an HTTP status → set `default = false` in `variables.tf`, add `users-grpc` to the `--aliases` list in the Makefile (Task 14), re-apply, and confirm `docker run --rm --network 3mrai-preprod_preprod-network busybox:1.36 nc -z users-grpc 50051` exits 0.

- [x] **Step 4: Hand over for commit** — `feat(infra): give pre-prod ECS tasks stable aliases and settle Users gRPC routing`

---

### Task 10: `preprod-deploy` — one service, no restart of the rest

**Files:**
- Modify: `Makefile`

**Interfaces:**
- Consumes: `build_push.py`, `wait_services.py`, `module.service["<svc>"]`.
- Produces: `make preprod-deploy S=<svc> [ENV_ONLY=1]`.

- [x] **Step 1: Target**

```make
preprod-deploy: scripts-setup ## Pre-prod: redeploy one service (S=users|orders|tracking|web|…; ENV_ONLY=1 = config only)
	@test -n "$(S)" || { echo "usage: make preprod-deploy S=<service> [ENV_ONLY=1]"; exit 2; }
ifeq ($(ENV_ONLY),1)
	@# WHY: ECS reads secrets only at task start, so a config change needs new tasks.
	aws ecs update-service --cluster "$$($(PP_TF) output -raw ecs_cluster_name)" --service $(S) --force-new-deployment >/dev/null
else
	$(PY) $(PP_TF_DIR)/scripts/build_push.py --tf-dir $(PP_TF_DIR) --services $(S)
	$(PP_TF) apply -auto-approve -input=false $(PP_TF_VARS) -var deploy_services=true \
	    -target='module.service["$(S)"]'
endif
	$(PY) $(PP_TF_DIR)/scripts/wait_services.py --cluster "$$($(PP_TF) output -raw ecs_cluster_name)"
	$(MAKE) --no-print-directory preprod-smoke
```

- [x] **Step 2: Verify zero failed requests during a rollout** (amended — see Execution notes / Spec amendments)

```bash
( for i in $(seq 1 240); do curl -s -o /dev/null -w '%{http_code}\n' http://localhost:9102/v1/health; sleep 0.5; done ) > /tmp/rollout.txt &
make preprod-deploy S=orders
wait; sort /tmp/rollout.txt | uniq -c
```
Expected: only `200` lines.

- [x] **Step 3: Verify the blast radius**

Run: `make preprod-deploy S=tracking 2>&1 | grep -E 'Plan:|Apply complete'`
Expected: the plan touches only `module.service["tracking"]` resources (task definition replaced, service updated); no `module.api_gateway`, `module.service["users"]` or `module.service["orders"]` addresses appear.

- [x] **Step 4: Verify ENV_ONLY**

```bash
aws --endpoint-url http://localhost:4566 ssm put-parameter --name /3mrai-preprod/tracking/PROGRESSION_INTERVAL_SECONDS --value 6 --overwrite --type String
make preprod-deploy S=tracking ENV_ONLY=1
C=$(docker ps --format '{{.Names}}' | grep -E 'floci-ecs-.*-tracking$'); docker inspect $C -f '{{range .Config.Env}}{{println .}}{{end}}' | grep PROGRESSION
```
Expected: `PROGRESSION_INTERVAL_SECONDS=6`. Restore it with `terraform apply` afterwards.

- [x] **Step 5: Hand over for commit** — `feat(infra): redeploy a single pre-prod service with make preprod-deploy`

---

## Phase F3 — Edge

### Task 11: API Gateway → ALB (no nginx)

**Files:**
- Modify: `infra/modules/api-gateway/variables.tf`, `infra/modules/api-gateway/main.tf` (integrations L190-212)
- Modify: `infra/environments/preprod/services.tf` (add `module "api_gateway"`), `outputs.tf`

**Interfaces:**
- Consumes: `local.routes` (unchanged), `module.cognito.issuer/client_id`.
- Produces: module input `alb_backends` (`map(string)`, default `{}`; keys `users`, `orders`, `tracking`); root output `api_gateway_url` = `http://localhost:4566/restapis/<id>/$default/_user_request_`.

- [x] **Step 1: Variable**

```hcl
variable "alb_backends" {
  type        = map(string)
  default     = {}
  description = "Service → base URI (e.g. users = \"http://localhost:9101\"). Non-empty switches the local gateway from the nginx task to per-service ALB listeners."
}
```

- [x] **Step 2: Integrations**

Replace the `per_route` resource with:

```hcl
locals {
  alb_mode = length(var.alb_backends) > 0
  route_service = {
    for k, r in local.routes : k => (
      can(regex("^/v1/(orders|products|cart)", r.path)) ? "orders" :
      can(regex("^/v1/(trackings|tracking/)", r.path)) ? "tracking" : "users"
    )
  }
}

# LOCAL: one HTTP_PROXY integration per route, path baked into the URI.
resource "aws_apigatewayv2_integration" "per_route" {
  for_each = var.local_gateway ? local.routes : {}

  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = local.alb_mode ? "${var.alb_backends[local.route_service[each.key]]}${each.value.path}" : "${var.nginx_base_uri}${each.value.path}"
  payload_format_version = "1.0"

  # CONTRACT: In ALB mode the gateway does what the nginx task did. Auth routes
  # OVERWRITE x-user-id from the verified token; public routes REMOVE it —
  # overwrite with claims.sub on a route without the authorizer leaves a
  # client-sent value intact (verified on Floci 2.1.0). Health routes map to the
  # services' unprefixed /v1/health. See [[2026-10-02-floci-preprod-environment-design]]
  request_parameters = !local.alb_mode ? null : merge(
    each.value.auth ? { "overwrite:header.x-user-id" = "$context.authorizer.claims.sub" } : { "remove:header.x-user-id" = "''" },
    endswith(each.key, "_health") ? { "overwrite:path" = "/v1/health" } : {},
  )
}
```

- [x] **Step 3: Instantiate in pre-prod** (not gated by `deploy_services`: the integrations target fixed listener ports, so they can exist before the services do)

```hcl
module "label_api" {
  source      = "../../modules/label"
  environment = var.environment
  name        = "api"
}

module "api_gateway" {
  source                   = "../../modules/api-gateway"
  context                  = { id = module.label_api.id, tags = module.label_api.tags }
  cognito_issuer           = module.cognito.issuer
  cognito_audience         = module.cognito.client_id
  local_gateway            = true
  enable_e2e_cleanup_route = true
  enable_tracking_routes   = true
  alb_backends = {
    users    = "http://localhost:9101"
    orders   = "http://localhost:9102"
    tracking = "http://localhost:9103"
  }
}

output "api_id" { value = module.api_gateway.api_id }
output "api_gateway_url" {
  value = "http://localhost:4566/restapis/${module.api_gateway.api_id}/$default/_user_request_"
}
```

- [x] **Step 4: Dev is unchanged** (amended — see Execution notes / Spec amendments)

Run: `terraform -chdir=infra/environments/local plan` (dev stack up)
Expected: `No changes.` — `alb_backends` defaults to `{}`, so dev keeps its nginx integrations and `request_parameters = null`.

- [x] **Step 5: Apply pre-prod and check routing**

```bash
terraform -chdir=infra/environments/preprod apply -auto-approve -var python_bin=$PWD/.venv/bin/python -var deploy_services=true
GW=$(terraform -chdir=infra/environments/preprod output -raw api_gateway_url)
for p in users orders tracking; do curl -s -o /dev/null -w "$p-health %{http_code}\n" "$GW/v1/$p/health"; done
curl -s -o /dev/null -w "me-no-token %{http_code}\n" "$GW/v1/users/me"
```
Expected: three `200`, then `401`.

- [x] **Step 6: The spoof check (Review Focus 2)** (amended — see Execution notes / Spec amendments)

Write a gateway spec through `e2e-impl` (it owns `e2e/`): `e2e/tests/gateway/x-user-id-spoof.gateway.spec.ts` (shipped as `x-user-id-spoof.spec.ts`, following the folder's naming) — register+login a user via `getGatewayToken()`; call `GET /v1/users/me` with the token AND header `x-user-id: forged-<uuid>`; assert the response's user is the token's user (not 404/the forged id). Call a public route (`POST /v1/users/login` with bad credentials) with `x-user-id: forged` and assert it is rejected as a normal bad login (401/400), not authenticated. Run against pre-prod via Task 15's runner: `make preprod-e2e ARGS="--project=gateway x-user-id-spoof"` → green. Also run it against dev (`pnpm --filter @3mrai/e2e exec playwright test --project=gateway x-user-id-spoof`) → green there too.

- [x] **Step 7: Hand over for commit** — `feat(infra): route the pre-prod gateway to per-service ALB listeners without nginx`

---

### Task 12: Web on ECS

**Files:**
- Modify: `apps/web/nginx.conf` (the `/otlp/` location, L222-235)
- Modify: `apps/web/Dockerfile` (L108 filter, add ENV default)
- Modify: `infra/environments/local/scripts/generate_env_files.py` (`.env.local.web` generated box: `OTLP_RUM_UPSTREAM=otel-collector:4319`) and `.env.example`
- Modify: `infra/environments/preprod/services.tf` (web in `parameters` and `services`)

**Interfaces:**
- Produces: env var `OTLP_RUM_UPSTREAM` rendered by nginx envsubst; `module.service["web"]` on listener `9090`.

- [x] **Step 1: Make the RUM upstream configurable**

In `apps/web/nginx.conf` change `set $otlp_collector "otel-collector:4319";` to:

```nginx
        set $otlp_collector "${OTLP_RUM_UPSTREAM}";
```

In `apps/web/Dockerfile` change L108 and add a default right after it:

```dockerfile
ENV NGINX_ENVSUBST_FILTER='^(API_GATEWAY_|GEOAPIFY_|OTLP_RUM_)'
ENV OTLP_RUM_UPSTREAM=otel-collector:4319
```

In `generate_env_files.py`, add `"OTLP_RUM_UPSTREAM": "otel-collector:4319"` to the `.env.local.web` generated mapping, and add the key to `.env.example`'s web section.

- [x] **Step 2: Verify dev is unchanged** (amended — see Execution notes / Spec amendments)

```bash
make env-file && docker compose --env-file .env.local.web up -d --build web
docker compose --env-file .env.local.web exec web grep -n otlp_collector /etc/nginx/conf.d/default.conf
```
Expected: `set $otlp_collector "otel-collector:4319";`.

- [x] **Step 3: Web in pre-prod**

Add to `local.parameters` in `services.tf`:

```hcl
    web = {
      API_GATEWAY_PROXY_HOST = "floci:4566"
      API_GATEWAY_API_ID     = module.api_gateway.api_id
      OTLP_RUM_UPSTREAM      = "floci:4319"
    }
```

and to `local.services`:

```hcl
    web = {
      port = 80, cpu = 256, memory = 512, extra_ports = []
      listeners = { http = { port = 9090, container_port = 80, health_path = "/" } }
    }
```

`module.api_gateway` must not depend on `module.service` (it targets fixed ports), so no cycle arises; `module.app_config` now depends on `module.api_gateway`.

- [x] **Step 4: Verify in the browser path**

```bash
make preprod-deploy S=web
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:9090/
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:9090/orders/123
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:9090/v1/users/health
```
Expected: `200`, `200` (SPA fallback), `200` (proxied to the gateway). Then manually: open `http://localhost:9090`, register, log in, place an order (success criterion 4).

- [x] **Step 5: Hand over for commit** — `feat(web): make the RUM upstream configurable and serve the web app from pre-prod ECS`

---

## Phase F4 — Observability, Mailpit, heal, doctor

### Task 13: Collector and OpenObserve as ECS services

**Files:**
- Create: `observability/collector.Dockerfile`
- Modify: `observability/otel-collector-config.yaml` (exporter endpoints; `/ecs/…-web` classification)
- Modify: `docker-compose.yml` (`otel-collector` env: `O2_ENDPOINT=http://openobserve:5080`)
- Modify: `infra/environments/preprod/services.tf`
- Modify: `Makefile` (`preprod-observability` target)

**Interfaces:**
- Produces: collector env `O2_ENDPOINT`; services `otel-collector` (listeners `4318`, `4319`) and `openobserve` (listener `5080`).

- [x] **Step 1: Collector image**

```dockerfile
# Pre-prod only: ECS cannot bind-mount the repo, so the config ships in the image.
FROM otel/opentelemetry-collector-contrib:0.156.0
COPY observability/otel-collector-config.yaml /etc/otelcol-contrib/config.yaml
CMD ["--config=/etc/otelcol-contrib/config.yaml"]
```

- [x] **Step 2: Parameterise the exporter endpoint**

In `observability/otel-collector-config.yaml`, replace every `http://openobserve:5080` (11 occurrences, L819-944) with `${env:O2_ENDPOINT}`. Add `- O2_ENDPOINT=http://openobserve:5080` to the `otel-collector` service's `environment:` in `docker-compose.yml`.

- [x] **Step 3: Classify the web log group**

In `transform/parse_body`, right after the existing `fluent.tag == "web"` statement (L518-520), add:

```yaml
          # Pre-prod ships web's nginx output through awslogs, not fluentd.
          - set(attributes["service_name"], "web")
            where attributes["service_name"] == nil
              and resource.attributes["cloudwatch.log.group.name"] != nil
              and IsMatch(resource.attributes["cloudwatch.log.group.name"], "^/ecs/.*-web$")
```

- [x] **Step 4: Dev regression check** (amended — see Execution notes / Spec amendments)

Run: `make observability-up && make doctor`
Expected: the Tracing section passes; a fresh request to `http://localhost:3000/v1/health` appears in OpenObserve's `logs` stream within 2 minutes.

- [x] **Step 5: Services in pre-prod**

Add to `local.parameters`:

```hcl
    otel-collector = {
      AWS_ENDPOINT_URL      = "http://floci:4566"
      AWS_REGION            = local.region
      AWS_ACCESS_KEY_ID     = "test"
      AWS_SECRET_ACCESS_KEY = "test"
      O2_ORG                = "3mrai"
      O2_ENDPOINT           = "http://floci:5080"
    }
    openobserve = {
      ZO_ROOT_USER_EMAIL = "admin@3mrai.local"
    }
```

Add to `local.secrets`:

```hcl
    otel-collector = {
      O2_BASIC_AUTH = base64encode("admin@3mrai.local:${random_password.openobserve_root.result}")
    }
    openobserve = {
      ZO_ROOT_USER_PASSWORD = random_password.openobserve_root.result
    }
```

Add to `local.services`:

```hcl
    otel-collector = {
      port = 4318, cpu = 256, memory = 512, extra_ports = [4317, 13133]
      listeners = {
        otlp = { port = 4318, container_port = 4318, health_path = "/" }
        rum  = { port = 4319, container_port = 4319, health_path = "/" }
      }
    }
    openobserve = {
      port = 5080, cpu = 512, memory = 1024, extra_ports = []
      listeners = { http = { port = 5080, container_port = 5080, health_path = "/healthz" } }
    }
```

- [x] **Step 6: Schema, dashboards, verification**

```make
preprod-observability: ## Pre-prod: seed the traces schema and import dashboards into pre-prod's OpenObserve
	@pw="$$($(PP_TF) output -raw openobserve_root_password)"; \
	O2_ORG=3mrai O2_URL=http://localhost:5080 O2_USER=admin@3mrai.local O2_PASSWORD="$$pw" python3 scripts/seed_traces_schema.py; \
	O2_ORG=3mrai O2_URL=http://localhost:5080 O2_USER=admin@3mrai.local O2_PASSWORD="$$pw" node scripts/import-dashboards.mjs
```

Before writing it, read `scripts/seed_traces_schema.py` and `scripts/import-dashboards.mjs` for the env var names they actually read for URL/user/password, and use those names (keep the defaults dev relies on). Add `$(MAKE) --no-print-directory preprod-observability` as the last line of `preprod-up`.

Verify: `make preprod-deploy S=otel-collector && make preprod-deploy S=openobserve && make preprod-observability`, hit `http://localhost:9101/v1/health` a few times, then in OpenObserve (`http://localhost:5080`, password from `terraform output -raw openobserve_root_password`) find `service_name = users` in the `logs` stream and a `users` trace in the traces stream (success criterion 3).

- [x] **Step 7: Hand over for commit** — `feat(observability): run the collector and OpenObserve as pre-prod ECS services`

---

### Task 14: Mailpit, `preprod-heal`, `preprod-doctor`

**Files:**
- Modify: `infra/environments/preprod/services.tf` (mailpit)
- Create: `infra/environments/preprod/scripts/preprod_doctor.py`
- Create: `infra/environments/preprod/scripts/tests/test_preprod_doctor.py`
- Modify: `Makefile`

**Interfaces:**
- Consumes: `floci_heal.py` (`main`), `preprod_aliases.py` (`--check`), `doctor.backing_state`.
- Produces: targets `preprod-aliases`, `preprod-heal`, `preprod-doctor`; `unhealthy_targets(descriptions: list[dict]) -> list[str]`.

- [x] **Step 1: Mailpit service**

`local.parameters`: `mailpit = { MP_MAX_MESSAGES = "5000" }`. `local.services`:

```hcl
    mailpit = {
      port = 8025, cpu = 256, memory = 256, extra_ports = [1025]
      listeners = { http = { port = 8025, container_port = 8025, health_path = "/api/v1/info" } }
    }
```

- [x] **Step 2: Failing doctor test**

```python
import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "preprod_doctor.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
_spec = importlib.util.spec_from_file_location("preprod_doctor", SCRIPT)
pd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pd)


def test_unhealthy_targets():
    descs = [
        {"Target": {"Id": "10.0.0.1"}, "TargetHealth": {"State": "healthy"}},
        {"Target": {"Id": "10.0.0.2"}, "TargetHealth": {"State": "unhealthy"}},
        {"Target": {"Id": "10.0.0.3"}, "TargetHealth": {"State": "initial"}},
    ]
    assert pd.unhealthy_targets(descs) == ["10.0.0.2"]
```

- [x] **Step 3: Implement `preprod_doctor.py`**

```python
"""Diagnose pre-prod: ECS vs containers, ALB targets, aliases, phantom stores.

WARNING: Floci leaves target health at `initial` indefinitely while routing
traffic; only `unhealthy` is a failure here.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from lib3mrai.aws import client
from lib3mrai.console import no, ok

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
from doctor import backing_state  # noqa: E402


def unhealthy_targets(descriptions: list[dict]) -> list[str]:
    return [d["Target"]["Id"] for d in descriptions if d["TargetHealth"]["State"] == "unhealthy"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cluster", required=True)
    parser.add_argument("--network", required=True)
    parser.add_argument("--redis-host", required=True)
    parser.add_argument("--docdb-host", required=True)
    parser.add_argument("--aliases", default="mailpit")
    args = parser.parse_args(argv)
    failures = 0

    ecs = client("ecs")
    ecs.list_clusters()  # WORKAROUND(local): wakes Floci's lazy ECS reconciler.
    arns = ecs.list_services(cluster=args.cluster)["serviceArns"]
    for svc in ecs.describe_services(cluster=args.cluster, services=arns)["services"] if arns else []:
        if svc["runningCount"] < svc["desiredCount"]:
            no(f"ECS {svc['serviceName']}: {svc['runningCount']}/{svc['desiredCount']}")
            failures += 1
        else:
            ok(f"ECS {svc['serviceName']}: {svc['runningCount']}/{svc['desiredCount']}")

    elb = client("elbv2")
    for tg in elb.describe_target_groups()["TargetGroups"]:
        bad = unhealthy_targets(elb.describe_target_health(TargetGroupArn=tg["TargetGroupArn"])["TargetHealthDescriptions"])
        if bad:
            no(f"ALB {tg['TargetGroupName']}: unhealthy {bad}")
            failures += 1

    for host in (args.redis_host, args.docdb_host):
        state = backing_state(host)
        if state == "running":
            ok(f"{host} running")
        else:
            no(f"{host} is {state} — {'make preprod-heal' if state == 'exited' else 'make preprod-down && make preprod-up'}")
            failures += 1

    alias_rc = subprocess.run([sys.executable, str(Path(__file__).with_name("preprod_aliases.py")),
                               "--cluster", args.cluster, "--network", args.network,
                               "--aliases", args.aliases, "--check"]).returncode
    failures += alias_rc
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
```

Run the test → passes.

- [x] **Step 4: Makefile targets**

```make
PP_ALIASES := mailpit

preprod-aliases: scripts-setup ## Pre-prod: attach stable Docker aliases to ECS tasks
	$(PY) $(PP_TF_DIR)/scripts/preprod_aliases.py --cluster "$$($(PP_TF) output -raw ecs_cluster_name)" --network $(PP_NETWORK) --aliases $(PP_ALIASES)

preprod-heal: scripts-setup ## Pre-prod: recover after a Floci/Docker restart, then re-attach aliases
	$(PY) infra/scripts/floci_heal.py
	$(PY) $(PP_TF_DIR)/scripts/wait_services.py --cluster "$$($(PP_TF) output -raw ecs_cluster_name)"
	$(MAKE) --no-print-directory preprod-aliases

preprod-doctor: scripts-setup ## Pre-prod: ECS vs containers, ALB targets, aliases, phantom stores
	$(PY) $(PP_TF_DIR)/scripts/preprod_doctor.py --cluster "$$($(PP_TF) output -raw ecs_cluster_name)" \
	    --network $(PP_NETWORK) --aliases $(PP_ALIASES) \
	    --redis-host "$$($(PP_TF) output -raw redis_host)" --docdb-host "$$($(PP_TF) output -raw docdb_host)"
```

If Task 9 chose the alias path, set `PP_ALIASES := mailpit,users-grpc`. Insert `$(MAKE) --no-print-directory preprod-aliases` in `preprod-up` right after `wait_services.py`.

- [x] **Step 5: Verify mail and the heal loop**

```bash
make preprod-up
# trigger an email (register a user through the gateway), then:
curl -s http://localhost:8025/api/v1/messages | python3 -c 'import sys,json;print(json.load(sys.stdin)["total"])'
docker kill $(docker ps --format '{{.Names}}' | grep -E 'floci-ecs-.*-mailpit$')
sleep 20; make preprod-doctor   # expected: mailpit alias missing → exit 1
make preprod-heal && make preprod-doctor   # expected: exit 0
docker compose -f docker-compose.preprod.yml restart floci && make preprod-heal && make preprod-doctor   # exit 0, data kept
```
Expected: message total ≥ 1; doctor fails then passes as annotated.

- [x] **Step 6: Hand over for commit** — `feat(infra): add Mailpit, preprod-heal and preprod-doctor`

---

## Phase F5 — Validation and documentation

### Task 15: E2E and Gatling against pre-prod

**Files:**
- Create: `infra/environments/preprod/scripts/e2e_env.py`
- Create: `infra/environments/preprod/scripts/tests/test_e2e_env.py`
- Modify: `Makefile` (`preprod-e2e`, `preprod-load-test`)

**Interfaces:**
- Produces: `env_from_outputs(outputs: dict[str, str]) -> dict[str, str]`; CLI `e2e_env.py --tf-dir DIR -- <command…>` (execs the command with the env).

- [x] **Step 1: Failing test**

```python
import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "e2e_env.py"
sys.path.insert(0, str(Path(__file__).resolve().parents[5] / "infra" / "scripts"))
_spec = importlib.util.spec_from_file_location("e2e_env", SCRIPT)
ee = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ee)


def test_env_from_outputs_keeps_literal_default():
    env = ee.env_from_outputs({
        "api_gateway_url": "http://localhost:4566/restapis/abc/$default/_user_request_",
        "internal_api_key": "k", "carrier_api_key": "c", "e2e_query_token": "t",
        "events_query_url": "http://q", "ws_url": "ws://w",
        "notifications_queue_url": "http://n", "events_topic_arn": "arn:t",
        "openobserve_root_password": "p",
    })
    assert env["API_GATEWAY_URL"].endswith("/$default/_user_request_")
    assert env["USERS_BASE_URL"] == "http://localhost:9101"
    assert env["ORDERS_BASE_URL"] == "http://localhost:9102"
    assert env["TRACKING_BASE_URL"] == "http://localhost:9103"
    assert env["MAILPIT_API_URL"] == "http://localhost:8025/api/v1"
    assert env["WEB_BASE_URL"] == "http://localhost:9090"
    assert env["TRACKING_CARRIER_API_KEY"] == "c"
```

- [x] **Step 2: Implement**

```python
"""Run a command with the pre-prod endpoints and keys in its environment.

CONTRACT: Exec, never print `export` lines — API_GATEWAY_URL carries a literal
`$default` that a shell would expand. Pre-set values win in playwright.config.ts
(dotenv never overwrites), so stale dev `.env.local.*` files cannot leak in.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

KEYS = ["api_gateway_url", "internal_api_key", "carrier_api_key", "e2e_query_token",
        "events_query_url", "ws_url", "notifications_queue_url", "events_topic_arn",
        "openobserve_root_password"]


def env_from_outputs(o: dict[str, str]) -> dict[str, str]:
    return {
        "API_GATEWAY_URL": o["api_gateway_url"],
        "USERS_BASE_URL": "http://localhost:9101",
        "ORDERS_BASE_URL": "http://localhost:9102",
        "TRACKING_BASE_URL": "http://localhost:9103",
        "WEB_BASE_URL": "http://localhost:9090",
        "MAILPIT_API_URL": "http://localhost:8025/api/v1",
        "OPENOBSERVE_URL": "http://localhost:5080",
        "OPENOBSERVE_USER": "admin@3mrai.local",
        "OPENOBSERVE_PASSWORD": o["openobserve_root_password"],
        "INTERNAL_API_KEY": o["internal_api_key"],
        "TRACKING_CARRIER_API_KEY": o["carrier_api_key"],
        "E2E_QUERY_TOKEN": o["e2e_query_token"],
        "EVENTS_QUERY_URL": o["events_query_url"],
        "WS_URL": o["ws_url"],
        "NOTIFICATIONS_QUEUE_URL": o["notifications_queue_url"],
        "EVENTS_TOPIC_ARN": o["events_topic_arn"],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tf-dir", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    raw = json.loads(subprocess.run(["terraform", f"-chdir={args.tf_dir}", "output", "-json"],
                                    capture_output=True, text=True, check=True).stdout)
    outputs = {k: raw[k]["value"] for k in KEYS}
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    os.execvpe(command[0], command, {**os.environ, **env_from_outputs(outputs)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Run the test → passes.

- [x] **Step 3: Targets**

```make
preprod-e2e: scripts-setup ## Pre-prod: Playwright (ARGS="--project=gateway …" to narrow)
	$(PY) $(PP_TF_DIR)/scripts/e2e_env.py --tf-dir $(PP_TF_DIR) -- pnpm --filter @3mrai/e2e exec playwright test $(ARGS)

preprod-load-test: scripts-setup ## Pre-prod: Gatling fullJourney
	cd e2e/load-tests && $(PY) ../../$(PP_TF_DIR)/scripts/e2e_env.py --tf-dir ../../$(PP_TF_DIR) -- pnpm run load
```

- [x] **Step 4: Success criteria 1 and 2** (amended — see Execution notes / Spec amendments)

```bash
nvm use
make preprod-e2e ARGS="--project=gateway --project=gateway-tracking --project=email"
make preprod-load-test
```
Expected: gateway suites green; Gatling completes with its assertions passing. A failure that also fails on dev at the same commit is recorded, not fixed here; a pre-prod-only failure is a defect of this plan and gets its own fix + review (no silent fix).

- [x] **Step 5: Hand over for commit** — `test(e2e): run the gateway suite and Gatling against pre-prod`

---

### Task 16: Environment checks (the spec's own criteria)

**Files:** none (verification only; record results in the handover)

- [x] **Step 1: Redeploy without failed requests** — repeat Task 10 Step 2 for `users` and `web` (`http://localhost:9090/`). Expected: only `200`. (amended — see Execution notes / Spec amendments)
- [x] **Step 2: Restart keeps data** — create an order; `docker compose -f docker-compose.preprod.yml restart floci && make preprod-heal`; `GET /v1/orders/my-orders` through the gateway returns the order; an events-pipeline read (`EVENTS_QUERY_URL`) still returns the order's events (DocumentDB kept).
- [x] **Step 3: Teardown leaves nothing** — `make preprod-down`; `docker ps -a --format '{{.Names}}' | grep -cE '^(floci-|3mrai-preprod)'` → `0`; `docker volume ls -q | grep -cE 'floci-|3mrai-preprod'` → `0`.
- [ ] **Step 4: Exclusivity both ways** — with pre-prod up, `make up` prompts; answer `n` → exits 1, pre-prod untouched. With dev up, `make preprod-up < /dev/null` → aborts (no TTY), dev untouched. (no-TTY abort verified with pre-prod up; dev-up direction not run)

---

### Task 17: Documentation propagation and the audit gate

**Files (all via `obsidian-vault`, English):**
- Update spec `docs/superpowers/specs/2026-10-02-floci-preprod-environment-design.md` with the five amendments at the top of this plan.
- Create `docs/shared/conventions/environment-exclusivity.md` (convention; the guard, the prompt, no-TTY abort, why: `:4566` + ECR coupling).
- Create `docs/infrastructure/runbooks/preprod.md` (targets table, ports table, heal/doctor, redeploy, teardown).
- Create `docs/shared/decisions/ADR-0022-preprod-ecs-on-floci.md` (topology: API GW → per-service ALB listeners → ECS; SSM/Secrets; no nginx in pre-prod).
- Update `[[ADR-0016-local-apigw-nginx-ecs]]` (nginx remains for dev only; the claim-to-header limitation it documents no longer holds on Floci 2.1.0), `[[local-dev-floci]]`, `[[local-dev]]`, `[[aws-resources]]`, `[[terraform-modules]]` (new modules `ecr`, `app-config`, `alb`, `ecs-service`; `api-gateway.alb_backends`), `[[env-files]]` (pre-prod has none; `OTLP_RUM_UPSTREAM`).
- Link the plan from `docs/plans/index.md`; add the new notes to the spec's `propagates-to`.

- [x] **Step 1: Dispatch `obsidian-vault`** with the list above and the facts from Tasks 1-16; run `nvm use && node scripts/validate-vault.mjs` → green.
- [x] **Step 2: Run the `spec-implementation-audit` skill** (spec → code, code → docs, plan → repo). Close each gap; a real code defect gets its own change and review. (audit and its re-run complete)
- [x] **Step 3: Hand over for commit** — `docs(infra): propagate the pre-prod environment into the vault`

## Related

- [[2026-10-02-floci-preprod-environment-design]]
- [[2026-10-02-dev-stack-floci-2-1]]
- [[local-dev-floci]]
- [[local-dev]]
- [[aws-resources]]
- [[terraform-modules]]
- [[env-files]]
- [[ADR-0016-local-apigw-nginx-ecs]]
- [[ADR-0022-preprod-ecs-on-floci]]
- [[environment-exclusivity]]
- [[preprod]]
- [[2026-10-03-floci-preprod-alb-and-ecs-behaviours]]
- [[2026-10-03-floci-preprod-follow-ups]]
