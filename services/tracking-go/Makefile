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
test: verify-toolchain ## Run unit tests (no external services required)
	$(GO) test -race $(PKG)

.PHONY: test-cover
test-cover: verify-toolchain ## Run tests and write coverage.out
	$(GO) test -race -coverprofile=coverage.out $(PKG)

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
