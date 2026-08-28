# Makefile for the Tracking Go service.
#
# Every target assumes goenv has selected the version in .go-version. Run all
# targets from services/tracking-go/ so goenv picks that file up.

GO          ?= go
BINARY      := bin/tracking-server
PKG         := ./...
MODULE      := github.com/jemartinez/3mrai/services/tracking-go

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.PHONY: verify-toolchain
verify-toolchain: ## Fail loudly if the active Go is not 1.26.7
	@test "$$($(GO) env GOVERSION)" = "go1.26.7" || \
		{ echo "ERROR: active Go is $$($(GO) env GOVERSION), want go1.26.7. Run: goenv local 1.26.7"; exit 1; }

.PHONY: fmt
fmt: ## Format all Go source in place
	gofmt -s -w .

.PHONY: fmt-check
fmt-check: ## Fail if any file is unformatted
	@out="$$(gofmt -s -l .)"; \
	if [ -n "$$out" ]; then echo "unformatted files:"; echo "$$out"; exit 1; fi

.PHONY: lint
lint: ## Run golangci-lint
	golangci-lint run

.PHONY: build
build: verify-toolchain ## Compile the server binary into bin/
	$(GO) build -o $(BINARY) ./cmd/server

.PHONY: test
test: verify-toolchain ## Run the full suite — FAILS without a database (see test-db)
	@# NOT "unit tests, no external services required", which is what this target
	@# used to claim. internal/adapter/mysql's tests need a real MySQL, and
	@# without one they skip while the package still prints `ok`. That hollow
	@# green already cost this migration a Wave-3A debugging session, so the
	@# TestMain gate in internal/adapter/mysql/dbgate_test.go now FAILS the run
	@# instead. Use `make test-db` to run them, or TRACKING_SKIP_DB_TESTS=1 to
	@# opt out deliberately.
	$(GO) test -race $(PKG)

.PHONY: test-cover
test-cover: verify-toolchain ## Run tests and write coverage.out
	$(GO) test -race -coverprofile=coverage.out $(PKG)

# ─── The real-database suite ─────────────────────────────────────────────────
#
# THE PORT IS NOT FIXED. Floci assigns RDS proxy ports from 7000-7099 by cluster
# CREATION ORDER, which is not stable across applies — MySQL and Postgres have
# been observed to swap. Hardcoding 7002 here would work until the next
# `make floci-up` and then fail in a way that looks like a broken test.
#
# So the DSN is DISCOVERED, from the generated .env.local.tracking, which
# `make env-file` writes from Terraform outputs. That file is the single place
# the discovered port already lives; re-discovering it here would be a second
# source that can disagree with the first.
#
# It read .env.local.tracking-go until the cutover, when this service took over
# the `tracking` compose key and its env file. There is no -go file any more.
#
# Two rewrites are applied to the value found there:
#   - the SQLAlchemy driver prefix `mysql+pymysql://` becomes `mysql://`, which
#     is what internal/platform/config.MySQLDSN parses;
#   - the compose hostname `floci` becomes 127.0.0.1, because `make test-db`
#     runs on the HOST, outside the compose network, where `floci` does not
#     resolve.
ENV_FILE       := ../../.env.local.tracking
TRACKING_DB_URL = $(shell sed -n 's|^DATABASE_WRITER_URL=mysql+pymysql://|mysql://|p' $(ENV_FILE) | sed 's|@floci:|@127.0.0.1:|' | sed 's|?.*||')
# The server DSN drops the database segment: the count and soft-delete suites
# each CREATE THEIR OWN throwaway schema rather than touching the shared
# `tracking` database, which the running service and the E2E suite both use.
TRACKING_DB_SERVER = $(shell echo '$(TRACKING_DB_URL)' | sed -E 's|^mysql://([^@]+)@([^/]+)/.*|\1@tcp(\2)/|')

.PHONY: test-db-env
test-db-env: ## Print the discovered database DSNs without running anything
	@if [ ! -f $(ENV_FILE) ]; then \
		echo "ERROR: $(ENV_FILE) does not exist. Run 'make env-file' from the repo root."; exit 1; fi
	@if [ -z "$(TRACKING_DB_URL)" ]; then \
		echo "ERROR: no DATABASE_WRITER_URL in $(ENV_FILE). Run 'make env-file' from the repo root."; exit 1; fi
	@echo "TRACKING_DATABASE_URL   = $(TRACKING_DB_URL)"
	@echo "TRACKING_TEST_MYSQL_DSN = $(TRACKING_DB_SERVER)"

