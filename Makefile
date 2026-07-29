# Local development orchestration for 3MRAI.
# Run `make help` (the default) to list targets.
# Two layers: docker-compose (Floci + services) and Terraform against Floci.

COMPOSE      := docker compose
TF_LOCAL_DIR := infra/environments/local
TF           := terraform -chdir=$(TF_LOCAL_DIR)
FLOCI_URL    := http://localhost:4566
ENV_FILE     := .env

# Python interpreter for the infra scripts. ABSOLUTE on purpose: neither this
# Makefile nor Terraform's local-exec may depend on whichever `python3` sits on
# PATH — a developer's shell can already be inside an unrelated venv, and an
# apply must never silently pick up a stray interpreter. `make scripts-setup`
# creates it; the apply-triggering targets depend on that, so it is invisible.
REPO_ROOT := $(shell pwd)
VENV      := $(REPO_ROOT)/.venv
PY        := $(VENV)/bin/python

# Single reusable per-engine RDS-proxy-port discovery. Floci assigns those ports
# (7000-7099) by cluster CREATION ORDER, which is NOT stable across applies, so
# postgres/mysql can flip between 7001/7002. This script reads the port for a
# given engine from `describe-db-clusters` (which exposes Engine per cluster) —
# never hardcode 7001=Postgres / 7002=MySQL. Also imported by bootstrap.py.
DISCOVER_DB_PORT := $(TF_LOCAL_DIR)/scripts/discover_db_port.py

# Terraform talks to Floci through the host-published port; the AWS provider in
# environments/local/providers.tf pins every endpoint to localhost:4566.
export AWS_ENDPOINT_URL    ?= $(FLOCI_URL)
export AWS_DEFAULT_REGION  ?= us-east-1
export AWS_ACCESS_KEY_ID   ?= test
export AWS_SECRET_ACCESS_KEY ?= test

.DEFAULT_GOAL := help

.PHONY: help up down logs build ps test-unit test-e2e test-all backend-up infra-init infra-plan infra-up infra-up-post infra-down infra-output env-file migrate bootstrap clean observability-up observability-down observability-dashboards scripts-setup

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

## --- Python infra scripts ---

scripts-setup: $(PY) ## Create .venv and install the infra script package (idempotent)

$(PY):
	@# A FILE target, so this is naturally idempotent: once the interpreter
	@# exists, make skips the recipe. Every apply-triggering target depends on
	@# scripts-setup, so a fresh clone can't hit a cryptic "python: not found"
	@# from inside a terraform local-exec.
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -q --upgrade pip
	$(VENV)/bin/pip install -q -e infra/scripts
	@echo "infra script venv ready at $(VENV)"

## --- Docker Compose ---

up: ## Start the stack (Floci + services) in the background
	$(COMPOSE) up -d

down: ## Stop the stack
	$(COMPOSE) down

logs: ## Tail logs (optional: make logs S=users)
	$(COMPOSE) logs -f $(S)

build: ## Build service images
	$(COMPOSE) build

ps: ## Show container status
	$(COMPOSE) ps

## --- Tests (the three-layer convention: docs/shared/conventions/testing.md) ---

test-unit: ## Layer 1 — unit/integration for both services (orders dotnet, users vitest) + e2e typecheck. No stack needed.
	dotnet test services/orders/Orders.sln
	pnpm --filter @3mrai/users test
	pnpm --filter @3mrai/e2e typecheck

test-e2e: ## Layers 2+3 — Playwright internal + gateway for both services. REQUIRES `make bootstrap` up.
	pnpm --filter @3mrai/e2e test

test-all: ## All three layers for both services (unit + internal E2E + gateway E2E). E2E needs the stack up.
	$(MAKE) test-unit
	$(MAKE) test-e2e

## --- Terraform (against Floci) ---

backend-up: ## Create the remote-state bucket + lock table in Floci (idempotent; local state)
	terraform -chdir=$(TF_LOCAL_DIR)/backend init
	terraform -chdir=$(TF_LOCAL_DIR)/backend apply -auto-approve

