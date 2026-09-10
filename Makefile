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

# CONTRACT: Both entries are required — the goenv SHIM dir (which puts `go` on PATH
# at the version .go-version pins) and the directory holding `goenv` itself, which the
# shim re-execs. Resolved rather than hardcoded because goenv is a git checkout for
# some installs and Homebrew for others. Empty when goenv is absent, which is
# harmless: the service's own verify-toolchain target reports the missing toolchain.
GOENV_ROOT := $(HOME)/.goenv
GOENV_BIN  := $(dir $(shell command -v goenv 2>/dev/null))
GOENV_PATH := $(GOENV_ROOT)/shims:$(GOENV_BIN)

# Terraform talks to Floci through the host-published port; the AWS provider in
# environments/local/providers.tf pins every endpoint to localhost:4566.
export AWS_ENDPOINT_URL    ?= $(FLOCI_URL)
export AWS_DEFAULT_REGION  ?= us-east-1
export AWS_ACCESS_KEY_ID   ?= test
export AWS_SECRET_ACCESS_KEY ?= test

# WHY: The DynamoDB table the provisioning scripts record their runs to, for
# traceability only — never to skip a re-run (lib3mrai/execution_log.py explains why).
# Exported like AWS_ENDPOINT_URL so terraform and every local-exec it spawns inherit it.
#
# CONTRACT: A literal, not a terraform_remote_state read of environments/local/backend.
# That root deliberately keeps LOCAL state (it creates the bucket every other root's
# backend points at), so reading it would need a `backend = "local"` data source
# hardcoding a relative path between two roots — a mechanism used nowhere here. The name
# is deterministic ("<context.id>-execution-log"), `?=` yields to an environment
# override, and the backend root exposes execution_log_table_name to confirm it.
# See [[terraform-remote-state-backend]]
export EXECUTION_LOG_TABLE ?= 3mrai-local-tfstate-execution-log

.DEFAULT_GOAL := help

.PHONY: help up down logs build ps test-unit test-e2e test-all load-test load-test-smoke cache-toggle load-test-cache-ab-on load-test-cache-ab-off backend-up infra-init infra-plan lambda-bundles infra-up post-infra infra-down infra-output env-file migrate migrate-tracking assets-sync bootstrap bootstrap-provision bootstrap-converge doctor clean observability-up observability-down observability-dashboards observability-traces-schema redeploy-lambdas scripts-setup lint-comments lint-comments-diff install-comment-hook ai-sync ai-sync-check

help: ## List available targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
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

## --- Code-comment convention ---

# The linter is stdlib-only and must run before scripts-setup creates the repo
# venv. Prefer the absolute repo interpreter when present; otherwise fall back
# to python3 so a fresh clone can still run the gate.
COMMENT_PY       := $(if $(wildcard $(PY)),$(PY),python3)
COMMENT_DIFF_REF ?= main

lint-comments: ## Check the whole repo for new code-comment violations
	@command -v "$(COMMENT_PY)" >/dev/null 2>&1 \
	  || { echo "ERROR: Python 3 is required to lint code comments"; exit 1; }
	@$(COMMENT_PY) scripts/validate-comments.py --all --root . \
	  --strict-narrative \
	  || { status=$$?; echo "ERROR: code-comment lint failed"; exit $$status; }

lint-comments-diff: ## Check code-comment violations in the diff (COMMENT_DIFF_REF=main)
	@command -v "$(COMMENT_PY)" >/dev/null 2>&1 \
	  || { echo "ERROR: Python 3 is required to lint code comments"; exit 1; }
	@$(COMMENT_PY) scripts/validate-comments.py --diff "$(COMMENT_DIFF_REF)" --root . \
	  --strict-narrative \
	  || { status=$$?; echo "ERROR: diff-scoped code-comment lint failed"; exit $$status; }

install-comment-hook: ## Install the staged code-comment pre-commit hook
	@hook_dir="$$(git rev-parse --git-path hooks 2>/dev/null)" \
	  || { echo "ERROR: not inside a Git working tree"; exit 1; }; \
	if test -e "$$hook_dir/pre-commit" \
	   && ! cmp -s .githooks/pre-commit "$$hook_dir/pre-commit"; then \
	  echo "ERROR: $$hook_dir/pre-commit already exists and differs; preserve or remove it first"; \
	  exit 1; \
	fi; \
	mkdir -p "$$hook_dir"; \
	install -m 0755 .githooks/pre-commit "$$hook_dir/pre-commit"; \
	echo "Installed $$hook_dir/pre-commit"

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

test-unit: ## Layer 1 — unit/integration for orders (dotnet), users + both Lambdas + the Cognito trigger + the web app (vitest), tracking (go test) + e2e typecheck. Tracking needs the local DB.
	dotnet test services/orders/Orders.sln
	pnpm --filter @3mrai/users test
	# Safe in the no-stack layer: the events-pipeline suites that need real
	# infrastructure guard themselves. The DocumentDB suite skips when DOCDB_* is
	# absent and the Mailpit suite skips when :8025 does not answer, both printing
	# why and how to run them for real. Set EVENTS_PIPELINE_REQUIRE_INTEGRATION=1
	# where the stack IS expected to turn those skips into hard failures.
	pnpm --filter @3mrai/events-pipeline test
	# CONTRACT: Keep realtime-events and cognito-otp-challenge-lambda listed here. Both
	# have suites that nothing else invokes, and a suite nobody runs is worse than none:
	# it reads as coverage in review and cannot fail. The Cognito trigger is a workspace
	# for this reason alone; archive_file excludes what that adds so the deployed zip is
	# unchanged (see infra/modules/cognito/main.tf).
	pnpm --filter @3mrai/realtime-events test
	pnpm --filter @3mrai/cognito-otp-challenge-lambda test
	# CONTRACT: The web app's specs are layer 1 and belong in this target — they include
	# the auth unit layer the testing convention requires, and they need no stack
	# (component/unit level, HTTP stubbed).
	pnpm --filter @3mrai/web test
	# CONTRACT: `test-db`, NOT `test`. internal/adapter/mysql's tests need a real MySQL;
	# without one they skip while the package still prints `ok`, and that hollow green
	# already cost the migration a debugging session. Without the stack up, use
	# `make -C services/tracking-go test-no-db`, which skips loudly.
	#
	# CONTRACT: Keep GOENV_PATH prepended. goenv is activated by a shell rc file and make
	# recipes run under a NON-interactive /bin/sh that sources none, so a bare `go` here
	# is `go: command not found` even where the terminal resolves it fine. It carries the
	# SHIM dir (so .go-version stays the single source of truth) and goenv's OWN dir,
	# because the shim re-execs `goenv` and fails with "exec: goenv: not found" without it.
	# See [[testing]]
	PATH="$(GOENV_PATH):$$PATH" $(MAKE) -C services/tracking-go test-db
	pnpm --filter @3mrai/e2e typecheck

