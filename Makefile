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

# Directories prepended to PATH for any recipe that shells out to Go.
#
# Two entries, both required: the goenv SHIM dir (what puts `go` on PATH at the
# version .go-version pins) and the directory holding `goenv` itself, which the
# shim re-execs. Resolved rather than hardcoded — goenv is a git checkout under
# ~/.goenv for some installs and Homebrew for others, and pinning either spelling
# breaks the other machine. `shell command -v` returns empty when goenv is absent,
# which is harmless here: the service's own verify-toolchain target is what
# reports the missing toolchain, with the command to fix it.
GOENV_ROOT := $(HOME)/.goenv
GOENV_BIN  := $(dir $(shell command -v goenv 2>/dev/null))
GOENV_PATH := $(GOENV_ROOT)/shims:$(GOENV_BIN)

# Terraform talks to Floci through the host-published port; the AWS provider in
# environments/local/providers.tf pins every endpoint to localhost:4566.
export AWS_ENDPOINT_URL    ?= $(FLOCI_URL)
export AWS_DEFAULT_REGION  ?= us-east-1
export AWS_ACCESS_KEY_ID   ?= test
export AWS_SECRET_ACCESS_KEY ?= test

# DynamoDB table the provisioning scripts record their runs to, for traceability
# only — never to skip a re-run (lib3mrai/execution_log.py explains why). Threaded
# the same way AWS_ENDPOINT_URL is: exported here, inherited by terraform and by
# every local-exec provisioner it spawns, and passed on explicitly by the two
# cognito provisioners (which is a SHARED module, so it takes it as a variable).
#
# WHY A LITERAL, NOT A terraform_remote_state READ of environments/local/backend:
# that root deliberately keeps LOCAL state (it creates the S3 bucket every other
# root's backend points at), so reading it would mean a `backend = "local"` data
# source hardcoding a relative path between two roots — a mechanism this repo
# uses nowhere. The name is deterministic anyway: modules/tf-backend derives it
# as "<context.id>-execution-log" and the backend root's label is
# 3mrai-local-tfstate. An override still flows through: `?=` yields to an
# environment value, and the table name is exposed as the backend root's
# execution_log_table_name output for anyone who needs to confirm it.
export EXECUTION_LOG_TABLE ?= 3mrai-local-tfstate-execution-log

.DEFAULT_GOAL := help

.PHONY: help up down logs build ps test-unit test-e2e test-all load-test load-test-smoke cache-toggle load-test-cache-ab-on load-test-cache-ab-off backend-up infra-init infra-plan infra-up post-infra infra-down infra-output env-file migrate migrate-tracking assets-sync bootstrap bootstrap-provision bootstrap-converge doctor clean observability-up observability-down observability-dashboards observability-traces-schema redeploy-lambdas scripts-setup lint-comments lint-comments-diff install-comment-hook ai-sync ai-sync-check

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
	  || { status=$$?; echo "ERROR: code-comment lint failed"; exit $$status; }

lint-comments-diff: ## Check code-comment violations in the diff (COMMENT_DIFF_REF=main)
	@command -v "$(COMMENT_PY)" >/dev/null 2>&1 \
	  || { echo "ERROR: Python 3 is required to lint code comments"; exit 1; }
	@$(COMMENT_PY) scripts/validate-comments.py --diff "$(COMMENT_DIFF_REF)" --root . \
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

test-unit: ## Layer 1 — unit/integration for orders (dotnet), users + both Lambdas + the Cognito trigger (vitest), tracking (go test) + e2e typecheck. Tracking needs the local DB.
	dotnet test services/orders/Orders.sln
	pnpm --filter @3mrai/users test
	# Safe in the no-stack layer: the events-pipeline suites that need real
	# infrastructure guard themselves. The DocumentDB suite skips when DOCDB_* is
	# absent and the Mailpit suite skips when :8025 does not answer, both printing
	# why and how to run them for real. Set EVENTS_PIPELINE_REQUIRE_INTEGRATION=1
	# where the stack IS expected to turn those skips into hard failures.
	pnpm --filter @3mrai/events-pipeline test
	# These three existed and NOTHING ran them. A suite nobody invokes is worse
	# than no suite: it reads as coverage in a review and cannot fail, so the
	# code it guards drifts freely. Found when a logging change to the Cognito
	# trigger needed its tests and the only way to run them was borrowing another
	# package's vitest by hand.
	#
	# realtime-events was simply never listed. The Cognito trigger additionally
	# had no package.json — it is a workspace now for this reason alone, and
	# archive_file excludes what that adds so the deployed zip is unchanged (see
	# infra/modules/cognito/main.tf).
	pnpm --filter @3mrai/realtime-events test
	pnpm --filter @3mrai/cognito-otp-challenge-lambda test
	# Tracking's suite is `go test`, not vitest, and it needs the Go toolchain
	# goenv pins in services/tracking-go/.go-version — `make test-db` verifies
	# that before running anything.
	#
	# test-db, NOT test. `make test` in that service FAILS without a database on
	# purpose: internal/adapter/mysql's tests need a real MySQL, and without one
	# they skip while the package still prints `ok`. That hollow green already
	# cost the migration a debugging session, which is why the gate exists. So
	# this layer runs the real thing against the shared local database — the same
	# reason its pytest predecessor lived here: that database is part of the local
	# stack anyone running tests already has. Without the stack up, use
	# `make -C services/tracking-go test-no-db`, which skips loudly.
	#
	# GOENV_PATH (top of this file) is prepended because goenv is activated by a
	# shell rc file and make recipes run under a NON-interactive /bin/sh that
	# never sources one — so a bare `go` here is `go: command not found` even on
	# a machine whose terminal resolves it fine. It carries the SHIM directory
	# (so .go-version stays the single source of truth for which Go) and goenv's
	# OWN directory, because the shim re-execs `goenv` and fails with
	# "exec: goenv: not found" without it.
	PATH="$(GOENV_PATH):$$PATH" $(MAKE) -C services/tracking-go test-db
	pnpm --filter @3mrai/e2e typecheck