infra-init: ## terraform init (environments/local) into the S3 backend
	$(TF) init -reconfigure -backend-config=backend.hcl

infra-plan: ## terraform plan (environments/local)
	$(TF) plan

infra-up: scripts-setup ## terraform apply -auto-approve (environments/local), then refresh .env
	$(TF) apply -auto-approve
	$(MAKE) env-file

infra-down: ## terraform destroy -auto-approve (environments/local)
	$(TF) destroy -auto-approve

infra-output: ## Show terraform outputs (Cognito IDs, etc.)
	$(TF) output

env-file: scripts-setup ## Generate every env file from terraform outputs (CUSTOM sections preserved)
	@# Floci mints a new user-pool/client id and api id on every apply, and
	@# reassigns the RDS proxy ports by cluster creation order, so none of these
	@# values can be hand-maintained. The generator writes five files, one per
	@# consumer (root .env for compose interpolation, one per service for
	@# `env_file:`, infra for the E2E suite, debug for a host SQL client) and
	@# rewrites ONLY each file's AUTO-GENERATED box — anything under CUSTOM
	@# survives. See docs/superpowers/specs/2026-07-20-env-file-generation-design.md
	$(PY) $(TF_LOCAL_DIR)/scripts/generate_env_files.py

## --- Database migrations ---

migrate: ## Apply Prisma migrations (users) against Floci's Postgres (idempotent)
	@# `prisma migrate deploy` (never `migrate dev`: that one is interactive and
	@# can reset data — unsuitable for bootstrap). It must run as the cluster
	@# SUPERUSER (test/test), because migrations run DDL and users_app
	@# deliberately has none (ADR-0004: soft-delete enforced at grant level).
	@# It must ALSO be the same role the post-effects apply's ALTER DEFAULT
	@# PRIVILEGES runs as, so users_app correctly inherits SELECT/INSERT/UPDATE
	@# on the tables this step creates — do not change to a different DB user.
	@#
	@# Runs inside the compose network via the `deps` build stage (the users
	@# Dockerfile already assembles it: workspace deps + prisma CLI + prisma/
	@# for @3mrai/users). We reuse that stage instead of publishing Floci's
	@# Postgres proxy port to the host — the port is Floci-internal and, per
	@# Floci's RDS proxy range (7000-7099) assigned by creation order, not
	@# guaranteed to stay 7001; staying in-network avoids depending on it as a
	@# host contract. Inside the compose network the host is `floci` and the port
	@# is the SAME proxy port describe-db-clusters reports, so we DISCOVER it
	@# per-engine (never hardcode 7001) and interpolate it into the URL.
	@# The users runtime image is production-only and has no prisma CLI/prisma/
	@# dir, so it cannot run this itself (see services/users/Dockerfile).
	docker build --target deps -t 3mrai-users:deps -f services/users/Dockerfile .
	@pgport="$$($(PY) $(DISCOVER_DB_PORT) postgres)"; \
	docker run --rm --network 3mrai_3mrai-network \
		-e DATABASE_WRITER_URL="postgres://test:test@floci:$$pgport/users" \
		-w /app/services/users \
		3mrai-users:deps \
		node node_modules/prisma/build/index.js migrate deploy --schema=./prisma/schema.prisma
	@echo "Prisma migrations applied."

infra-up-post: scripts-setup ## Phase 2: create DB app-users in Terraform (post-effects), after phase 1
	@# Two-phase apply (see docs/superpowers/specs/2026-07-15-two-phase-post-effects-design.md
	@# and environments/local/post/README.md): a SEPARATE Terraform root with its
	@# own state that reads phase-1 outputs + the master secret by ARN, waits for
	@# each DB via a healthcheck gate, and creates the least-privilege app-users
	@# (SELECT/INSERT/UPDATE, no DELETE — ADR-0004). Local enables postgres only
	@# (users_app); the mysql provider hangs on Floci so orders_app is prod-only.
	@# Runs host-side, reaching Floci's published RDS proxy ports (7000-7010).
	@# DISCOVER the Postgres proxy port per-engine and pass it as -var pg_port:
	@# Floci assigns those ports by creation order and they can flip across
	@# applies, so the variable's default (7001) is not reliable. (mysql is
	@# gated off locally; pass -var mysql_port=... too if it is ever enabled.)
	pgport="$$($(PY) $(DISCOVER_DB_PORT) postgres)"; \
	cd $(TF_LOCAL_DIR)/post && terraform init -reconfigure -backend-config=backend.hcl >/dev/null && terraform apply -auto-approve -var pg_port=$$pgport -var python_bin=$(PY)