test-e2e: ## Layers 2+3 — Playwright internal + gateway for both services. REQUIRES `make bootstrap` up.
	pnpm --filter @3mrai/e2e test

load-test: ## Gatling load simulation (fullJourney). REQUIRES `make bootstrap` up.
	@# CONTRACT: Export these three explicitly, and keep API_GATEWAY_URL quoted through.
	@# Gatling runs on GraalVM and does NOT inherit a .env, so without them the run dies
	@# at load time with "API_GATEWAY_URL is not set"; the URL contains a literal
	@# `$$default` stage segment, and an unquoted expansion silently yields
	@# .../restapis/<id>//_user_request_ — a 404 that reads as a routing bug.
	@#
	@# WHY: TRACKING_CARRIER_API_KEY (the prefixed name the simulation reads) drives the
	@# carrier webhook, because load tests send NEITHER x-e2e-source NOR x-test-mode and
	@# their data persists like real traffic. GRPC_API_KEY drives the pre-run restock
	@# step: load runs are never cleaned up, so without it the catalogue empties across
	@# runs and orders fail for want of stock rather than under contention.
	@# See [[testing]]
	cd e2e/load-tests && \
	  API_GATEWAY_URL="$$(grep '^API_GATEWAY_URL=' ../../.env.local.infra | cut -d= -f2-)" \
	  TRACKING_CARRIER_API_KEY="$$(grep '^TRACKING_CARRIER_API_KEY=' ../../.env.local.tracking | cut -d= -f2-)" \
	  GRPC_API_KEY="$$(grep '^GRPC_API_KEY=' ../../.env.local.orders | cut -d= -f2-)" \
	  pnpm run load

load-test-smoke: ## Short Gatling run (~20s) to check the simulation still works.
	cd e2e/load-tests && \
	  API_GATEWAY_URL="$$(grep '^API_GATEWAY_URL=' ../../.env.local.infra | cut -d= -f2-)" \
	  TRACKING_CARRIER_API_KEY="$$(grep '^TRACKING_CARRIER_API_KEY=' ../../.env.local.tracking | cut -d= -f2-)" \
	  GRPC_API_KEY="$$(grep '^GRPC_API_KEY=' ../../.env.local.orders | cut -d= -f2-)" \
	  pnpm run smoke

cache-toggle: ## Flip CACHE_ENABLED in all three env files + restart. Usage: make cache-toggle V=false
	@# CONTRACT: CACHE_ENABLED lives in the CUSTOM box of each generated env file, which
	@# `make env-file` preserves verbatim. Editing the AUTO box instead is silently
	@# reverted on the next apply. See [[env-files]]

	@# WHY: `sed -i ''` is the BSD/macOS spelling this repo's tooling assumes; on GNU sed
	@# it is a bare `-i`. Shell rather than Python because a Make recipe IS shell — the
	@# Python-first rule governs standalone scripts, not in-recipe glue.
	@test -n "$(V)" || { echo "Usage: make cache-toggle V=true|false"; exit 1; }
	@for f in .env.local.orders .env.local.tracking .env.local.users; do \
	  grep -q '^CACHE_ENABLED=' $$f || { echo "CACHE_ENABLED missing from $$f — is Task 1 merged?"; exit 1; }; \
	  sed -i '' "s/^CACHE_ENABLED=.*/CACHE_ENABLED=$(V)/" $$f; \
	  echo "$$f: $$(grep '^CACHE_ENABLED=' $$f)"; \
	done
	@# The flag is read at process start, so the services MUST be restarted for
	@# it to take effect. `--force-recreate` because compose does NOT recreate a
	@# container merely because its env_file changed on disk.
	docker compose up -d --force-recreate users orders tracking
	@echo "Waiting for the three services to answer their health checks..."
	@until curl -sf http://localhost:3000/v1/health >/dev/null; do sleep 1; done
	@until curl -sf http://localhost:3001/v1/health >/dev/null; do sleep 1; done
	@until curl -sf http://localhost:3002/v1/health >/dev/null; do sleep 1; done
	@echo "All three services healthy with CACHE_ENABLED=$(V)."

load-test-cache-ab-on: ## A/B leg A — the cache simulation with CACHE_ENABLED=true.
	$(MAKE) cache-toggle V=true
	cd e2e/load-tests && \
	  API_GATEWAY_URL="$$(grep '^API_GATEWAY_URL=' ../../.env.local.infra | cut -d= -f2-)" \
	  TRACKING_CARRIER_API_KEY="$$(grep '^TRACKING_CARRIER_API_KEY=' ../../.env.local.tracking | cut -d= -f2-)" \
	  GRPC_API_KEY="$$(grep '^GRPC_API_KEY=' ../../.env.local.orders | cut -d= -f2-)" \
	  pnpm run cache-ab leg=cache-on

