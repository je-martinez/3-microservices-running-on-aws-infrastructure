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
	@# CONTRACT: This target REQUIRES a database — it is not a unit-only suite.
	@# internal/adapter/mysql's tests need a real MySQL, and without one they skip
	@# while the package still prints `ok`. That hollow green is what the TestMain
	@# gate in internal/adapter/mysql/dbgate_test.go FAILS the run
	@# instead. Use `make test-db` to run them, or TRACKING_SKIP_DB_TESTS=1 to
	@# opt out deliberately.
	$(GO) test -race $(PKG)

.PHONY: test-cover
test-cover: verify-toolchain ## Run tests and write coverage.out
	$(GO) test -race -coverprofile=coverage.out $(PKG)

# ─── The real-database suite ─────────────────────────────────────────────────
#
# CONTRACT: DISCOVER the DSN from the generated .env.local.tracking; never
# hardcode a port. Floci assigns RDS proxy ports by cluster creation order, so
# a literal works until the next `make floci-up` and then fails looking like a
# broken test. The two rewrites below reach the parser
# (internal/platform/config.MySQLDSN) and the host, which cannot resolve
# `floci`. See [[2026-09-30-discover-the-dsn-do-not-hardcode-the-port]]
ENV_FILE       := ../../.env.local.tracking
TRACKING_DB_URL = $(shell sed -n 's|^DATABASE_WRITER_URL=mysql+pymysql://|mysql://|p' $(ENV_FILE) | sed 's|@floci:|@127.0.0.1:|' | sed 's|?.*||')
# The server DSN drops the database segment: the count and soft-delete suites
# each CREATE THEIR OWN throwaway schema rather than touching the shared
# `tracking` database, which the running service and the E2E suite both use.
TRACKING_DB_SERVER = $(shell echo '$(TRACKING_DB_URL)' | sed -E 's|^mysql://([^@]+)@([^/]+)/.*|\1@tcp(\2)/|')
# Root superuser for throwaway-schema DDL in repository tests. The `test` user
# holds only database-scoped grants — see create_mysql_database.py.
TRACKING_DB_ADMIN_SERVER = $(shell echo '$(TRACKING_DB_SERVER)' | sed 's|^[^@]*@|root:test@|')

.PHONY: test-db-env
test-db-env: ## Print the discovered database DSNs without running anything
	@if [ ! -f $(ENV_FILE) ]; then \
		echo "ERROR: $(ENV_FILE) does not exist. Run 'make env-file' from the repo root."; exit 1; fi
	@if [ -z "$(TRACKING_DB_URL)" ]; then \
		echo "ERROR: no DATABASE_WRITER_URL in $(ENV_FILE). Run 'make env-file' from the repo root."; exit 1; fi
	@echo "TRACKING_DATABASE_URL   = $(TRACKING_DB_URL)"
	@echo "TRACKING_TEST_MYSQL_DSN = $(TRACKING_DB_SERVER)"
	@echo "TRACKING_TEST_MYSQL_ADMIN_DSN = $(TRACKING_DB_ADMIN_SERVER)"

.PHONY: test-db
test-db: verify-toolchain test-db-env ## Run the FULL suite including the real-MySQL tests
	@# CONTRACT: Set BOTH. TRACKING_DATABASE_URL drives the creation/reads/
	@# transition suites and TRACKING_TEST_MYSQL_DSN the count/soft-delete ones;
	@# setting one leaves the other group silently skipping. Fourteen tests, not
	@# eleven. See [[2026-09-30-go-test-discards-a-passing-packages-output]]
	TRACKING_DATABASE_URL='$(TRACKING_DB_URL)' \
	TRACKING_TEST_MYSQL_DSN='$(TRACKING_DB_SERVER)' \
	TRACKING_TEST_MYSQL_ADMIN_DSN='$(TRACKING_DB_ADMIN_SERVER)' \
	$(GO) test -race $(PKG)

.PHONY: test-no-db
test-no-db: verify-toolchain ## Run the suite WITHOUT a database, opting out explicitly and loudly
	@# CONTRACT: The banner belongs HERE, in make, not in TestMain. `go test`
	@# discards a passing package's stdout unless -v is given, so a warning
	@# printed from the test is invisible in a default run — and the one channel
	@# Go leaves open without -v is a FAILURE, which is what an opt-out exists
	@# not to do. make's output is never buffered.
	@# See [[2026-09-30-go-test-discards-a-passing-packages-output]]
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