test-e2e: ## Layers 2+3 — Playwright internal + gateway for both services. REQUIRES `make bootstrap` up.
	pnpm --filter @3mrai/e2e test

load-test: ## Gatling load simulation (fullJourney). REQUIRES `make bootstrap` up.
	@# Exports what the simulations read from the generated env files, because
	@# Gatling runs on GraalVM and does NOT inherit a .env: `getEnvironmentVariable`
	@# reads the real process environment only. Without this the run dies at load
	@# time with "API_GATEWAY_URL is not set" — before a single request is sent.
	@#
	@# The value is quoted through: API_GATEWAY_URL contains a literal `$$default`
	@# stage segment, and an unquoted expansion silently turns the URL into
	@# .../restapis/<id>//_user_request_ — a 404 that looks like a routing bug.
	@#
	@# TRACKING_CARRIER_API_KEY (not CARRIER_API_KEY — the simulation reads the
	@# prefixed name) drives the carrier webhook that advances deliveries. Load
	@# tests deliberately send NEITHER x-e2e-source NOR x-test-mode, so their data
	@# persists like real traffic and tracking advances only through that webhook.
	@#
	@# GRPC_API_KEY is passed for the pre-run restock step (`pnpm run restock`,
	@# wired into every simulation script): it calls Orders' e2e-cleanup route to
	@# put catalogue stock back to the seed quantities BEFORE traffic starts.
	@# Because load runs are never cleaned up, every order they place drains stock
	@# permanently — without this the catalogue empties over successive runs and
	@# order creation starts failing for want of stock rather than under genuine
	@# contention. The step FAILS the target if it cannot reach the route.
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
	@# CACHE_ENABLED lives in the CUSTOM box of each generated env file, which
	@# `make env-file` preserves verbatim — so this edit survives a regeneration.
	@# Editing the AUTO box instead would be silently reverted on the next apply.
	@#
	@# `sed -i ''` is the BSD/macOS spelling this repo's tooling assumes
	@# (Platform: darwin); on GNU sed it must be a bare `-i`. Shell rather than
	@# Python only because a Make recipe IS shell by definition — the repo's
	@# Python-first rule governs standalone scripts, and this is in-recipe glue.
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

infra-plan: ## terraform plan (environments/local)
	$(TF) plan

infra-up: scripts-setup ## terraform apply -auto-approve (environments/local), then refresh .env
	@# RETRIED ONCE THROUGH `infra-reconcile`, because a bare apply is brittle here
	@# in a way it would not be against real AWS. The state lives in a bucket
	@# INSIDE Floci, so anything that restarts or half-destroys the emulator
	@# leaves state and reality disagreeing, in BOTH directions:
	@#
	@#   state has it, Floci does not -> "NotFoundException: Invalid API id"
	@#   Floci has it, state does not -> "EntityAlreadyExists" / "ResourceAlreadyExists"
	@#
	@# Both were hit in one session. A plain `apply` reports the error and stops,
	@# so `make bootstrap` fails with a message that names a resource rather than
	@# the actual problem, and the reader is left hand-editing state — which is
	@# how the second failure mode gets created from the first.
	@#
	@# The retry is bounded and it is NOT a loop: one apply, and if it fails,
	@# reconcile the two directions and apply once more. A second failure is a
	@# real error and is reported as one.
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
	@# The other direction — Floci holds an IAM role or log group that the state
	@# has forgotten — cannot be fixed by refreshing, because there is nothing in
	@# state to refresh. `import` would need one line per resource and a name for
	@# each. Applying again after the refresh resolves the common case; if it
	@# still fails, the state is far enough gone that `make clean && make
	@# bootstrap` is both faster and more certain than surgery, and the message
	@# says so instead of leaving the reader guessing.
	@$(TF) apply -auto-approve || { 		echo ""; 		echo "  RECONCILE FAILED. Terraform state and Floci disagree in a way a refresh"; 		echo "  cannot repair — usually Floci holds a resource the state has forgotten"; 		echo "  (EntityAlreadyExists / ResourceAlreadyExists above)."; 		echo ""; 		echo "  Do NOT hand-edit the state: removing an entry for a resource that DOES"; 		echo "  exist produces the opposite error on the next run. Run:"; 		echo ""; 		echo "      make clean && make bootstrap"; 		echo ""; 		exit 1; 	}

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
	@#
	@# Note on "idempotent", by analogy with migrate-tracking below: Prisma also
	@# decides what to apply from a bookkeeping table (`_prisma_migrations`), not
	@# by introspecting whether the tables still exist. UNVERIFIED here, but the
	@# same shape as Alembic's stamp check, so a database whose bookkeeping is
	@# current but whose tables are gone would plausibly get the same silent
	@# no-op. Users' tests do NOT drop the shared schema (they mock the Prisma
	@# client), so nothing in this repo is known to produce that state — noted
	@# so that a future live-database test suite for Users starts from the
	@# lesson rather than rediscovering it.
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