load-test-cache-ab-off: ## A/B leg B — the SAME simulation with CACHE_ENABLED=false.
	@# Leaves the flag OFF when it finishes. Run `make cache-toggle V=true`
	@# afterwards: with it off, every assertion in e2e/tests/cache.spec.ts and
	@# tests/gateway/cache.spec.ts fails with "no X-Cache header at all".
	$(MAKE) cache-toggle V=false
	cd e2e/load-tests && \
	  API_GATEWAY_URL="$$(grep '^API_GATEWAY_URL=' ../../.env.local.infra | cut -d= -f2-)" \
	  TRACKING_CARRIER_API_KEY="$$(grep '^TRACKING_CARRIER_API_KEY=' ../../.env.local.tracking | cut -d= -f2-)" \
	  GRPC_API_KEY="$$(grep '^GRPC_API_KEY=' ../../.env.local.orders | cut -d= -f2-)" \
	  pnpm run cache-ab leg=cache-off

test-all: ## All three layers for both services (unit + internal E2E + gateway E2E). E2E needs the stack up.
	$(MAKE) test-unit
	$(MAKE) test-e2e

## --- Terraform (against Floci) ---

backend-up: ## Create the remote-state bucket + lock table in Floci (idempotent; local state)
	terraform -chdir=$(TF_LOCAL_DIR)/backend init
	terraform -chdir=$(TF_LOCAL_DIR)/backend apply -auto-approve

infra-init: ## terraform init (environments/local) into the S3 backend
	$(TF) init -reconfigure -backend-config=backend.hcl

lambda-bundles: ## Build the esbuild bundles Terraform's archive_file data sources read at PLAN time
	@# CONTRACT: This must run BEFORE any terraform plan or apply, on every path that
	@# reaches one. Both bundled Lambdas are wired in through `archive_file`, a DATA
	@# SOURCE Terraform evaluates at PLAN time, so a missing dist/ kills the run up front
	@# with "could not archive missing directory". Do NOT move this after the apply and
	@# do NOT rely on `redeploy-lambdas` to cover it — that target runs only once a stack
	@# exists, while both dist/ directories are gitignored and absent on a fresh clone.
	@#
	@# CONTRACT: Keep the `pnpm install --frozen-lockfile`. No earlier target installs
	@# node_modules (the services build inside Docker, the venv is Python), and frozen
	@# because a bootstrap must not silently resolve something new.
	@# See [[2026-09-09-makefile-orchestration-invariants]]
	pnpm install --frozen-lockfile
	pnpm --filter @3mrai/events-pipeline build
	pnpm --filter @3mrai/realtime-events build

infra-plan: lambda-bundles ## terraform plan (environments/local)
	$(TF) plan

infra-up: scripts-setup lambda-bundles ## terraform apply -auto-approve (environments/local), then refresh .env
	@# WHY: Retried once through `infra-reconcile`, because state lives in a bucket
	@# INSIDE Floci, so anything that restarts or half-destroys the emulator leaves state
	@# and reality disagreeing in BOTH directions — "NotFoundException: Invalid API id"
	@# (state has it, Floci does not) and "EntityAlreadyExists" (the reverse). A bare
	@# apply reports the error and stops, so bootstrap fails naming a resource rather
	@# than the problem, and the reader hand-edits state — which creates the second
	@# failure mode from the first.
	@#
	@# CONTRACT: The retry is bounded and is NOT a loop — one apply, reconcile, one more.
	@# A second failure is a real error and is reported as one.
	@# See [[2026-09-09-makefile-orchestration-invariants]]
	@$(TF) apply -auto-approve || $(MAKE) infra-reconcile
	$(MAKE) env-file

.PHONY: infra-reconcile
infra-reconcile: ## Re-sync Terraform state with what Floci actually has, then apply again
	@echo ""
	@echo "  apply failed — reconciling Terraform state with Floci, then retrying once."
	@echo "  (state lives in a bucket inside Floci, so an emulator restart desyncs them)"
	@echo ""
	@# `-refresh-only` asks Terraform to reread every resource and drop the ones
	@# that no longer exist. It fixes the "state has it, Floci does not" direction
	@# without a single manual `state rm`, which is the step that goes wrong when
	@# done by hand: removing a resource that DOES exist creates the opposite
	@# failure on the next apply.
	@$(TF) apply -refresh-only -auto-approve 2>/dev/null || true
	@# CONTRACT: Do NOT hand-repair the other direction (Floci holds a resource the state
	@# has forgotten) — a refresh cannot fix it, and removing an entry for a resource that
	@# DOES exist produces the opposite error next run. Re-applying resolves the common
	@# case; past that, the message says `make clean && make bootstrap`.
	@# See [[2026-09-09-makefile-orchestration-invariants]]
	@$(TF) apply -auto-approve || { 		echo ""; 		echo "  RECONCILE FAILED. Terraform state and Floci disagree in a way a refresh"; 		echo "  cannot repair — usually Floci holds a resource the state has forgotten"; 		echo "  (EntityAlreadyExists / ResourceAlreadyExists above)."; 		echo ""; 		echo "  Do NOT hand-edit the state: removing an entry for a resource that DOES"; 		echo "  exist produces the opposite error on the next run. Run:"; 		echo ""; 		echo "      make clean && make bootstrap"; 		echo ""; 		exit 1; 	}

infra-down: ## terraform destroy -auto-approve (environments/local)
	$(TF) destroy -auto-approve

infra-output: ## Show terraform outputs (Cognito IDs, etc.)
	$(TF) output

env-file: scripts-setup ## Generate every env file from terraform outputs (CUSTOM sections preserved)
	@# CONTRACT: No env file is hand-maintained — Floci mints a new user-pool/client id
	@# and api id on every apply and reassigns the RDS proxy ports by cluster creation
	@# order. The generator writes five files (root .env, one per service, infra for the
	@# E2E suite, debug for a host SQL client) and rewrites ONLY each AUTO-GENERATED box;
	@# anything under CUSTOM survives. See [[env-files]]
	$(PY) $(TF_LOCAL_DIR)/scripts/generate_env_files.py

## --- Database migrations ---