## --- Orchestration ---

bootstrap: scripts-setup ## Bring the whole local chain up from scratch, in dependency order
	@# Order matters. The services cannot start before the infra exists: `users`
	@# validates COGNITO_* with Zod at boot, and those IDs only exist after apply.
	@# So: Floci first, then terraform, then .env, then migrations (DB needs
	@# tables before it's usable), then bootstrap.py (nginx alias), and only
	@# then the services.
	$(COMPOSE) up -d floci
	@echo "Waiting for Floci at $(FLOCI_URL) ..."
	@for i in $$(seq 1 30); do \
		if curl -sf -o /dev/null "$(FLOCI_URL)"; then echo "Floci is up."; break; fi; \
		if [ $$i -eq 30 ]; then echo "Floci did not become ready in time." >&2; exit 1; fi; \
		sleep 1; \
	done
	$(MAKE) backend-up
	$(MAKE) infra-init
	@# infra-up ends by calling env-file, so every generated env file exists
	@# BEFORE any service starts. That ordering is load-bearing now that the
	@# services read .env.local.<service> via compose `env_file:` — starting
	@# them first would mean starting against a missing or stale file.
	$(MAKE) infra-up
	$(MAKE) migrate
	$(COMPOSE) up -d --build users
	$(PY) $(TF_LOCAL_DIR)/bootstrap.py
	@# Phase 2 (post-effects): create the least-privilege DB app-users in
	@# Terraform now that the clusters exist and migrations have run. Replaces the
	@# app-user step formerly in bootstrap.sh (bootstrap.py only manages the nginx alias).
	$(MAKE) infra-up-post
	@# Orders migrates + seeds ITSELF on startup (SEED_ON_STARTUP=true in
	@# compose): the Api applies EF Core migrations then ProductSeed against
	@# Floci's MySQL before serving. This differs from Users (Prisma via `make
	@# migrate`) because no Aurora-MySQL cluster is provisioned in infra yet, so
	@# there is no standalone migrate target to run — the service owns its schema
	@# locally. Bring it up after users so the Users gRPC gate (users:50051) is
	@# reachable for POST /v1/orders.
	$(COMPOSE) up -d --build orders

clean: ## Tear down infra + compose (prompts before removing ./data)
	-$(TF) destroy -auto-approve
	$(COMPOSE) down
	@printf "Remove ./data (local emulator state)? [y/N] "; read ans; \
		if [ "$$ans" = "y" ] || [ "$$ans" = "Y" ]; then rm -rf ./data && echo "removed ./data"; else echo "kept ./data"; fi

observability-up: ## Start OpenObserve + the OTel collector (opt-in; ~512MB-1.5GB RAM)
	# --force-recreate, scoped to just these two services: they sit outside the main
	# up/down cycle, so a recreated stack network can leave them stranded on a dead
	# network (exit 128, "network ... not found"). Recreating them re-attaches to the
	# current network. Naming the services keeps --force-recreate from bouncing the
	# whole app stack.
	$(COMPOSE) --profile observability up -d --force-recreate openobserve otel-collector
	@echo "OpenObserve UI on http://localhost:5080 once it's healthy (~5s)."
	@echo "Login: admin@3mrai.local / Complexpass#123"

observability-down: ## Stop the observability stack (leaves the rest running)
	$(COMPOSE) stop openobserve otel-collector

observability-dashboards: ## Import/update OpenObserve dashboards from observability/dashboards/*.dashboard.json (idempotent)
	node scripts/import-dashboards.mjs