.PHONY: test-db
test-db: verify-toolchain test-db-env ## Run the FULL suite including the real-MySQL tests
	@# BOTH variables, deliberately. This package's tests read two different ones
	@# — TRACKING_DATABASE_URL for the creation/reads/transition suites and
	@# TRACKING_TEST_MYSQL_DSN for the count/soft-delete suites — and setting only
	@# one leaves the other group silently skipping. That split is exactly why the
	@# documented skip list said "eleven tests" when a database-less run actually
	@# skips fourteen.
	TRACKING_DATABASE_URL='$(TRACKING_DB_URL)' \
	TRACKING_TEST_MYSQL_DSN='$(TRACKING_DB_SERVER)' \
	$(GO) test -race $(PKG)

.PHONY: test-no-db
test-no-db: verify-toolchain ## Run the suite WITHOUT a database, opting out explicitly and loudly
	@# The recorded-choice path.
	@#
	@# THE BANNER LIVES HERE, IN MAKE, AND NOT IN THE TEST — measured, not
	@# assumed. `go test` BUFFERS AND DISCARDS a passing package's stdout and
	@# stderr unless -v is passed, so the gate's own opt-out warning (printed
	@# from TestMain in internal/adapter/mysql/dbgate_test.go) is invisible in a
	@# default run. Verified: `grep -c "DATABASE TESTS WERE SKIPPED"` returns 1
	@# with -v and 0 without it.
	@#
	@# That is a real limitation of doing this from inside a test binary: the
	@# ONLY channel Go surfaces reliably without -v is a FAILURE, and failing is
	@# exactly what the opt-out exists not to do. So the always-visible half of
	@# the warning is printed by make, whose output is never buffered, and the
	@# test keeps the detailed inventory for anyone running with -v.
	TRACKING_SKIP_DB_TESTS=1 $(GO) test -race $(PKG); status=$$?; \
	echo ""; \
	echo "=============================================================================="; \
	echo "NOT A FULL PASS: the real-MySQL tests did NOT run (TRACKING_SKIP_DB_TESTS=1)."; \
	echo "Unverified: cognito_sub ownership scoping, scoped-vs-unscoped reads, both"; \
	echo "soft-delete paths, transactional rollback, the 1062 duplicate-key"; \
	echo "translation, fsp-0 DATETIME rounding and JSON_CONTAINS tag matching."; \
	echo "Run 'make test-db' for the real thing, or add -v to see the full inventory."; \
	echo "=============================================================================="; \
	exit $$status

.PHONY: tidy
tidy: ## Sync go.mod/go.sum with the imports actually used
	$(GO) mod tidy

.PHONY: clean
clean: ## Remove build and coverage artifacts
	rm -rf bin coverage.out coverage.html

# ─── Migrations (golang-migrate) ─────────────────────────────────────────────
# DSN is assembled from the generated .env.local.tracking values. Never hardcode
# credentials here.

MIGRATE_DSN := mysql://$(TRACKING_DB_USER):$(TRACKING_DB_PASSWORD)@tcp($(TRACKING_DB_HOST):$(TRACKING_DB_PORT))/$(TRACKING_DB_NAME)

.PHONY: migrate-up
migrate-up: ## Apply all pending migrations (FRESH databases only)
	migrate -path ./migrations -database "$(MIGRATE_DSN)" up

.PHONY: migrate-down
migrate-down: ## Roll back one migration
	migrate -path ./migrations -database "$(MIGRATE_DSN)" down 1

.PHONY: migrate-version
migrate-version: ## Print the current version and dirty flag
	migrate -path ./migrations -database "$(MIGRATE_DSN)" version

.PHONY: migrate-stamp-baseline
migrate-stamp-baseline: ## Mark an ALREADY-Alembic-migrated DB as at version 1 WITHOUT running SQL
	@echo "Stamping schema_migrations at version 1. No DDL will run."
	@echo "Use this ONLY against a database whose tables Alembic already created."
	migrate -path ./migrations -database "$(MIGRATE_DSN)" force 1

# ─── sqlc ────────────────────────────────────────────────────────────────────

.PHONY: sqlc-generate
sqlc-generate: ## Regenerate the data layer from migrations/ + queries/
	sqlc generate

.PHONY: sqlc-verify
sqlc-verify: ## Fail if the generated code is stale relative to the SQL
	sqlc diff