migrate: ## Apply Prisma migrations (users) against Floci's Postgres (idempotent)
	@# CONTRACT: `prisma migrate deploy`, never `migrate dev` — that one is interactive
	@# and can reset data, which is unusable in bootstrap.
	@#
	@# CONTRACT: Run as the cluster SUPERUSER (test/test) and do NOT switch to another
	@# DB user. Migrations run DDL, which users_app deliberately lacks (ADR-0004), and it
	@# must be the same role the post-effects ALTER DEFAULT PRIVILEGES runs as or
	@# users_app never inherits SELECT/INSERT/UPDATE on the tables created here.
	@# WARNING: "idempotent" means Prisma consults `_prisma_migrations`, not the tables —
	@# the same shape as the version-table caveat on migrate-tracking below, so current
	@# bookkeeping over missing tables would plausibly no-op silently.
	@# See [[2026-09-09-migration-version-tables-lie-about-schema]]

	@# WHY: Uses the users Dockerfile's `deps` stage — the runtime image is
	@# production-only and carries no prisma CLI. Staying in-network avoids depending on
	@# Floci's proxy port as a host contract; it is DISCOVERED per-engine because Floci
	@# assigns 7000-7099 by cluster creation order.
	docker build --target deps -t 3mrai-users:deps -f services/users/Dockerfile .
	@pgport="$$($(PY) $(DISCOVER_DB_PORT) postgres)"; \
	docker run --rm --network 3mrai_3mrai-network \
		-e DATABASE_WRITER_URL="postgres://test:test@floci:$$pgport/users" \
		-w /app/services/users \
		3mrai-users:deps \
		node node_modules/prisma/build/index.js migrate deploy --schema=./prisma/schema.prisma
	@echo "Prisma migrations applied."

migrate-tracking: ## Apply golang-migrate migrations (tracking) against Floci's MySQL (idempotent)
	@# CONTRACT: The baseline is STAMPED, never replayed, and for ONE case only — the
	@# `tracking` table present and `schema_migrations` ABSENT, i.e. the database Alembic
	@# built. Both broader spellings were measured here: stamping as the whole branch left
	@# 000002_add_order_number unapplied while doctor, the service and the tests all
	@# reported healthy; stamping on every existing-table run REWINDS a database already
	@# at 2, and the `up` that follows dies on `Error 1060: Duplicate column name` with
	@# the version left DIRTY (recovery: `force <real version>`).
	@# See [[2026-09-09-migration-version-tables-lie-about-schema]]
	@#

	@# WARNING: "up to date" is decided by the VERSION TABLE, not by the tables. A
	@# database whose schema_migrations says 1 but whose tables are gone gets a silent
	@# no-op, and the service then 500s with `Table 'tracking.tracking' doesn't exist`.
	@# Recovery: `DROP TABLE tracking.schema_migrations`, then re-run. `make doctor`
	@# cross-checks tables against databases so this surfaces before a request does.

	@# CONTRACT: Probe `schema_migrations` too, not just `tracking`, and check the probe's
	@# exit status SEPARATELY from its output. The obvious `if docker run ... | grep -q 1`
	@# conflates "table absent" with "could not connect", which want opposite actions —
	@# under the conflated form a TLS failure selected `up`, which died on `Error 1050:
	@# Table 'tracking' already exists` AFTER golang-migrate wrote (version=1, dirty=1),
	@# and a dirty flag makes every later invocation refuse outright.
	@# See [[2026-09-09-migration-version-tables-lie-about-schema]]
	@#

	@# CONTRACT: Keep `--ssl-mode=DISABLED`. The mysql 8.0 client defaults to TLS and
	@# Floci does not terminate it — without the flag the probe dies with `SSL connection
	@# error: unexpected eof`. See [[floci-rds-apigw-limits]]
	@#
	@# WHY: A one-off pinned migrate/migrate container on the compose network — the
	@# service image is distroless, `.env.local.tracking` already holds the in-network
	@# superuser URL, and migrations need DDL the app user lacks (ADR-0004). The DSN
	@# rewrite mirrors services/tracking-go/Makefile.
	@dsn="$$(sed -n 's|^DATABASE_WRITER_URL=mysql+pymysql://||p' .env.local.tracking | sed 's|?.*||')"; \
	test -n "$$dsn" || { echo "ERROR: no DATABASE_WRITER_URL in .env.local.tracking — run 'make env-file'"; exit 1; }; \
	creds="$${dsn%%@*}"; rest="$${dsn#*@}"; hostport="$${rest%%/*}"; dbname="$${rest#*/}"; \
	migrate_dsn="mysql://$$creds@tcp($$hostport)/$$dbname"; \
	probe="$$(docker run --rm --network 3mrai_3mrai-network mysql:8.0 \
	     mysql --ssl-mode=DISABLED -h "$${hostport%%:*}" -P "$${hostport##*:}" \
	           -u "$${creds%%:*}" -p"$${creds#*:}" -N -B \
	           -e "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$$dbname' AND table_name='tracking'), \
	                      (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$$dbname' AND table_name='schema_migrations')" \
	     2>/dev/null)" \
	  || { echo "ERROR: could not reach MySQL at $$hostport to check the tracking schema."; \
	       echo "       Refusing to guess: running 'up' against an existing schema leaves schema_migrations DIRTY."; exit 1; }; \
	tracking_tbl="$$(printf '%s' "$$probe" | cut -f1)"; version_tbl="$$(printf '%s' "$$probe" | cut -f2)"; \
	if [ "$$tracking_tbl" = "1" ] && [ "$$version_tbl" != "1" ]; then \
	  echo "Alembic-built database (tables, no schema_migrations) — stamping the baseline instead of replaying it."; \
	  docker run --rm --network 3mrai_3mrai-network -v "$$PWD/services/tracking-go/migrations:/migrations" \
	    migrate/migrate:v4.17.1 -path=/migrations -database "$$migrate_dsn" force 1; \
	  echo "Baseline stamped — applying anything newer."; \
	else \
	  echo "Applying migrations (no-op if already at head)."; \
	fi; \
	docker run --rm --network 3mrai_3mrai-network -v "$$PWD/services/tracking-go/migrations:/migrations" \
	  migrate/migrate:v4.17.1 -path=/migrations -database "$$migrate_dsn" up
	@echo "golang-migrate migrations applied (tracking)."