migrate-tracking: ## Apply golang-migrate migrations (tracking) against Floci's MySQL (idempotent)
	@# golang-migrate, NOT Alembic — Tracking is Go now (services/tracking-go).
	@# Idempotent: `up` is a no-op once schema_migrations is at head, so bootstrap
	@# and a manual re-run are both safe.
	@#
	@# STAMPED, NOT REPLAYED, on a database Alembic already built. The baseline
	@# migration is a squash of the four Alembic revisions the Python service
	@# arrived at (services/tracking-go/migrations/README.md), so running `up`
	@# against an existing local database fails on CREATE TABLE. The recipe below
	@# handles both cases: a database whose tables already exist gets
	@# `force 1` (writes version=1 WITHOUT running any SQL), and a fresh one gets
	@# a real `up`. That is why it probes for the `tracking` table first rather
	@# than just running `up`.
	@#
	@# CAVEAT, inherited from Alembic and unchanged in shape: "up to date" is
	@# decided by the VERSION TABLE, not by the tables. A database whose
	@# schema_migrations says 1 but whose tables are gone gets a silent no-op
	@# here. Symptom: the service 500s with `Table 'tracking.tracking' doesn't
	@# exist`. Recovery: `DROP TABLE tracking.schema_migrations` first, then
	@# re-run this. `make doctor` cross-checks tables against the databases that
	@# should hold them precisely so this surfaces before a request does.
	@#
	@# Runs in a ONE-OFF migrate/migrate container on the compose network, not on
	@# the host and not in the service image. Three reasons:
	@#   1. The service image is gcr.io/distroless/static-debian12 — it holds the
	@#      server binary and nothing else. There is no `migrate` in it and no
	@#      shell to invoke one, so the Python service's `compose run --entrypoint`
	@#      trick has no analogue.
	@#   2. The DB URL. `.env.local.tracking` holds the IN-NETWORK writer URL and
	@#      `--network 3mrai_3mrai-network` is what makes the `floci` hostname in
	@#      it resolve. A host-side run would have to rebuild the URL against
	@#      localhost plus the discovered port — Floci reassigns those (7000-7099,
	@#      by cluster creation order) on every apply, so that would be a second,
	@#      drift-prone copy of a value the env file already resolved correctly.
	@#   3. Credentials. Like `make migrate` (Users/Prisma), migrations run as the
	@#      cluster SUPERUSER (test/test) because they execute DDL, and the
	@#      least-privilege app user has no DDL grant by design (ADR-0004). The
	@#      generated URL is already the superuser one.
	@#
	@# The DSN rewrite mirrors services/tracking-go/Makefile: the generated value
	@# keeps the SQLAlchemy-flavoured `mysql+pymysql://` spelling (the Go service
	@# parses it itself), and golang-migrate wants `mysql://user:pass@tcp(host:port)/db`.
	@# The image is PINNED, like every other image in this repo — a `latest`
	@# migrate could change its DSN parsing under a green bootstrap.
	@# --ssl-mode=DISABLED on the probe is LOAD-BEARING, not tidiness. The mysql
	@# 8.0 client defaults to TLS and Floci does not terminate it, so without the
	@# flag the probe dies with `SSL connection error: unexpected eof`. That is
	@# the same limitation infra/CLAUDE.md records for the mysql Terraform
	@# provider (which is why the app users use mysql_native_password).
	@#
	@# The probe's exit status is CHECKED SEPARATELY from its output, because the
	@# obvious `if docker run ... | grep -q 1` conflates "the table is absent"
	@# with "the probe could not connect" — and those want opposite actions. Under
	@# the conflated form a TLS failure silently selected the `up` branch, which
	@# then died on `Error 1050: Table 'tracking' already exists` AFTER golang-
	@# migrate had written (version=1, dirty=1). Measured here, first run. A dirty
	@# flag makes every later invocation refuse outright, so the cost of guessing
	@# wrong is a wedged database, not a retry.
	@dsn="$$(sed -n 's|^DATABASE_WRITER_URL=mysql+pymysql://||p' .env.local.tracking | sed 's|?.*||')"; \
	test -n "$$dsn" || { echo "ERROR: no DATABASE_WRITER_URL in .env.local.tracking — run 'make env-file'"; exit 1; }; \
	creds="$${dsn%%@*}"; rest="$${dsn#*@}"; hostport="$${rest%%/*}"; dbname="$${rest#*/}"; \
	migrate_dsn="mysql://$$creds@tcp($$hostport)/$$dbname"; \
	existing="$$(docker run --rm --network 3mrai_3mrai-network mysql:8.0 \
	     mysql --ssl-mode=DISABLED -h "$${hostport%%:*}" -P "$${hostport##*:}" \
	           -u "$${creds%%:*}" -p"$${creds#*:}" -N -B \
	           -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$$dbname' AND table_name='tracking'" \
	     2>/dev/null)" \
	  || { echo "ERROR: could not reach MySQL at $$hostport to check whether tracking.tracking exists."; \
	       echo "       Refusing to guess: running 'up' against an existing schema leaves schema_migrations DIRTY."; exit 1; }; \
	if [ "$$existing" = "1" ]; then \
	  echo "tracking.tracking already exists — stamping baseline instead of replaying it."; \
	  docker run --rm --network 3mrai_3mrai-network -v "$$PWD/services/tracking-go/migrations:/migrations" \
	    migrate/migrate:v4.17.1 -path=/migrations -database "$$migrate_dsn" force 1; \
	else \
	  echo "Fresh database — applying migrations."; \
	  docker run --rm --network 3mrai_3mrai-network -v "$$PWD/services/tracking-go/migrations:/migrations" \
	    migrate/migrate:v4.17.1 -path=/migrations -database "$$migrate_dsn" up; \
	fi
	@echo "golang-migrate migrations applied (tracking)."

post-infra: scripts-setup ## Harden a bootstrapped environment: MySQL provider grants + least-privilege DB app-users (phase 2)
	@# REQUIRES a successful `make bootstrap` first — phase 2 reads phase-1's
	@# state via terraform_remote_state; running this against a torn-down or
	@# never-applied phase 1 fails at that read, before any provisioner runs.
	@# See docs/superpowers/specs/2026-07-30-post-infra-root-design.md
	@# ("What happens if post-infra runs before bootstrap").
	@#
	@# Two-phase apply (see docs/superpowers/specs/2026-07-15-two-phase-post-effects-design.md
	@# and environments/local/post/README.md): a SEPARATE Terraform root with its
	@# own state that reads phase-1 outputs + the master secret by ARN, waits for
	@# each DB via a healthcheck gate, and creates the least-privilege app-users
	@# (SELECT/INSERT/UPDATE, no DELETE — ADR-0004). BOTH engines are enabled:
	@# users_app on Postgres, plus orders_app and tracking_app on the shared MySQL
	@# cluster. The mysql provider was re-verified against Floci on 2026-07-30 and
	@# no longer hangs, so the old postgres-only gating is gone.
	@# Runs host-side, reaching Floci's published RDS proxy ports (7000-7099).
	@# DISCOVER both proxy ports per-engine and pass them as -var: Floci assigns
	@# those ports by cluster creation order and they flip across applies, so the
	@# variable defaults (7001/7002) are not reliable — a live check saw mysql on
	@# 7001 and postgres on 7002, the reverse of the defaults.
	pgport="$$($(PY) $(DISCOVER_DB_PORT) postgres)"; \
	myport="$$($(PY) $(DISCOVER_DB_PORT) mysql)"; \
	cd $(TF_LOCAL_DIR)/post && terraform init -reconfigure -backend-config=backend.hcl >/dev/null && terraform apply -auto-approve -var pg_port=$$pgport -var mysql_port=$$myport -var python_bin=$(PY)

assets-sync: scripts-setup ## Re-optimise and re-upload assets/ to the assets bucket (NO terraform apply)
	@# The day-to-day entry point for asset changes: swap a logo, run this, done.
	@# It touches NO infrastructure — no plan, no apply, no teardown — so it is
	@# safe against an already-running stack and safely re-runnable. The script
	@# fully overwrites every object and the manifest on each run, so re-running
	@# is the repair mechanism rather than something to avoid.
	@#
	@# The bucket lives in the phase-2 (post) root, so its name and public base
	@# URL are DISCOVERED from that root's outputs rather than hardcoded here —
	@# the same reason `post-infra` discovers RDS proxy ports instead of trusting
	@# a default. `terraform output` is a state read, not an apply.
	@#
	@# REQUIRES `make post-infra` to have run once (that is what creates the
	@# bucket). Against a root that has never been applied the output read fails
	@# with a clear message, before anything is uploaded.
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
	@# Order matters. The services cannot start before the infra exists: `users`
	@# validates COGNITO_* with Zod at boot, and those IDs only exist after apply.
	@# So: Floci first, then terraform, then .env, then migrations (DB needs
	@# tables before it's usable), then the services.
	@#
	@# Split in two halves: `bootstrap-provision` (Floci + terraform + env files)
	@# and `bootstrap-converge` (migrations + services + alias). Only the first
	@# is un-re-runnable, because a second phase-1 apply fails on Floci's
	@# UpdateTags (JE-113). So when a run dies partway, `make bootstrap-converge`
	@# resumes it without re-entering the apply that cannot succeed.
	@#
	@# bootstrap.py (the nginx alias) runs LAST, not before the services. The
	@# alias is what the API Gateway routes THROUGH; no service reads it — grep
	@# for nginx-stable under services/ and compose and you get nothing. Running
	@# it mid-chain meant a failure there skipped `orders`, `migrate-tracking`
	@# and `tracking`, which is how a cold bootstrap ended up with Tracking's
	@# database created but its tables missing (JE-112). Placed last, its
	@# blast radius is itself.
	$(COMPOSE) up -d floci
	@echo "Waiting for Floci at $(FLOCI_URL) ..."
	@for i in $$(seq 1 30); do \
		if curl -sf -o /dev/null "$(FLOCI_URL)"; then echo "Floci is up."; break; fi; \
		if [ $$i -eq 30 ]; then echo "Floci did not become ready in time." >&2; exit 1; fi; \
		sleep 1; \
	done
	$(MAKE) backend-up
	$(MAKE) infra-init
	@# Observability BEFORE the terraform apply, and it is no longer opt-in.
	@#
	@# Every OTLP producer here — the three services AND the Lambdas — is
	@# configured with OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 and
	@# builds its exporter in code (Node's `new OTLPTraceExporter()`, .NET's
	@# `AddOtlpExporter()`, Go's `otlptracehttp.New`). With the collector absent
	@# that hostname does not resolve and every export writes a full `getaddrinfo
	@# ENOTFOUND otel-collector` stack trace — measured at 8 in 2 minutes in Users
	@# alone on an IDLE stack, one per metrics tick, 24/7. Lambda stderr is
	@# CloudWatch's, and CloudWatch tags it ERROR, so those also arrive
	@# unclassified and fail e2e/tests/observability/unclassified-logs.spec.ts.
	@#
	@# Silencing the exporters by env var does NOT work and was measured: an
	@# explicitly-constructed SDK exporter beats OTEL_TRACES_EXPORTER, and paired
	@# control/treatment runs reproduced the identical ENOTFOUND. Fixing it in code
	@# would contradict the env-vars-not-code rule this repo paid for three times.
	@# Making the hostname RESOLVE removes the error at its source.
	@#
	@# BEFORE `infra-up`, not after: the apply INVOKES Lambdas (Cognito triggers,
	@# the events function), and a Lambda that runs while the collector is still
	@# missing logs exactly that error. Placing this in bootstrap-converge alone
	@# left a 46-SECOND window — measured: the error at 04:19:58, the collector up
	@# at 04:20:44 — which is one unclassified record and one red spec.
	@#
	@# Measured cost: 616MB RAM (collector 378 + OpenObserve 238) and 0 bytes
	@# written in 30s while idle. It buys back a tracing path that was silently
	@# dead on every default bootstrap.
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
	@# Phase 2, LAST. The 2026-07-30 design deliberately split this out so that
	@# `bootstrap` ended "usable" and a hardening failure could be diagnosed
	@# against a known-good stack. That split held for the DB app-users it was
	@# written about — but phase 2 later grew the ASSETS BUCKET the email
	@# templates load their images from (environments/local/post/assets.tf), and
	@# a stack whose emails render as broken-image placeholders is not usable in
	@# the sense that decision claimed. The gap was silent: everything reports
	@# healthy, every service answers, and the defect only appears in a delivered
	@# email. So `bootstrap` is once again the single command that produces a
	@# complete environment.
	@#
	@# What the original split bought is NOT given back up: post-infra is still
	@# its own target with its own state, still re-runnable on its own, and still
	@# fails against a torn-down phase 1 at the remote-state read before any
	@# provisioner runs. It is only also CALLED here, at the very end, where its
	@# blast radius is itself — the same placement argument that puts
	@# bootstrap.py last inside bootstrap-converge.
	@#
	@# It is NOT in `bootstrap-converge`: that target is the resume path for a
	@# run that died partway, and every step in it is idempotent by design.
	@# post-infra is idempotent too, but it reads phase-1 state that a partial
	@# run may not have written yet, so folding it in would make the resume path
	@# fail for a reason unrelated to what it is resuming.
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
	@# The resume path for a `bootstrap` that died partway. Every step here is
	@# idempotent — Prisma and golang-migrate are no-ops on an up-to-date database,
	@# `compose up -d` reconciles rather than duplicates, and bootstrap.py
	@# returns early when the alias already resolves — so re-running costs time
	@# and nothing else.
	@#
	@# Starts with `env-file` because it is the one thing `infra-up` did that
	@# this half depends on: `migrate-tracking` reads DATABASE_WRITER_URL from
	@# .env.local.tracking, and the services read their own files via compose
	@# `env_file:`. Regenerating is cheap and reads existing terraform outputs —
	@# it does NOT apply, so it is safe against JE-113.
	@#
	@# On a full `make bootstrap` this runs twice (infra-up ends by calling it
	@# too). Intentional, not an oversight: the second call is a sub-second
	@# no-op, and dropping it would make this target depend on having been
	@# entered through bootstrap — exactly the assumption that would stop it
	@# working as a standalone resume path.
	$(MAKE) env-file
	$(MAKE) migrate
	@# Idempotent, and here so this target works as a STANDALONE resume path: a
	@# full `make bootstrap` already started the collector before its terraform
	@# apply (see there for why that ordering matters), so on that path this is a
	@# no-op. Entered directly, it is what guarantees the collector exists before
	@# the services open their exporters at boot.
	$(MAKE) observability-up
	$(COMPOSE) up -d --build users
	@# Phase 2 is deliberately NOT called here — but it IS called at the end of
	@# `bootstrap`. The distinction is the point of this target: this is the
	@# RESUME path for a run that died partway, and every step in it is
	@# idempotent. post-infra reads phase-1 state through terraform_remote_state,
	@# which a partial run may never have written, so calling it here would make
	@# a resume fail for a reason that has nothing to do with what it is
	@# resuming. Run `make post-infra` yourself after a resume.
	@# See docs/superpowers/specs/2026-07-30-post-infra-root-design.md.
	@# Orders migrates + seeds ITSELF on startup (SEED_ON_STARTUP=true in
	@# compose): the Api applies EF Core migrations then ProductSeed against
	@# Floci's MySQL before serving. This differs from Users (Prisma via `make
	@# migrate`) because no Aurora-MySQL cluster is provisioned in infra yet, so
	@# there is no standalone migrate target to run — the service owns its schema
	@# locally. Bring it up after users so the Users gRPC gate (users:50051) is
	@# reachable for POST /v1/orders.
	$(COMPOSE) up -d --build orders
	@# Tracking, LAST in the chain, and unlike Orders it does NOT self-migrate: it
	@# has real golang-migrate migrations that nothing invokes on boot, so the
	@# migration is an explicit step here (the Orders comment above explains why
	@# that service owns its schema instead).
	@#
	@# Placement. Only two things actually gate it:
	@#   - Its MySQL cluster and the `tracking` database must exist — both are created by
	@#     phase-1 `infra-up` (terraform_data.tracking_database), far above.
	@#   - `.env.local.tracking` must exist, because `migrate-tracking` reads
	@#     DATABASE_WRITER_URL from it — also written by `infra-up` via `env-file`.
	@# It does NOT need `users` running: Tracking's only gRPC is an OUTBOUND client to
	@# Users, dialed lazily per REQUEST on POST /v1/trackings/init-tracking — nothing at
	@# boot. That is the same reasoning that keeps its compose `depends_on` at `floci`
	@# alone, and this ordering must not contradict it: Tracking is placed here for
	@# readability (services grouped at the end), NOT because it depends on users/orders.
	@#
	@# migrate-tracking does NOT build the Tracking image any more, and no longer
	@# needs to: it runs golang-migrate in its own pinned container rather than
	@# `compose run` inside the service image (which is distroless and holds no
	@# migration tool). So the order below is migrate-then-build rather than
	@# build-then-migrate-then-build, and the `--build` here is the only build.
	$(MAKE) migrate-tracking
	$(COMPOSE) up -d --build tracking
	@# LAST, deliberately — see the ordering note at the top of this target.
	@# It also benefits from running here: by now `users` has had the whole
	@# orders/tracking build to finish booting, so its health poll succeeds on
	@# the first attempt instead of racing a container that started seconds ago.
	$(PY) $(TF_LOCAL_DIR)/bootstrap.py

clean: ## Tear down infra + compose, including the emulator state volume
	@# `down -v` — the -v is load-bearing, not a convenience. It removes the
	@# `floci-state` volume holding what resources Floci BELIEVES exist, and that
	@# has to die in the same breath as the containers backing them.
	@#
	@# This used to ask before deleting ./data, DEFAULTING TO KEEPING IT, which
	@# made a from-scratch teardown non-deterministic: the containers went away
	@# and the state claiming they existed stayed. The next apply then read
	@# `available` from that stale state and skipped creating DocumentDB and
	@# ElastiCache, leaving clusters with no container behind them — a failure
	@# that surfaced only later, as `getaddrinfo ENOTFOUND floci-docdb-…` inside
	@# a Lambda. No prompt now: clean means clean.
	@#
	@# (RDS survived that same teardown because Floci relaunches ITS containers
	@# from persisted state at boot; DocumentDB and ElastiCache have no such
	@# reconciler. That asymmetry is what made it look intermittent.)
	@# --profile is load-bearing here for the same reason -v is. `down` SKIPS
	@# services behind a profile, so openobserve/otel-collector survived
	@# every `make clean` — still running, still holding `3mrai_openobserve-data`
	@# and keeping the network alive so it could not be removed either. A
	@# "from-scratch" rebuild therefore inherited the previous run's metric
	@# series, which is how rows written under an OLD schema kept colliding with
	@# new ones long after the change that caused it.
	@# The volume sweep below is the third thing that turned out to be
	@# load-bearing, alongside -v and --profile, and it fails in the same shape:
	@# something survives a "from-scratch" teardown and the next run silently
	@# inherits it.
	@#
	@# `down -v` removes only the volumes the CURRENT compose file DECLARES. A
	@# volume compose itself created under an earlier version of this file is not
	@# in that list any more, so it outlives every clean with no warning — it is
	@# not dangling (a container may still mount it) and not orphaned in the sense
	@# --remove-orphans handles (that flag is about containers, not volumes).
	@#
	@# Found exactly that: `3mrai_otelcol-storage`, carrying the CloudWatch
	@# receiver's checkpoint file, created 2026-08-14 by a compose revision that
	@# was never committed. Nothing writes it today — the config declares no
	@# file_storage extension, so the receiver keeps its checkpoint in memory —
	@# yet it sat there holding a stale read position for every log group.
	@#
	@# Filtering on compose's own project label is what makes this safe: it is
	@# exactly the set compose would have removed had it still known about these
	@# volumes, so it can never reach another project's data. `docker volume prune`
	@# was the alternative and is strictly worse — it is scoped to the whole
	@# daemon, not to this project.
	@#
	@# Runs AFTER `down -v` so the declared volumes are already gone and this only
	@# catches the leftovers. `|| true`: an empty list is the healthy case, and a
	@# volume still held by a container from another project must not fail clean.
	@# NO `terraform destroy` HERE, DELIBERATELY. It was the single largest source
	@# of trouble in this target, and it was never necessary.
	@#
	@# Every resource Terraform manages locally IS a Docker container or volume
	@# inside Floci, and the state describing them lives in a bucket inside Floci
	@# too. Removing the containers and volumes therefore destroys the resources
	@# AND the state in the same stroke — there is nothing left on either side to
	@# disagree, which is exactly what a teardown wants.
	@#
	@# What destroy actually bought was three problems:
	@#   - it HANGS: 26 minutes on one CloudWatch log group in one session, and
	@#     still going at 8 in another, because Floci stops answering that delete;
	@#   - killing the hang leaves state HALF-DESTROYED, which is what produced
	@#     "NotFoundException: Invalid API id" on the next bootstrap;
	@#   - hand-repairing that state produced the OPPOSITE failure
	@#     ("EntityAlreadyExists"), because entries were removed for resources that
	@#     did still exist.
	@#
	@# All three vanish when the teardown is done at the Docker layer, which also
	@# takes seconds instead of minutes and cannot partially succeed.
	@#
	@# The one piece of state that does NOT live inside Floci is the bootstrap
	@# backend (infra/environments/local/backend/*.tfstate, 4 resources: the bucket
	@# and lock table that hold everything else). It has to go too, or the next
	@# bootstrap reads a state describing a bucket that no longer exists.
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
	@# Floci's OWN containers — the same leak, one layer up.
	@#
	@# Floci launches ECS tasks (and the RDS/DocDB/valkey backers) through the
	@# mounted docker socket, so they are NOT compose services: they carry no
	@# com.docker.compose.project label, `down` never sees them, and
	@# --remove-orphans does not apply (it only removes containers compose itself
	@# started for this project). They therefore outlive every teardown.
	@#
	@# Two consequences, both observed here rather than theorised: a nginx task
	@# from a FOUR-HOUR-OLD run was still up after a full clean, and because it
	@# held the network, `down` could not remove it either — "Network
	@# 3mrai_3mrai-network Resource is still in use". The next bootstrap then
	@# builds on a network it did not create, with a stale gateway task on it.
	@#
	@# Matched on the `floci-` name prefix, which Floci derives from the resource
	@# identifier — the same naming the doctor check and DOCDB_HOST rely on.
	@# Removing the network afterwards is what makes the next `up` recreate it
	@# clean; `|| true` throughout because "nothing to remove" is the healthy case.
	@echo "Removing Floci-launched containers (not compose services, so down misses them)…"
	@docker ps -aq --filter "name=^floci-" | xargs -r docker rm -f 2>/dev/null || true
	@# The FOURTH thing that survived a "from-scratch" teardown, same shape as the
	@# three above. Floci creates its own volumes for the databases it launches
	@# (floci-rds-cluster-*, DocumentDB, ElastiCache) and labels them `floci=true`
	@# — NOT `com.docker.compose.project=3mrai`, so the compose-labelled sweep two
	@# lines up walks straight past them. Removing the container without its
	@# volume is precisely the split-brain this target exists to prevent.
	@#
	@# Measured on 2026-08-30: six of these had accumulated across bootstraps,
	@# holding 870MB, of which only two belonged to the live stack.
	@echo "Removing Floci-created volumes (labelled floci=true, not compose)…"
	@docker volume ls -q --filter label=floci=true \
		| xargs -r docker volume rm -f 2>/dev/null || true
	@docker network rm 3mrai_3mrai-network 2>/dev/null || true
	@# Build cache and dangling images. Neither is state, so neither breaks
	@# anything by going — but both grow without bound across the rebuild loop
	@# this project runs on (`compose up --build` per service change), and nothing
	@# else ever reclaims them. Measured the same day: 6.4GB of build cache and
	@# 2.2GB of dangling images, i.e. more than the containers and volumes put
	@# together.
	@#
	@# BOTH are machine-wide, not project-scoped, and that is worth knowing before
	@# running this on a machine hosting other work: `image prune` removes every
	@# DANGLING image (untagged, unreferenced — no project loses a tagged image),
	@# and the builder cache has no project filter at all. Both are caches: the
	@# cost of dropping them is one slower rebuild, never lost state.
	@echo "Reclaiming dangling images and build cache…"
	@docker image prune -f 2>/dev/null || true
	@docker builder prune -af 2>/dev/null || true

redeploy-lambdas: scripts-setup ## Rebuild and redeploy every local Lambda from the current source
	@# A Lambda does NOT rebuild with `docker compose`. The services do, so the
	@# habit the rest of this Makefile teaches is wrong for exactly these seven
	@# functions — and the failure is SILENT: the source is correct, its tests
	@# pass, and the deployed function keeps running whatever it ran before.
	@#
	@# That shipped a real bug. The Cognito trigger was fixed to emit
	@# severity_text/severity_number instead of a hardcoded `level: "info"`, and
	@# days later every otp_challenge_rejected — a wrong one-time code — was
	@# still arriving at severity 0, because the deployed zip predated the fix.
	@# Nothing reported it; only reading the deployed code revealed it.
	@#
	@# BUILD FIRST, then deploy. The two bundled functions are esbuild bundles;
	@# uploading dist/ without rebuilding would deploy the previous bundle and
	@# report success. The Cognito functions are bare .mjs with no build step.
	@#
	@# `terraform apply` would also redeploy these (archive_file's hash triggers
	@# the update), but a second phase-1 apply fails against Floci on UpdateTags
	@# — see docs/lessons/floci-rds-apigw-limits.md — so it is not the loop to
	@# reach for after a code edit.
	pnpm --filter @3mrai/events-pipeline build
	pnpm --filter @3mrai/realtime-events build
	$(PY) infra/scripts/redeploy_lambdas.py


observability-up: ## Start OpenObserve + the OTel collector (opt-in; ~512MB-1.5GB RAM)
	# --force-recreate, scoped to just these services: they sit outside the main
	# up/down cycle, so a recreated stack network can leave them stranded on a dead
	# network (exit 128, "network ... not found"). Recreating them re-attaches to the
	# current network. Naming the services keeps --force-recreate from bouncing the
	# whole app stack.
	#
	# EVERY service in the profile must be named here. Naming services is what
	# makes --force-recreate surgical, but it also means a service the list forgets
	# NEVER STARTS — the profile alone does not start it. That is exactly how
	# jaeger (since removed) sat in `profiles: [observability]` and in no target,
	# leaving the entire tracing path dead. Add to the profile, add here.
	#
	# The failure is quiet and loud only in the collector's own log: the exporter
	# retries "no children to pick from" (gRPC for: the target resolved to no
	# address) and after the retry budget logs "Exporting failed. Dropping data."
	# Traces and logs both go to OpenObserve now, so a missing collector means an
	# empty UI on a port with nothing listening and no other clue.
	$(COMPOSE) --profile observability up -d --force-recreate openobserve otel-collector
	@# The dashboards live in the `openobserve-data` volume, which `make clean`
	@# now deletes (that is the point of the -v). Nothing recreated them: this
	@# target started the stack and `observability-dashboards` existed but was
	@# invoked by NOTHING — not bootstrap, not here — so every from-scratch
	@# rebuild left OpenObserve running with no dashboards at all, and the only
	@# way back was remembering an undocumented manual command.
	@#
	@# Chained here rather than in bootstrap because this is the target that
	@# creates the thing they live in. The importer keys on dashboard TITLE and
	@# PUTs when one already exists, so running it on every up is a no-op when
	@# they are current.
	@#
	@# The wait is not cosmetic: openobserve declares no healthcheck, so
	@# `up -d` returns as soon as the container is created, well before it
	@# accepts HTTP. Polling rather than sleeping a fixed guess — a sleep long
	@# enough to be safe is mostly wasted, and one short enough to feel quick
	@# fails on a cold start.
	@printf 'Waiting for OpenObserve to accept requests'
	@for i in $$(seq 1 60); do \
		if curl -sf -o /dev/null http://localhost:5080/healthz 2>/dev/null; then break; fi; \
		printf '.'; sleep 1; \
	done; echo
	@# Declares the gen_ai_* columns on the traces stream. Without them
	@# OpenObserve's trace waterfall 400s on EVERY trace, because its
	@# /traces/{id}/dag endpoint SELECTs gen_ai_operation_name unconditionally and
	@# nothing here emits it. Not a version bug — v0.92.2 was tested side by side
	@# and fails identically; see the script's docstring.
	@#
	@# Chained here for the same reason observability-dashboards is: the schema
	@# lives in the openobserve-data volume that `make clean` deletes, so a
	@# hand-run seed survives only until the next from-scratch rebuild. Idempotent
	@# — it checks the schema first and re-running is a no-op.
	@$(MAKE) --no-print-directory observability-traces-schema
	@$(MAKE) --no-print-directory observability-dashboards
	@echo "OpenObserve UI on http://localhost:5080 once it's healthy (~5s)."
	@echo "Login: admin@3mrai.local / Complexpass#123"
	@# This target is now also called BY `bootstrap-converge`, before the services
	@# start — it is no longer opt-in. Running it by hand stays valid and is a
	@# no-op when the containers are already up; what it is NOT is the only thing
	@# standing between the services and a resolvable `otel-collector` hostname.
	@# See the note in bootstrap-converge for why that became mandatory.

observability-down: ## Stop the observability stack (leaves the rest running)
	@# Every service in the profile, for the same reason observability-up names
	@# them all: a "down" that leaves one running contradicts the target name.
	$(COMPOSE) stop openobserve otel-collector

observability-traces-schema: ## Declare the gen_ai_* fields OpenObserve's trace waterfall requires (idempotent)
	@# O2_ORG must match the collector's, exactly as for the dashboards below —
	@# and O2_TRACES_STREAM must match the collector's `stream-name` header for
	@# traces (app_traces). Seeding the wrong stream returns 200 and fixes
	@# nothing: the columns land where no one reads them.
	@#
	@# Plain python3, not .venv/bin/python: this is standard-library only and
	@# deliberately has no venv dependency, so it runs before scripts-setup has
	@# ever executed on a fresh clone.
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
	@# .claude/ is the source of truth; .ai/ is derived. Distilling universal
	@# rules from Claude-specific ones needs judgment, so it runs through the
	@# ai-config-sync subagent — this target is the deterministic half only.
	@# The checksum bracket is the guard: a sync must never alter the source.
	@#
	@# ENTRIES UNDER .agents/skills/ THAT MIRROR .ai/skills/ MUST BE SYMLINKS.
	@# Four of them (golang-concurrency, -context, -database, -error-handling)
	@# were committed as REAL DIRECTORIES holding a byte-identical copy. lnai
	@# rewrites those on every run, so each sync deleted 21 tracked files and
	@# re-created them untracked — `ai-sync-check` then failed for a reason that
	@# reads as corruption and was really a format mismatch. Converted to symlinks
	@# on 2026-08-31 (verified identical first); two consecutive syncs are now a
	@# no-op. Note the five WITHOUT a .ai/skills/ counterpart (golang-code-style,
	@# -naming, -observability, -project-layout, -testing) are legitimately real
	@# directories — they own their content. Add a mirrored skill as a symlink.
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