post-infra: scripts-setup ## Harden a bootstrapped environment: MySQL provider grants + least-privilege DB app-users (phase 2)
	@# CONTRACT: REQUIRES a successful `make bootstrap` first. Phase 2 is a SEPARATE
	@# Terraform root with its own state that reads phase-1's through
	@# terraform_remote_state; against a torn-down or never-applied phase 1 it fails at
	@# that read, before any provisioner runs.
	@#
	@# CONTRACT: DISCOVER both RDS proxy ports per-engine and pass them as -var. Floci
	@# assigns 7000-7099 by cluster creation order, so the variable defaults (7001/7002)
	@# are not reliable — a live check saw mysql on 7001 and postgres on 7002.
	@# See [[two-phase-terraform-apply]] and [[2026-07-30-post-infra-root-design]]
	@#
	@# WHY: It creates the least-privilege app-users (SELECT/INSERT/UPDATE, no DELETE —
	@# ADR-0004) on both engines, host-side against Floci's published proxy ports.
	pgport="$$($(PY) $(DISCOVER_DB_PORT) postgres)"; \
	myport="$$($(PY) $(DISCOVER_DB_PORT) mysql)"; \
	cd $(TF_LOCAL_DIR)/post && terraform init -reconfigure -backend-config=backend.hcl >/dev/null && terraform apply -auto-approve -var pg_port=$$pgport -var mysql_port=$$myport -var python_bin=$(PY)

assets-sync: scripts-setup ## Re-optimise and re-upload assets/ to the assets bucket (NO terraform apply)
	@# WHY: The day-to-day entry point for asset changes — it touches NO infrastructure
	@# (no plan, no apply, no teardown), fully overwrites every object and the manifest,
	@# so re-running IS the repair mechanism.
	@#
	@# CONTRACT: REQUIRES `make post-infra` to have run once — that phase-2 root creates
	@# the bucket, and its name and public base URL are read from that root's outputs
	@# rather than hardcoded. Against a never-applied root the output read fails with a
	@# clear message before anything uploads. `terraform output` is a state read.
	@# See [[two-phase-terraform-apply]]
	@bucket="$$(cd $(TF_LOCAL_DIR)/post && terraform output -raw assets_bucket_name)"; \
	base_url="$$(cd $(TF_LOCAL_DIR)/post && terraform output -raw assets_base_url)"; \
	$(PY) infra/modules/assets-bucket/scripts/sync_assets.py --bucket "$$bucket" --base-url "$$base_url"

doctor: scripts-setup ## Diagnose the local stack: what ran, what did not, and how to finish it
	@# READ-ONLY. Every check is a SELECT, a SHOW, an HTTP GET or a docker
	@# inspect; it repairs nothing and prints the command that would. The check
	@# it exists for is the one nothing else surfaces: a database that EXISTS
	@# while its tables do not, which is what a bootstrap that died before
	@# `migrate-tracking` leaves behind (JE-112).
	$(PY) infra/scripts/doctor.py

## --- Orchestration ---

bootstrap: scripts-setup ## Bring the whole local chain up from scratch, in dependency order (includes phase 2)
	@# CONTRACT: Order is load-bearing — Floci, then terraform, then .env, then
	@# migrations, then the services. `users` validates COGNITO_* with Zod at boot and
	@# those IDs exist only after the apply.

	@# CONTRACT: bootstrap.py (the nginx alias) runs LAST, inside bootstrap-converge. No
	@# service reads the alias — the API Gateway routes THROUGH it — so run mid-chain a
	@# failure there skips `orders`, `migrate-tracking` and `tracking`, which is how a
	@# cold bootstrap produced Tracking's database with none of its tables (JE-112).
	@# See [[2026-09-09-makefile-orchestration-invariants]]

	@# WHY: Split into `bootstrap-provision` (un-re-runnable: a second phase-1 apply
	@# fails on Floci's UpdateTags, JE-113) and `bootstrap-converge`, so a run that dies
	@# partway resumes without re-entering the apply that cannot succeed.
	@# See [[2026-09-09-makefile-orchestration-invariants]]
	$(COMPOSE) up -d floci
	@echo "Waiting for Floci at $(FLOCI_URL) ..."
	@for i in $$(seq 1 30); do \
		if curl -sf -o /dev/null "$(FLOCI_URL)"; then echo "Floci is up."; break; fi; \
		if [ $$i -eq 30 ]; then echo "Floci did not become ready in time." >&2; exit 1; fi; \
		sleep 1; \
	done
	$(MAKE) backend-up
	$(MAKE) infra-init
	@# CONTRACT: observability-up runs BEFORE `infra-up`, and is not opt-in. Every OTLP
	@# producer builds its exporter in code against otel-collector:4318, so with the
	@# collector absent every export writes a full `getaddrinfo ENOTFOUND otel-collector`
	@# stack trace — 8 in 2 minutes in Users alone on an IDLE stack — and Lambda stderr
	@# arrives via CloudWatch tagged ERROR, failing unclassified-logs.spec.ts.
	@#
	@# CONTRACT: Do NOT move it after the apply, and do NOT silence the exporters by env
	@# var instead. The apply INVOKES Lambdas, so a later start leaves a measured
	@# 46-second window worth one red spec; an explicitly-constructed SDK exporter beats
	@# OTEL_TRACES_EXPORTER, reproducing the identical ENOTFOUND. Making the hostname
	@# RESOLVE is the fix. See [[2026-09-09-makefile-orchestration-invariants]] and
	@# [[ADR-0019-distributed-tracing-opentelemetry]]
	$(MAKE) observability-up
	@# infra-up ends by calling env-file, so every generated env file exists
	@# BEFORE any service starts. That ordering is load-bearing now that the
	@# services read .env.local.<service> via compose `env_file:` — starting
	@# them first would mean starting against a missing or stale file.
	$(MAKE) infra-up
	@# Everything from here down is `bootstrap-converge` — see that target. It is
	@# repeated there rather than factored out because a prerequisite would run
	@# it in the wrong order relative to the terraform steps above.
	$(MAKE) bootstrap-converge
	@# CONTRACT: post-infra runs LAST inside `bootstrap`, and `bootstrap` must keep
	@# calling it. Phase 2 owns the ASSETS BUCKET the email templates load images from,
	@# and a stack without it reports healthy everywhere — the defect appears only as
	@# broken-image placeholders in a delivered email.
	@#
	@# CONTRACT: Do NOT fold post-infra into `bootstrap-converge`. That target is the
	@# resume path; post-infra reads phase-1 state a partial run may not have written.
	@# It stays its own target with its own state, still re-runnable, still failing at
	@# the remote-state read against a torn-down phase 1.
	@# See [[2026-07-30-post-infra-root-design]] and
	@# [[2026-09-09-makefile-orchestration-invariants]]
	$(MAKE) post-infra

bootstrap-provision: scripts-setup ## Phase 1 of bootstrap: Floci + terraform + env files (NOT re-runnable — see below)
	@# The half of `bootstrap` that CANNOT be safely re-run: a second phase-1
	@# apply fails against Floci on UpdateTags (JE-113). Split out so that
	@# `bootstrap-converge` exists as a resume path that never re-enters it.
	$(COMPOSE) up -d floci
	@echo "Waiting for Floci at $(FLOCI_URL) ..."
	@for i in $$(seq 1 30); do \
		if curl -sf -o /dev/null "$(FLOCI_URL)"; then echo "Floci is up."; break; fi; \
		if [ $$i -eq 30 ]; then echo "Floci did not become ready in time." >&2; exit 1; fi; \
		sleep 1; \
	done
	$(MAKE) backend-up
	$(MAKE) infra-init
	$(MAKE) infra-up

bootstrap-converge: scripts-setup ## Phase 2 of bootstrap: migrations + services + nginx alias. SAFE to re-run.
	@# CONTRACT: Every step here stays idempotent — this is the resume path for a
	@# `bootstrap` that died partway, and a non-idempotent step would make a resume fail
	@# on work already done. Prisma and golang-migrate no-op at head, `compose up -d`
	@# reconciles, and bootstrap.py returns early when the alias resolves.
	@#
	@# CONTRACT: Start with `env-file`, and do NOT drop it because `infra-up` already
	@# called it. `migrate-tracking` reads DATABASE_WRITER_URL from .env.local.tracking
	@# and the services read theirs via compose `env_file:`; on a full bootstrap the
	@# second call is a sub-second no-op, and removing it would make this target work
	@# only when entered through bootstrap. Regenerating reads outputs, never applies,
	@# so it is safe against JE-113. See [[2026-09-09-makefile-orchestration-invariants]]
	$(MAKE) env-file
	$(MAKE) migrate
	@# Idempotent, and here so this target works as a STANDALONE resume path: a
	@# full `make bootstrap` already started the collector before its terraform
	@# apply (see there for why that ordering matters), so on that path this is a
	@# no-op. Entered directly, it is what guarantees the collector exists before
	@# the services open their exporters at boot.
	$(MAKE) observability-up
	$(COMPOSE) up -d --build users
	@# CONTRACT: Do NOT call `post-infra` from this target (only from `bootstrap`). This
	@# is the RESUME path for a partial run and every step in it is idempotent; post-infra
	@# reads phase-1 state through terraform_remote_state, which a partial run may never
	@# have written, so a resume would fail for a reason unrelated to what it resumes.
	@# Run `make post-infra` yourself after a resume.
	@# See [[2026-07-30-post-infra-root-design]]
	@#
	@# WHY: Orders migrates and seeds ITSELF on startup (SEED_ON_STARTUP=true) because no
	@# Aurora-MySQL cluster is provisioned for it in infra, so it owns its schema locally.
	@# It comes up after users so the Users gRPC gate (users:50051) answers POST /v1/orders.
	$(COMPOSE) up -d --build orders
	@# CONTRACT: Tracking does NOT self-migrate (unlike Orders), so `migrate-tracking`
	@# is an explicit step here. Only two things gate it: its MySQL cluster and the
	@# `tracking` database (created by phase-1 `infra-up`), and `.env.local.tracking`
	@# (written by `infra-up` via `env-file`), which is where it reads
	@# DATABASE_WRITER_URL.
	@#
	@# CONTRACT: Do NOT read this placement as a dependency on users/orders. Tracking's
	@# only gRPC is an OUTBOUND client dialed lazily per request, which is why its
	@# compose `depends_on` is `floci` alone; it sits last for readability only, and an
	@# ordering change that contradicts that compose file is the bug.
	@# See [[2026-09-09-makefile-orchestration-invariants]]
	$(MAKE) migrate-tracking
	$(COMPOSE) up -d --build tracking
	@# CONTRACT: Build the web app AFTER the services and with `--build`, never
	@# `restart`. Its NG_APP_* values are inlined at BUILD time, so a restart re-serves
	@# the same bundle and a changed flag looks ignored.
	@# WHY: This is the CONTAINER on :3004 (nginx serving the production bundle), not
	@# `pnpm web:dev` on :4200 — the E2E web specs target :4200 and start it separately.
	$(COMPOSE) up -d --build web
	@# LAST, deliberately — see the ordering note at the top of this target.
	@# It also benefits from running here: by now `users` has had the whole
	@# orders/tracking build to finish booting, so its health poll succeeds on
	@# the first attempt instead of racing a container that started seconds ago.
	$(PY) $(TF_LOCAL_DIR)/bootstrap.py

clean: ## Tear down infra + compose, including the emulator state volume
	@# CONTRACT: Four things make this a true teardown, and each was found by a
	@# "from-scratch" run silently inheriting the previous one. Do NOT drop any of them.
	@#   - `-v`: removes the `floci-state` volume recording what Floci BELIEVES exists.
	@#     Kept, the next apply reads `available` for DocumentDB/ElastiCache and skips
	@#     creating them, surfacing later as `getaddrinfo ENOTFOUND floci-docdb-…`.
	@#   - `--profile`: `down` SKIPS profiled services, so openobserve/otel-collector
	@#     survive every clean, hold their data volume, and keep the network alive.
	@#   - the compose-labelled volume sweep: `down -v` removes only volumes the CURRENT
	@#     file declares, so one created under an older revision outlives every clean.
	@#   - the floci=true volume sweep, below.
	@# See [[floci-recreate-destroys-backing-containers]] and
	@# [[2026-09-09-makefile-orchestration-invariants]]

	@# CONTRACT: The bootstrap backend state and the cached .terraform config must go
	@# too — they describe a bucket that dies with Floci, and `init` otherwise reuses a
	@# pointer to it and fails before reaching the reconcile path.
	@echo "Removing the bootstrap backend state (it describes a bucket that dies with Floci)…"
	@rm -f infra/environments/local/backend/terraform.tfstate \
		infra/environments/local/backend/terraform.tfstate.backup 2>/dev/null || true
	@# The cached backend CONFIG (0 resources — just which bucket to talk to) has
	@# to go with it, or `terraform init` reuses a pointer to the dead bucket and
	@# `bootstrap` fails before it reaches the reconcile path.
	@rm -rf infra/environments/local/.terraform \
		infra/environments/local/post/.terraform 2>/dev/null || true
	$(COMPOSE) --profile observability --profile preview down -v --remove-orphans
	@echo "Removing compose volumes this project still owns but no longer declares…"
	@docker volume ls -q --filter label=com.docker.compose.project=3mrai \
		| xargs -r docker volume rm 2>/dev/null || true
	@# CONTRACT: Remove the floci- prefixed containers explicitly. Floci launches ECS
	@# tasks and the RDS/DocDB/valkey backers through the mounted docker socket, so they
	@# carry no compose project label: `down` never sees them and --remove-orphans does
	@# not apply. A stale gateway task then survives the teardown AND holds the network,
	@# so `down` reports "Network 3mrai_3mrai-network Resource is still in use" and the
	@# next bootstrap builds on a network it did not create.
	@# See [[2026-09-09-makefile-orchestration-invariants]]
	@echo "Removing Floci-launched containers (not compose services, so down misses them)…"
	@docker ps -aq --filter "name=^floci-" | xargs -r docker rm -f 2>/dev/null || true
	@# CONTRACT: Sweep the floci=true volumes too. Floci labels the volumes for the
	@# databases it launches `floci=true`, NOT `com.docker.compose.project=3mrai`, so
	@# the compose-labelled sweep above walks straight past them and removing a
	@# container without its volume recreates the split-brain this target prevents.
	@echo "Removing Floci-created volumes (labelled floci=true, not compose)…"
	@docker volume ls -q --filter label=floci=true \
		| xargs -r docker volume rm -f 2>/dev/null || true
	@docker network rm 3mrai_3mrai-network 2>/dev/null || true
	@# WARNING: Both prunes are machine-wide, not project-scoped — `image prune` removes
	@# every DANGLING image (untagged, unreferenced, so no project loses a tagged image)
	@# and the builder cache has no project filter at all. Worth knowing before running
	@# this on a machine hosting other work. Neither is state: the cost of dropping them
	@# is one slower rebuild. They grow without bound across this project's rebuild loop
	@# and nothing else reclaims them (measured: 6.4GB cache, 2.2GB dangling images).
	@echo "Reclaiming dangling images and build cache…"
	@docker image prune -f 2>/dev/null || true
	@docker builder prune -af 2>/dev/null || true

redeploy-lambdas: scripts-setup ## Rebuild and redeploy every local Lambda from the current source
	@# CONTRACT: Do NOT expect `docker compose` to redeploy a Lambda. The services
	@# rebuild that way and these seven functions do not, and the failure is SILENT —
	@# source correct, tests green, deployed function still running the old zip. It
	@# shipped a real bug: otp_challenge_rejected kept arriving at severity 0 for days
	@# after the fix that set severity_text landed.
	@#
	@# WHY: `terraform apply` would also redeploy these, but a second phase-1 apply
	@# fails on Floci's UpdateTags. See [[floci-rds-apigw-limits]]
	@# CONTRACT: Build BEFORE deploying, and keep these duplicated from `lambda-bundles`
	@# rather than shared — that target carries a `pnpm install` that only earns its cost
	@# on a fresh clone. Uploading dist/ unrebuilt deploys the previous bundle and reports
	@# success. The Cognito functions are bare .mjs with no build step.
	pnpm --filter @3mrai/events-pipeline build
	pnpm --filter @3mrai/realtime-events build
	$(PY) infra/scripts/redeploy_lambdas.py


observability-up: ## Start OpenObserve + the OTel collector (opt-in; ~512MB-1.5GB RAM)
	# CONTRACT: Name EVERY service in the observability profile here. The profile alone
	# does not start anything, so a service omitted from this list NEVER STARTS — that
	# is how the whole tracing path once sat dead with a profiled service in no target.
	# Symptom: the collector logs "no children to pick from" then "Exporting failed.
	# Dropping data.", and the UI is empty with no other clue. Add to the profile, add
	# here. See [[2026-09-09-makefile-orchestration-invariants]]
	#
	# WHY: --force-recreate, scoped by name. These sit outside the main up/down cycle,
	# so a recreated stack network strands them (exit 128, "network ... not found");
	# naming the services keeps the flag from bouncing the whole app stack.
	$(COMPOSE) --profile observability up -d --force-recreate openobserve otel-collector
	@# CONTRACT: Do NOT invoke the dashboard and schema seeds from bootstrap instead of
	@# here. They live in the `openobserve-data` volume that `make clean` deletes, and
	@# this is the target that creates it — chained anywhere else, a from-scratch
	@# rebuild leaves OpenObserve running with no dashboards. Both importers are
	@# idempotent (they key on title / probe the schema), so every run is a no-op when
	@# current. See [[2026-09-09-makefile-orchestration-invariants]]
	@#
	@# WHY: Poll rather than sleep — openobserve declares no healthcheck, so `up -d`
	@# returns well before it accepts HTTP.
	@printf 'Waiting for OpenObserve to accept requests'
	@for i in $$(seq 1 60); do \
		if curl -sf -o /dev/null http://localhost:5080/healthz 2>/dev/null; then break; fi; \
		printf '.'; sleep 1; \
	done; echo
	@# CONTRACT: Keep both seeds chained here. The traces schema declares the gen_ai_*
	@# columns OpenObserve's /traces/{id}/dag endpoint SELECTs unconditionally; without
	@# them the trace waterfall 400s on EVERY trace. Not a version bug — v0.92.2 fails
	@# identically. Both live in the openobserve-data volume `make clean` deletes, so a
	@# hand-run seed survives only until the next rebuild. Both are idempotent.
	@# See [[ADR-0019-distributed-tracing-opentelemetry]]
	@$(MAKE) --no-print-directory observability-traces-schema
	@$(MAKE) --no-print-directory observability-dashboards
	@echo "OpenObserve UI on http://localhost:5080 once it's healthy (~5s)."
	@echo "Login: admin@3mrai.local / Complexpass#123"
	@# WHY: `bootstrap-converge` also calls this, before the services start, so it is
	@# mandatory rather than opt-in. Running it by hand stays valid and no-ops when the
	@# containers are up. See the CONTRACT in bootstrap-converge.

observability-down: ## Stop the observability stack (leaves the rest running)
	@# Every service in the profile, for the same reason observability-up names
	@# them all: a "down" that leaves one running contradicts the target name.
	$(COMPOSE) stop openobserve otel-collector

observability-traces-schema: ## Declare the gen_ai_* fields OpenObserve's trace waterfall requires (idempotent)
	@# CONTRACT: O2_ORG must match the collector's and O2_TRACES_STREAM must match its
	@# `stream-name` header for traces (app_traces). Seeding the wrong stream returns 200
	@# and fixes nothing — the columns land where no one reads them.
	@# See [[ADR-0019-distributed-tracing-opentelemetry]]

	@# WHY: Plain python3, not .venv/bin/python — stdlib only and deliberately venv-free,
	@# so it runs before scripts-setup has ever executed on a fresh clone.
	O2_ORG=$${O2_ORG:-3mrai} python3 scripts/seed_traces_schema.py

observability-dashboards: ## Import/update OpenObserve dashboards from observability/dashboards/*.dashboard.json (idempotent)
	@# O2_ORG must match the collector's (docker-compose.yml), or the dashboards
	@# import into one organization while the data lands in another — every panel
	@# then renders empty with no error to explain why.
	O2_ORG=$${O2_ORG:-3mrai} node scripts/import-dashboards.mjs

## --- Multi-provider agent config ---

# lnai is PINNED, not @latest. The committed provider output is only
# reproducible if the generator is too: with @latest, an upstream release can
# change the output and make `ai-sync-check` report the committed config as
# stale — a red gate nobody caused. Bump this deliberately, run `make ai-sync`,
# and commit the resulting diff.
LNAI_VERSION := 0.6.92

ai-sync: ## Propagate agent config from .claude/ to the other AI providers
	@# CONTRACT: .claude/ is the source of truth and .ai/ is derived — the checksum
	@# bracket below fails the run if a sync alters CLAUDE.md. Distilling universal
	@# rules from Claude-specific ones needs judgment, so that half runs through the
	@# ai-config-sync subagent; this target is the deterministic half only.
	@#
	@# CONTRACT: An entry under .agents/skills/ that mirrors one in .ai/skills/ MUST be
	@# a symlink. lnai rewrites a real directory on every run, deleting its tracked
	@# files and re-creating them untracked, so ai-sync-check fails looking like
	@# corruption. The five without a .ai/skills/ counterpart own their content and are
	@# legitimately real directories. See [[2026-09-09-makefile-orchestration-invariants]]
	@before=$$(shasum CLAUDE.md | cut -d' ' -f1); \
	npx -y lnai@$(LNAI_VERSION) sync; \
	after=$$(shasum CLAUDE.md | cut -d' ' -f1); \
	test "$$before" = "$$after" \
	  || { echo "ERROR: CLAUDE.md changed during sync — the arrow inverted"; exit 1; }
	@test ! -e .claude/CLAUDE.md \
	  || { echo "ERROR: .claude/CLAUDE.md was created — lnai's claudeCode target is enabled"; exit 1; }

ai-sync-check: ## Verify provider configs are valid and the guard is in place (CI gate)
	npx -y lnai@$(LNAI_VERSION) validate
	@# The arrow points one way: .claude/ -> .ai/ -> providers. lnai's claudeCode
	@# plugin, if enabled, writes .claude/CLAUDE.md as a symlink to generated
	@# output — so both its absence and the config flag are checked. This gate
	@# deliberately does NOT require a clean working tree: uncommitted subagent
	@# edits are normal, and conflating them with corruption would make the gate
	@# cry wolf on every ordinary change.
	@test ! -e .claude/CLAUDE.md \
	  || { echo "ERROR: .claude/CLAUDE.md exists — lnai's claudeCode target is enabled"; exit 1; }
	@grep -A1 '"claudeCode"' .ai/config.json | grep -q '"enabled": false' \
	  || { echo "ERROR: claudeCode is not disabled in .ai/config.json"; exit 1; }
	@# The provider outputs are committed, so they can go stale when someone edits
	@# .claude/ and forgets to sync. Re-run the sync and fail if it changed
	@# anything: the output is deterministic, so a diff here means the committed
	@# config no longer matches its source.
	@npx -y lnai@$(LNAI_VERSION) sync >/dev/null 2>&1
	@test -z "$$(git status --porcelain .ai/ .cursor/ .windsurf/ .gemini/ .codex/ .agents/ .github/ .opencode/ .vscode/ AGENTS.md GEMINI.md opencode.json)" \
	  || { echo "ERROR: provider config is stale — run 'make ai-sync' and commit the result"; \
	       git status --porcelain .ai/ .cursor/ .windsurf/ .gemini/ .codex/ .agents/ .github/ .opencode/ .vscode/ AGENTS.md GEMINI.md opencode.json; exit 1; }
	@echo "OK: providers valid, guard in place, committed output up to date"
