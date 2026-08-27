---
title: Tracking Service Go Migration Implementation Plan
type: plan
area: tracking
status: draft
created: 2026-08-27
updated: 2026-08-27
tags:
  - type/plan
  - area/tracking
  - status/draft
propagates-to:
  - "[[tracking-service-design]]"
  - "[[testmode-in-process-asyncio-task]]"
  - "[[ADR-0021-tracking-go-gin-sqlc-stack]]"
  - "[[plans/index]]"
related:
  - "[[2026-08-27-tracking-go-migration-design]]"
  - "[[ADR-0021-tracking-go-gin-sqlc-stack]]"
  - "[[user-id-vs-cognito-sub-ownership-key]]"
  - "[[two-api-keys-two-trust-domains]]"
  - "[[testmode-in-process-asyncio-task]]"
  - "[[logging-context]]"
  - "[[testing]]"
  - "[[git-workflow]]"
  - "[[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]"
---

# Tracking Service Go Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Tracking microservice in Go/Gin at `services/tracking-go/`, behaviourally identical to the Python/FastAPI service, so the Python folder can be deleted once a four-part gate proves equivalence.

**Architecture:** Hexagonal (ports and adapters). `internal/domain` is pure — it imports no framework, no driver, no SDK — so the compiler prevents infrastructure leaking into business rules. Use cases live in `internal/app`, each declaring the narrow port it consumes (there is no central `ports.go` and no shared repository interface). Adapters under `internal/adapter/{http,mysql,redis,sqs,grpcusers,otel}`. All dependencies are wired by hand in `cmd/server/main.go` — no DI container, no code generation for wiring, no reflection.

**Tech Stack:** Go 1.25.14 (pinned via goenv, `.go-version`) · Gin · sqlc + `database/sql` + `go-sql-driver/mysql` · golang-migrate · `go-redis` · `aws-sdk-go-v2` (SQS, CloudWatch) · `grpc-go` · OpenTelemetry Go SDK (`otelgin`, `otelsql`, `otelgrpc`) · `log/slog`.

**Spec:** `docs/superpowers/specs/2026-08-27-tracking-go-migration-design.md`

## Global Constraints

These apply to EVERY task. They are copied verbatim from the spec and from the extracted Python contracts; do not restate them per task, but never violate them.

**Language and tooling**
- Go version is exactly `1.25.14`, pinned in `services/tracking-go/.go-version`. Before ANY Go command run `goenv local 1.25.14` (or ensure `goenv version` reports it). goenv 3.1.4 is already installed; the toolchain itself is not — `goenv install 1.25.14` is a wave-0 step.
- Module path: `github.com/jemartinez/3mrai/services/tracking-go`.
- `gofmt -s -w .` before every commit. `golangci-lint run` must pass.
- Never use `npm`/`yarn` anywhere in this repo (pnpm only); irrelevant to Go tasks but applies to any E2E/load-test work.

**Naming and layout**
- `internal/domain` MUST NOT import: `gin`, `sqlc`-generated packages, `redis`, `aws-sdk`, `grpc`, `otel`, or `net/http`. A domain file importing any of these is a defect regardless of whether tests pass.
- Ports (interfaces) are declared in the file of the use case that CONSUMES them, kept narrow (one or two methods). Never a central interface file.
- Errors are values declared beside the type that produces them (`var ErrTrackingNotFound = errors.New(...)`), never in a shared `errors` package.

**Wire-contract invariants (highest risk — each was verified against the Python source)**
- Field names on the wire are snake_case everywhere. There are no camelCase aliases in this service.
- The `datetime` field on every response is a STRING built as `isoformat() + "Z"`, NOT RFC3339 from a time type. A zero/absent value renders as `""`, never `null`. Go: format with `2006-01-02T15:04:05.999999` then append `"Z"`.
- `shipping_address` and `cognito_sub` appear on NO HTTP response. Response structs must be physically incapable of holding them (do not reuse the domain type as the response type).
- Ownership on user-scoped reads is filtered by `cognito_sub`, NEVER by `user_id`. The `x-user-id` header carries the JWT `sub`, not the internal `usr_` id.
- The empty string is NOT a valid identity. `x-user-id: ""` must be treated exactly as absent (401). nginx sends `""` when the token is missing or malformed.
- **Scoped vs unscoped reads are SEPARATE methods** (`GetByOrderID` / `GetByOrderIDScoped`), never one method with an optional parameter. Go's zero value for `string` is `""`, not `nil`, so an optional-parameter port silently converts "unscoped" into "scoped to empty string" or vice versa. This is the single highest-risk translation in the migration.

**Time**
- MySQL `DATETIME` here has fsp 0 and MySQL ROUNDS fractional seconds, it does not truncate (verified on 8.0.46: `04:03:46.965829` stores as `04:03:47`). Every timestamp must be `time.Now().UTC().Truncate(time.Second)` at a single mint point.
- The DSN must set `parseTime=true&loc=UTC`.
- A write path that produces a tracking row and its history row must stamp BOTH from one `now` value, passed in — not two calls to `time.Now()`.

**Logging**
- Structured JSON to stdout via `log/slog`. Severity strings are `DEBUG`/`INFO`/`WARN`/`ERROR`/`FATAL` — `WARN` not `WARNING`, `FATAL` not `CRITICAL`.
- Unknown/absent fields are OMITTED, never emitted as `null` and never as `""`. Build attributes conditionally.
- Never log: passwords, tokens, API keys (not even a prefix or length), full request bodies, plaintext email, or `shipping_address` (PII).
- There is no SUCCESS severity. Success is `INFO` + `app_event=<flow>_succeeded`.
- The seven allowed log-context keys are exactly: `cognito_sub`, `user_id`, `order_id`, `tracking_id`, `email_hash`, `request_id`, `cache_result`.

**OTel**
- Endpoint, protocol and exporter-disabling come from standard `OTEL_*` environment variables, never from code. What lives in code is only WHICH surfaces are instrumented (Go has no `opentelemetry-instrument` equivalent).
- Tracer names are exactly: `tracking-workflow`, `tracking-messaging`, `tracking-metrics`, `tracking-cache`.

**Events**
- The SQS envelope is validated downstream by a Zod schema in the events-pipeline Lambda. An extra field, a missing field, or a `null` where omission is required produces a `PermanentError` that consumes the record and LOSES the email and the WebSocket push. "Almost identical" is a failure.
- Publishing is best-effort and NEVER raises: log with a machine-readable `reason` and swallow.

**Testing**
- Repository/integration tests run against a REAL MySQL, never mocks (mocks hide schema and driver bugs — a documented lesson in this repo).
- Any test asserting ownership MUST use two DIFFERENT values for `user_id` and `cognito_sub`, or it structurally cannot fail on the ownership bug.
- Table-driven tests are the default Go idiom; use `t.Run` subtests.

**Git**
- Leave all work in the working tree. Implementers NEVER run git and never touch Linear. The main session commits via the A/B/C/D/E menu.

---
## Wave 0 — Foundations

**This wave is SEQUENTIAL.** Tasks 1–7 run one after another, in order, by a single implementer. Do not fan out inside this wave.

**This wave ends at a review checkpoint.** When Task 7 is green, stop and hand the branch back for review before any Wave 1 or Wave 2 work begins. The reason is structural, not ceremonial: `internal/domain` (Tasks 3, 4, 5) and the generated data layer (Task 6) are what every later wave builds on. Waves 1 and 2 fan out into parallel agents that all import these packages, so a wrong status guard, a wrong ID alphabet, or a wrong sqlc override discovered in Wave 2 invalidates work already done in parallel across several branches. Reviewing once, here, at the narrow point of the funnel, is far cheaper than reconciling four parallel branches later.

---

### Task 1: Project scaffold + goenv toolchain

**Files:**
- Create: `services/tracking-go/.go-version`
- Create: `services/tracking-go/go.mod`
- Create: `services/tracking-go/Makefile`
- Create: `services/tracking-go/.golangci.yml`
- Create: `services/tracking-go/.gitignore`
- Test: `services/tracking-go/internal/domain/doc.go`, `services/tracking-go/internal/domain/doc_test.go`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the Go module `github.com/jemartinez/3mrai/services/tracking-go`, and the package `internal/domain` (package name `domain`), which every later domain task adds files to.

- [ ] **Step 1: Write the failing test**

Create the directory and the trivial package the test proves compiles. First `services/tracking-go/internal/domain/doc.go`:

```go
// Package domain holds the pure business rules of the Tracking service.
//
// PURITY RULE (enforced by review, and by the import test in Task 5): this
// package and every file in it may import ONLY the Go standard library. No gin,
// no sqlc-generated package, no redis, no aws-sdk, no grpc, no otel, and not
// even net/http. Business rules that compile without a framework are business
// rules that can be tested without one.
package domain

// Version is the schema-independent marker used by the scaffold test to prove
// the toolchain compiles and runs this module. It has no runtime meaning.
const Version = "tracking-go"
```

Then the failing test, `services/tracking-go/internal/domain/doc_test.go`:

```go
package domain

import "testing"

func TestToolchainCompilesAndRuns(t *testing.T) {
	if Version != "tracking-go" {
		t.Fatalf("Version = %q, want %q", Version, "tracking-go")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Before the toolchain exists the test cannot even build. Run:

```bash
cd services/tracking-go && go test ./internal/domain/
```

Expected output while `.go-version`/`go.mod` are still missing — one of:

```
go: cannot find main module, but found no go.mod in ...
```

or, if goenv has no such toolchain installed:

```
goenv: version `1.25.14' is not installed
```

Either message is the expected failure. This is the "red" state.

- [ ] **Step 3: Write minimal implementation**

Install and pin the toolchain (goenv 3.1.4 is already present; the Go toolchain is not):

```bash
goenv install 1.25.14
cd services/tracking-go && goenv local 1.25.14
goenv version   # must print: 1.25.14 (set by .../services/tracking-go/.go-version)
go version      # must print: go version go1.25.14 darwin/arm64
```

`goenv local 1.25.14` writes `services/tracking-go/.go-version`. Verify its content is exactly:

```
1.25.14
```

Initialize the module:

```bash
cd services/tracking-go && go mod init github.com/jemartinez/3mrai/services/tracking-go
```

`services/tracking-go/go.mod` must then read:

```
module github.com/jemartinez/3mrai/services/tracking-go

go 1.25.14
```

Create `services/tracking-go/.gitignore`:

```gitignore
# Compiled binary produced by `make build`
/bin/

# Test and coverage artifacts
*.test
coverage.out
coverage.html

# Local env overrides. Env files in this repo are GENERATED by `make env-file`
# from Terraform outputs and are never hand-edited; none of them belong here.
.env
.env.local

# Editor/OS noise
.DS_Store
```

Create `services/tracking-go/.golangci.yml`:

```yaml
# golangci-lint configuration for the Tracking Go service.
version: "2"

run:
  timeout: 5m
  tests: true

linters:
  enable:
    - errcheck      # an unchecked error is the most common Go defect
    - govet
    - ineffassign
    - staticcheck
    - unused
    - bodyclose     # an unclosed HTTP response body leaks a connection
    - errorlint     # forces errors.Is/As over == comparisons on wrapped errors
    - gosec         # flags math/rand where crypto/rand is required (Task 5)
    - noctx         # a request without a context cannot be cancelled or traced
    - sqlclosecheck # an unclosed sql.Rows holds a pooled connection open

formatters:
  enable:
    - gofmt
    - goimports
  settings:
    gofmt:
      simplify: true
    goimports:
      local-prefixes:
        - github.com/jemartinez/3mrai/services/tracking-go

issues:
  max-issues-per-linter: 0
  max-same-issues: 0
```

Create `services/tracking-go/Makefile` (tabs, not spaces, for recipe lines):

```makefile
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
verify-toolchain: ## Fail loudly if the active Go is not 1.25.14
	@test "$$($(GO) env GOVERSION)" = "go1.25.14" || \
		{ echo "ERROR: active Go is $$($(GO) env GOVERSION), want go1.25.14. Run: goenv local 1.25.14"; exit 1; }

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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/tracking-go && make verify-toolchain && go test ./internal/domain/
```

Expected output:

```
ok  	github.com/jemartinez/3mrai/services/tracking-go/internal/domain	0.00Xs
```

Also confirm formatting and linting are clean:

```bash
cd services/tracking-go && make fmt-check && make lint
```

`make lint` must exit 0. If `golangci-lint` is not installed, install it with `go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest` and re-run; the lint gate is not optional.

- [ ] **Step 5: Commit** *(the implementer does NOT run this — the main session commits via the A/B/C/D/E menu. Recorded here for plan completeness.)*

```bash
git add services/tracking-go && \
git commit -m "build(tracking): scaffold tracking-go module with goenv-pinned Go 1.25.14"
```

---

### Task 2: golang-migrate baseline migration

**Files:**
- Create: `services/tracking-go/migrations/000001_baseline.up.sql`
- Create: `services/tracking-go/migrations/000001_baseline.down.sql`
- Create: `services/tracking-go/migrations/README.md`
- Modify: `services/tracking-go/Makefile` (add migrate targets)

**Interfaces:**
- Consumes: the module from Task 1.
- Produces: the schema that Task 6's `sqlc` reads as its source of truth (`sqlc.yaml` points its `schema:` at `migrations/`), and the two tables every repository test in Waves 1–2 writes against.

This task translates the four Alembic revisions (`da01eaebb060` → `b17f4c2e9a30` → `0a1cc6845c4a` → `c93b7d1f52ae`) into ONE squashed baseline. The Go service does not replay the Python migration history; it declares the schema that history arrived at.

**Details that are load-bearing. Each of these is a real trap, not a style preference:**

1. **`DEFAULT (JSON_ARRAY())` — the parentheses are MANDATORY.** MySQL rejects a bare literal default on a `JSON` column (`Error 1101: BLOB, TEXT, GEOMETRY or JSON column 'tags' can't have a default value`). Only a parenthesized *expression* default is legal. Writing `DEFAULT '[]'` fails outright; omitting the default silently gives you `NULL` tags, and `JSON_CONTAINS(NULL, ...)` evaluates to `NULL` rather than `FALSE`, so a NULL-tags row is silently excluded from the e2e-cleanup predicate — a bug that looks like an accident rather than a schema error.

2. **Charset and collation MUST be declared explicitly.** The Python code NEVER declared them; the tables inherited `utf8mb4_unicode_ci` from the server. MySQL 8's own default is `utf8mb4_0900_ai_ci`. If the Go baseline stays silent, a freshly created database gets `utf8mb4_0900_ai_ci` and string comparison semantics change silently — which would alter how `order_id` and `cognito_sub` lookups match. Declare `DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci` on both tables so the Go schema reproduces the existing one rather than the server's current default.

3. **`datetime` is a reserved-ish column name — backtick it everywhere.** In DDL, and in every query written in Task 6 and later. In `SELECT`s, alias it: ``SELECT `datetime` AS occurred_at``. An unbackticked `datetime` is a type keyword and produces a syntax error at a location that does not obviously point at the column.

4. **`tracking_history` deliberately has NO surrogate `id`, NO `tags`, NO `shipping_address`.** All three omissions are intentional. The shipping address is fixed for the lifetime of a tracking, so snapshotting it per transition would store the same JSON five times. The composite primary key `(tracking_id, status)` is a SECOND enforcement of the forward-only state machine: a tracking can hold at most one row per status, so a duplicate transition fails at INSERT even if an application-level guard is somehow bypassed.

5. **The FK carries no `ON DELETE` / `ON UPDATE` clause**, so MySQL applies `RESTRICT`. This is correct and deliberate: the application never issues `DELETE` (it soft-deletes by stamping `deleted_at`), and the database user has no `DELETE` grant. Do not "helpfully" add `ON DELETE CASCADE`.

6. **golang-migrate and Alembic are MUTUALLY BLIND.** golang-migrate tracks state in `schema_migrations (version BIGINT, dirty BOOLEAN)`; Alembic tracks it in `alembic_version (version_num VARCHAR(32))`. Neither reads the other's table. During coexistence both services share ONE database, so the baseline must be applied to an already-migrated schema as a **no-op stamp**, never re-run — re-running it would fail on `CREATE TABLE` against existing tables. Step 3 below covers this explicitly.

- [ ] **Step 1: Write the failing test**

The test for a migration is applying it to a real MySQL and inspecting the resulting schema. Create `services/tracking-go/migrations/README.md` with the operational contract, then write the verification script the step below runs. First, `services/tracking-go/migrations/README.md`:

```markdown
# Tracking Go migrations (golang-migrate)

`000001_baseline.up.sql` is a SQUASH of the four Alembic revisions the Python
service arrived at, in order:

| Alembic revision | What it added |
|---|---|
| `da01eaebb060` | `tracking` + `tracking_history`, base indexes |
| `b17f4c2e9a30` | `cognito_sub` on both tables + its two indexes |
| `0a1cc6845c4a` | `tracking.tags` (JSON, NOT NULL, `(JSON_ARRAY())` default) |
| `c93b7d1f52ae` | `tracking.tracking_number` + its UNIQUE constraint |

The Go service does not replay that history. It declares the schema the history
produced.

## The two version tables are mutually blind

golang-migrate stores state in `schema_migrations (version BIGINT, dirty BOOLEAN)`.
Alembic stores it in `alembic_version (version_num VARCHAR(32))`. Neither tool
reads the other's table, and neither will warn you about the other.

### Applying to an EXISTING (already-Alembic-migrated) database

The tables already exist. Running the baseline would fail on `CREATE TABLE`.
Stamp instead of migrate:

    migrate -path ./migrations \
            -database "mysql://$USER:$PASS@tcp($HOST:$PORT)/$DB" \
            force 1

`force 1` writes `(version=1, dirty=0)` into `schema_migrations` WITHOUT running
any SQL — it asserts "the schema is already at version 1".

### What happens to `alembic_version`

**Decision: while both services run, `alembic_version` STAYS, untouched.** The
Python service is still live during coexistence and Alembic must keep believing
it is current.

**On Python deletion, `alembic_version` is DROPPED** in the same change that
removes `services/tracking/`:

    DROP TABLE alembic_version;

Leaving both tables behind permanently is a silent trap: a stray
`alembic upgrade head` against a database whose schema has since moved on under
golang-migrate would believe it is current and do nothing, or would apply a
revision that conflicts with what golang-migrate has since written. One tool
owns the schema; the other's bookkeeping goes away with it.

### Applying to a FRESH database

    migrate -path ./migrations \
            -database "mysql://$USER:$PASS@tcp($HOST:$PORT)/$DB" \
            up

## `dirty` state

If a migration fails midway, golang-migrate marks the version dirty and refuses
to run again. Fix the schema by hand, then `force <version>` to clear the flag.
```

Now the verification script. Create `services/tracking-go/migrations/verify_baseline.sql` — the assertions the schema must satisfy:

```sql
-- Verification queries for 000001_baseline. Run against a database the baseline
-- has been applied to. Every SELECT must return the stated expected row.

-- 1. Both tables exist with the inherited (NOT the MySQL 8 default) collation.
--    Expected: two rows, both utf8mb4_unicode_ci.
SELECT TABLE_NAME, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('tracking', 'tracking_history')
ORDER BY TABLE_NAME;

-- 2. tags is NOT NULL and carries an expression default.
--    Expected: IS_NULLABLE='NO', COLUMN_DEFAULT contains 'json_array'.
SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tracking' AND COLUMN_NAME = 'tags';

-- 3. The history primary key is the composite (tracking_id, status).
--    Expected: exactly two rows, tracking_id at position 1, status at position 2.
SELECT COLUMN_NAME, ORDINAL_POSITION
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'tracking_history'
  AND CONSTRAINT_NAME = 'PRIMARY'
ORDER BY ORDINAL_POSITION;

-- 4. The FK exists with RESTRICT (MySQL's default when no clause is given).
--    Expected: DELETE_RULE='RESTRICT', UPDATE_RULE='RESTRICT'.
SELECT CONSTRAINT_NAME, DELETE_RULE, UPDATE_RULE
FROM information_schema.REFERENTIAL_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE()
  AND CONSTRAINT_NAME = 'fk_tracking_history_tracking_id';

-- 5. Both UNIQUE constraints are present under their declared names.
--    Expected: uq_tracking_order_id and uq_tracking_tracking_number.
SELECT CONSTRAINT_NAME
FROM information_schema.TABLE_CONSTRAINTS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'tracking'
  AND CONSTRAINT_TYPE = 'UNIQUE'
ORDER BY CONSTRAINT_NAME;

-- 6. All eight indexes exist.
--    Expected 8 names: the five on tracking, the three on tracking_history.
SELECT DISTINCT INDEX_NAME
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('tracking', 'tracking_history')
  AND INDEX_NAME LIKE 'idx_%'
ORDER BY INDEX_NAME;
```

- [ ] **Step 2: Run test to verify it fails**

With the `.sql` migration files not yet written, applying them produces nothing to verify. Run:

```bash
cd services/tracking-go && \
migrate -path ./migrations \
        -database "mysql://${TRACKING_DB_USER}:${TRACKING_DB_PASSWORD}@tcp(${TRACKING_DB_HOST}:${TRACKING_DB_PORT})/${TRACKING_DB_NAME}" \
        up
```

Expected failure:

```
error: no migration found for version 1: read down for version 1 .: file does not exist
```

(Install golang-migrate first if absent: `go install -tags 'mysql' github.com/golang-migrate/migrate/v4/cmd/migrate@latest`.)

- [ ] **Step 3: Write minimal implementation**

Create `services/tracking-go/migrations/000001_baseline.up.sql`:

```sql
-- Baseline schema for the Tracking service.
--
-- Squash of Alembic revisions da01eaebb060 -> b17f4c2e9a30 -> 0a1cc6845c4a ->
-- c93b7d1f52ae. See migrations/README.md before applying this to a database that
-- an Alembic-managed Python service has already migrated: there you STAMP
-- (`migrate force 1`), you do not run this file.
--
-- CHARSET/COLLATE are declared EXPLICITLY even though the Python DDL never did.
-- Python inherited utf8mb4_unicode_ci from the server. MySQL 8 would otherwise
-- default a fresh database to utf8mb4_0900_ai_ci, silently changing string
-- comparison semantics for order_id and cognito_sub lookups.

CREATE TABLE tracking (
  id               VARCHAR(28)  NOT NULL,
  user_id          VARCHAR(28)  NOT NULL,
  order_id         VARCHAR(28)  NOT NULL,
  status           VARCHAR(50)  NOT NULL,
  shipping_address JSON         NULL,
  -- Backticked: `datetime` is also a type keyword. Every query that selects it
  -- must backtick it and alias it (`datetime` AS occurred_at).
  `datetime`       DATETIME     NOT NULL,
  created_by       VARCHAR(64)  NULL,
  created_at       DATETIME     NOT NULL,
  updated_by       VARCHAR(64)  NULL,
  updated_at       DATETIME     NOT NULL,
  deleted_by       VARCHAR(64)  NULL,
  deleted_at       DATETIME     NULL,
  cognito_sub      VARCHAR(255) NULL,
  -- The parentheses around JSON_ARRAY() are MANDATORY. MySQL rejects a bare
  -- literal default on a JSON column; only a parenthesized expression default is
  -- legal. NOT NULL because JSON_CONTAINS(NULL, ...) is NULL, not FALSE, which
  -- would silently exclude a NULL-tags row from the e2e-cleanup predicate.
  tags             JSON         NOT NULL DEFAULT (JSON_ARRAY()),
  tracking_number  VARCHAR(20)  NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_tracking_order_id        UNIQUE (order_id),
  CONSTRAINT uq_tracking_tracking_number UNIQUE (tracking_number)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_tracking_deleted_at            ON tracking (deleted_at);
CREATE INDEX idx_tracking_order_id_user_id      ON tracking (order_id, user_id);
CREATE INDEX idx_tracking_user_id               ON tracking (user_id);
CREATE INDEX idx_tracking_order_id_cognito_sub  ON tracking (order_id, cognito_sub);
CREATE INDEX idx_tracking_cognito_sub           ON tracking (cognito_sub);

-- tracking_history deliberately has NO surrogate id, NO tags, and NO
-- shipping_address. The address is fixed for a tracking's lifetime, so
-- snapshotting it per transition would store identical JSON five times. The
-- composite PK (tracking_id, status) is a SECOND enforcement of the forward-only
-- state machine: at most one row per status, so a duplicate transition fails at
-- INSERT even if an application guard is bypassed.
CREATE TABLE tracking_history (
  tracking_id  VARCHAR(28)  NOT NULL,
  status       VARCHAR(50)  NOT NULL,
  user_id      VARCHAR(28)  NOT NULL,
  order_id     VARCHAR(28)  NOT NULL,
  `datetime`   DATETIME     NOT NULL,
  created_by   VARCHAR(64)  NULL,
  created_at   DATETIME     NOT NULL,
  updated_by   VARCHAR(64)  NULL,
  updated_at   DATETIME     NOT NULL,
  deleted_by   VARCHAR(64)  NULL,
  deleted_at   DATETIME     NULL,
  cognito_sub  VARCHAR(255) NULL,
  PRIMARY KEY (tracking_id, status),
  -- No ON DELETE / ON UPDATE clause: MySQL applies RESTRICT, which is what we
  -- want. The application never issues DELETE (it soft-deletes via deleted_at)
  -- and the DB user has no DELETE grant. Do not add ON DELETE CASCADE.
  CONSTRAINT fk_tracking_history_tracking_id FOREIGN KEY (tracking_id) REFERENCES tracking (id)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_tracking_history_deleted_at           ON tracking_history (deleted_at);
CREATE INDEX idx_tracking_history_order_id_user_id     ON tracking_history (order_id, user_id);
CREATE INDEX idx_tracking_history_order_id_cognito_sub ON tracking_history (order_id, cognito_sub);
```

Create `services/tracking-go/migrations/000001_baseline.down.sql`:

```sql
-- Reverse of 000001_baseline.
--
-- tracking_history is dropped FIRST: its FK references tracking.id, and the FK
-- is RESTRICT, so dropping tracking while the child table exists fails with
-- errno 3730.

DROP TABLE IF EXISTS tracking_history;
DROP TABLE IF EXISTS tracking;
```

Add the migrate targets to `services/tracking-go/Makefile` (append):

```makefile
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
```

- [ ] **Step 4: Run test to verify it passes**

Against a FRESH scratch database (never the shared one — the shared one gets `migrate-stamp-baseline` instead):

```bash
cd services/tracking-go && \
mysql -h "$TRACKING_DB_HOST" -P "$TRACKING_DB_PORT" -u "$TRACKING_DB_USER" -p"$TRACKING_DB_PASSWORD" \
      -e "DROP DATABASE IF EXISTS tracking_go_scratch; CREATE DATABASE tracking_go_scratch;" && \
migrate -path ./migrations \
        -database "mysql://${TRACKING_DB_USER}:${TRACKING_DB_PASSWORD}@tcp(${TRACKING_DB_HOST}:${TRACKING_DB_PORT})/tracking_go_scratch" \
        up
```

Expected output:

```
1/u baseline (XX.XXXms)
```

Now run the assertions:

```bash
cd services/tracking-go && \
mysql -h "$TRACKING_DB_HOST" -P "$TRACKING_DB_PORT" -u "$TRACKING_DB_USER" -p"$TRACKING_DB_PASSWORD" \
      tracking_go_scratch < migrations/verify_baseline.sql
```

Expected, query by query:
- Query 1: two rows — `tracking / utf8mb4_unicode_ci` and `tracking_history / utf8mb4_unicode_ci`. If either says `utf8mb4_0900_ai_ci`, the `COLLATE` clause was dropped.
- Query 2: `tags | NO | json_array()`.
- Query 3: exactly two rows — `tracking_id | 1`, `status | 2`.
- Query 4: `fk_tracking_history_tracking_id | RESTRICT | RESTRICT`.
- Query 5: two rows — `uq_tracking_order_id`, `uq_tracking_tracking_number`.
- Query 6: exactly eight `idx_` names.

Verify the down migration too, then drop the scratch DB:

```bash
cd services/tracking-go && \
migrate -path ./migrations \
        -database "mysql://${TRACKING_DB_USER}:${TRACKING_DB_PASSWORD}@tcp(${TRACKING_DB_HOST}:${TRACKING_DB_PORT})/tracking_go_scratch" \
        down 1 && \
mysql -h "$TRACKING_DB_HOST" -P "$TRACKING_DB_PORT" -u "$TRACKING_DB_USER" -p"$TRACKING_DB_PASSWORD" \
      -e "DROP DATABASE tracking_go_scratch;"
```

Expected: `1/d baseline (XX.XXXms)` and no error.

- [ ] **Step 5: Commit**

```bash
git add services/tracking-go/migrations services/tracking-go/Makefile && \
git commit -m "feat(tracking): golang-migrate baseline squashing the four Alembic revisions"
```

---

### Task 3: Domain — Status forward-only state machine

**Files:**
- Create: `services/tracking-go/internal/domain/status.go`
- Test: `services/tracking-go/internal/domain/status_test.go`

**Interfaces:**
- Consumes: the `domain` package from Task 1.
- Produces (every later task depends on these exact names):

```go
type Status string

const (
	StatusPlaced         Status = "PLACED"
	StatusProcessing     Status = "PROCESSING"
	StatusShipped        Status = "SHIPPED"
	StatusOutForDelivery Status = "OUT_FOR_DELIVERY"
	StatusDelivered      Status = "DELIVERED"
)

const (
	InitialStatus  = StatusPlaced
	TerminalStatus = StatusDelivered
)

type RejectionReason string

const (
	ReasonAlreadyDelivered  RejectionReason = "already_delivered"
	ReasonBackwardTransition RejectionReason = "backward_transition"
	ReasonNotStrictlyForward RejectionReason = "not_strictly_forward"
)

type TransitionCheck struct {
	Allowed bool
	Reason  RejectionReason // "" when Allowed is true
}

type InvalidTransitionError struct {
	Current   Status
	Requested Status
	Reason    RejectionReason
}

func (e *InvalidTransitionError) Error() string

func StatusIndex(s Status) (int, bool)
func CheckTransition(current, requested Status) TransitionCheck
func CanTransition(current, requested Status) bool
func AssertCanTransition(current, requested Status) error
func NextStatus(current Status) (Status, bool)
func ParseStatus(s string) (Status, error)
```

**Rules this task must implement exactly:**

- The five values in progression order are `PLACED`, `PROCESSING`, `SHIPPED`, `OUT_FOR_DELIVERY`, `DELIVERED`, with indices 0..4. Stored as `VARCHAR(50)`, never a MySQL `ENUM`.
- **Ordering comes from an explicit ordered slice, NEVER from comparing the string values.** `Status` has underlying type `string`, so `<` compiles and silently gives alphabetical order, in which `DELIVERED < PLACED` — exactly backwards. This must be stated in a code comment.
- Three guards, in this exact order — **the order is load-bearing**:
  1. `current == DELIVERED` → reject with `already_delivered`. Checked FIRST so a delivered tracking reports this whatever is requested of it, **including `DELIVERED` itself**.
  2. `requestedIndex < currentIndex` → reject with `backward_transition`.
  3. `requestedIndex == currentIndex` → reject with `not_strictly_forward`.
  Otherwise, allowed.
- **Skipping IS allowed.** `PLACED → DELIVERED` is legal. This is not a next-step-only machine.
- `NextStatus(current)` returns the next status, and `ok=false` at `DELIVERED` — reaching the end is the expected way a TestMode run finishes, not an error.
- `ParseStatus` is case-SENSITIVE. Its failure message is exactly: `invalid tracking status 'FOO'; expected one of: PLACED, PROCESSING, SHIPPED, OUT_FOR_DELIVERY, DELIVERED`.

- [ ] **Step 1: Write the failing test**

Create `services/tracking-go/internal/domain/status_test.go`:

```go
package domain

import (
	"errors"
	"testing"
)

func TestStatusOrderIsProgressionNotAlphabetical(t *testing.T) {
	// The guard rail for this entire file: if ordering ever came from comparing
	// the string values, DELIVERED would sort before PLACED.
	if !(StatusDelivered < StatusPlaced) {
		t.Fatal("precondition changed: DELIVERED no longer sorts before PLACED as a string")
	}
	dIdx, ok := StatusIndex(StatusDelivered)
	if !ok {
		t.Fatal("StatusIndex(DELIVERED) not found")
	}
	pIdx, ok := StatusIndex(StatusPlaced)
	if !ok {
		t.Fatal("StatusIndex(PLACED) not found")
	}
	if dIdx <= pIdx {
		t.Fatalf("progression index: DELIVERED=%d must be AFTER PLACED=%d", dIdx, pIdx)
	}
}

func TestStatusIndexes(t *testing.T) {
	want := map[Status]int{
		StatusPlaced:         0,
		StatusProcessing:     1,
		StatusShipped:        2,
		StatusOutForDelivery: 3,
		StatusDelivered:      4,
	}
	for s, wantIdx := range want {
		got, ok := StatusIndex(s)
		if !ok {
			t.Errorf("StatusIndex(%s): not found", s)
			continue
		}
		if got != wantIdx {
			t.Errorf("StatusIndex(%s) = %d, want %d", s, got, wantIdx)
		}
	}
	if _, ok := StatusIndex(Status("NOPE")); ok {
		t.Error("StatusIndex(NOPE) reported found; want not found")
	}
}

func TestCheckTransition(t *testing.T) {
	tests := []struct {
		name       string
		current    Status
		requested  Status
		wantAllow  bool
		wantReason RejectionReason
	}{
		// Every legal adjacent transition.
		{"placed to processing", StatusPlaced, StatusProcessing, true, ""},
		{"processing to shipped", StatusProcessing, StatusShipped, true, ""},
		{"shipped to out for delivery", StatusShipped, StatusOutForDelivery, true, ""},
		{"out for delivery to delivered", StatusOutForDelivery, StatusDelivered, true, ""},

		// Skipping is ALLOWED. This is not a next-step-only machine.
		{"skip placed to delivered", StatusPlaced, StatusDelivered, true, ""},
		{"skip placed to shipped", StatusPlaced, StatusShipped, true, ""},
		{"skip processing to delivered", StatusProcessing, StatusDelivered, true, ""},
		{"skip placed to out for delivery", StatusPlaced, StatusOutForDelivery, true, ""},

		// Guard 1 — terminal, checked FIRST. DELIVERED reports already_delivered
		// whatever is requested of it.
		{"delivered to placed", StatusDelivered, StatusPlaced, false, ReasonAlreadyDelivered},
		{"delivered to processing", StatusDelivered, StatusProcessing, false, ReasonAlreadyDelivered},
		{"delivered to shipped", StatusDelivered, StatusShipped, false, ReasonAlreadyDelivered},
		{"delivered to out for delivery", StatusDelivered, StatusOutForDelivery, false, ReasonAlreadyDelivered},
		// The load-bearing case: DELIVERED->DELIVERED violates guards 1 and 3 at
		// once. Guard order decides which is reported, and it must be guard 1.
		{"delivered to delivered", StatusDelivered, StatusDelivered, false, ReasonAlreadyDelivered},

		// Guard 2 — backward.
		{"processing to placed", StatusProcessing, StatusPlaced, false, ReasonBackwardTransition},
		{"shipped to processing", StatusShipped, StatusProcessing, false, ReasonBackwardTransition},
		{"out for delivery to placed", StatusOutForDelivery, StatusPlaced, false, ReasonBackwardTransition},
		{"shipped to placed", StatusShipped, StatusPlaced, false, ReasonBackwardTransition},

		// Guard 3 — equal is not strictly forward.
		{"placed to placed", StatusPlaced, StatusPlaced, false, ReasonNotStrictlyForward},
		{"processing to processing", StatusProcessing, StatusProcessing, false, ReasonNotStrictlyForward},
		{"shipped to shipped", StatusShipped, StatusShipped, false, ReasonNotStrictlyForward},
		{"out for delivery to out for delivery", StatusOutForDelivery, StatusOutForDelivery, false, ReasonNotStrictlyForward},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CheckTransition(tt.current, tt.requested)
			if got.Allowed != tt.wantAllow {
				t.Fatalf("CheckTransition(%s, %s).Allowed = %v, want %v",
					tt.current, tt.requested, got.Allowed, tt.wantAllow)
			}
			if got.Reason != tt.wantReason {
				t.Fatalf("CheckTransition(%s, %s).Reason = %q, want %q",
					tt.current, tt.requested, got.Reason, tt.wantReason)
			}
			if CanTransition(tt.current, tt.requested) != tt.wantAllow {
				t.Fatalf("CanTransition(%s, %s) disagrees with CheckTransition",
					tt.current, tt.requested)
			}
		})
	}
}

func TestAssertCanTransition(t *testing.T) {
	if err := AssertCanTransition(StatusPlaced, StatusShipped); err != nil {
		t.Fatalf("AssertCanTransition(PLACED, SHIPPED) = %v, want nil", err)
	}

	err := AssertCanTransition(StatusDelivered, StatusDelivered)
	if err == nil {
		t.Fatal("AssertCanTransition(DELIVERED, DELIVERED) = nil, want error")
	}
	var ite *InvalidTransitionError
	if !errors.As(err, &ite) {
		t.Fatalf("error is %T, want *InvalidTransitionError", err)
	}
	if ite.Reason != ReasonAlreadyDelivered {
		t.Errorf("Reason = %q, want %q", ite.Reason, ReasonAlreadyDelivered)
	}
	if ite.Current != StatusDelivered || ite.Requested != StatusDelivered {
		t.Errorf("Current/Requested = %s/%s, want DELIVERED/DELIVERED", ite.Current, ite.Requested)
	}
	want := "cannot transition from DELIVERED to DELIVERED: already_delivered"
	if got := err.Error(); got != want {
		t.Errorf("Error() = %q, want %q", got, want)
	}
}

func TestNextStatus(t *testing.T) {
	tests := []struct {
		current Status
		want    Status
		wantOK  bool
	}{
		{StatusPlaced, StatusProcessing, true},
		{StatusProcessing, StatusShipped, true},
		{StatusShipped, StatusOutForDelivery, true},
		{StatusOutForDelivery, StatusDelivered, true},
		// Reaching the end is how a TestMode run FINISHES. Not an error.
		{StatusDelivered, "", false},
	}
	for _, tt := range tests {
		t.Run(string(tt.current), func(t *testing.T) {
			got, ok := NextStatus(tt.current)
			if ok != tt.wantOK {
				t.Fatalf("NextStatus(%s) ok = %v, want %v", tt.current, ok, tt.wantOK)
			}
			if ok && got != tt.want {
				t.Fatalf("NextStatus(%s) = %s, want %s", tt.current, got, tt.want)
			}
		})
	}
}

func TestParseStatus(t *testing.T) {
	for _, s := range []Status{
		StatusPlaced, StatusProcessing, StatusShipped, StatusOutForDelivery, StatusDelivered,
	} {
		got, err := ParseStatus(string(s))
		if err != nil {
			t.Errorf("ParseStatus(%q) returned error %v", s, err)
			continue
		}
		if got != s {
			t.Errorf("ParseStatus(%q) = %s, want %s", s, got, s)
		}
	}
}

func TestParseStatusIsCaseSensitive(t *testing.T) {
	// The five values are a fixed wire contract shared with the proto, not
	// free-form input.
	for _, bad := range []string{"placed", "Placed", "delivered", "oUt_FoR_dElIvErY"} {
		if _, err := ParseStatus(bad); err == nil {
			t.Errorf("ParseStatus(%q) = nil error; parsing must be case-sensitive", bad)
		}
	}
}

func TestParseStatusErrorMessageIsExact(t *testing.T) {
	_, err := ParseStatus("FOO")
	if err == nil {
		t.Fatal("ParseStatus(FOO) = nil error, want error")
	}
	want := "invalid tracking status 'FOO'; expected one of: PLACED, PROCESSING, SHIPPED, OUT_FOR_DELIVERY, DELIVERED"
	if got := err.Error(); got != want {
		t.Fatalf("Error() =\n  %q\nwant\n  %q", got, want)
	}
}

func TestParseStatusRejectsEmptyString(t *testing.T) {
	if _, err := ParseStatus(""); err == nil {
		t.Fatal("ParseStatus(\"\") = nil error, want error")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/tracking-go && go test ./internal/domain/
```

Expected output (compilation failure — nothing is defined yet):

```
# github.com/jemartinez/3mrai/services/tracking-go/internal/domain [github.com/jemartinez/3mrai/services/tracking-go/internal/domain.test]
./status_test.go:10:14: undefined: StatusDelivered
./status_test.go:10:32: undefined: StatusPlaced
./status_test.go:13:15: undefined: StatusIndex
...
FAIL	github.com/jemartinez/3mrai/services/tracking-go/internal/domain [build failed]
```

- [ ] **Step 3: Write minimal implementation**

Create `services/tracking-go/internal/domain/status.go`:

```go
package domain

import "fmt"

// Status is one of the five delivery statuses.
//
// Underlying type string so it stores directly into VARCHAR(50) and serializes
// directly onto the REST surface — one representation across wire, storage and
// HTTP. Stored as a plain VARCHAR rather than a MySQL ENUM: the REST surface
// carries it as a string, and widening a native ENUM is a DDL change.
type Status string

const (
	StatusPlaced         Status = "PLACED"
	StatusProcessing     Status = "PROCESSING"
	StatusShipped        Status = "SHIPPED"
	StatusOutForDelivery Status = "OUT_FOR_DELIVERY"
	StatusDelivered      Status = "DELIVERED"
)

// statusOrder is the allowed progression, in order. Position in this slice IS
// the ordering every guard below compares against.
//
// NEVER order statuses by comparing the Status values directly. Status has
// underlying type string, so `<` compiles and silently yields ALPHABETICAL
// order, in which DELIVERED < PLACED — the terminal status sorting before the
// initial one. That comparison would type-check, run, and be wrong. The index
// lookup below is the only ordering in this package.
var statusOrder = [...]Status{
	StatusPlaced,
	StatusProcessing,
	StatusShipped,
	StatusOutForDelivery,
	StatusDelivered,
}

const (
	// InitialStatus is the status every tracking is created at.
	InitialStatus = StatusPlaced
	// TerminalStatus is terminal: nothing may follow it, and nothing may update
	// a tracking sitting on it.
	TerminalStatus = StatusDelivered
)

// RejectionReason is the machine-readable reason a transition was rejected.
//
// Three distinct values on purpose. A single `requested > current` comparison
// would satisfy all three guards at once and collapse them into one
// indistinguishable failure. Keeping them separate gives the `reason` field the
// logging convention requires on *_failed events, and lets each guard be tested
// independently.
type RejectionReason string

const (
	// ReasonAlreadyDelivered — guard 1: the current status is terminal.
	ReasonAlreadyDelivered RejectionReason = "already_delivered"
	// ReasonBackwardTransition — guard 2: the requested status is earlier.
	ReasonBackwardTransition RejectionReason = "backward_transition"
	// ReasonNotStrictlyForward — guard 3: the requested status equals the current.
	ReasonNotStrictlyForward RejectionReason = "not_strictly_forward"
)

// TransitionCheck is the result of evaluating a transition. Reason is "" when
// Allowed is true.
type TransitionCheck struct {
	Allowed bool
	Reason  RejectionReason
}

// InvalidTransitionError is returned by AssertCanTransition. It carries the
// machine-readable Reason so the HTTP layer can log it without re-deriving why
// the transition failed.
type InvalidTransitionError struct {
	Current   Status
	Requested Status
	Reason    RejectionReason
}

func (e *InvalidTransitionError) Error() string {
	return fmt.Sprintf("cannot transition from %s to %s: %s", e.Current, e.Requested, e.Reason)
}

// StatusIndex returns s's position in the forward-only progression. ok is false
// for a value outside the five.
func StatusIndex(s Status) (int, bool) {
	for i, candidate := range statusOrder {
		if candidate == s {
			return i, true
		}
	}
	return 0, false
}

// CheckTransition evaluates current -> requested against the three guards.
//
// The guards run in this order and THE ORDER IS LOAD-BEARING. DELIVERED->PLACED
// violates guards 1 and 2 simultaneously; DELIVERED->DELIVERED violates 1 and 3.
// Terminality is the more specific fact about the tracking, so it is reported
// first.
//
// Skipping is ALLOWED: PLACED -> DELIVERED is legal. This is a forward-only
// machine, not a next-step-only one.
func CheckTransition(current, requested Status) TransitionCheck {
	// Guard 1: terminal. Checked before the ordering guards so that a tracking
	// already delivered reports already_delivered whatever is requested of it,
	// INCLUDING DELIVERED itself.
	if current == TerminalStatus {
		return TransitionCheck{Allowed: false, Reason: ReasonAlreadyDelivered}
	}

	currentIndex, ok := StatusIndex(current)
	if !ok {
		return TransitionCheck{Allowed: false, Reason: ReasonBackwardTransition}
	}
	requestedIndex, ok := StatusIndex(requested)
	if !ok {
		return TransitionCheck{Allowed: false, Reason: ReasonBackwardTransition}
	}

	// Guard 2: backward.
	if requestedIndex < currentIndex {
		return TransitionCheck{Allowed: false, Reason: ReasonBackwardTransition}
	}

	// Guard 3: strictly forward — equal is not forward. Distinct from guard 2:
	// guard 2 fires on `<`, this one only on `==`, so the two can never both be
	// the reported reason for the same pair.
	if requestedIndex == currentIndex {
		return TransitionCheck{Allowed: false, Reason: ReasonNotStrictlyForward}
	}

	return TransitionCheck{Allowed: true}
}

// CanTransition is the boolean view of CheckTransition.
func CanTransition(current, requested Status) bool {
	return CheckTransition(current, requested).Allowed
}

// AssertCanTransition returns an *InvalidTransitionError unless the transition
// is allowed. The form callers use when a rejection is exceptional — the PUT
// handler maps the returned error to 400 Bad Request.
func AssertCanTransition(current, requested Status) error {
	result := CheckTransition(current, requested)
	if result.Allowed {
		return nil
	}
	return &InvalidTransitionError{
		Current:   current,
		Requested: requested,
		Reason:    result.Reason,
	}
}

// NextStatus returns the single status following current.
//
// ok is false at the terminal status. Deliberately not an error: reaching the
// end of the progression is the expected way a TestMode run finishes.
func NextStatus(current Status) (Status, bool) {
	if current == TerminalStatus {
		return "", false
	}
	index, ok := StatusIndex(current)
	if !ok {
		return "", false
	}
	return statusOrder[index+1], true
}

// ParseStatus parses an external string into a Status.
//
// Case-SENSITIVE on purpose: the five values are a fixed wire contract shared
// with the proto, not free-form input. The REST handler turns the returned error
// into a 400.
func ParseStatus(s string) (Status, error) {
	for _, candidate := range statusOrder {
		if string(candidate) == s {
			return candidate, nil
		}
	}
	return "", fmt.Errorf(
		"invalid tracking status '%s'; expected one of: %s, %s, %s, %s, %s",
		s,
		StatusPlaced, StatusProcessing, StatusShipped, StatusOutForDelivery, StatusDelivered,
	)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/tracking-go && go test -race -v -run 'TestStatus|TestCheckTransition|TestAssertCanTransition|TestNextStatus|TestParseStatus' ./internal/domain/
```

Expected: every subtest reports `--- PASS`, ending with:

```
PASS
ok  	github.com/jemartinez/3mrai/services/tracking-go/internal/domain	0.0XXs
```

Then confirm the package still lints:

```bash
cd services/tracking-go && make fmt-check && make lint
```

- [ ] **Step 5: Commit**

```bash
git add services/tracking-go/internal/domain && \
git commit -m "feat(tracking): port the forward-only status state machine to pure Go domain"
```

---

### Task 4: Domain — Tracking and TrackingHistory types + history ordering

**Files:**
- Create: `services/tracking-go/internal/domain/tracking.go`
- Test: `services/tracking-go/internal/domain/tracking_test.go`

**Interfaces:**
- Consumes: `Status`, `StatusIndex` from Task 3.
- Produces:

```go
const (
	IDLength         = 28
	StatusLength     = 50
	CognitoSubLength = 255
	E2ESourceTag     = "E2E Source"
)

type Tracking struct {
	ID              string
	UserID          string
	CognitoSub      string   // "" means absent (column is NULL)
	OrderID         string
	TrackingNumber  string
	Status          Status
	ShippingAddress []byte   // raw JSON, nil when absent; NEVER a parsed struct
	Tags            []string
	Datetime        time.Time
	CreatedBy       string
	CreatedAt       time.Time
	UpdatedBy       string
	UpdatedAt       time.Time
	DeletedBy       string
	DeletedAt       *time.Time // nil means not soft-deleted
	History         []TrackingHistory
}

type TrackingHistory struct {
	TrackingID string
	Status     Status
	UserID     string
	OrderID    string
	CognitoSub string
	Datetime   time.Time
	CreatedBy  string
	CreatedAt  time.Time
	UpdatedBy  string
	UpdatedAt  time.Time
	DeletedBy  string
	DeletedAt  *time.Time
}

func SortHistory(history []TrackingHistory)
func (t *Tracking) IsDeleted() bool
func (t *Tracking) HasTag(tag string) bool
```

**Rules this task must implement exactly:**

- **History ordering is `datetime ASC, then progression-position ASC`.** The tiebreaker is load-bearing, not decoration. Two transitions can share a `datetime` — the column is `DATETIME` with fsp 0, i.e. SECOND resolution, and any code path writing several transitions in one unit of work stamps them all from one `now`. When timestamps tie, MySQL is free to return rows in primary-key order, and the PK is `(tracking_id, status)`, so the tie resolves ALPHABETICALLY: `DELIVERED, OUT_FOR_DELIVERY, PLACED, PROCESSING, SHIPPED`. A caller would see a shipment delivered before it was placed. Mapping each status to its progression index resolves ties into the only order that can be correct.
- `ShippingAddress` is `[]byte` holding raw JSON, **never a parsed Go struct**. Its shape is owned by Orders/Users; an additive upstream field must not become a creation outage for data this service only stores and never inspects.
- `IDLength` is 28 and is `PrefixLength + NanoIDLength` from Task 5 — but Task 5 has not run yet, so declare the literal here and have Task 5 add the compile-time assertion that ties them together. MySQL TRUNCATES an over-long value silently rather than erroring, so a column narrower than the generator produces stores a shortened id that still looks like an id and simply stops matching its row.
- `E2ESourceTag` is exactly `"E2E Source"` — space, capitals and all. Users' teardown selects on this same literal; a near-miss like `"e2e-source"` would clean up nothing while looking correct.

- [ ] **Step 1: Write the failing test**

Create `services/tracking-go/internal/domain/tracking_test.go`:

```go
package domain

import (
	"testing"
	"time"
)

func TestSortHistoryOrdersByDatetimeThenProgression(t *testing.T) {
	early := time.Date(2026, 8, 27, 10, 0, 0, 0, time.UTC)
	later := time.Date(2026, 8, 27, 11, 0, 0, 0, time.UTC)

	history := []TrackingHistory{
		{TrackingID: "trk_a", Status: StatusShipped, Datetime: later},
		{TrackingID: "trk_a", Status: StatusPlaced, Datetime: early},
		{TrackingID: "trk_a", Status: StatusProcessing, Datetime: early},
	}

	SortHistory(history)

	want := []Status{StatusPlaced, StatusProcessing, StatusShipped}
	for i, wantStatus := range want {
		if history[i].Status != wantStatus {
			t.Fatalf("history[%d].Status = %s, want %s (full order: %v)",
				i, history[i].Status, wantStatus, statusesOf(history))
		}
	}
}

// The regression this ordering exists for. Two rows sharing a datetime is not
// hypothetical: DATETIME here has fsp 0 (second resolution) and a single unit of
// work stamps every row it writes from one `now`. With a bare datetime sort,
// MySQL falls back to primary-key order — (tracking_id, status), i.e.
// ALPHABETICAL — and DELIVERED would come out first.
func TestSortHistoryTiebreakerOnIdenticalTimestamps(t *testing.T) {
	sameInstant := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)

	// Deliberately seeded in the order MySQL's PK order would return them:
	// DELIVERED before PLACED. If the tiebreaker is missing, a stable sort
	// leaves them exactly like this and the test fails.
	history := []TrackingHistory{
		{TrackingID: "trk_a", Status: StatusDelivered, Datetime: sameInstant},
		{TrackingID: "trk_a", Status: StatusPlaced, Datetime: sameInstant},
	}

	SortHistory(history)

	if history[0].Status != StatusPlaced {
		t.Fatalf("history[0].Status = %s, want PLACED — a shipment cannot be delivered before it is placed",
			history[0].Status)
	}
	if history[1].Status != StatusDelivered {
		t.Fatalf("history[1].Status = %s, want DELIVERED", history[1].Status)
	}
}

func TestSortHistoryFullAlphabeticalPKOrderIsCorrected(t *testing.T) {
	sameInstant := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)

	// All five, seeded in exactly the alphabetical order MySQL's PK would yield.
	history := []TrackingHistory{
		{Status: StatusDelivered, Datetime: sameInstant},
		{Status: StatusOutForDelivery, Datetime: sameInstant},
		{Status: StatusPlaced, Datetime: sameInstant},
		{Status: StatusProcessing, Datetime: sameInstant},
		{Status: StatusShipped, Datetime: sameInstant},
	}

	SortHistory(history)

	want := []Status{
		StatusPlaced, StatusProcessing, StatusShipped, StatusOutForDelivery, StatusDelivered,
	}
	for i, wantStatus := range want {
		if history[i].Status != wantStatus {
			t.Fatalf("history[%d].Status = %s, want %s (full order: %v)",
				i, history[i].Status, wantStatus, statusesOf(history))
		}
	}
}

func TestSortHistoryHandlesEmptyAndSingle(t *testing.T) {
	var empty []TrackingHistory
	SortHistory(empty) // must not panic

	one := []TrackingHistory{{Status: StatusPlaced, Datetime: time.Now().UTC()}}
	SortHistory(one)
	if len(one) != 1 || one[0].Status != StatusPlaced {
		t.Fatalf("single-element slice was disturbed: %v", statusesOf(one))
	}
}

func TestTrackingIsDeleted(t *testing.T) {
	live := Tracking{ID: "trk_live"}
	if live.IsDeleted() {
		t.Error("IsDeleted() = true for a tracking with a nil DeletedAt")
	}

	at := time.Date(2026, 8, 27, 9, 0, 0, 0, time.UTC)
	gone := Tracking{ID: "trk_gone", DeletedAt: &at}
	if !gone.IsDeleted() {
		t.Error("IsDeleted() = false for a tracking with a set DeletedAt")
	}
}

func TestTrackingHasTag(t *testing.T) {
	tagged := Tracking{Tags: []string{E2ESourceTag}}
	if !tagged.HasTag(E2ESourceTag) {
		t.Errorf("HasTag(%q) = false, want true", E2ESourceTag)
	}
	// Matching is exact. Users' teardown selects on this same literal, and a
	// near-miss would clean up nothing while looking correct.
	if tagged.HasTag("e2e-source") {
		t.Error(`HasTag("e2e-source") = true; matching must be exact`)
	}
	if tagged.HasTag("E2E SOURCE") {
		t.Error(`HasTag("E2E SOURCE") = true; matching must be case-sensitive`)
	}

	untagged := Tracking{Tags: []string{}}
	if untagged.HasTag(E2ESourceTag) {
		t.Error("HasTag on an empty tag slice = true, want false")
	}

	var nilTags Tracking
	if nilTags.HasTag(E2ESourceTag) {
		t.Error("HasTag on nil Tags = true, want false")
	}
}

func TestE2ESourceTagLiteralIsExact(t *testing.T) {
	// Shared VERBATIM with Users. Do not "normalize" it.
	if E2ESourceTag != "E2E Source" {
		t.Fatalf("E2ESourceTag = %q, want %q", E2ESourceTag, "E2E Source")
	}
}

func TestColumnWidthConstants(t *testing.T) {
	if IDLength != 28 {
		t.Errorf("IDLength = %d, want 28 (prefix 4 + nano 24)", IDLength)
	}
	if StatusLength != 50 {
		t.Errorf("StatusLength = %d, want 50", StatusLength)
	}
	if CognitoSubLength != 255 {
		t.Errorf("CognitoSubLength = %d, want 255", CognitoSubLength)
	}
}

func statusesOf(history []TrackingHistory) []Status {
	out := make([]Status, len(history))
	for i, h := range history {
		out[i] = h.Status
	}
	return out
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/tracking-go && go test ./internal/domain/
```

Expected output:

```
# github.com/jemartinez/3mrai/services/tracking-go/internal/domain [github.com/jemartinez/3mrai/services/tracking-go/internal/domain.test]
./tracking_test.go:14:16: undefined: TrackingHistory
./tracking_test.go:20:2: undefined: SortHistory
./tracking_test.go:76:12: undefined: Tracking
./tracking_test.go:95:5: undefined: E2ESourceTag
./tracking_test.go:120:5: undefined: IDLength
...
FAIL	github.com/jemartinez/3mrai/services/tracking-go/internal/domain [build failed]
```

- [ ] **Step 3: Write minimal implementation**

Create `services/tracking-go/internal/domain/tracking.go`:

```go
package domain

import (
	"sort"
	"time"
)

// Column widths, as domain constants so nothing restates a literal.
const (
	// IDLength is the width of every id-bearing column: prefix (4) + random
	// portion (24). Task 5 adds a compile-time assertion tying this to the
	// generator's own constants.
	//
	// Getting this wrong does not error. MySQL TRUNCATES an over-long value
	// silently, so a column narrower than the generator produces stores a
	// shortened id that still looks like an id and merely stops matching the row
	// it was supposed to identify.
	IDLength = 28

	// StatusLength is the declared width of the status column.
	StatusLength = 50

	// CognitoSubLength matches Orders' order.cognito_sub. A Cognito sub is a
	// 36-char UUID today, but the two MySQL services storing the same value
	// under the same name must not disagree on its width.
	CognitoSubLength = 255
)

// E2ESourceTag is the only tag value this service ever writes: the label marking
// a tracking as an E2E fixture, and the exact string
// DELETE /v1/trackings/e2e-cleanup selects on.
//
// Shared with Users VERBATIM — space, capitals and all — because both services'
// teardowns select on this same literal, and a near-miss ("e2e-source") would
// clean up nothing while looking perfectly correct.
//
// It lives in the domain rather than beside the HTTP header that requests it:
// the tag is a value persisted on a row, so the transport-free use-case layer
// needs it and must not import an HTTP module to get it.
const E2ESourceTag = "E2E Source"

// Tracking is one tracking record — one per order.
//
// A pure domain type. It is deliberately NOT reused as an HTTP response type:
// ShippingAddress and CognitoSub appear on no response, and a response struct
// must be physically incapable of holding them.
type Tracking struct {
	// ID is the prefixed nano-ID (trk_...). Primary key.
	ID string

	// UserID is the INTERNAL usr_ id, as Orders resolved it from Users. Stored
	// for reporting and cross-service joins. NOT the key user-scoped reads
	// filter by — see CognitoSub.
	UserID string

	// CognitoSub is the owner's Cognito sub, and THE OWNERSHIP KEY for the REST
	// reads. The gateway injects it as the x-user-id header. Scoping a read by
	// UserID instead would compare a sub against a usr_ id, which never matches,
	// so every user-scoped read would answer 404 — including for the caller's
	// own tracking — while looking perfectly implemented.
	//
	// "" means absent (the column is NULL). Such a row is unreachable over the
	// user-scoped reads, never mis-attributed: NULL matches no caller's sub.
	CognitoSub string

	// OrderID is UNIQUE — one tracking per order, enforced at the database so a
	// duplicate creation cannot race past a pre-check.
	OrderID string

	// TrackingNumber is the customer-facing 3MRAI-XXXX-XXXX-XXXX number. OURS,
	// not a carrier's: the row exists from PLACED onward, long before anything
	// is handed to a shipper.
	TrackingNumber string

	// Status is one of the five Status values.
	Status Status

	// ShippingAddress is the point-in-time address snapshot forwarded as-is by
	// Orders, held as RAW JSON.
	//
	// Deliberately []byte and NOT a parsed Go struct. The shape is owned by
	// Orders/Users; this service only stores and returns it, never inspects it.
	// A strict model would turn an additive upstream field into a creation
	// outage. nil when absent.
	//
	// PII — never log it.
	ShippingAddress []byte

	// Tags are free-form labels. Today exactly one value is ever written:
	// E2ESourceTag. Never nil in the database (NOT NULL, default JSON_ARRAY()).
	Tags []string

	// Datetime is the timestamp of the CURRENT status. Distinct from UpdatedAt:
	// this moves only on a status transition, UpdatedAt moves on any write.
	Datetime time.Time

	CreatedBy string
	CreatedAt time.Time
	UpdatedBy string
	UpdatedAt time.Time
	DeletedBy string

	// DeletedAt is nil when the row is live. Soft delete: the application never
	// issues DELETE, and the DB user has no DELETE grant.
	DeletedAt *time.Time

	// History is ordered by SortHistory. Never trust the order rows arrive in.
	History []TrackingHistory
}

// TrackingHistory is one status transition of a tracking.
//
// It deliberately has NO surrogate id, NO tags, and NO shipping address. The
// address is fixed for a tracking's lifetime, so snapshotting it per transition
// would store identical JSON five times. Its composite primary key
// (TrackingID, Status) is a SECOND enforcement of the forward-only state
// machine: at most one row per status, so a duplicate transition fails at INSERT
// even if an application guard is bypassed.
type TrackingHistory struct {
	TrackingID string
	Status     Status
	UserID     string
	OrderID    string
	CognitoSub string
	Datetime   time.Time
	CreatedBy  string
	CreatedAt  time.Time
	UpdatedBy  string
	UpdatedAt  time.Time
	DeletedBy  string
	DeletedAt  *time.Time
}

// NOTE: the audit Actor type and its five constants are NOT declared here. They
// live in the sibling package `internal/domain/audit` (Task 17) — still inside
// the domain, since "what produced this row" is a business fact, not transport.
// Every use case takes an audit.Actor parameter and threads it through; it is
// NEVER a constant the publisher or the repository picks for itself.

// Sentinel errors. Declared here, beside the types that produce them, rather
// than in a shared errors package — the adapters map them to status codes with
// errors.Is, so the mapping lives at the boundary and the domain stays unaware
// of HTTP.
var (
	// ErrTrackingNotFound means no LIVE tracking matched. On the user-scoped
	// reads it deliberately also covers "exists but belongs to someone else":
	// the two are indistinguishable to the caller by design, so the endpoint
	// cannot be used as an oracle for other people's order ids. Maps to 404.
	ErrTrackingNotFound = errors.New("tracking not found")

	// ErrTrackingAlreadyExists means the order already has a tracking or any
	// history. Maps to 409, so a retry cannot duplicate a shipment.
	ErrTrackingAlreadyExists = errors.New("tracking already exists")

	// ErrUserNotFound means Users answered NOT_FOUND for the caller's sub.
	// Maps to 404 with reason "unknown_user". It must NOT be returned for any
	// other gRPC failure: a Users outage is a 500, never "this user does not
	// exist".
	ErrUserNotFound = errors.New("user not found")
)

// NewTracking is the input to creation: the caller-supplied facts, before the
// service mints the id, the tracking number, the initial status and the audit
// stamps. Keeping it separate from Tracking is what stops a caller supplying
// an id or a status of its own choosing.
type NewTracking struct {
	OrderID string

	// UserID is the internal usr_ id, already resolved from the caller's sub.
	UserID string

	// CognitoSub is the caller's sub — the ownership key. "" is stored as NULL.
	CognitoSub string

	// ShippingAddress stays opaque JSON, never a struct: the shape is owned by
	// Orders (originally Users' Address message) and this service only stores
	// it. A strict type here would turn an additive upstream field into a
	// creation outage. nil means the column is NULL.
	ShippingAddress []byte

	// Tags carries E2ESourceTag when, and only when, the request sent
	// x-e2e-source: true AND E2E_TESTING_ENABLED is on.
	Tags Tags
}

// TrackingWithHistory is a tracking together with its ordered history.
//
// This is the unit every read and every write path returns, because BOTH REST
// reads answer with the tracking AND its history, and the SQS event embeds the
// history too. Keeping them in one value is what stops a caller assembling the
// pair itself and getting the ordering wrong — History is expected to already
// be sorted by SortHistory when this value is built.
//
// It is a plain composition, not an embedding: Tracking is a field rather than
// an anonymous member, so a handler cannot accidentally marshal the parent's
// PII-bearing fields by promoting them onto a response type. Response structs
// are built explicitly from this value; they never embed it.
//
// After a write that appends a history row, this value MUST be rebuilt from a
// fresh read. Reusing a TrackingWithHistory loaded before the append publishes
// an event that omits the very transition it announces — the Python service
// expires that collection explicitly for this reason.
type TrackingWithHistory struct {
	Tracking Tracking
	History  []TrackingHistory
}

// SortHistory orders history in place by transition time, then by progression
// position.
//
// THE TIEBREAKER IS LOAD-BEARING, not decoration. A bare datetime sort is NOT
// deterministic here, and this bit the Python service in a real test against
// real MySQL:
//
// Two transitions can share a datetime. The column is DATETIME with fsp 0, i.e.
// SECOND resolution; a carrier can send two updates inside the same second, and
// any code path writing several transitions in one unit of work stamps them all
// from one `now`. When the timestamps tie, MySQL is free to return rows in
// primary-key order, and the PK is (tracking_id, status) — so the tie resolves
// ALPHABETICALLY: DELIVERED, OUT_FOR_DELIVERY, PLACED, PROCESSING, SHIPPED. The
// terminal status first, meaning a caller would see a shipment delivered before
// it was ever placed.
//
// Mapping each status to its index in the forward-only progression resolves ties
// into the only order that can be correct.
//
// sort.SliceStable, not sort.Slice: with both keys equal (the same status at the
// same instant, which the composite PK makes impossible in the database but
// which an in-memory caller could construct) the input order is preserved rather
// than scrambled.
func SortHistory(history []TrackingHistory) {
	sort.SliceStable(history, func(i, j int) bool {
		if !history[i].Datetime.Equal(history[j].Datetime) {
			return history[i].Datetime.Before(history[j].Datetime)
		}
		// Timestamps tie: fall back to progression position, NEVER to the status
		// string (which would sort DELIVERED first).
		iIndex, iOK := StatusIndex(history[i].Status)
		jIndex, jOK := StatusIndex(history[j].Status)
		// An unrecognized status sorts last rather than crashing the read path.
		if !iOK || !jOK {
			return iOK && !jOK
		}
		return iIndex < jIndex
	})
}

// IsDeleted reports whether the tracking has been soft-deleted.
func (t *Tracking) IsDeleted() bool {
	return t.DeletedAt != nil
}

// HasTag reports whether the tracking carries tag. Matching is exact and
// case-sensitive — see E2ESourceTag.
func (t *Tracking) HasTag(tag string) bool {
	for _, candidate := range t.Tags {
		if candidate == tag {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/tracking-go && go test -race -v -run 'TestSortHistory|TestTracking|TestE2ESourceTag|TestColumnWidth' ./internal/domain/
```

Expected: every test reports `--- PASS`, ending with:

```
PASS
ok  	github.com/jemartinez/3mrai/services/tracking-go/internal/domain	0.0XXs
```

Then the whole package plus lint:

```bash
cd services/tracking-go && go test -race ./... && make fmt-check && make lint
```

- [ ] **Step 5: Commit**

```bash
git add services/tracking-go/internal/domain && \
git commit -m "feat(tracking): domain Tracking/TrackingHistory types with progression-tiebreak history ordering"
```

---

### Task 5: Domain — ID generation (nano ID + tracking number)

**Files:**
- Create: `services/tracking-go/internal/domain/id.go`
- Test: `services/tracking-go/internal/domain/id_test.go`

**Interfaces:**
- Consumes: `IDLength` from Task 4.
- Produces:

```go
const (
	NanoIDAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	NanoIDLength   = 24
	PrefixLength   = 4
	TrackingPrefix = "trk_"
	RequestPrefix  = "req_"

	TrackingNumberPrefix   = "3MRAI"
	TrackingNumberAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	TrackingNumberGroupSize  = 4
	TrackingNumberGroupCount = 3
	TrackingNumberSeparator  = "-"
	TrackingNumberLength     = 20
)

func NewTrackingID() (string, error)
func NewRequestID() (string, error)
func NewTrackingNumber() (string, error)
```

**Rules this task must implement exactly:**

- **Both generators use `crypto/rand`, never `math/rand`.** `math/rand` is a deterministic PRNG: observing a handful of outputs reconstructs its state and predicts every subsequent one. A tracking number is quoted in emails and appears in URLs, so a guessable one lets somebody enumerate other people's shipments. The `gosec` linter enabled in Task 1 flags `math/rand` here.
- **Nano ID:** alphabet exactly `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789` — 62 symbols, this exact order, **no `_` and no `-`**. Those two characters are why this configuration exists: an id is pasted into a shell, a URL, a log grep and a CSV, and a leading `-` reads as a flag while `_` disappears against an underscored column name. Random length 24, prefix `trk_`, total length 28.
- **Modulo bias must be avoided.** 62 does not divide 256, so `randomByte % 62` favours the first 8 symbols. Use `crypto/rand.Int` (which does rejection sampling internally) or hand-rolled rejection sampling. The Python explicitly guards this by using `secrets.choice`.
- **Cross-service contract:** the same alphabet, length and prefix exist in Users (`shared/id/nano-id.ts`, TypeScript) and Orders (`Orders.Infrastructure/Id/NanoId.cs`, C#). Ids cross service boundaries in headers, envelopes and foreign keys, so a service that disagrees produces ids the others reject. **Changing one means changing all three.**
- **Tracking number:** format `3MRAI-XXXX-XXXX-XXXX`, total width 20. Alphabet exactly `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` — 32 symbols, the 36 uppercase alphanumerics minus `I`, `O`, `0` and `1`, which are the pairs a reader confuses when transcribing from an email or reading aloud. 3 groups of 4, separator `-`. **No checksum** — uniqueness is guaranteed by the `uq_tracking_tracking_number` UNIQUE constraint, so a collision is a failed INSERT rather than two shipments sharing a number. 12 characters from a 32-symbol alphabet is 5 bits each, i.e. 60 bits (~1.15e18 values).
- **It is NOT a carrier number.** A tracking row exists from `PLACED` onward, long before anything is handed to a shipper. The `3MRAI-` prefix keeps that honest; the day a real carrier number arrives it is a second, differently-named column.

- [ ] **Step 1: Write the failing test**

Create `services/tracking-go/internal/domain/id_test.go`:

```go
package domain

import (
	"strings"
	"testing"
)

func TestNanoIDAlphabetIsTheCrossServiceContract(t *testing.T) {
	// EXACT string, EXACT order. Users (TypeScript) and Orders (C#) declare the
	// same one. Changing this means changing all three services together.
	const want = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	if NanoIDAlphabet != want {
		t.Fatalf("NanoIDAlphabet =\n  %q\nwant\n  %q", NanoIDAlphabet, want)
	}
	if len(NanoIDAlphabet) != 62 {
		t.Fatalf("NanoIDAlphabet has %d symbols, want 62", len(NanoIDAlphabet))
	}
	// nanoid's default alphabet adds these two. Ours must not.
	if strings.ContainsAny(NanoIDAlphabet, "_-") {
		t.Error("NanoIDAlphabet contains '_' or '-'; both are excluded on purpose")
	}
}

func TestIDLengthIsDerivedNotRestated(t *testing.T) {
	if PrefixLength+NanoIDLength != IDLength {
		t.Fatalf("PrefixLength(%d) + NanoIDLength(%d) = %d, but IDLength = %d",
			PrefixLength, NanoIDLength, PrefixLength+NanoIDLength, IDLength)
	}
	if len(TrackingPrefix) != PrefixLength {
		t.Errorf("len(TrackingPrefix) = %d, want %d", len(TrackingPrefix), PrefixLength)
	}
	if len(RequestPrefix) != PrefixLength {
		t.Errorf("len(RequestPrefix) = %d, want %d", len(RequestPrefix), PrefixLength)
	}
}

func TestNewTrackingIDFormat(t *testing.T) {
	id, err := NewTrackingID()
	if err != nil {
		t.Fatalf("NewTrackingID() error = %v", err)
	}
	if len(id) != IDLength {
		t.Errorf("len(%q) = %d, want %d", id, len(id), IDLength)
	}
	if !strings.HasPrefix(id, TrackingPrefix) {
		t.Errorf("%q does not start with %q", id, TrackingPrefix)
	}
	random := strings.TrimPrefix(id, TrackingPrefix)
	if len(random) != NanoIDLength {
		t.Errorf("random portion of %q is %d chars, want %d", id, len(random), NanoIDLength)
	}
	for _, r := range random {
		if !strings.ContainsRune(NanoIDAlphabet, r) {
			t.Errorf("%q contains %q, which is outside the alphabet", id, r)
		}
	}
}

func TestNewRequestIDFormat(t *testing.T) {
	id, err := NewRequestID()
	if err != nil {
		t.Fatalf("NewRequestID() error = %v", err)
	}
	if len(id) != IDLength {
		t.Errorf("len(%q) = %d, want %d", id, len(id), IDLength)
	}
	if !strings.HasPrefix(id, RequestPrefix) {
		t.Errorf("%q does not start with %q", id, RequestPrefix)
	}
}

func TestNewTrackingNumberFormat(t *testing.T) {
	number, err := NewTrackingNumber()
	if err != nil {
		t.Fatalf("NewTrackingNumber() error = %v", err)
	}
	if len(number) != TrackingNumberLength {
		t.Errorf("len(%q) = %d, want %d", number, len(number), TrackingNumberLength)
	}
	parts := strings.Split(number, TrackingNumberSeparator)
	if len(parts) != TrackingNumberGroupCount+1 {
		t.Fatalf("%q split into %d parts, want %d (prefix + %d groups)",
			number, len(parts), TrackingNumberGroupCount+1, TrackingNumberGroupCount)
	}
	if parts[0] != TrackingNumberPrefix {
		t.Errorf("prefix of %q = %q, want %q", number, parts[0], TrackingNumberPrefix)
	}
	for i, group := range parts[1:] {
		if len(group) != TrackingNumberGroupSize {
			t.Errorf("group %d of %q is %d chars, want %d", i, number, len(group), TrackingNumberGroupSize)
		}
		for _, r := range group {
			if !strings.ContainsRune(TrackingNumberAlphabet, r) {
				t.Errorf("%q contains %q, which is outside the alphabet", number, r)
			}
		}
	}
}

func TestTrackingNumberAlphabetExcludesConfusableCharacters(t *testing.T) {
	const want = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	if TrackingNumberAlphabet != want {
		t.Fatalf("TrackingNumberAlphabet =\n  %q\nwant\n  %q", TrackingNumberAlphabet, want)
	}
	if len(TrackingNumberAlphabet) != 32 {
		t.Fatalf("TrackingNumberAlphabet has %d symbols, want 32", len(TrackingNumberAlphabet))
	}
	// I/O/0/1 are the pairs a reader confuses transcribing from an email.
	for _, excluded := range []rune{'I', 'O', '0', '1'} {
		if strings.ContainsRune(TrackingNumberAlphabet, excluded) {
			t.Errorf("alphabet contains %q; I, O, 0 and 1 are excluded as confusable", excluded)
		}
	}
}

func TestTrackingNumberLengthIsDerived(t *testing.T) {
	want := len(TrackingNumberPrefix) +
		TrackingNumberGroupCount*(len(TrackingNumberSeparator)+TrackingNumberGroupSize)
	if TrackingNumberLength != want {
		t.Fatalf("TrackingNumberLength = %d, want %d", TrackingNumberLength, want)
	}
	if TrackingNumberLength != 20 {
		t.Fatalf("TrackingNumberLength = %d, want 20", TrackingNumberLength)
	}
}

// Not a proof of uniqueness — that is the UNIQUE constraint's job. This catches
// the generator being broken outright: a constant return, a stuck RNG, or an
// alphabet index that never varies.
func TestGeneratorsDoNotRepeat(t *testing.T) {
	const n = 5000

	ids := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		id, err := NewTrackingID()
		if err != nil {
			t.Fatalf("NewTrackingID() error at iteration %d = %v", i, err)
		}
		if _, dup := ids[id]; dup {
			t.Fatalf("NewTrackingID() returned duplicate %q within %d generations", id, n)
		}
		ids[id] = struct{}{}
	}

	numbers := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		number, err := NewTrackingNumber()
		if err != nil {
			t.Fatalf("NewTrackingNumber() error at iteration %d = %v", i, err)
		}
		if _, dup := numbers[number]; dup {
			t.Fatalf("NewTrackingNumber() returned duplicate %q within %d generations", number, n)
		}
		numbers[number] = struct{}{}
	}
}

// A crude bias check. With rejection sampling every symbol should appear a
// roughly equal number of times. Modulo bias over 62 symbols would leave the
// first 8 symbols noticeably over-represented; the loose bound below still
// catches that while never flaking on ordinary randomness.
func TestNanoIDCoversItsWholeAlphabet(t *testing.T) {
	const n = 4000
	seen := make(map[rune]int, len(NanoIDAlphabet))
	for i := 0; i < n; i++ {
		id, err := NewTrackingID()
		if err != nil {
			t.Fatalf("NewTrackingID() error = %v", err)
		}
		for _, r := range strings.TrimPrefix(id, TrackingPrefix) {
			seen[r]++
		}
	}
	if len(seen) != len(NanoIDAlphabet) {
		t.Fatalf("only %d of %d alphabet symbols were ever produced", len(seen), len(NanoIDAlphabet))
	}
	total := n * NanoIDLength
	expected := total / len(NanoIDAlphabet)
	for _, r := range NanoIDAlphabet {
		count := seen[r]
		if count < expected/2 || count > expected*2 {
			t.Errorf("symbol %q appeared %d times; expected roughly %d (modulo bias?)",
				r, count, expected)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/tracking-go && go test ./internal/domain/
```

Expected output:

```
# github.com/jemartinez/3mrai/services/tracking-go/internal/domain [github.com/jemartinez/3mrai/services/tracking-go/internal/domain.test]
./id_test.go:12:5: undefined: NanoIDAlphabet
./id_test.go:23:5: undefined: PrefixLength
./id_test.go:33:14: undefined: NewTrackingID
./id_test.go:75:19: undefined: NewTrackingNumber
...
FAIL	github.com/jemartinez/3mrai/services/tracking-go/internal/domain [build failed]
```

- [ ] **Step 3: Write minimal implementation**

Create `services/tracking-go/internal/domain/id.go`:

```go
package domain

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"strings"
)

// ─── Nano ID: the machine identifier (trk_…) ─────────────────────────────────

const (
	// NanoIDAlphabet is letters and digits ONLY, in this exact order.
	//
	// nanoid's default alphabet adds '_' and '-', and those two characters are
	// why this configuration exists: an id is pasted into a shell, a URL, a log
	// grep and a CSV, and a leading '-' reads as a flag while '_' disappears
	// against an underscored column name. Restricting the alphabet costs
	// nothing: 62^24 is MORE entropy than the 64^21 it replaces, so collision
	// risk goes down, not up.
	//
	// CROSS-SERVICE CONTRACT. The same alphabet, the same length and the same
	// prefixes are declared in Users (shared/id/nano-id.ts) and Orders
	// (Orders.Infrastructure/Id/NanoId.cs). Ids cross service boundaries in
	// headers, envelopes and foreign keys, so a service that disagrees about the
	// alphabet or the length produces ids the others reject. CHANGING ANY OF
	// THESE MEANS CHANGING ALL THREE SERVICES TOGETHER.
	NanoIDAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

	// NanoIDLength is the RANDOM portion only. A stored id is
	// PrefixLength + NanoIDLength = 28 characters, which is what every
	// id-bearing database column is sized for.
	NanoIDLength = 24

	// PrefixLength is the width of an entity prefix, including its underscore.
	PrefixLength = 4

	// TrackingPrefix prefixes a Tracking row's id.
	//
	// Only ONE entity prefix exists for persisted rows. TrackingHistory has a
	// composite primary key (tracking_id, status) and no id column at all, so it
	// gets no prefix and no generated id.
	TrackingPrefix = "trk_"

	// RequestPrefix prefixes the cross-service correlation id. Same format by
	// design: a second alphabet or a second notion of "how long" is exactly what
	// these constants exist to prevent.
	RequestPrefix = "req_"
)

// Compile-time assertion that domain.IDLength (the column width in tracking.go)
// stays tied to what the generator actually produces. If someone widens the
// random portion without widening the column, this fails to build — which is
// the only safe failure, because MySQL TRUNCATES an over-long value silently
// rather than erroring.
const _ = uint(IDLength - (PrefixLength + NanoIDLength))
const _ = uint((PrefixLength + NanoIDLength) - IDLength)

// ─── Tracking number: the human-readable identifier (3MRAI-…) ────────────────

const (
	// TrackingNumberPrefix says the number is OURS, not a carrier's. A tracking
	// row is created at PLACED, long before any carrier is involved, so there is
	// no carrier number to record. The day a real carrier number arrives it is a
	// second, differently-named column, not a silent overwrite of this one.
	TrackingNumberPrefix = "3MRAI"

	// TrackingNumberAlphabet is the 36 uppercase alphanumerics MINUS I, O, 0 and
	// 1 — the pairs a reader confuses when transcribing from an email or reading
	// aloud. A tracking number's whole job is to survive exactly that trip.
	// 32 symbols.
	TrackingNumberAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

	TrackingNumberGroupSize  = 4
	TrackingNumberGroupCount = 3
	TrackingNumberSeparator  = "-"

	// TrackingNumberLength is 5 + 3*(1+4) = 20, the width of the
	// tracking.tracking_number column.
	//
	// Entropy: 12 characters from a 32-symbol alphabet is 5 bits each, i.e. 60
	// bits (~1.15e18 values). The birthday bound puts a 50% chance of any
	// collision at ~1.3e9 rows. It is not left to luck either: there is NO
	// checksum, because tracking_number is UNIQUE — a collision is a failed
	// INSERT, not two shipments sharing a number.
	TrackingNumberLength = len(TrackingNumberPrefix) +
		TrackingNumberGroupCount*(len(TrackingNumberSeparator)+TrackingNumberGroupSize)
)

// ─── Generation ──────────────────────────────────────────────────────────────

// randomString returns n characters drawn uniformly from alphabet.
//
// crypto/rand, NEVER math/rand. math/rand is a deterministic PRNG: observing a
// handful of outputs is enough to reconstruct its state and predict every
// subsequent one. A tracking number is quoted in emails and appears in URLs, so
// a guessable one would let somebody enumerate other people's shipments.
//
// rand.Int over a big.Int bound rather than `randomByte % len(alphabet)`:
// neither 62 nor 32 divides 256 evenly for the general case, and the modulo
// would favour the first symbols of the alphabet. crypto/rand.Int performs
// rejection sampling internally, so the draw is uniform.
func randomString(alphabet string, n int) (string, error) {
	bound := big.NewInt(int64(len(alphabet)))
	var builder strings.Builder
	builder.Grow(n)
	for i := 0; i < n; i++ {
		index, err := rand.Int(rand.Reader, bound)
		if err != nil {
			return "", fmt.Errorf("draw random symbol: %w", err)
		}
		builder.WriteByte(alphabet[index.Int64()])
	}
	return builder.String(), nil
}

// mint is the single generation path for prefixed nano IDs.
func mint(prefix string) (string, error) {
	random, err := randomString(NanoIDAlphabet, NanoIDLength)
	if err != nil {
		return "", err
	}
	return prefix + random, nil
}

// NewTrackingID returns a fresh trk_-prefixed id for a Tracking row,
// e.g. trk_7gK3mP1vXz9wLq2bN8rRt4Yc.
func NewTrackingID() (string, error) {
	return mint(TrackingPrefix)
}

// NewRequestID returns a fresh req_-prefixed cross-service correlation id.
func NewRequestID() (string, error) {
	return mint(RequestPrefix)
}

// NewTrackingNumber returns a fresh customer-facing number,
// e.g. 3MRAI-K7P2-9WXM-4TQB.
func NewTrackingNumber() (string, error) {
	parts := make([]string, 0, TrackingNumberGroupCount+1)
	parts = append(parts, TrackingNumberPrefix)
	for i := 0; i < TrackingNumberGroupCount; i++ {
		group, err := randomString(TrackingNumberAlphabet, TrackingNumberGroupSize)
		if err != nil {
			return "", fmt.Errorf("mint tracking number: %w", err)
		}
		parts = append(parts, group)
	}
	return strings.Join(parts, TrackingNumberSeparator), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/tracking-go && go test -race -v -run 'TestNanoID|TestIDLength|TestNewTracking|TestNewRequest|TestTrackingNumber|TestGenerators' ./internal/domain/
```

Expected: every test reports `--- PASS`, ending with:

```
PASS
ok  	github.com/jemartinez/3mrai/services/tracking-go/internal/domain	0.XXXs
```

Verify the whole domain package, and confirm `gosec` sees no weak RNG:

```bash
cd services/tracking-go && go test -race ./... && make fmt-check && make lint
```

Finally, assert the purity rule by hand — this command must print NOTHING:

```bash
cd services/tracking-go && \
go list -deps ./internal/domain/ | grep -Ev '^(internal/|[a-z]+(/[a-z0-9_]+)*$)' | \
grep -E 'gin-gonic|redis|aws-sdk|grpc|opentelemetry|go-sql-driver'
```

Any output here means a non-stdlib dependency reached `internal/domain`, which is a defect regardless of whether tests pass.

- [ ] **Step 5: Commit**

```bash
git add services/tracking-go/internal/domain && \
git commit -m "feat(tracking): crypto/rand nano-ID and tracking-number generators in the domain"
```

---

### Task 6: sqlc setup + generated data layer

**Files:**
- Create: `services/tracking-go/sqlc.yaml`
- Create: `services/tracking-go/internal/adapter/mysql/tags.go`
- Create: `services/tracking-go/internal/adapter/mysql/queries/tracking.sql`
- Test: `services/tracking-go/internal/adapter/mysql/tags_test.go`
- Generated (do not hand-edit): `services/tracking-go/internal/adapter/mysql/db.go`, `models.go`, `tracking.sql.go`
- Modify: `services/tracking-go/Makefile` (add `sqlc-generate`, `sqlc-verify`)

**Interfaces:**
- Consumes: the migrations from Task 2 (sqlc reads them as its schema), and the domain from Tasks 3–5.
- Produces:

```go
package mysql

// Hand-written, referenced by sqlc's overrides:
type Tags []string
func (t *Tags) Scan(src any) error
func (t Tags) Value() (driver.Value, error)

// Generated by sqlc:
type Querier interface { /* one method per query in queries/tracking.sql */ }
type Queries struct{ /* ... */ }
func New(db DBTX) *Queries
func (q *Queries) WithTx(tx *sql.Tx) *Queries
```

**Configuration that is load-bearing:**

- `version: "2"`, `engine: "mysql"`, `sql_package: "database/sql"` (not pgx — this is MySQL), `emit_json_tags: false`.
- `schema:` points at `migrations/` so the generated models are derived from the same DDL the database actually runs. There is no second schema definition to drift.
- **Override `tracking.tags` to the hand-written `Tags` type** implementing `sql.Scanner` / `driver.Valuer` over `[]string`. Without the override sqlc yields `json.RawMessage`, pushing marshalling into every call site.
- **Leave `shipping_address` as `json.RawMessage`/`[]byte`, nullable. Do NOT define a Go struct for it.** The Python explicitly rejected a strict model: the shape is owned by Orders/Users, and an additive upstream field must not turn into a creation outage for data this service only stores and never inspects.
- **Backtick `` `datetime` `` in every query and alias it** (`` `datetime` AS occurred_at ``). Unbackticked it is a type keyword and produces a syntax error pointing somewhere unhelpful.
- **`IN (sqlc.slice('ids'))` generates INVALID SQL for an EMPTY slice.** sqlc expands the placeholder per element, so zero elements yields `IN ()`, which MySQL rejects with a syntax error. **The caller must short-circuit to an empty result without querying** — exactly what the Python does. This is called out again in the query file's comments so it cannot be missed by whoever writes the repository in Wave 1.

- [ ] **Step 1: Write the failing test**

Create `services/tracking-go/internal/adapter/mysql/tags_test.go`:

```go
package mysql

import (
	"database/sql/driver"
	"testing"
)

func TestTagsValueMarshalsToJSONArray(t *testing.T) {
	tests := []struct {
		name string
		tags Tags
		want string
	}{
		// NEVER NULL and never "": the column is NOT NULL with a
		// DEFAULT (JSON_ARRAY()), and JSON_CONTAINS(NULL, ...) is NULL rather
		// than FALSE, which would silently exclude the row from the e2e-cleanup
		// predicate.
		{"nil renders as empty array", nil, `[]`},
		{"empty renders as empty array", Tags{}, `[]`},
		{"single tag", Tags{"E2E Source"}, `["E2E Source"]`},
		{"several tags", Tags{"E2E Source", "other"}, `["E2E Source","other"]`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := tt.tags.Value()
			if err != nil {
				t.Fatalf("Value() error = %v", err)
			}
			b, ok := got.([]byte)
			if !ok {
				t.Fatalf("Value() returned %T, want []byte", got)
			}
			if string(b) != tt.want {
				t.Fatalf("Value() = %s, want %s", b, tt.want)
			}
		})
	}
}

func TestTagsScan(t *testing.T) {
	tests := []struct {
		name string
		src  any
		want Tags
	}{
		{"empty array bytes", []byte(`[]`), Tags{}},
		{"single tag bytes", []byte(`["E2E Source"]`), Tags{"E2E Source"}},
		{"several tags bytes", []byte(`["a","b"]`), Tags{"a", "b"}},
		{"string source", `["E2E Source"]`, Tags{"E2E Source"}},
		// The column is NOT NULL, but a driver can still hand us nil for a row
		// written before the constraint existed. Degrade to empty, never panic.
		{"nil source", nil, Tags{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got Tags
			if err := got.Scan(tt.src); err != nil {
				t.Fatalf("Scan(%v) error = %v", tt.src, err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("Scan(%v) = %v, want %v", tt.src, got, tt.want)
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Fatalf("Scan(%v)[%d] = %q, want %q", tt.src, i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestTagsScanRejectsUnsupportedType(t *testing.T) {
	var tags Tags
	if err := tags.Scan(42); err == nil {
		t.Fatal("Scan(42) = nil error, want an error")
	}
}

func TestTagsRoundTrip(t *testing.T) {
	original := Tags{"E2E Source"}
	encoded, err := original.Value()
	if err != nil {
		t.Fatalf("Value() error = %v", err)
	}
	var decoded Tags
	if err := decoded.Scan(encoded); err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	if len(decoded) != 1 || decoded[0] != "E2E Source" {
		t.Fatalf("round trip = %v, want [E2E Source]", decoded)
	}
}

// Compile-time proof that Tags satisfies both database/sql interfaces. sqlc's
// override is only correct if it does.
var (
	_ driver.Valuer = Tags(nil)
)
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/tracking-go && go test ./internal/adapter/mysql/
```

Expected output:

```
# github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql [github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql.test]
./tags_test.go:11:9: undefined: Tags
...
FAIL	github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql [build failed]
```

- [ ] **Step 3: Write minimal implementation**

Create `services/tracking-go/internal/adapter/mysql/tags.go`:

```go
package mysql

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
)

// Tags is the Go representation of tracking.tags, a MySQL JSON array of strings.
//
// MySQL has no array type, so the portable equivalent of Users' Postgres text[]
// is a JSON array, queried with JSON_CONTAINS. This type is referenced by an
// override in sqlc.yaml so the generated model exposes []string rather than
// json.RawMessage, keeping marshalling out of every call site.
type Tags []string

// Value marshals the tags to a JSON array.
//
// A nil or empty Tags marshals to `[]`, NEVER to NULL. The column is NOT NULL
// with a DEFAULT (JSON_ARRAY()), and a NULL would give "no tags" two spellings —
// worse, JSON_CONTAINS(NULL, ...) evaluates to NULL rather than FALSE, so a NULL
// row is silently excluded from the e2e-cleanup predicate for a reason that
// reads like an accident.
func (t Tags) Value() (driver.Value, error) {
	if t == nil {
		return []byte("[]"), nil
	}
	b, err := json.Marshal([]string(t))
	if err != nil {
		return nil, fmt.Errorf("marshal tags: %w", err)
	}
	return b, nil
}

// Scan unmarshals a JSON array from the driver.
//
// Accepts []byte and string (drivers differ), and degrades a nil source to an
// empty slice rather than panicking: the column is NOT NULL today, but a row
// written before that constraint existed must not crash a read path.
func (t *Tags) Scan(src any) error {
	switch v := src.(type) {
	case nil:
		*t = Tags{}
		return nil
	case []byte:
		return t.unmarshal(v)
	case string:
		return t.unmarshal([]byte(v))
	default:
		return fmt.Errorf("cannot scan %T into Tags", src)
	}
}

func (t *Tags) unmarshal(b []byte) error {
	if len(b) == 0 {
		*t = Tags{}
		return nil
	}
	var out []string
	if err := json.Unmarshal(b, &out); err != nil {
		return fmt.Errorf("unmarshal tags: %w", err)
	}
	if out == nil {
		out = []string{}
	}
	*t = Tags(out)
	return nil
}
```

Create `services/tracking-go/sqlc.yaml`:

```yaml
version: "2"
sql:
  - engine: "mysql"
    # Schema comes from the migrations themselves, so the generated models can
    # never drift from the DDL the database actually runs. There is no second
    # schema definition to keep in sync.
    schema: "migrations/"
    queries: "internal/adapter/mysql/queries/"
    gen:
      go:
        package: "mysql"
        out: "internal/adapter/mysql"
        sql_package: "database/sql"
        # No JSON tags on generated models. These are persistence structs; the
        # HTTP response types are separate and hand-written, precisely so a
        # response can never accidentally carry shipping_address or cognito_sub.
        emit_json_tags: false
        emit_prepared_queries: false
        emit_interface: true
        emit_empty_slices: true
        emit_result_struct_pointers: false
        emit_params_struct_pointers: false
        overrides:
          # tags -> the hand-written Tags type (tags.go), which implements
          # sql.Scanner and driver.Valuer over []string.
          - column: "tracking.tags"
            go_type:
              import: "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql"
              package: "mysql"
              type: "Tags"
          # shipping_address stays RAW JSON. Deliberately NOT a Go struct: the
          # shape is owned by Orders/Users, this service only stores and returns
          # it, and a strict model would turn an additive upstream field into a
          # tracking-creation outage.
          - column: "tracking.shipping_address"
            go_type:
              import: "encoding/json"
              package: "json"
              type: "RawMessage"
            nullable: true
```

Create `services/tracking-go/internal/adapter/mysql/queries/tracking.sql`:

```sql
-- Queries for the tracking and tracking_history tables.
--
-- TWO RULES THAT APPLY TO EVERY QUERY IN THIS FILE:
--
-- 1. `datetime` is BACKTICKED and ALIASED. It is also a MySQL type keyword, so
--    an unbackticked reference is a syntax error reported at an unhelpful
--    location. Every SELECT aliases it to occurred_at so the generated Go field
--    is a legal, readable identifier.
--
-- 2. sqlc.slice() GENERATES INVALID SQL FOR AN EMPTY SLICE. sqlc expands the
--    placeholder once per element, so zero elements produces `IN ()`, which
--    MySQL rejects outright. Every caller of a query using sqlc.slice MUST
--    short-circuit to an empty result WITHOUT querying when the slice is empty.
--    The Python does exactly this. See ListTrackingsByIDs below.
--
-- Soft delete: every read filters `deleted_at IS NULL`. The application never
-- issues DELETE, and the database user has no DELETE grant.

-- name: GetTrackingByOrderID :one
-- UNSCOPED lookup, used by the internal/gRPC path. Deliberately a SEPARATE query
-- from the scoped one below rather than one query with an optional parameter:
-- Go's zero value for string is "", not nil, so an optional-parameter port
-- silently converts "unscoped" into "scoped to the empty string".
SELECT
  id,
  user_id,
  order_id,
  status,
  shipping_address,
  `datetime` AS occurred_at,
  created_by,
  created_at,
  updated_by,
  updated_at,
  deleted_by,
  deleted_at,
  cognito_sub,
  tags,
  tracking_number
FROM tracking
WHERE order_id = ?
  AND deleted_at IS NULL;

-- name: GetTrackingByOrderIDScoped :one
-- OWNERSHIP-SCOPED lookup for the user-facing REST reads.
--
-- Scoped by cognito_sub, NEVER by user_id. The gateway injects the JWT `sub` as
-- the x-user-id header; user_id holds the internal usr_ id Orders resolved
-- through Users. Comparing a sub against a usr_ id never matches, so scoping by
-- user_id would answer 404 for every read — including the caller's own tracking —
-- while looking perfectly implemented.
SELECT
  id,
  user_id,
  order_id,
  status,
  shipping_address,
  `datetime` AS occurred_at,
  created_by,
  created_at,
  updated_by,
  updated_at,
  deleted_by,
  deleted_at,
  cognito_sub,
  tags,
  tracking_number
FROM tracking
WHERE order_id = ?
  AND cognito_sub = ?
  AND deleted_at IS NULL;

-- name: ListTrackingsByCognitoSub :many
-- The caller's own trackings. Scoped by cognito_sub for the reason above.
SELECT
  id,
  user_id,
  order_id,
  status,
  shipping_address,
  `datetime` AS occurred_at,
  created_by,
  created_at,
  updated_by,
  updated_at,
  deleted_by,
  deleted_at,
  cognito_sub,
  tags,
  tracking_number
FROM tracking
WHERE cognito_sub = ?
  AND deleted_at IS NULL
ORDER BY created_at DESC;

-- name: ListTrackingsByIDs :many
-- Batch fetch by primary key.
--
-- !! THE CALLER MUST SHORT-CIRCUIT ON AN EMPTY ids SLICE !!
-- sqlc expands sqlc.slice('ids') once per element. With zero elements the
-- generated SQL is `IN ()`, which MySQL rejects with a syntax error. Return an
-- empty result WITHOUT calling this query when len(ids) == 0.
SELECT
  id,
  user_id,
  order_id,
  status,
  shipping_address,
  `datetime` AS occurred_at,
  created_by,
  created_at,
  updated_by,
  updated_at,
  deleted_by,
  deleted_at,
  cognito_sub,
  tags,
  tracking_number
FROM tracking
WHERE id IN (sqlc.slice('ids'))
  AND deleted_at IS NULL;

-- name: CreateTracking :exec
-- The ONLY path that brings a tracking into existence.
--
-- `datetime` and the audit timestamps are all passed in from ONE minted `now`,
-- never from several time.Now() calls: MySQL DATETIME here has fsp 0 and ROUNDS
-- fractional seconds rather than truncating, so two calls a millisecond apart
-- can land on different seconds.
INSERT INTO tracking (
  id,
  user_id,
  order_id,
  status,
  shipping_address,
  `datetime`,
  created_by,
  created_at,
  updated_by,
  updated_at,
  cognito_sub,
  tags,
  tracking_number
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: UpdateTrackingStatus :execrows
-- Advance a tracking's status. Returns the affected-row count so the caller can
-- distinguish "updated" from "no such live tracking" without a second read.
UPDATE tracking
SET status      = ?,
    `datetime`  = ?,
    updated_by  = ?,
    updated_at  = ?
WHERE order_id = ?
  AND deleted_at IS NULL;

-- name: SoftDeleteTrackingsByCognitoSub :execrows
-- Account-deletion cascade. Soft delete only: stamps deleted_at/deleted_by and
-- never issues DELETE.
UPDATE tracking
SET deleted_at = ?,
    deleted_by = ?
WHERE cognito_sub = ?
  AND deleted_at IS NULL;

-- name: ListE2ETrackingIDs :many
-- The e2e-cleanup selector. JSON_CONTAINS is how a MySQL JSON array is queried
-- for membership (verified against MySQL 8.0.46).
--
-- The tag argument must be the EXACT literal "E2E Source" — space, capitals and
-- all. Users' teardown selects on the same string; a near-miss would clean up
-- nothing while looking correct.
SELECT id
FROM tracking
WHERE JSON_CONTAINS(tags, CAST(? AS JSON))
  AND deleted_at IS NULL;

-- name: CreateTrackingHistory :exec
-- One row per transition. The composite PK (tracking_id, status) makes a
-- duplicate transition fail at INSERT — a second enforcement of the forward-only
-- state machine, independent of the application guard.
--
-- No id, no tags, no shipping_address: all three omissions are deliberate.
INSERT INTO tracking_history (
  tracking_id,
  status,
  user_id,
  order_id,
  `datetime`,
  created_by,
  created_at,
  updated_by,
  updated_at,
  cognito_sub
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: ListTrackingHistory :many
-- History for one tracking.
--
-- ORDER BY datetime alone is NOT deterministic: DATETIME has fsp 0 (second
-- resolution) and one unit of work stamps every row it writes from a single
-- `now`, so ties are common. On a tie MySQL is free to return primary-key order,
-- which for (tracking_id, status) is ALPHABETICAL — DELIVERED first. The FIELD()
-- tiebreaker maps each status to its progression position; domain.SortHistory
-- applies the same rule in Go for any path that assembles history in memory.
SELECT
  tracking_id,
  status,
  user_id,
  order_id,
  `datetime` AS occurred_at,
  created_by,
  created_at,
  updated_by,
  updated_at,
  deleted_by,
  deleted_at,
  cognito_sub
FROM tracking_history
WHERE tracking_id = ?
  AND deleted_at IS NULL
ORDER BY
  `datetime` ASC,
  FIELD(status, 'PLACED', 'PROCESSING', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED') ASC;

-- name: SoftDeleteTrackingHistoryByCognitoSub :execrows
-- History side of the account-deletion cascade.
UPDATE tracking_history
SET deleted_at = ?,
    deleted_by = ?
WHERE cognito_sub = ?
  AND deleted_at IS NULL;
```

Add sqlc targets to `services/tracking-go/Makefile` (append):

```makefile
# ─── sqlc ────────────────────────────────────────────────────────────────────

.PHONY: sqlc-generate
sqlc-generate: ## Regenerate the data layer from migrations/ + queries/
	sqlc generate

.PHONY: sqlc-verify
sqlc-verify: ## Fail if the generated code is stale relative to the SQL
	sqlc diff
```

Generate and add the driver dependency:

```bash
cd services/tracking-go && \
go get github.com/go-sql-driver/mysql@latest && \
sqlc generate && \
go mod tidy
```

(Install sqlc first if absent: `go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest`.)

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/tracking-go && go test -race -v ./internal/adapter/mysql/
```

Expected: every `Tags` test reports `--- PASS`, ending with:

```
PASS
ok  	github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql	0.0XXs
```

Confirm the generated files exist and that the overrides landed:

```bash
cd services/tracking-go && \
ls internal/adapter/mysql/db.go internal/adapter/mysql/models.go internal/adapter/mysql/tracking.sql.go && \
grep -n 'Tags\|ShippingAddress\|OccurredAt' internal/adapter/mysql/models.go
```

Expected in `models.go`: a `Tags Tags` field (not `json.RawMessage`), and a `ShippingAddress json.RawMessage` field. Confirm the whole module builds, that generated code is not stale, and that lint is clean:

```bash
cd services/tracking-go && sqlc diff && go build ./... && go test -race ./... && make fmt-check && make lint
```

`sqlc diff` must produce no output.

- [ ] **Step 5: Commit**

```bash
git add services/tracking-go && \
git commit -m "feat(tracking): sqlc data layer with Tags override and raw-JSON shipping_address"
```

---

### Task 7: main.go skeleton + GET /v1/health

**Files:**
- Create: `services/tracking-go/internal/adapter/http/health.go`
- Create: `services/tracking-go/internal/adapter/http/router.go`
- Create: `services/tracking-go/cmd/server/main.go`
- Test: `services/tracking-go/internal/adapter/http/health_test.go`

**Interfaces:**
- Consumes: the module from Task 1.
- Produces:

```go
package http

type HealthResponse struct {
	Status string `json:"status"`
}

func RegisterHealth(router gin.IRouter)
func NewRouter() *gin.Engine
```

**Rules this task must implement exactly:**

- **The route is served UNPREFIXED at `/v1/health`.** The gateway publishes it as `/v1/tracking/health` and nginx rewrites the prefixed path down to this bare one. This is not cosmetic: nginx's default `location /` proxies anything unmatched to `users:3000`, so a bare `GET /v1/health` route at the GATEWAY would fall through to that catch-all and return **Users'** 200 — a Tracking health probe reporting healthy while never once reaching this service. That failure mode is worse than a 404 because nothing would ever flag it.
- **Response is exactly `{"status":"ok"}` with HTTP 200.** No auth (an ALB/Fargate probe carries neither `x-user-id` nor an API key) and **no database access**. This is a liveness check answering "is this process up and serving HTTP"; folding a `SELECT 1` into it would make a transient database blip cycle otherwise-healthy tasks.
- **Graceful shutdown** via `signal.NotifyContext` + `srv.Shutdown(ctx)`.
- **12-Factor:** configuration from environment variables, logs to stdout.

**GIN ROUTING NOTE — this task must carry it forward, because it is a startup-time crash, not a runtime 404:**

Gin builds one radix route tree **per HTTP method** and **PANICS AT STARTUP** on a wildcard/literal conflict within a method's tree. Starlette matched by declaration order and simply never hit the shadowed route, so this class of problem did not exist in Python.

Today's literal routes are `POST /v1/trackings/init-tracking`, `DELETE /v1/trackings/by-user`, and `DELETE /v1/trackings/e2e-cleanup`. None conflicts with `GET /v1/trackings/:order_id` **because the methods differ** — they live in different trees. But adding **ANY `GET` literal** under `/v1/trackings/` (say `GET /v1/trackings/summary`) would land in the same tree as the `:order_id` wildcard and panic the process on boot. Whoever adds a GET route under that prefix in a later wave must restructure, not just register.

Also: reproducing the Python's **405** (not 404) for the unmounted e2e route requires `router.HandleMethodNotAllowed = true`. Gin's default is `false`, which answers 404 for a path that exists under a different method.

- [ ] **Step 1: Write the failing test**

Create `services/tracking-go/internal/adapter/http/health_test.go`:

```go
package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestMain(m *testing.M) {
	gin.SetMode(gin.TestMode)
	m.Run()
}

func TestHealthReturns200AndExactBody(t *testing.T) {
	router := NewRouter()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	// The body is exactly {"status":"ok"} — no extra fields, no whitespace
	// differences that a consumer's strict parser would trip on.
	if got := rec.Body.String(); got != `{"status":"ok"}` {
		t.Fatalf("body = %s, want %s", got, `{"status":"ok"}`)
	}

	var decoded map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("body is not valid JSON: %v", err)
	}
	if len(decoded) != 1 {
		t.Fatalf("body has %d fields, want exactly 1: %v", len(decoded), decoded)
	}
	if decoded["status"] != "ok" {
		t.Fatalf(`status = %v, want "ok"`, decoded["status"])
	}
}

// The route is served UNPREFIXED. The gateway publishes it as
// /v1/tracking/health and nginx rewrites down to the bare path. A service that
// also served the prefixed path would mask a broken rewrite.
func TestHealthIsServedUnprefixed(t *testing.T) {
	router := NewRouter()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/tracking/health", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /v1/tracking/health status = %d, want %d — the service serves the BARE path only",
			rec.Code, http.StatusNotFound)
	}
}

// Health carries no auth dependency: an ALB/Fargate probe sends neither an
// x-user-id header nor an API key.
func TestHealthRequiresNoAuthHeaders(t *testing.T) {
	router := NewRouter()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	req.Header.Del("x-user-id")
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status without auth headers = %d, want %d", rec.Code, http.StatusOK)
	}
}

// 200 is the ONLY status this route ever returns.
func TestHealthRejectsOtherMethods(t *testing.T) {
	router := NewRouter()

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		t.Run(method, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(method, "/v1/health", nil)
			router.ServeHTTP(rec, req)

			// HandleMethodNotAllowed is enabled, so a path that exists under a
			// different method answers 405, not 404.
			if rec.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s /v1/health status = %d, want %d", method, rec.Code, http.StatusMethodNotAllowed)
			}
		})
	}
}

// Gin's default is false, which answers 404 where the Python answered 405.
func TestRouterHandlesMethodNotAllowed(t *testing.T) {
	router := NewRouter()
	if !router.HandleMethodNotAllowed {
		t.Fatal("HandleMethodNotAllowed = false; the Python surface answers 405, not 404, for a path under the wrong method")
	}
}

// Today's literals differ in METHOD from the GET wildcard, so they occupy
// different route trees and cannot conflict. Registering them must not panic.
// Adding any GET literal under /v1/trackings/ WOULD panic at startup.
func TestRouteRegistrationDoesNotPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("route registration panicked: %v", r)
		}
	}()

	router := NewRouter()
	noop := func(c *gin.Context) { c.Status(http.StatusOK) }

	router.POST("/v1/trackings/init-tracking", noop)
	router.DELETE("/v1/trackings/by-user", noop)
	router.DELETE("/v1/trackings/e2e-cleanup", noop)
	router.GET("/v1/trackings/:order_id", noop)
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/tracking-go && go test ./internal/adapter/http/
```

Expected output:

```
internal/adapter/http/health_test.go:9:2: no required module provides package github.com/gin-gonic/gin; to add it:
	go get github.com/gin-gonic/gin
```

After `go get github.com/gin-gonic/gin`, re-running gives the real red state:

```
# github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http [github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http.test]
./health_test.go:17:16: undefined: NewRouter
FAIL	github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http [build failed]
```

- [ ] **Step 3: Write minimal implementation**

Add the dependency:

```bash
cd services/tracking-go && go get github.com/gin-gonic/gin@latest
```

Create `services/tracking-go/internal/adapter/http/health.go`:

```go
package http

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// HealthResponse is the entire body of the liveness probe: {"status":"ok"}.
type HealthResponse struct {
	Status string `json:"status"`
}

// RegisterHealth mounts GET /v1/health.
//
// ## Bare path here, prefixed at the gateway
//
// The service serves this UNPREFIXED at /v1/health, while the gateway publishes
// it as /v1/tracking/health and nginx rewrites the prefixed path down to this
// bare one (infra/modules/compute/nginx/nginx.conf, marked HEALTH-ONLY there —
// the rewrite must not be extended to functional routes). Users and Orders serve
// theirs the same way.
//
// The gateway prefix is not cosmetic. nginx's default `location /` proxies
// anything unmatched to users:3000, so a bare GET /v1/health route AT THE
// GATEWAY would fall through to that catch-all and return USERS' 200 — a
// Tracking health probe that reports healthy while never once reaching this
// service. That failure mode is worse than a 404 because nothing would ever
// flag it. Hence: bare internally, prefixed at the gateway.
//
// ## Unauthenticated, and shallow
//
// No x-user-id, no API key — an ALB/Fargate probe carries neither. And it does
// NOT touch the database: this is a liveness check answering "is this process up
// and serving HTTP". Folding a SELECT 1 into it would make a transient database
// blip cycle otherwise-healthy tasks.
func RegisterHealth(router gin.IRouter) {
	router.GET("/v1/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, HealthResponse{Status: "ok"})
	})
}
```

Create `services/tracking-go/internal/adapter/http/router.go`:

```go
package http

import "github.com/gin-gonic/gin"

// NewRouter builds the Gin engine with the routes registered so far.
//
// ## Gin route trees PANIC AT STARTUP on a conflict
//
// Gin builds one radix route tree PER HTTP METHOD and panics when a wildcard and
// a literal collide within one method's tree. Starlette matched by declaration
// order and simply never reached the shadowed route, so this failure mode did
// not exist in the Python service.
//
// Today's literals are:
//
//	POST   /v1/trackings/init-tracking
//	DELETE /v1/trackings/by-user
//	DELETE /v1/trackings/e2e-cleanup
//
// None conflicts with GET /v1/trackings/:order_id BECAUSE THE METHODS DIFFER —
// they live in separate trees. But adding ANY GET literal under /v1/trackings/
// (e.g. GET /v1/trackings/summary) lands in the same tree as the :order_id
// wildcard and panics the process on boot. Whoever adds such a route must
// restructure the prefix, not merely register one more handler.
func NewRouter() *gin.Engine {
	router := gin.New()
	router.Use(gin.Recovery())

	// Gin defaults this to false, which answers 404 for a path that exists under
	// a different method. The Python surface answers 405 — notably for the
	// unmounted e2e route — so the default would be a silent behavioural drift.
	router.HandleMethodNotAllowed = true

	RegisterHealth(router)

	return router
}
```

Create `services/tracking-go/cmd/server/main.go`:

```go
// Command server runs the Tracking HTTP service.
//
// All dependencies are wired BY HAND here — no DI container, no code generation
// for wiring, no reflection. The wiring is a function you can read top to bottom.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
)

const (
	defaultPort            = "8000"
	shutdownGracePeriod    = 15 * time.Second
	serverReadHeaderTimeout = 10 * time.Second
)

func main() {
	// 12-Factor: structured logs to STDOUT, never to a file. Severity strings
	// are DEBUG/INFO/WARN/ERROR/FATAL — WARN, not WARNING.
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// 12-Factor: configuration comes from the environment, never from a file
	// baked into the image. Env files in this repo are GENERATED by
	// `make env-file` from Terraform outputs.
	if ginMode := os.Getenv("GIN_MODE"); ginMode != "" {
		gin.SetMode(ginMode)
	} else {
		gin.SetMode(gin.ReleaseMode)
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	router := adapterhttp.NewRouter()

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           router,
		ReadHeaderTimeout: serverReadHeaderTimeout,
	}

	// NotifyContext cancels ctx on SIGINT/SIGTERM. SIGTERM is what ECS sends
	// when it drains a task, so handling it is what makes a deploy graceful
	// rather than a burst of dropped connections.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serverErr := make(chan error, 1)
	go func() {
		logger.Info("http server starting", slog.String("addr", srv.Addr))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
			return
		}
		serverErr <- nil
	}()

	select {
	case err := <-serverErr:
		if err != nil {
			logger.Error("http server failed", slog.String("error", err.Error()))
			os.Exit(1)
		}
	case <-ctx.Done():
		logger.Info("shutdown signal received, draining connections")

		// A FRESH context: ctx is already cancelled, so passing it to Shutdown
		// would abort in-flight requests immediately instead of draining them.
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGracePeriod)
		defer cancel()

		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("graceful shutdown failed", slog.String("error", err.Error()))
			os.Exit(1)
		}
		logger.Info("http server stopped cleanly")
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/tracking-go && go mod tidy && go test -race -v ./internal/adapter/http/
```

Expected: every test reports `--- PASS`, ending with:

```
PASS
ok  	github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http	0.0XXs
```

Build and smoke-test the binary end to end:

```bash
cd services/tracking-go && make build && PORT=8099 ./bin/tracking-server &
sleep 2
curl -s -w '\nHTTP %{http_code}\n' http://localhost:8099/v1/health
curl -s -w '\nHTTP %{http_code}\n' http://localhost:8099/v1/tracking/health
kill %1
```

Expected:

```
{"status":"ok"}
HTTP 200
404 page not found
HTTP 404
```

The startup log line must be JSON on stdout, e.g. `{"time":"...","level":"INFO","msg":"http server starting","addr":":8099"}`, and the `kill` must produce `{"...","msg":"http server stopped cleanly"}`.

Full module gate:

```bash
cd services/tracking-go && go build ./... && go test -race ./... && make fmt-check && make lint
```

- [ ] **Step 5: Commit**

```bash
git add services/tracking-go && \
git commit -m "feat(tracking): Gin server skeleton with unprefixed GET /v1/health and graceful shutdown"
```

---

**WAVE 0 REVIEW CHECKPOINT.** Stop here. Do not begin Wave 1 or Wave 2. Hand the branch back with:
- `go build ./... && go test -race ./... && make fmt-check && make lint` all green,
- `sqlc diff` producing no output,
- the domain-purity check (Task 5, Step 4) producing no output,
- the migration verification queries (Task 2, Step 4) matching every expected row.

Review against this section's stated rules, not merely against whether the code is self-consistent: a requirement dropped in implementation leaves no trace, because the shipped code passes its own tests on its own terms.

---

## Wave 0 equivalence map

| Source Python file | Destination Go file(s) | Tacit rules found |
|---|---|---|
| `services/tracking/src/features/tracking/domain/status.py` | `services/tracking-go/internal/domain/status.go`<br>`services/tracking-go/internal/domain/status_test.go` | Ordering comes from an explicit ordered slice, NEVER from comparing values — `StrEnum` (and Go's `string` underlying type) compares alphabetically, where `DELIVERED < PLACED`. The three guards run in a load-bearing order: terminal first, so `DELIVERED → DELIVERED` reports `already_delivered` (guard 1), not `not_strictly_forward` (guard 3). Three distinct reason values, not one boolean, so each guard is independently testable and the logging convention's `reason` field on `*_failed` is machine-readable. Skipping is legal (`PLACED → DELIVERED`) — forward-only, not next-step-only. `next_status` returns nil/`ok=false` at the terminal status rather than raising: reaching the end is how a TestMode run FINISHES. `parse_status` is case-sensitive because the five values are a wire contract shared with the proto. |
| `services/tracking/src/features/tracking/domain/models.py` | `services/tracking-go/internal/domain/tracking.go`<br>`services/tracking-go/internal/domain/tracking_test.go`<br>`services/tracking-go/internal/adapter/mysql/tags.go` | History ordering is `datetime ASC, then progression position ASC` — the tiebreaker is load-bearing, and a bare datetime sort bit the Python service in a real MySQL test: `DATETIME` has fsp 0, one unit of work stamps rows from one `now`, and MySQL then falls back to PK order `(tracking_id, status)`, which is ALPHABETICAL (DELIVERED first). `cognito_sub`, not `user_id`, is the ownership key: `x-user-id` carries the JWT `sub`, so scoping by `user_id` compares a `sub` to a `usr_` id and 404s every read while looking implemented. `shipping_address` is raw JSON with no Go struct — its shape is owned by Orders/Users and a strict model turns an additive upstream field into a creation outage. `tags` is JSON (MySQL has no array type), NOT NULL with a `[]` default, because `JSON_CONTAINS(NULL, …)` is NULL rather than FALSE. `E2E Source` is shared VERBATIM with Users. `ID_LENGTH` is DERIVED from the generator's constants, never restated — MySQL truncates an over-long value silently. `tracking_history` has no surrogate id, no tags, no shipping_address, and its composite PK is a second enforcement of the state machine. |
| `services/tracking/src/shared/db/nano_id.py` | `services/tracking-go/internal/domain/id.go`<br>`services/tracking-go/internal/domain/id_test.go` | Alphabet is 62 symbols in an exact order with NO `_` and NO `-`: nanoid's default includes both, and a leading `-` reads as a shell flag while `_` disappears against an underscored column name. 62^24 is MORE entropy than the 64^21 it replaced. Length 24 is the RANDOM portion only; stored width is prefix(4)+24=28. CROSS-SERVICE CONTRACT with Users (`shared/id/nano-id.ts`) and Orders (`Orders.Infrastructure/Id/NanoId.cs`) — changing one means changing all three. `TrackingHistory` deliberately gets no prefix and no generated id. `req_` shares the format on purpose so no second notion of "how long" can appear. Modulo bias must be avoided: 62 does not divide 256, so use `crypto/rand.Int` (rejection sampling), never `randomByte % 62`. |
| `services/tracking/src/shared/db/tracking_number.py` | `services/tracking-go/internal/domain/id.go`<br>`services/tracking-go/internal/domain/id_test.go` | `secrets`/`crypto/rand`, never `random`/`math/rand`: a Mersenne Twister's state is reconstructible from a few outputs, and the number appears in emails and URLs, so a guessable one lets somebody enumerate other people's shipments. Alphabet is the 36 uppercase alphanumerics MINUS `I`, `O`, `0`, `1` — the pairs a reader confuses when transcribing. Format `3MRAI-XXXX-XXXX-XXXX`, width 20, derived from prefix+groups rather than a literal. NO checksum: 60 bits of entropy plus the UNIQUE constraint means a collision is a failed INSERT, not two shipments sharing a number. The number is OURS, not a carrier's — the row exists from `PLACED`, before any shipper is involved; a real carrier number would be a second, differently-named column. |
| `services/tracking/alembic/versions/*.py`<br>(`da01eaebb060`, `b17f4c2e9a30`, `0a1cc6845c4a`, `c93b7d1f52ae`) | `services/tracking-go/migrations/000001_baseline.up.sql`<br>`services/tracking-go/migrations/000001_baseline.down.sql`<br>`services/tracking-go/migrations/README.md` | Four revisions squash into one baseline; the Go service declares the schema the history arrived at rather than replaying it. `DEFAULT (JSON_ARRAY())` parentheses are MANDATORY — MySQL rejects a bare literal default on a JSON column. Charset/collation were NEVER declared in Python (inherited `utf8mb4_unicode_ci` from the server), so the baseline must declare them explicitly: MySQL 8 defaults to `utf8mb4_0900_ai_ci`, silently changing comparison semantics. `datetime` must be backticked in DDL and in every query, and aliased on select (`` `datetime` AS occurred_at ``). The FK carries no ON DELETE/ON UPDATE (MySQL defaults to RESTRICT); the app never issues DELETE and the DB user has no DELETE grant. golang-migrate (`schema_migrations`) and Alembic (`alembic_version`) are MUTUALLY BLIND — during coexistence both services share ONE database, so the baseline is applied as a no-op stamp (`migrate force 1`), never re-run, and `alembic_version` stays until Python deletion, then is dropped, because leaving both is a silent trap for a stray `alembic upgrade head`. Down migration drops `tracking_history` first, since the RESTRICT FK blocks dropping the parent. |
## Wave 1 — Platform

Wave 1 builds everything the domain and the HTTP surface will stand on: configuration, logging, tracing, metrics, cache, auth, the outbound gRPC client, and the SQS publisher. Nothing here knows what a "tracking" is.

**Four agents run this wave concurrently.** The groups touch disjoint files and share no build artifact except `internal/platform/config`, which Group A creates first and the other three only read. Agents B, C and D declare the tiny slice of config they consume as their own local interface or take primitives in their constructors, so none of them blocks on Group A compiling.

| Agent | Tasks | Files it owns |
|---|---|---|
| A — Config + Logging | 8, 9, 10 | `internal/platform/config/**`, `internal/platform/logging/**` |
| B — OTel + Metrics | 11, 12 | `internal/adapter/otel/**`, `internal/adapter/cloudwatch/**` |
| C — Cache | 13, 14, 15 | `internal/adapter/redis/**` |
| D — Auth + gRPC + SQS | 16, 17, 18 | `internal/adapter/http/**` (middleware only), `internal/adapter/grpcusers/**`, `internal/adapter/sqs/**` |

---

## Group A — Config + Logging

### Task 8: Environment configuration and the DSN converter

**Files:**
- Create: `services/tracking-go/internal/platform/config/config.go`
- Create: `services/tracking-go/internal/platform/config/dsn.go`
- Test: `services/tracking-go/internal/platform/config/config_test.go`
- Test: `services/tracking-go/internal/platform/config/dsn_test.go`

**Interfaces:**
- Consumes: `os.Getenv` only. This package imports nothing from the rest of the module.
- Produces:
  ```go
  func Load() (Config, error)
  func MySQLDSN(sqlAlchemyDSN string) (string, error)
  ```

There are exactly **four required** variables. Everything else has a default, and an unparseable value falls back to that same default rather than failing — a malformed flag must never stop the process booting.

| Env | Type | Default | Required |
|---|---|---|---|
| `DATABASE_WRITER_URL` | string | — | YES (len ≥ 1) |
| `DATABASE_READER_URL` | string | — | YES (len ≥ 1) |
| `GRPC_API_KEY` | string | — | YES (len ≥ 1) |
| `TRACKING_CARRIER_API_KEY` | string | — | YES (len ≥ 1) |
| `PORT` | int | `8000` | no (> 0, < 65536) |
| `USERS_GRPC_URL` | string | `users:50051` | no |
| `EVENTS_QUEUE_URL` | string | `""` | no |
| `AWS_ENDPOINT_URL` | `*string` | `nil` | no |
| `AWS_REGION` | string | `us-east-1` | no |
| `METRICS_INTERVAL_SECONDS` | float64 | `15.0` | no |
| `METRICS_ENABLED` | bool | **`true`** | no |
| `E2E_TESTING_ENABLED` | bool | **`false`** | no |
| `REDIS_HOST` | string | `localhost` | no |
| `REDIS_PORT` | int | `6379` | no |
| `CACHE_ENABLED` | bool | `true` | no |
| `CACHE_TIMEOUT_MS` | int | `50` | no (> 0) |
| `DEPLOYMENT_ENVIRONMENT` | string | `local` | no |
| `ENVIRONMENT` | enum `development\|test\|production` | `development` | no — rejects any other value |

**The two bool defaults point in OPPOSITE directions on purpose.** Forgetting `METRICS_ENABLED` in a deployed environment leaves the dashboards populated (default `true`, because publishing a metric is harmless while silently empty dashboards are not). Forgetting `E2E_TESTING_ENABLED` means the mass-delete route is **not mounted** (default `false`, because a forgotten variable must not expose a mass-delete surface). Do not "make them consistent."

`AWS_ENDPOINT_URL` is `*string`, not `string`: locally it is Floci (`http://floci:4566`); in a deployed environment it is **unset**, and the AWS SDK must then resolve the real endpoint itself. An empty-string default would point the SDK at nothing.

`EVENTS_QUEUE_URL` defaults to `""` while the database URLs are required, and the asymmetry is deliberate: publishing fails loudly at the one call site that needs it, whereas making it required would break every test that constructs a config for a surface unrelated to events.

**The DSN converter.** `DATABASE_*_URL` hold **SQLAlchemy** DSNs (`mysql+pymysql://user:pass@host:3306/tracking`), because they are generated by `infra/environments/local/scripts/generate_env_files.py` and shared with the Python service during the migration. `go-sql-driver/mysql` wants `user:pass@tcp(host:3306)/tracking?parseTime=true&loc=UTC`. `parseTime=true&loc=UTC` is **always appended** — without `parseTime` every `DATETIME` comes back as `[]byte`, and without `loc=UTC` the driver interprets stored values in the process's local zone.

- [ ] **Step 1: Write the failing test**

`services/tracking-go/internal/platform/config/dsn_test.go`:
```go
package config_test

import (
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/config"
)

func TestMySQLDSN(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{
			name: "sqlalchemy pymysql dsn",
			in:   "mysql+pymysql://root:secret@floci-mysql:3306/tracking",
			want: "root:secret@tcp(floci-mysql:3306)/tracking?parseTime=true&loc=UTC",
		},
		{
			name: "bare mysql scheme",
			in:   "mysql://root:secret@127.0.0.1:7001/tracking",
			want: "root:secret@tcp(127.0.0.1:7001)/tracking?parseTime=true&loc=UTC",
		},
		{
			name: "no port defaults to 3306",
			in:   "mysql+pymysql://root:secret@db/tracking",
			want: "root:secret@tcp(db:3306)/tracking?parseTime=true&loc=UTC",
		},
		{
			name: "password with url-encoded characters is decoded",
			in:   "mysql+pymysql://root:p%40ss%2Fword@db:3306/tracking",
			want: "root:p@ss/word@tcp(db:3306)/tracking?parseTime=true&loc=UTC",
		},
		{
			name: "existing query params are preserved and ours appended",
			in:   "mysql+pymysql://root:secret@db:3306/tracking?charset=utf8mb4",
			want: "root:secret@tcp(db:3306)/tracking?charset=utf8mb4&parseTime=true&loc=UTC",
		},
		{
			name: "no user or password",
			in:   "mysql+pymysql://db:3306/tracking",
			want: "@tcp(db:3306)/tracking?parseTime=true&loc=UTC",
		},
		{name: "empty is an error", in: "", wantErr: true},
		{name: "no database name is an error", in: "mysql+pymysql://root:secret@db:3306", wantErr: true},
		{name: "unparseable is an error", in: "://://", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := config.MySQLDSN(tt.in)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("MySQLDSN(%q) = %q, want error", tt.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("MySQLDSN(%q) returned unexpected error: %v", tt.in, err)
			}
			if got != tt.want {
				t.Errorf("MySQLDSN(%q)\n got = %q\nwant = %q", tt.in, got, tt.want)
			}
		})
	}
}

// parseTime and loc are what make DATETIME columns arrive as time.Time in UTC.
// Asserted separately from the table so a future change to the table cannot
// quietly drop them from every case at once.
func TestMySQLDSNAlwaysAppendsParseTimeAndUTC(t *testing.T) {
	inputs := []string{
		"mysql+pymysql://root:secret@db:3306/tracking",
		"mysql+pymysql://root:secret@db:3306/tracking?charset=utf8mb4",
		"mysql://a:b@h/d",
	}
	for _, in := range inputs {
		got, err := config.MySQLDSN(in)
		if err != nil {
			t.Fatalf("MySQLDSN(%q): %v", in, err)
		}
		if !strings.Contains(got, "parseTime=true") {
			t.Errorf("MySQLDSN(%q) = %q, missing parseTime=true", in, got)
		}
		if !strings.Contains(got, "loc=UTC") {
			t.Errorf("MySQLDSN(%q) = %q, missing loc=UTC", in, got)
		}
	}
}
```
(add `"strings"` to that file's imports).

`services/tracking-go/internal/platform/config/config_test.go`:
```go
package config_test

import (
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/config"
)

// setRequired writes the four variables without which Load must fail.
func setRequired(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_WRITER_URL", "mysql+pymysql://root:secret@db:3306/tracking")
	t.Setenv("DATABASE_READER_URL", "mysql+pymysql://root:secret@db:3306/tracking")
	t.Setenv("GRPC_API_KEY", "internal-key")
	t.Setenv("TRACKING_CARRIER_API_KEY", "carrier-key")
}

func TestLoadDefaults(t *testing.T) {
	setRequired(t)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() returned unexpected error: %v", err)
	}

	if cfg.Port != 8000 {
		t.Errorf("Port = %d, want 8000", cfg.Port)
	}
	if cfg.UsersGRPCURL != "users:50051" {
		t.Errorf("UsersGRPCURL = %q, want %q", cfg.UsersGRPCURL, "users:50051")
	}
	if cfg.EventsQueueURL != "" {
		t.Errorf("EventsQueueURL = %q, want empty", cfg.EventsQueueURL)
	}
	if cfg.AWSEndpointURL != nil {
		t.Errorf("AWSEndpointURL = %v, want nil", cfg.AWSEndpointURL)
	}
	if cfg.AWSRegion != "us-east-1" {
		t.Errorf("AWSRegion = %q, want us-east-1", cfg.AWSRegion)
	}
	if cfg.MetricsIntervalSeconds != 15.0 {
		t.Errorf("MetricsIntervalSeconds = %v, want 15", cfg.MetricsIntervalSeconds)
	}
	if cfg.RedisHost != "localhost" || cfg.RedisPort != 6379 {
		t.Errorf("Redis = %s:%d, want localhost:6379", cfg.RedisHost, cfg.RedisPort)
	}
	if !cfg.CacheEnabled {
		t.Error("CacheEnabled = false, want true")
	}
	if cfg.CacheTimeoutMS != 50 {
		t.Errorf("CacheTimeoutMS = %d, want 50", cfg.CacheTimeoutMS)
	}
	if cfg.DeploymentEnvironment != "local" {
		t.Errorf("DeploymentEnvironment = %q, want local", cfg.DeploymentEnvironment)
	}
	if cfg.Environment != "development" {
		t.Errorf("Environment = %q, want development", cfg.Environment)
	}
}

// The two flags default in OPPOSITE directions, deliberately. Forgetting
// METRICS_ENABLED must leave dashboards populated; forgetting
// E2E_TESTING_ENABLED must leave the mass-delete route unmounted.
func TestLoadFlagDefaultsPointOppositeWays(t *testing.T) {
	setRequired(t)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if !cfg.MetricsEnabled {
		t.Error("MetricsEnabled defaulted to false; a forgotten variable must not empty the dashboards")
	}
	if cfg.E2ETestingEnabled {
		t.Error("E2ETestingEnabled defaulted to true; a forgotten variable must not expose the mass-delete route")
	}
}

func TestLoadRequiresTheFourRequiredVariables(t *testing.T) {
	for _, missing := range []string{
		"DATABASE_WRITER_URL",
		"DATABASE_READER_URL",
		"GRPC_API_KEY",
		"TRACKING_CARRIER_API_KEY",
	} {
		t.Run("missing_"+missing, func(t *testing.T) {
			setRequired(t)
			t.Setenv(missing, "")

			if _, err := config.Load(); err == nil {
				t.Fatalf("Load() with %s empty returned no error", missing)
			}
		})
	}
}

func TestLoadBoolSpellings(t *testing.T) {
	tests := []struct {
		raw  string
		want bool
	}{
		{"true", true}, {"TRUE", true}, {"True", true},
		{"1", true}, {"yes", true}, {"YES", true}, {"on", true}, {"On", true},
		{"false", false}, {"FALSE", false}, {"0", false}, {"no", false}, {"off", false},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			setRequired(t)
			t.Setenv("CACHE_ENABLED", tt.raw)

			cfg, err := config.Load()
			if err != nil {
				t.Fatalf("Load(): %v", err)
			}
			if cfg.CacheEnabled != tt.want {
				t.Errorf("CACHE_ENABLED=%q gave %v, want %v", tt.raw, cfg.CacheEnabled, tt.want)
			}
		})
	}
}

// An unparseable flag falls back to the field's own default. It must never be a
// startup failure: refusing to boot over a malformed test-harness flag is the
// worse trade.
func TestLoadUnparseableValuesFallBackToDefaults(t *testing.T) {
	setRequired(t)
	t.Setenv("METRICS_ENABLED", "maybe")
	t.Setenv("E2E_TESTING_ENABLED", "perhaps")
	t.Setenv("PORT", "not-a-number")
	t.Setenv("METRICS_INTERVAL_SECONDS", "soon")
	t.Setenv("CACHE_TIMEOUT_MS", "-1")
	t.Setenv("REDIS_PORT", "99999")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() failed on unparseable optional values: %v", err)
	}
	if !cfg.MetricsEnabled {
		t.Error("unparseable METRICS_ENABLED must fall back to true")
	}
	if cfg.E2ETestingEnabled {
		t.Error("unparseable E2E_TESTING_ENABLED must fall back to false")
	}
	if cfg.Port != 8000 {
		t.Errorf("Port = %d, want the 8000 default", cfg.Port)
	}
	if cfg.MetricsIntervalSeconds != 15.0 {
		t.Errorf("MetricsIntervalSeconds = %v, want the 15 default", cfg.MetricsIntervalSeconds)
	}
	if cfg.CacheTimeoutMS != 50 {
		t.Errorf("CacheTimeoutMS = %d, want the 50 default (out of range)", cfg.CacheTimeoutMS)
	}
	if cfg.RedisPort != 6379 {
		t.Errorf("RedisPort = %d, want the 6379 default (out of range)", cfg.RedisPort)
	}
}

func TestLoadEnvironmentEnum(t *testing.T) {
	for _, valid := range []string{"development", "test", "production"} {
		t.Run("valid_"+valid, func(t *testing.T) {
			setRequired(t)
			t.Setenv("ENVIRONMENT", valid)

			cfg, err := config.Load()
			if err != nil {
				t.Fatalf("Load(): %v", err)
			}
			if cfg.Environment != valid {
				t.Errorf("Environment = %q, want %q", cfg.Environment, valid)
			}
		})
	}

	t.Run("rejects_other_values", func(t *testing.T) {
		setRequired(t)
		t.Setenv("ENVIRONMENT", "staging")

		if _, err := config.Load(); err == nil {
			t.Fatal("Load() accepted ENVIRONMENT=staging; the enum must reject it")
		}
	})
}

func TestLoadAWSEndpointURLIsAPointer(t *testing.T) {
	setRequired(t)
	t.Setenv("AWS_ENDPOINT_URL", "http://floci:4566")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.AWSEndpointURL == nil || *cfg.AWSEndpointURL != "http://floci:4566" {
		t.Errorf("AWSEndpointURL = %v, want pointer to http://floci:4566", cfg.AWSEndpointURL)
	}
}

// EchoSQL is true everywhere except production — the Python `echo_sql` property.
func TestEchoSQL(t *testing.T) {
	for _, tt := range []struct {
		env  string
		want bool
	}{
		{"development", true}, {"test", true}, {"production", false},
	} {
		setRequired(t)
		t.Setenv("ENVIRONMENT", tt.env)

		cfg, err := config.Load()
		if err != nil {
			t.Fatalf("Load(): %v", err)
		}
		if cfg.EchoSQL() != tt.want {
			t.Errorf("EchoSQL() with ENVIRONMENT=%s = %v, want %v", tt.env, cfg.EchoSQL(), tt.want)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && go test ./internal/platform/config/...
```

Expected: `internal/platform/config/config_test.go:8:2: no required module provides package .../internal/platform/config` — the package does not exist yet. (If the directory exists but is empty, the failure is `build constraints exclude all Go files`.)

- [ ] **Step 3: Write minimal implementation**

`services/tracking-go/internal/platform/config/config.go`:
```go
// Package config reads and validates the process environment.
//
// Exactly four variables are REQUIRED; Load returns an error when any of them is
// missing or empty, so a misconfigured process refuses to start rather than
// failing later at its first query.
//
// Every other variable has a default, and an unparseable or out-of-range value
// falls back to that same default WITHOUT an error. A malformed optional value
// must never take a runtime down: refusing to boot over a mistyped feature flag
// is the worse trade in both directions.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config is the validated environment. Every field name here corresponds to a
// variable emitted by infra/environments/local/scripts/generate_env_files.py —
// renaming one is a change to that generator, not just to this struct.
type Config struct {
	// Database DSNs, in SQLAlchemy form. Convert with MySQLDSN before handing
	// either to database/sql. Reads go to the reader, writes to the writer
	// (ADR-0006); locally both point at the same Floci MySQL, but the split is
	// honoured in code so local and deployed behave identically.
	DatabaseWriterURL string
	DatabaseReaderURL string

	Port int

	// GRPCAPIKey is the INTERNAL service-to-service credential (ADR-0003),
	// shared with Users and Orders. TrackingCarrierAPIKey is the EXTERNAL key
	// handed to a third-party carrier. They are two fields because they are two
	// trust domains — see internal/adapter/http/auth.go.
	GRPCAPIKey            string
	TrackingCarrierAPIKey string

	// UsersGRPCURL may carry an http:// or https:// scheme: Orders' .NET channel
	// requires one, and both services read this same variable. The gRPC client
	// strips it.
	UsersGRPCURL string

	// EventsQueueURL is the one shared queue all three producers write to.
	// Defaults to empty; publishing fails (loudly, at the publisher) when it is.
	EventsQueueURL string

	// AWSEndpointURL is a pointer because "unset" is meaningful: locally it is
	// Floci, and in a deployed environment it must be absent so the SDK resolves
	// the real endpoint itself.
	AWSEndpointURL *string
	AWSRegion      string

	MetricsIntervalSeconds float64
	// MetricsEnabled defaults TRUE: forgetting the variable in a deployed
	// environment must leave the dashboards populated, not silently empty.
	MetricsEnabled bool
	// E2ETestingEnabled defaults FALSE, the OPPOSITE direction and deliberately:
	// a runtime that never sets the variable must not serve the mass-delete
	// route at all.
	E2ETestingEnabled bool

	RedisHost string
	RedisPort int
	// CacheEnabled false means NO Redis client is constructed at all — see
	// internal/adapter/redis. The service then needs no reachable Redis to boot.
	CacheEnabled bool
	// CacheTimeoutMS is the budget for BOTH connect and socket. A connect that
	// takes longer than the operation is allowed to take has already blown it.
	CacheTimeoutMS int

	DeploymentEnvironment string
	// Environment is one of development, test, production. Any other value is a
	// startup error — unlike the optional flags, a typo here changes behaviour
	// silently (EchoSQL, and anything that branches on it later).
	Environment string
}

// EchoSQL reports whether to log SQL statements: everywhere except production.
func (c Config) EchoSQL() bool { return c.Environment != "production" }

const (
	defaultPort                   = 8000
	defaultUsersGRPCURL           = "users:50051"
	defaultAWSRegion              = "us-east-1"
	defaultMetricsIntervalSeconds = 15.0
	defaultRedisHost              = "localhost"
	defaultRedisPort              = 6379
	defaultCacheTimeoutMS         = 50
	defaultDeploymentEnvironment  = "local"
	defaultEnvironment            = "development"
)

var validEnvironments = map[string]bool{
	"development": true,
	"test":        true,
	"production":  true,
}

// Load reads the environment and validates it.
func Load() (Config, error) {
	cfg := Config{
		DatabaseWriterURL:      os.Getenv("DATABASE_WRITER_URL"),
		DatabaseReaderURL:      os.Getenv("DATABASE_READER_URL"),
		GRPCAPIKey:             os.Getenv("GRPC_API_KEY"),
		TrackingCarrierAPIKey:  os.Getenv("TRACKING_CARRIER_API_KEY"),
		Port:                   intInRange("PORT", defaultPort, 1, 65535),
		UsersGRPCURL:           stringOr("USERS_GRPC_URL", defaultUsersGRPCURL),
		EventsQueueURL:         os.Getenv("EVENTS_QUEUE_URL"),
		AWSEndpointURL:         optionalString("AWS_ENDPOINT_URL"),
		AWSRegion:              stringOr("AWS_REGION", defaultAWSRegion),
		MetricsIntervalSeconds: floatOr("METRICS_INTERVAL_SECONDS", defaultMetricsIntervalSeconds),
		MetricsEnabled:         Bool("METRICS_ENABLED", true),
		E2ETestingEnabled:      Bool("E2E_TESTING_ENABLED", false),
		RedisHost:              stringOr("REDIS_HOST", defaultRedisHost),
		RedisPort:              intInRange("REDIS_PORT", defaultRedisPort, 1, 65535),
		CacheEnabled:           Bool("CACHE_ENABLED", true),
		CacheTimeoutMS:         intInRange("CACHE_TIMEOUT_MS", defaultCacheTimeoutMS, 1, 1<<31-1),
		DeploymentEnvironment:  stringOr("DEPLOYMENT_ENVIRONMENT", defaultDeploymentEnvironment),
		Environment:            stringOr("ENVIRONMENT", defaultEnvironment),
	}

	required := []struct {
		name  string
		value string
	}{
		{"DATABASE_WRITER_URL", cfg.DatabaseWriterURL},
		{"DATABASE_READER_URL", cfg.DatabaseReaderURL},
		{"GRPC_API_KEY", cfg.GRPCAPIKey},
		{"TRACKING_CARRIER_API_KEY", cfg.TrackingCarrierAPIKey},
	}
	for _, r := range required {
		if r.value == "" {
			return Config{}, fmt.Errorf("config: %s is required and must not be empty", r.name)
		}
	}

	if !validEnvironments[cfg.Environment] {
		return Config{}, fmt.Errorf(
			"config: ENVIRONMENT=%q is not one of development, test, production", cfg.Environment)
	}

	return cfg, nil
}

// Bool reads a flag from the environment, falling back to fallback when the
// variable is absent, empty, or unrecognized.
//
// Exported because two call sites need a flag BEFORE a full Config exists: the
// route-mounting decision reads E2E_TESTING_ENABLED while the app is being
// constructed, and a failed Load must not be able to change whether a route is
// served.
//
// Accepted spellings, case-insensitively: true/1/yes/on and false/0/no/off.
// Nothing more — a flag that switches on for many spellings is one a caller
// enables by accident.
func Bool(name string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "true", "1", "yes", "on":
		return true
	case "false", "0", "no", "off":
		return false
	default:
		return fallback
	}
}

func stringOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func optionalString(name string) *string {
	v := os.Getenv(name)
	if v == "" {
		return nil
	}
	return &v
}

func intInRange(name string, fallback, min, max int) int {
	v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil || v < min || v > max {
		return fallback
	}
	return v
}

func floatOr(name string, fallback float64) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv(name)), 64)
	if err != nil {
		return fallback
	}
	return v
}
```

`services/tracking-go/internal/platform/config/dsn.go`:
```go
package config

import (
	"fmt"
	"net/url"
	"strings"
)

// MySQLDSN converts a SQLAlchemy DSN into a go-sql-driver/mysql DSN.
//
//	mysql+pymysql://user:pass@host:3306/tracking
//	  ->  user:pass@tcp(host:3306)/tracking?parseTime=true&loc=UTC
//
// The env files are generated (never hand-edited) and are shared with the Python
// service during the migration, so the SQLAlchemy spelling is what arrives and
// converting here is cheaper than forking the generator.
//
// parseTime=true and loc=UTC are ALWAYS appended, and both are load-bearing:
// without parseTime every DATETIME column comes back as []byte, and without
// loc=UTC the driver reads stored values in the process's local zone — which
// makes every timestamp wrong by the offset, silently, and only outside UTC.
func MySQLDSN(sqlAlchemyDSN string) (string, error) {
	if strings.TrimSpace(sqlAlchemyDSN) == "" {
		return "", fmt.Errorf("config: empty database DSN")
	}

	// Collapse the SQLAlchemy dialect+driver form to a plain scheme so net/url
	// parses it; "mysql+pymysql" is not a valid URL scheme character sequence
	// for every parser and carries no information we need.
	normalized := sqlAlchemyDSN
	if i := strings.Index(normalized, "://"); i >= 0 {
		normalized = "mysql" + normalized[i:]
	}

	u, err := url.Parse(normalized)
	if err != nil {
		return "", fmt.Errorf("config: unparseable database DSN: %w", err)
	}

	database := strings.TrimPrefix(u.Path, "/")
	if database == "" {
		return "", fmt.Errorf("config: database DSN names no database")
	}

	host := u.Hostname()
	if host == "" {
		return "", fmt.Errorf("config: database DSN names no host")
	}
	port := u.Port()
	if port == "" {
		port = "3306"
	}

	// url.Userinfo decodes percent-escapes, which is what makes a password
	// containing @ or / survive the round trip.
	var credentials string
	if u.User != nil {
		credentials = u.User.Username()
		if password, ok := u.User.Password(); ok {
			credentials += ":" + password
		}
	}

	query := u.Query()
	query.Set("parseTime", "true")
	query.Set("loc", "UTC")
	// Encode() sorts keys, which would put loc and parseTime in an arbitrary
	// place among any pre-existing params. Build the tail by hand so ours are
	// always last and the output is stable enough to assert on.
	existing := u.RawQuery
	tail := "parseTime=true&loc=UTC"
	if existing != "" {
		tail = existing + "&" + tail
	}

	return fmt.Sprintf("%s@tcp(%s:%s)/%s?%s", credentials, host, port, database, tail), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && gofmt -s -w ./internal/platform/config && go test ./internal/platform/config/... -v
```

Expected: all subtests `--- PASS`, ending in `ok  github.com/jemartinez/3mrai/services/tracking-go/internal/platform/config`.

- [ ] **Step 5: Commit**

```
feat(tracking): environment config and SQLAlchemy-to-go DSN converter
```

---

### Task 9: Structured JSON logging with `log/slog`

**Files:**
- Create: `services/tracking-go/internal/platform/logging/handler.go`
- Create: `services/tracking-go/internal/platform/logging/logger.go`
- Test: `services/tracking-go/internal/platform/logging/handler_test.go`

**Interfaces:**
- Consumes: nothing from this module. Takes `serviceName` and `deploymentEnvironment` as constructor strings so it can be built before `config.Load()` and cannot import a cycle.
- Produces:
  ```go
  func NewHandler(w io.Writer, serviceName, deploymentEnvironment string, level slog.Leveler) slog.Handler
  func New(w io.Writer, serviceName, deploymentEnvironment string) *slog.Logger
  ```

**The exact JSON line shape.** Fields in this order, then the context/attribute fields, then `exception`/`stack` only when present:

```json
{"severity_text":"INFO","severity_number":9,"timestamp":"2026-08-27T12:34:56.789Z","service_name":"tracking","deployment_environment":"local","message":"tracking created","order_id":"ord_123"}
```

- `severity_text` ∈ `DEBUG` / `INFO` / **`WARN`** / `ERROR` / **`FATAL`**. Not `WARNING`, not `CRITICAL`. Both spellings reaching the backend at once (Python emitting `WARNING` beside Orders' `WARN`) made every dashboard filter silently return half the matches — which is worse than no filter, because it looks like it worked.
- `severity_number`: `5` / `9` / `13` / `17` / `21`, fallback `0` for any level with no mapping.
- `timestamp`: UTC, ISO-8601, **millisecond** precision, `Z` suffix. Go: `t.UTC().Format("2006-01-02T15:04:05.000") + "Z"`. Not `time.RFC3339Nano` — that gives variable precision and `+00:00`.
- `service_name` is the literal `tracking`. `deployment_environment` comes from `DEPLOYMENT_ENVIRONMENT`, default `local`.
- **Nil and empty values are dropped entirely** — omitted, never `null`, never `""`. An emitted `user_id: null` reads as "resolved, and it was null" rather than "not known at this point in the request".
- **Non-serializable values are stringified, never dropped.** Losing a field silently is how a diagnostic disappears exactly when it is needed.

`slog.JSONHandler` cannot produce this: it emits `time`/`level`/`msg` with fixed names and it renders zero values rather than dropping them. Write the handler.

- [ ] **Step 1: Write the failing test**

`services/tracking-go/internal/platform/logging/handler_test.go`:
```go
package logging_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// decode returns the single JSON object written to buf.
func decode(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	line := strings.TrimSpace(buf.String())
	if line == "" {
		t.Fatal("nothing was logged")
	}
	if strings.Count(line, "\n") != 0 {
		t.Fatalf("expected exactly one line, got:\n%s", line)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(line), &got); err != nil {
		t.Fatalf("log line is not valid JSON (%v): %s", err, line)
	}
	return got
}

func TestBaseFieldShape(t *testing.T) {
	var buf bytes.Buffer
	log := logging.New(&buf, "tracking", "local")

	log.Info("tracking created", slog.String("order_id", "ord_123"))

	got := decode(t, &buf)
	if got["severity_text"] != "INFO" {
		t.Errorf("severity_text = %v, want INFO", got["severity_text"])
	}
	if got["severity_number"] != float64(9) {
		t.Errorf("severity_number = %v, want 9", got["severity_number"])
	}
	if got["service_name"] != "tracking" {
		t.Errorf("service_name = %v, want tracking", got["service_name"])
	}
	if got["deployment_environment"] != "local" {
		t.Errorf("deployment_environment = %v, want local", got["deployment_environment"])
	}
	if got["message"] != "tracking created" {
		t.Errorf("message = %v, want 'tracking created'", got["message"])
	}
	if got["order_id"] != "ord_123" {
		t.Errorf("order_id = %v, want ord_123", got["order_id"])
	}
}

// The base fields appear in a fixed order, ahead of the context fields. The
// order is part of the shape the other three services emit.
func TestBaseFieldOrder(t *testing.T) {
	var buf bytes.Buffer
	log := logging.New(&buf, "tracking", "local")

	log.Info("hello", slog.String("order_id", "ord_1"))

	line := strings.TrimSpace(buf.String())
	want := []string{
		`"severity_text"`,
		`"severity_number"`,
		`"timestamp"`,
		`"service_name"`,
		`"deployment_environment"`,
		`"message"`,
		`"order_id"`,
	}
	previous := -1
	for _, key := range want {
		at := strings.Index(line, key)
		if at < 0 {
			t.Fatalf("key %s missing from: %s", key, line)
		}
		if at < previous {
			t.Errorf("key %s appears out of order in: %s", key, line)
		}
		previous = at
	}
}

// WARN not WARNING, FATAL not CRITICAL. Both spellings in one backend made
// dashboard filters return half the matches.
func TestSeverityNames(t *testing.T) {
	tests := []struct {
		level      slog.Level
		wantText   string
		wantNumber float64
	}{
		{slog.LevelDebug, "DEBUG", 5},
		{slog.LevelInfo, "INFO", 9},
		{slog.LevelWarn, "WARN", 13},
		{slog.LevelError, "ERROR", 17},
		{logging.LevelFatal, "FATAL", 21},
	}
	for _, tt := range tests {
		t.Run(tt.wantText, func(t *testing.T) {
			var buf bytes.Buffer
			h := logging.NewHandler(&buf, "tracking", "local", slog.LevelDebug)
			slog.New(h).Log(context.Background(), tt.level, "m")

			got := decode(t, &buf)
			if got["severity_text"] != tt.wantText {
				t.Errorf("severity_text = %v, want %v", got["severity_text"], tt.wantText)
			}
			if got["severity_number"] != tt.wantNumber {
				t.Errorf("severity_number = %v, want %v", got["severity_number"], tt.wantNumber)
			}
		})
	}
}

func TestUnknownLevelFallsBackToZero(t *testing.T) {
	var buf bytes.Buffer
	h := logging.NewHandler(&buf, "tracking", "local", slog.Level(-100))
	slog.New(h).Log(context.Background(), slog.Level(-99), "custom")

	got := decode(t, &buf)
	if got["severity_number"] != float64(0) {
		t.Errorf("severity_number = %v, want 0 for an unmapped level", got["severity_number"])
	}
}

// UTC, millisecond precision, Z suffix. Not RFC3339Nano (variable precision,
// +00:00 offset).
func TestTimestampFormat(t *testing.T) {
	var buf bytes.Buffer
	logging.New(&buf, "tracking", "local").Info("m")

	got := decode(t, &buf)
	ts, ok := got["timestamp"].(string)
	if !ok {
		t.Fatalf("timestamp is not a string: %v", got["timestamp"])
	}
	if !strings.HasSuffix(ts, "Z") {
		t.Errorf("timestamp %q does not end in Z", ts)
	}
	// 2026-08-27T12:34:56.789Z is exactly 24 characters.
	if len(ts) != 24 {
		t.Errorf("timestamp %q has length %d, want 24 (millisecond precision)", ts, len(ts))
	}
	if ts[19] != '.' {
		t.Errorf("timestamp %q has no millisecond separator at index 19", ts)
	}
}

// Nil and empty values are DROPPED. Never null, never "".
func TestEmptyAndNilValuesAreDropped(t *testing.T) {
	var buf bytes.Buffer
	log := logging.New(&buf, "tracking", "local")

	log.Info("m",
		slog.String("user_id", ""),
		slog.Any("order_id", nil),
		slog.String("tracking_id", "trk_kept"),
	)

	got := decode(t, &buf)
	if _, present := got["user_id"]; present {
		t.Errorf(`empty user_id was emitted as %v; it must be omitted entirely`, got["user_id"])
	}
	if _, present := got["order_id"]; present {
		t.Errorf(`nil order_id was emitted as %v; it must be omitted entirely`, got["order_id"])
	}
	if got["tracking_id"] != "trk_kept" {
		t.Errorf("tracking_id = %v, want trk_kept", got["tracking_id"])
	}
}

// A zero NUMBER is not an empty value: 0 is a real count and must survive.
func TestZeroNumbersSurvive(t *testing.T) {
	var buf bytes.Buffer
	logging.New(&buf, "tracking", "local").Info("m",
		slog.Int("http_response_status_code", 0),
		slog.Float64("duration_ms", 0),
		slog.Bool("cache_enabled", false),
	)

	got := decode(t, &buf)
	for _, key := range []string{"http_response_status_code", "duration_ms", "cache_enabled"} {
		if _, present := got[key]; !present {
			t.Errorf("%s was dropped; only nil and empty STRINGS are dropped", key)
		}
	}
}

// A value JSON cannot encode is stringified, never dropped: losing a field
// silently is how a diagnostic disappears exactly when it is needed.
func TestNonSerializableValuesAreStringified(t *testing.T) {
	var buf bytes.Buffer
	logging.New(&buf, "tracking", "local").Info("m",
		slog.Any("weird", make(chan int)),
	)

	got := decode(t, &buf)
	value, present := got["weird"]
	if !present {
		t.Fatal("a non-serializable value was dropped; it must be stringified")
	}
	if _, isString := value.(string); !isString {
		t.Errorf("weird = %#v, want a string rendering", value)
	}
}

// exception and stack appear only when present.
func TestExceptionAndStackOnlyWhenPresent(t *testing.T) {
	var buf bytes.Buffer
	logging.New(&buf, "tracking", "local").Info("clean")
	got := decode(t, &buf)
	if _, present := got["exception"]; present {
		t.Error("exception present on a line with no error")
	}
	if _, present := got["stack"]; present {
		t.Error("stack present on a line with no error")
	}

	buf.Reset()
	logging.New(&buf, "tracking", "local").Error("failed",
		slog.String("exception", "boom: connection refused"))
	got = decode(t, &buf)
	if got["exception"] != "boom: connection refused" {
		t.Errorf("exception = %v, want the message", got["exception"])
	}
}

// WithAttrs and WithGroup must not lose the base fields — slog calls them for
// every logger built with log.With(...).
func TestWithAttrsCarriesFields(t *testing.T) {
	var buf bytes.Buffer
	log := logging.New(&buf, "tracking", "local").With(slog.String("order_id", "ord_9"))

	log.Info("m", slog.String("tracking_id", "trk_1"))

	got := decode(t, &buf)
	if got["order_id"] != "ord_9" {
		t.Errorf("order_id from With() = %v, want ord_9", got["order_id"])
	}
	if got["tracking_id"] != "trk_1" {
		t.Errorf("tracking_id = %v, want trk_1", got["tracking_id"])
	}
	if got["service_name"] != "tracking" {
		t.Error("With() lost the base fields")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && go test ./internal/platform/logging/...
```

Expected: `no required module provides package .../internal/platform/logging`.

- [ ] **Step 3: Write minimal implementation**

`services/tracking-go/internal/platform/logging/handler.go`:
```go
// Package logging renders every log line as one JSON object with a field schema
// shared across all four 3MRAI services, so a single dashboard query spans them.
//
// slog.JSONHandler cannot produce this shape: it emits time/level/msg under
// fixed names and renders zero values rather than dropping them. The rules that
// forced a hand-written handler:
//
//   - severity_text is the OTel name (WARN, FATAL), never Go's or Python's
//     (WARNING, CRITICAL). Both spellings reaching the backend at once made
//     every dashboard filter silently return half the matches.
//   - nil and empty-string values are DROPPED, never emitted as null or "". An
//     emitted null reads as "resolved, and it was null" rather than "not known
//     at this point in the request".
//   - a value JSON cannot encode is STRINGIFIED, never dropped: losing a field
//     silently is how a diagnostic disappears exactly when it is needed.
package logging

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"sync"
	"time"
)

// LevelFatal is one step above slog.LevelError, mapping to OTel's FATAL/21.
// slog has no fatal level of its own.
const LevelFatal = slog.Level(12)

// OTel severity numbers from the logs data model. Explicit rather than derived
// from the level's integer value, so the mapping is auditable against the spec.
var severityNumbers = map[slog.Level]int{
	slog.LevelDebug: 5,
	slog.LevelInfo:  9,
	slog.LevelWarn:  13,
	slog.LevelError: 17,
	LevelFatal:      21,
}

var severityTexts = map[slog.Level]string{
	slog.LevelDebug: "DEBUG",
	slog.LevelInfo:  "INFO",
	slog.LevelWarn:  "WARN",
	slog.LevelError: "ERROR",
	LevelFatal:      "FATAL",
}

// timestampLayout is UTC ISO-8601 at MILLISECOND precision; the handler appends
// the literal Z. RFC3339Nano is wrong here twice over: variable precision, and
// a +00:00 offset where the other services emit Z.
const timestampLayout = "2006-01-02T15:04:05.000"

// Handler renders records as single-line JSON.
type Handler struct {
	mu                    *sync.Mutex
	w                     io.Writer
	level                 slog.Leveler
	serviceName           string
	deploymentEnvironment string
	// attrs accumulated by WithAttrs, already flattened to key/value pairs.
	attrs []slog.Attr
	// groups accumulated by WithGroup; joined with "." into the emitted key.
	groups []string
}

// NewHandler builds a handler writing to w.
func NewHandler(w io.Writer, serviceName, deploymentEnvironment string, level slog.Leveler) slog.Handler {
	if level == nil {
		level = slog.LevelInfo
	}
	return &Handler{
		mu:                    &sync.Mutex{},
		w:                     w,
		level:                 level,
		serviceName:           serviceName,
		deploymentEnvironment: deploymentEnvironment,
	}
}

// New builds a *slog.Logger at INFO over NewHandler.
func New(w io.Writer, serviceName, deploymentEnvironment string) *slog.Logger {
	return slog.New(NewHandler(w, serviceName, deploymentEnvironment, slog.LevelInfo))
}

func (h *Handler) Enabled(_ context.Context, level slog.Level) bool {
	return level >= h.level.Level()
}

func (h *Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return h
	}
	clone := *h
	clone.attrs = make([]slog.Attr, 0, len(h.attrs)+len(attrs))
	clone.attrs = append(clone.attrs, h.attrs...)
	for _, a := range attrs {
		clone.attrs = append(clone.attrs, qualify(h.groups, a))
	}
	return &clone
}

func (h *Handler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	clone := *h
	clone.groups = append(append([]string{}, h.groups...), name)
	return &clone
}

// Handle writes one JSON object. The base fields come first, in a fixed order,
// then everything the call site (and WithAttrs) contributed.
func (h *Handler) Handle(_ context.Context, r slog.Record) error {
	// A hand-built buffer rather than a map: encoding/json sorts map keys, and
	// the base-field ORDER is part of the shape the other services emit.
	buf := make([]byte, 0, 512)
	buf = append(buf, '{')

	buf = appendString(buf, "severity_text", severityText(r.Level), true)
	buf = append(buf, ',')
	buf = append(buf, `"severity_number":`...)
	buf = strconv.AppendInt(buf, int64(severityNumbers[r.Level]), 10)

	when := r.Time
	if when.IsZero() {
		when = time.Now()
	}
	buf = append(buf, ',')
	buf = appendString(buf, "timestamp", when.UTC().Format(timestampLayout)+"Z", true)
	buf = append(buf, ',')
	buf = appendString(buf, "service_name", h.serviceName, true)
	buf = append(buf, ',')
	buf = appendString(buf, "deployment_environment", h.deploymentEnvironment, true)
	buf = append(buf, ',')
	buf = appendString(buf, "message", r.Message, true)

	seen := map[string]bool{
		"severity_text": true, "severity_number": true, "timestamp": true,
		"service_name": true, "deployment_environment": true, "message": true,
	}

	for _, a := range h.attrs {
		buf = h.appendAttr(buf, a, seen)
	}
	r.Attrs(func(a slog.Attr) bool {
		buf = h.appendAttr(buf, qualify(h.groups, a), seen)
		return true
	})

	buf = append(buf, '}', '\n')

	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := h.w.Write(buf)
	return err
}

// appendAttr writes one field, applying the two rules that make this handler
// exist: drop nil and empty strings, stringify anything JSON cannot encode.
func (h *Handler) appendAttr(buf []byte, a slog.Attr, seen map[string]bool) []byte {
	a.Value = a.Value.Resolve()
	if a.Key == "" || seen[a.Key] {
		return buf
	}

	// A group flattens into dotted keys rather than a nested object: the schema
	// downstream is flat, and a nested object would not be queryable as a field.
	if a.Value.Kind() == slog.KindGroup {
		for _, member := range a.Value.Group() {
			buf = h.appendAttr(buf, slog.Attr{Key: a.Key + "." + member.Key, Value: member.Value}, seen)
		}
		return buf
	}

	raw := a.Value.Any()
	// Omitted, never null; omitted, never "".
	if raw == nil {
		return buf
	}
	if a.Value.Kind() == slog.KindString && a.Value.String() == "" {
		return buf
	}

	encoded, err := json.Marshal(raw)
	if err != nil {
		// Stringified, never dropped.
		encoded, err = json.Marshal(fmt.Sprintf("%v", raw))
		if err != nil {
			return buf
		}
	}

	seen[a.Key] = true
	buf = append(buf, ',')
	buf = appendKey(buf, a.Key)
	return append(buf, encoded...)
}

func severityText(level slog.Level) string {
	if text, ok := severityTexts[level]; ok {
		return text
	}
	return level.String()
}

func qualify(groups []string, a slog.Attr) slog.Attr {
	for i := len(groups) - 1; i >= 0; i-- {
		a = slog.Attr{Key: groups[i] + "." + a.Key, Value: a.Value}
	}
	return a
}

func appendKey(buf []byte, key string) []byte {
	encoded, err := json.Marshal(key)
	if err != nil {
		return append(buf, `"?":`...)
	}
	buf = append(buf, encoded...)
	return append(buf, ':')
}

func appendString(buf []byte, key, value string, _ bool) []byte {
	buf = appendKey(buf, key)
	encoded, err := json.Marshal(value)
	if err != nil {
		return append(buf, `""`...)
	}
	return append(buf, encoded...)
}
```

`services/tracking-go/internal/platform/logging/logger.go`:
```go
package logging

import (
	"log/slog"
	"os"
)

// ServiceName is this service's service_name on every log line, and the value
// of OTEL_SERVICE_NAME in the Dockerfile. One spelling, one place.
const ServiceName = "tracking"

// Install points the default slog logger at stdout with our JSON shape, so a
// package that reaches for slog.Info without a logger still emits the schema.
//
// deploymentEnvironment comes from DEPLOYMENT_ENVIRONMENT (default "local"); it
// is passed in rather than read here so this package stays free of config.
func Install(deploymentEnvironment string) *slog.Logger {
	log := New(os.Stdout, ServiceName, deploymentEnvironment)
	slog.SetDefault(log)
	return log
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && gofmt -s -w ./internal/platform/logging && go test ./internal/platform/logging/... -v
```

Expected: every subtest `--- PASS`, ending `ok  .../internal/platform/logging`.

- [ ] **Step 5: Commit**

```
feat(tracking): slog JSON handler with the shared cross-service field schema
```

---

### Task 10: Request context propagation, request ID, and the `request completed` line

**Files:**
- Create: `services/tracking-go/internal/platform/logging/context.go`
- Create: `services/tracking-go/internal/platform/logging/context_handler.go`
- Create: `services/tracking-go/internal/platform/logging/requestid.go`
- Create: `services/tracking-go/internal/adapter/http/logcontext_middleware.go`
- Test: `services/tracking-go/internal/platform/logging/context_test.go`
- Test: `services/tracking-go/internal/platform/logging/requestid_test.go`
- Test: `services/tracking-go/internal/adapter/http/logcontext_middleware_test.go`

**Interfaces:**
- Consumes: `logging.NewHandler` (Task 9).
- Produces:
  ```go
  func WithLogFields(ctx context.Context, fields ...slog.Attr) context.Context
  func LogFields(ctx context.Context) []slog.Attr
  func NewContextHandler(inner slog.Handler) slog.Handler

  func GenerateRequestID() string
  func ResolveRequestID(headerValue string) string
  const RequestIDHeader = "x-request-id"

  func LogContextMiddleware(log *slog.Logger) gin.HandlerFunc
  ```

**Context propagation.** Go's `context.Context` replaces Python's `contextvars`. It carries **exactly these seven keys and no others**:

`cognito_sub`, `user_id`, `order_id`, `tracking_id`, `email_hash`, `request_id`, `cache_result`

A fixed set, not a free map: the shared context is a convention (identical field names across all four services, so one dashboard query spans them), not a scratchpad. A typo'd key would otherwise become a new indexed field nobody queries.

**Both `nil` and `""` are dropped** at merge time, so a caller merging an unresolved identity costs nothing and adds no field.

`WithLogFields` **merges and returns a new context** — it never mutates the map in place. A mutated map would leak the change into every context that copied the same reference, which is the Go analogue of the `contextvars` trap the Python module documents.

**An explicit field at the call site WINS over the ambient context.** A handler logging about a different order than the request's own is being specific on purpose; overwriting that with the request's `order_id` would make the log lie.

**Request ID.** Header `x-request-id`, format `req_` + exactly 24 characters of the nano alphabet (`A-Za-z0-9`). **Trust rule:** honour an inbound id ONLY if it **fullmatches** that pattern; otherwise silently mint a fresh one. Never a 400 — a correlation header is a convenience, never a contract the caller must satisfy to be served, and failing an otherwise valid request would turn an observability aid into an outage. The value is copied onto every log line of the flow and forwarded downstream, which is exactly why an unvalidated one contaminates a whole flow's records at once rather than one field.

**The request log line** is the ONE line in this service with no `app_event`. Its message is literally `request completed`, with fields `http_request_method`, `http_route`, `http_response_status_code`, `duration_ms`.

- `http_route` is the matched **template** (`/v1/trackings/:order_id`), never the concrete URL. Logging the raw path makes every order id its own "route" and blows up dashboard cardinality — the field stops being groupable, which is the only reason it exists. In Gin this is `c.FullPath()`, empty when nothing matched; fall back to the raw path there, since those requests hit no route at all and the cardinality risk is bounded.
- **INFO for every status**, including 4xx and 5xx. The status code carries the outcome; raising the severity would double-encode it and make an error rate computed from `severity_text` disagree with one computed from `http_response_status_code`.
- **Health-check exemption applies ONLY to successes:** skip when route is `/v1/health` AND status is 2xx. Measured: 353 of 368 lines in an hour were healthy probes — 96% of the stream against 2 lines describing real work. A *failing* probe carries the status and latency that explain why, so it is logged like any other request. Scoping by status rather than by a route list is what keeps this a rule ("successful probes are not events") rather than an allowlist to maintain.

- [ ] **Step 1: Write the failing test**

`services/tracking-go/internal/platform/logging/requestid_test.go`:
```go
package logging_test

import (
	"regexp"
	"strings"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

var idShape = regexp.MustCompile(`^req_[A-Za-z0-9]{24}$`)

func TestGenerateRequestIDShape(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		id := logging.GenerateRequestID()
		if !idShape.MatchString(id) {
			t.Fatalf("GenerateRequestID() = %q, want req_ + 24 nano chars", id)
		}
		if seen[id] {
			t.Fatalf("GenerateRequestID() produced a duplicate: %q", id)
		}
		seen[id] = true
	}
}

// An inbound id is honoured only when it FULLMATCHES our shape.
func TestResolveRequestIDHonoursOurOwnFormat(t *testing.T) {
	inbound := "req_7gK3mP1vXz9wLq2bN8rRt4Yc"
	if got := logging.ResolveRequestID(inbound); got != inbound {
		t.Errorf("ResolveRequestID(%q) = %q, want the inbound id honoured", inbound, got)
	}
}

// Anything else is silently replaced with a fresh id — never a 400, and never
// the caller's value.
func TestResolveRequestIDMintsAFreshOneForAnythingElse(t *testing.T) {
	bad := []struct {
		name  string
		value string
	}{
		{"absent", ""},
		{"no prefix", "7gK3mP1vXz9wLq2bN8rRt4Yc"},
		{"wrong prefix", "trk_7gK3mP1vXz9wLq2bN8rRt4Yc"},
		{"too short", "req_7gK3mP1vXz9wLq2bN8rRt4"},
		{"too long", "req_7gK3mP1vXz9wLq2bN8rRt4Ycc"},
		{"illegal character", "req_7gK3mP1vXz9wLq2bN8rRt4Y-"},
		{"newline injection", "req_7gK3mP1vXz9wLq2bN8rRt4Yc\nfake"},
		{"prefix match only", "req_7gK3mP1vXz9wLq2bN8rRt4Yc trailing"},
		{"whitespace", "   "},
		{"control characters", "req_\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17"},
	}
	for _, tt := range bad {
		t.Run(tt.name, func(t *testing.T) {
			got := logging.ResolveRequestID(tt.value)
			if got == tt.value {
				t.Fatalf("ResolveRequestID(%q) echoed the untrusted value back", tt.value)
			}
			if !idShape.MatchString(got) {
				t.Fatalf("ResolveRequestID(%q) = %q, want a freshly minted id", tt.value, got)
			}
			if strings.ContainsAny(got, "\n\r") {
				t.Fatal("a minted id must never contain a newline")
			}
		})
	}
}
```

`services/tracking-go/internal/platform/logging/context_test.go`:
```go
package logging_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

func contextLogger(buf *bytes.Buffer) *slog.Logger {
	return slog.New(logging.NewContextHandler(
		logging.NewHandler(buf, "tracking", "local", slog.LevelDebug)))
}

func TestWithLogFieldsEmitsTheAmbientContext(t *testing.T) {
	var buf bytes.Buffer
	log := contextLogger(&buf)

	ctx := logging.WithLogFields(context.Background(),
		slog.String("cognito_sub", "sub-abc"),
		slog.String("request_id", "req_7gK3mP1vXz9wLq2bN8rRt4Yc"),
	)
	log.InfoContext(ctx, "m")

	var got map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &got); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if got["cognito_sub"] != "sub-abc" {
		t.Errorf("cognito_sub = %v, want sub-abc", got["cognito_sub"])
	}
	if got["request_id"] != "req_7gK3mP1vXz9wLq2bN8rRt4Yc" {
		t.Errorf("request_id = %v", got["request_id"])
	}
}

// Exactly seven keys, and no others. A typo'd key must not become a field.
func TestOnlyTheSevenAllowedKeysSurvive(t *testing.T) {
	var buf bytes.Buffer
	log := contextLogger(&buf)

	ctx := logging.WithLogFields(context.Background(),
		slog.String("cognito_sub", "s"),
		slog.String("user_id", "usr_1"),
		slog.String("order_id", "ord_1"),
		slog.String("tracking_id", "trk_1"),
		slog.String("email_hash", "abcdef0123456789"),
		slog.String("request_id", "req_7gK3mP1vXz9wLq2bN8rRt4Yc"),
		slog.String("cache_result", "hit"),
		// Not on the list: dropped.
		slog.String("congito_sub", "typo"),
		slog.String("shipping_address", "1 Main St"),
		slog.String("email", "a@b.com"),
	)
	log.InfoContext(ctx, "m")

	var got map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &got); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	for _, key := range []string{
		"cognito_sub", "user_id", "order_id", "tracking_id",
		"email_hash", "request_id", "cache_result",
	} {
		if _, present := got[key]; !present {
			t.Errorf("allowed key %s was dropped", key)
		}
	}
	for _, key := range []string{"congito_sub", "shipping_address", "email"} {
		if _, present := got[key]; present {
			t.Errorf("key %s is not on the allowed list but was emitted", key)
		}
	}
}

// Both nil and "" are dropped at merge time.
func TestEmptyContextValuesAreDropped(t *testing.T) {
	var buf bytes.Buffer
	log := contextLogger(&buf)

	ctx := logging.WithLogFields(context.Background(),
		slog.String("user_id", ""),
		slog.Any("order_id", nil),
		slog.String("tracking_id", "trk_1"),
	)
	log.InfoContext(ctx, "m")

	var got map[string]any
	_ = json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &got)
	if _, present := got["user_id"]; present {
		t.Error("empty user_id must be dropped")
	}
	if _, present := got["order_id"]; present {
		t.Error("nil order_id must be dropped")
	}
	if got["tracking_id"] != "trk_1" {
		t.Error("tracking_id was lost")
	}
}

// Merging returns a NEW context; the parent is unchanged.
func TestWithLogFieldsMergesWithoutMutatingTheParent(t *testing.T) {
	parent := logging.WithLogFields(context.Background(), slog.String("cognito_sub", "s"))
	child := logging.WithLogFields(parent, slog.String("user_id", "usr_1"))

	if len(logging.LogFields(parent)) != 1 {
		t.Errorf("parent gained a field: %v", logging.LogFields(parent))
	}
	if len(logging.LogFields(child)) != 2 {
		t.Errorf("child = %v, want both fields", logging.LogFields(child))
	}
}

// Later merges override earlier ones for the same key — that is how the
// late-resolved usr_ id reaches every line after the gRPC call.
func TestLaterMergeOverridesEarlier(t *testing.T) {
	ctx := logging.WithLogFields(context.Background(), slog.String("user_id", "usr_old"))
	ctx = logging.WithLogFields(ctx, slog.String("user_id", "usr_new"))

	for _, a := range logging.LogFields(ctx) {
		if a.Key == "user_id" && a.Value.String() != "usr_new" {
			t.Errorf("user_id = %q, want usr_new", a.Value.String())
		}
	}
}

// An explicit field at the CALL SITE wins over the ambient context: a handler
// logging about a different order is being specific on purpose.
func TestCallSiteAttributeWinsOverContext(t *testing.T) {
	var buf bytes.Buffer
	log := contextLogger(&buf)

	ctx := logging.WithLogFields(context.Background(), slog.String("order_id", "ord_ambient"))
	log.InfoContext(ctx, "m", slog.String("order_id", "ord_explicit"))

	var got map[string]any
	_ = json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &got)
	if got["order_id"] != "ord_explicit" {
		t.Errorf("order_id = %v, want the call-site value ord_explicit", got["order_id"])
	}
}

func TestNoContextFieldsIsNotAnError(t *testing.T) {
	var buf bytes.Buffer
	contextLogger(&buf).InfoContext(context.Background(), "m")

	var got map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &got); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if got["message"] != "m" {
		t.Errorf("message = %v", got["message"])
	}
}
```

`services/tracking-go/internal/adapter/http/logcontext_middleware_test.go`:
```go
package http_test

import (
	"bytes"
	"encoding/json"
	"log/slog"
	nethttp "net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

var reqIDShape = regexp.MustCompile(`^req_[A-Za-z0-9]{24}$`)

// lines returns every JSON object written to buf.
func lines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, raw := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if raw == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(raw), &m); err != nil {
			t.Fatalf("bad JSON line %q: %v", raw, err)
		}
		out = append(out, m)
	}
	return out
}

// findRequestLine returns the one line whose message is "request completed".
func findRequestLine(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	for _, m := range lines(t, buf) {
		if m["message"] == "request completed" {
			return m
		}
	}
	t.Fatalf("no 'request completed' line in:\n%s", buf.String())
	return nil
}

func newEngine(buf *bytes.Buffer) *gin.Engine {
	gin.SetMode(gin.TestMode)
	log := slog.New(logging.NewContextHandler(
		logging.NewHandler(buf, "tracking", "local", slog.LevelDebug)))

	r := gin.New()
	r.Use(adapterhttp.LogContextMiddleware(log))
	r.GET("/v1/health", func(c *gin.Context) { c.JSON(nethttp.StatusOK, gin.H{"status": "ok"}) })
	r.GET("/v1/trackings/:order_id", func(c *gin.Context) { c.JSON(nethttp.StatusOK, gin.H{}) })
	r.GET("/v1/boom", func(c *gin.Context) { c.JSON(nethttp.StatusInternalServerError, gin.H{}) })
	return r
}

func TestRequestLineShape(t *testing.T) {
	var buf bytes.Buffer
	r := newEngine(&buf)

	req := httptest.NewRequest(nethttp.MethodGet, "/v1/trackings/ord_abc123", nil)
	r.ServeHTTP(httptest.NewRecorder(), req)

	got := findRequestLine(t, &buf)
	if got["http_request_method"] != "GET" {
		t.Errorf("http_request_method = %v, want GET", got["http_request_method"])
	}
	// The matched TEMPLATE, never the concrete URL — cardinality.
	if got["http_route"] != "/v1/trackings/:order_id" {
		t.Errorf("http_route = %v, want the template /v1/trackings/:order_id", got["http_route"])
	}
	if got["http_response_status_code"] != float64(200) {
		t.Errorf("http_response_status_code = %v, want 200", got["http_response_status_code"])
	}
	if _, present := got["duration_ms"]; !present {
		t.Error("duration_ms missing")
	}
	// It is the ONE line with no app_event.
	if _, present := got["app_event"]; present {
		t.Errorf("the request line must carry no app_event, got %v", got["app_event"])
	}
}

// INFO for every status, 4xx and 5xx included. The status carries the outcome.
func TestRequestLineIsINFOForEveryStatus(t *testing.T) {
	for _, tt := range []struct {
		path       string
		wantStatus float64
	}{
		{"/v1/trackings/ord_1", 200},
		{"/v1/nowhere", 404},
		{"/v1/boom", 500},
	} {
		t.Run(tt.path, func(t *testing.T) {
			var buf bytes.Buffer
			r := newEngine(&buf)
			r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(nethttp.MethodGet, tt.path, nil))

			got := findRequestLine(t, &buf)
			if got["severity_text"] != "INFO" {
				t.Errorf("severity_text = %v, want INFO for status %v", got["severity_text"], tt.wantStatus)
			}
			if got["http_response_status_code"] != tt.wantStatus {
				t.Errorf("status = %v, want %v", got["http_response_status_code"], tt.wantStatus)
			}
		})
	}
}

// A SUCCEEDING health probe is not logged: 353 of 368 lines in an hour.
func TestHealthCheckSuccessIsNotLogged(t *testing.T) {
	var buf bytes.Buffer
	r := newEngine(&buf)
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(nethttp.MethodGet, "/v1/health", nil))

	for _, m := range lines(t, &buf) {
		if m["message"] == "request completed" {
			t.Fatalf("a successful /v1/health probe was logged: %v", m)
		}
	}
}

// A FAILING probe carries the status and latency that explain why, so it is
// logged like any other request. The exemption is scoped by STATUS, not route.
func TestFailingHealthCheckIsLogged(t *testing.T) {
	var buf bytes.Buffer
	gin.SetMode(gin.TestMode)
	log := slog.New(logging.NewContextHandler(
		logging.NewHandler(&buf, "tracking", "local", slog.LevelDebug)))

	r := gin.New()
	r.Use(adapterhttp.LogContextMiddleware(log))
	r.GET("/v1/health", func(c *gin.Context) {
		c.JSON(nethttp.StatusServiceUnavailable, gin.H{"status": "down"})
	})
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(nethttp.MethodGet, "/v1/health", nil))

	got := findRequestLine(t, &buf)
	if got["http_response_status_code"] != float64(503) {
		t.Errorf("a failing probe must be logged, got status %v", got["http_response_status_code"])
	}
}

// An inbound id of our own shape is honoured.
func TestInboundRequestIDIsHonoured(t *testing.T) {
	var buf bytes.Buffer
	r := newEngine(&buf)

	req := httptest.NewRequest(nethttp.MethodGet, "/v1/trackings/ord_1", nil)
	req.Header.Set("x-request-id", "req_7gK3mP1vXz9wLq2bN8rRt4Yc")
	r.ServeHTTP(httptest.NewRecorder(), req)

	got := findRequestLine(t, &buf)
	if got["request_id"] != "req_7gK3mP1vXz9wLq2bN8rRt4Yc" {
		t.Errorf("request_id = %v, want the inbound id", got["request_id"])
	}
}

// A malformed one is silently replaced — never a 400.
func TestMalformedInboundRequestIDIsReplacedNotRejected(t *testing.T) {
	var buf bytes.Buffer
	r := newEngine(&buf)

	req := httptest.NewRequest(nethttp.MethodGet, "/v1/trackings/ord_1", nil)
	req.Header.Set("x-request-id", "'; DROP TABLE tracking; --")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200: a malformed correlation header must never fail the request", rec.Code)
	}
	got := findRequestLine(t, &buf)
	id, _ := got["request_id"].(string)
	if !reqIDShape.MatchString(id) {
		t.Errorf("request_id = %q, want a freshly minted id", id)
	}
}

// The sub is seeded from x-user-id for LOGGING only — it authorizes nothing.
func TestCognitoSubIsSeededFromHeader(t *testing.T) {
	var buf bytes.Buffer
	r := newEngine(&buf)

	req := httptest.NewRequest(nethttp.MethodGet, "/v1/trackings/ord_1", nil)
	req.Header.Set("x-user-id", "sub-abc")
	r.ServeHTTP(httptest.NewRecorder(), req)

	got := findRequestLine(t, &buf)
	if got["cognito_sub"] != "sub-abc" {
		t.Errorf("cognito_sub = %v, want sub-abc", got["cognito_sub"])
	}
}

// An id is seeded even on requests that never reach a handler — those are
// disproportionately the ones someone asks about afterwards.
func TestRequestIDIsSeededOnA404(t *testing.T) {
	var buf bytes.Buffer
	r := newEngine(&buf)
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(nethttp.MethodGet, "/v1/nowhere", nil))

	got := findRequestLine(t, &buf)
	id, _ := got["request_id"].(string)
	if !reqIDShape.MatchString(id) {
		t.Errorf("request_id = %q on a 404, want a minted id", id)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && go test ./internal/platform/logging/... ./internal/adapter/http/...
```

Expected: `undefined: logging.WithLogFields`, `undefined: logging.ResolveRequestID`, `undefined: logging.NewContextHandler`, and `no required module provides package .../internal/adapter/http`.

- [ ] **Step 3: Write minimal implementation**

`services/tracking-go/internal/platform/logging/context.go`:
```go
package logging

import (
	"context"
	"log/slog"
)

// The seven keys the shared cross-service log context may carry. A FIXED set
// rather than a free map: the field names are a convention shared by all four
// services, so one dashboard query spans them. A typo'd key would otherwise
// silently become a new indexed field nobody ever queries.
const (
	KeyCognitoSub  = "cognito_sub"
	KeyUserID      = "user_id"
	KeyOrderID     = "order_id"
	KeyTrackingID  = "tracking_id"
	KeyEmailHash   = "email_hash"
	KeyRequestID   = "request_id"
	KeyCacheResult = "cache_result"
)

var allowedKeys = map[string]bool{
	KeyCognitoSub: true, KeyUserID: true, KeyOrderID: true, KeyTrackingID: true,
	KeyEmailHash: true, KeyRequestID: true, KeyCacheResult: true,
}

type logFieldsKey struct{}

// WithLogFields merges fields into ctx's log context and returns a NEW context.
//
// It never mutates in place. A mutated map would leak the change into every
// context that copied the same reference — the Go analogue of the contextvars
// trap the Python service documents, where a goroutine started earlier would
// observe a merge it was never meant to see.
//
// Unknown keys are dropped, as are nil values and empty strings. An emitted
// empty user_id reads as a resolved identity that happened to be blank, rather
// than "not known at this point in the request".
func WithLogFields(ctx context.Context, fields ...slog.Attr) context.Context {
	existing := LogFields(ctx)

	merged := make([]slog.Attr, 0, len(existing)+len(fields))
	overridden := map[string]bool{}
	for _, f := range fields {
		if keep(f) {
			overridden[f.Key] = true
		}
	}
	for _, e := range existing {
		if !overridden[e.Key] {
			merged = append(merged, e)
		}
	}
	for _, f := range fields {
		if keep(f) {
			merged = append(merged, f)
		}
	}
	if len(merged) == 0 {
		return ctx
	}
	return context.WithValue(ctx, logFieldsKey{}, merged)
}

// LogFields returns the active context's fields, or nil outside a request.
func LogFields(ctx context.Context) []slog.Attr {
	if ctx == nil {
		return nil
	}
	fields, _ := ctx.Value(logFieldsKey{}).([]slog.Attr)
	return fields
}

func keep(a slog.Attr) bool {
	if !allowedKeys[a.Key] {
		return false
	}
	v := a.Value.Resolve()
	if v.Any() == nil {
		return false
	}
	if v.Kind() == slog.KindString && v.String() == "" {
		return false
	}
	return true
}
```

`services/tracking-go/internal/platform/logging/context_handler.go`:
```go
package logging

import (
	"context"
	"log/slog"
)

// ContextHandler merges the ambient log context into every record before the
// inner handler renders it.
//
// Wrapping the handler rather than the logger is what makes the enrichment
// unconditional: a package that logs through the default slog logger, a library
// whose records reach the same handler, and a use case deep in the call stack
// all get the same fields with no logger threaded through their constructors.
type ContextHandler struct{ inner slog.Handler }

// NewContextHandler wraps inner so records carry the context's log fields.
func NewContextHandler(inner slog.Handler) slog.Handler { return &ContextHandler{inner: inner} }

func (h *ContextHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h *ContextHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &ContextHandler{inner: h.inner.WithAttrs(attrs)}
}

func (h *ContextHandler) WithGroup(name string) slog.Handler {
	return &ContextHandler{inner: h.inner.WithGroup(name)}
}

// Handle prepends the ambient fields, so a CALL-SITE attribute of the same name
// is written later and wins.
//
// The precedence is deliberate: a handler logging about a different order than
// the request's own is being specific on purpose, and silently overwriting that
// with the request's order_id would make the log lie. Our JSON handler keeps the
// FIRST occurrence of a key... so the ambient fields go into a fresh record
// AFTER the record's own, and the record's own are added first.
func (h *ContextHandler) Handle(ctx context.Context, r slog.Record) error {
	fields := LogFields(ctx)
	if len(fields) == 0 {
		return h.inner.Handle(ctx, r)
	}

	enriched := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	// Call-site attributes FIRST: the JSON handler keeps the first occurrence
	// of a key, so an explicit field beats the ambient one.
	r.Attrs(func(a slog.Attr) bool {
		enriched.AddAttrs(a)
		return true
	})
	enriched.AddAttrs(fields...)
	return h.inner.Handle(ctx, enriched)
}
```

`services/tracking-go/internal/platform/logging/requestid.go`:
```go
package logging

import (
	"crypto/rand"
	"regexp"
	"strings"
)

// RequestIDHeader carries the cross-service correlation id between services.
const RequestIDHeader = "x-request-id"

// The id is deliberately NOT a second trace_id: it carries no tracing semantics
// and needs no SDK, which is exactly why it exists — the runtimes at the ends of
// these flows (the events-pipeline Lambda, the realtime WebSocket handlers) have
// no OTel SDK at all, so trace_id is absent on precisely the hops where
// reconstructing a flow end to end matters most.
const (
	requestIDPrefix = "req_"
	requestIDLength = 24
	nanoAlphabet    = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
)

// requestIDPattern is anchored at both ends. The length is EXACT rather than a
// bound, because this pattern is the only thing standing between an untrusted
// header and every log line the request produces.
var requestIDPattern = regexp.MustCompile(`^req_[A-Za-z0-9]{24}$`)

// GenerateRequestID mints a fresh id, e.g. req_7gK3mP1vXz9wLq2bN8rRt4Yc.
func GenerateRequestID() string {
	buf := make([]byte, requestIDLength)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand does not fail on any supported platform; if it ever did,
		// a degraded id is still better than failing the request this id only
		// exists to describe.
		for i := range buf {
			buf[i] = byte(i)
		}
	}
	var sb strings.Builder
	sb.Grow(len(requestIDPrefix) + requestIDLength)
	sb.WriteString(requestIDPrefix)
	for _, b := range buf {
		sb.WriteByte(nanoAlphabet[int(b)%len(nanoAlphabet)])
	}
	return sb.String()
}

// ResolveRequestID returns the caller's id when it is one of ours, else a fresh
// one.
//
// WHY VALIDATE. x-request-id is attacker-controlled input on any public
// endpoint, and by design its value is copied onto EVERY log line of the
// resulting flow and forwarded downstream over gRPC and SQS. So an unbounded
// string, a control character or an injected newline does not contaminate one
// field on one line — it contaminates a whole flow's records at once, in a field
// that log queries, dashboards and alerting rules all assume is well-formed.
//
// WHY DISCARD SILENTLY RATHER THAN ANSWER 400. A correlation header is a
// convenience, never a contract the caller must satisfy to be served. The
// senders of a malformed value are misconfigured clients, header-mangling
// proxies and curious testers, none of whom asked for anything illegitimate;
// failing their otherwise valid request would turn an observability aid into an
// outage. The flow stays correlated end to end — just not with the caller's id.
func ResolveRequestID(headerValue string) string {
	if requestIDPattern.MatchString(headerValue) {
		return headerValue
	}
	return GenerateRequestID()
}
```

`services/tracking-go/internal/adapter/http/logcontext_middleware.go`:
```go
// Package http holds the Gin adapters: middleware, routers and handlers.
package http

import (
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// UserIDHeader carries the JWT `sub` the gateway injects. Despite its name it
// is NOT the internal usr_ id — see the auth middleware.
const UserIDHeader = "x-user-id"

// healthRoute is the liveness probe's matched template. Only its 2xx responses
// are exempt from the request log.
const healthRoute = "/v1/health"

// LogContextMiddleware seeds the per-request log context and emits the one
// `request completed` line.
//
// The context is seeded at the OUTERMOST layer, before any auth or routing step.
// The requests someone asks about afterwards are disproportionately the ones
// that did NOT reach a handler — a 401 from the api-key check, a 404 from the
// router — and those are exactly the lines an id seeded further in would be
// missing. Users shipped that precise ordering bug (id seeded after the auth
// guard, so 401s had none) and a test caught it.
//
// The x-user-id header is seeded for LOGGING ONLY. It authorizes nothing:
// rejecting an absent or empty sub is the auth middleware's job, and seeding a
// context field never grants access to anything.
func LogContextMiddleware(log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		requestID := logging.ResolveRequestID(c.GetHeader(logging.RequestIDHeader))

		ctx := logging.WithLogFields(c.Request.Context(),
			slog.String(logging.KeyRequestID, requestID),
			// Empty is dropped by WithLogFields, so an absent header adds no
			// field rather than an empty one.
			slog.String(logging.KeyCognitoSub, c.GetHeader(UserIDHeader)),
		)
		c.Request = c.Request.WithContext(ctx)

		started := time.Now()
		c.Next()

		logRequest(c, log, started)
	}
}

// logRequest emits the ONE line in this service with no app_event.
//
// INFO for every status, 4xx and 5xx included: the status code already carries
// the outcome, so raising the severity would double-encode it and make an error
// rate computed from severity_text disagree with one computed from
// http_response_status_code.
//
// HEALTH CHECKS ARE THE ONE EXCEPTION, and only while they SUCCEED. Measured:
// 353 of this service's 368 log lines in an hour were GET /v1/health -> 200 —
// 96% of the stream against 2 lines describing actual tracking work. The probe
// runs forever at a fixed interval, so that share only grows on an idle system.
// A succeeding probe is also the one request whose line carries no information;
// a FAILING one carries the status and latency that explain why, so it is logged
// like any other request. Scoped by STATUS rather than by a route list, which is
// what keeps this a rule rather than an allowlist to maintain.
func logRequest(c *gin.Context, log *slog.Logger, started time.Time) {
	// FullPath() is the matched TEMPLATE (/v1/trackings/:order_id), not the
	// concrete URL. Logging the raw path would make every order id its own
	// "route" and blow up dashboard cardinality — the field would stop being
	// groupable, which is the only reason it exists.
	//
	// It is empty whenever nothing matched (a 404 from the router), so the raw
	// path is the fallback: those requests still deserve a line, and the
	// cardinality risk is bounded by their hitting no route at all.
	route := c.FullPath()
	if route == "" {
		route = c.Request.URL.Path
	}

	status := c.Writer.Status()
	if route == healthRoute && status >= 200 && status < 300 {
		return
	}

	log.InfoContext(c.Request.Context(), "request completed",
		slog.String("http_request_method", c.Request.Method),
		slog.String("http_route", route),
		slog.Int("http_response_status_code", status),
		slog.Float64("duration_ms", float64(time.Since(started).Microseconds())/1000.0),
	)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && gofmt -s -w ./internal && go test ./internal/platform/logging/... ./internal/adapter/http/... -v
```

Expected: every subtest `--- PASS` in both packages.

- [ ] **Step 5: Commit**

```
feat(tracking): request log context, x-request-id trust rule, and the request line
```

---

## Group B — OTel + Metrics

Runs concurrently with A, C and D. It touches only `internal/adapter/otel/**` and `internal/adapter/cloudwatch/**`.

### Task 11: OpenTelemetry wiring, workflow spans, and trace ids on log lines

**Files:**
- Create: `services/tracking-go/internal/adapter/otel/provider.go`
- Create: `services/tracking-go/internal/adapter/otel/workflow.go`
- Create: `services/tracking-go/internal/adapter/otel/loghandler.go`
- Test: `services/tracking-go/internal/adapter/otel/workflow_test.go`
- Test: `services/tracking-go/internal/adapter/otel/loghandler_test.go`

**Interfaces:**
- Consumes: `go.opentelemetry.io/otel/**`, and `logging.NewHandler` for the log-handler test only.
- Produces:
  ```go
  func SetupTracing(ctx context.Context) (shutdown func(context.Context) error, err error)
  func WorkflowSpan(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, EndFunc)
  type EndFunc func(err error)
  func MarkPhase(ctx context.Context, name, reason string)
  func NewTraceHandler(inner slog.Handler) slog.Handler
  func GinFilter(req *nethttp.Request) bool
  ```

**Go has no `opentelemetry-instrument` equivalent**, so every surface Python got for free must be wired in code:

| Surface | Package | Where it is applied |
|---|---|---|
| Inbound HTTP | `otelgin.Middleware` | the Gin engine (wave 2) |
| SQL | `otelsql` around the driver | the MySQL adapter (wave 2) |
| Outbound gRPC | `otelgrpc.NewClientHandler()` | the Users client (Task 17) |
| SQS producer | hand-instrumented | the publisher (Task 18) |

**Endpoint, protocol and exporters still come from environment variables, never code** — this repo has three recorded silent failures from configuring the SDK in code. Required in the generated env:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_METRICS_EXPORTER=none
OTEL_LOGS_EXPORTER=none
```
plus `OTEL_SERVICE_NAME=tracking` in the Dockerfile. What lives in code is only *which* surfaces are instrumented.

**Tracer names, exactly:** `tracking-workflow`, `tracking-messaging`, `tracking-metrics`, `tracking-cache`.

`WorkflowSpan` mirrors the Python helper: `SpanKind.INTERNAL`, status OK on success, and — the load-bearing part — **the error is recorded exactly once**. Python passes `record_exception=False, set_status_on_exception=False` because the SDK's own `__exit__` runs *after* the except arm and would record the exception a second time and overwrite the chosen status description. In Go the equivalent discipline is: call `RecordError` once in the error path and `SetStatus` explicitly; never also defer a second recorder.

`MarkPhase` adds a span **event**, not a span: a milestone is an instant with no duration to draw. What it buys is the answer to "how far did this request get?" on a flow that failed. No PII — lifecycle vocabulary only.

**Trace ids on log lines:** `trace_id` and `span_id` as **lowercase hex, zero-padded to 32 and 16 characters**, matching what the other three services emit — a join is string equality, so emitting a raw integer silently matches nothing. **OMITTED (never zeroed) when there is no valid span**: startup lines and the metrics ticker run outside any request, and writing `trace_id: "000…0"` would be worse than writing nothing, because 30 unrelated lines would appear to share a trace.

**The health endpoint must be excluded from tracing.** Python does it with `OTEL_PYTHON_FASTAPI_EXCLUDED_URLS="/v1/health$"`; Go has no such variable, so `GinFilter` skips it in `otelgin.WithFilter`.

- [ ] **Step 1: Write the failing test**

`services/tracking-go/internal/adapter/otel/workflow_test.go`:
```go
package otel_test

import (
	"context"
	"errors"
	nethttp "net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	oteltrace "go.opentelemetry.io/otel/trace"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
)

// recorder installs an in-memory exporter and returns the spans it collected.
func recorder(t *testing.T) (oteltrace.TracerProvider, func() []sdktrace.ReadOnlySpan) {
	t.Helper()
	exporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	return tp, exporter.GetSpans().Snapshots
}

func TestWorkflowSpanSuccess(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	tracing.SetTracerProvider(tp)

	ctx, end := tracing.WorkflowSpan(context.Background(), "init_tracking",
		attribute.String("app_event", "init_tracking_started"),
		attribute.String("order_id", "ord_1"),
	)
	_ = ctx
	end(nil)

	spans := exporter.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	s := spans[0]
	if s.Name != "init_tracking" {
		t.Errorf("Name = %q, want init_tracking", s.Name)
	}
	if s.SpanKind != oteltrace.SpanKindInternal {
		t.Errorf("SpanKind = %v, want Internal", s.SpanKind)
	}
	if s.Status.Code != codes.Ok {
		t.Errorf("Status = %v, want Ok on success", s.Status.Code)
	}
	if len(s.Events) != 0 {
		t.Errorf("a successful span must record no exception event, got %v", s.Events)
	}
}

// The error is recorded EXACTLY ONCE. The Python helper disables the SDK's own
// recorder for this reason; the Go equivalent is not deferring a second one.
func TestWorkflowSpanRecordsTheErrorExactlyOnce(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	tracing.SetTracerProvider(tp)

	_, end := tracing.WorkflowSpan(context.Background(), "carrier_status_update")
	end(errors.New("not_strictly_forward"))

	spans := exporter.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	s := spans[0]
	if s.Status.Code != codes.Error {
		t.Errorf("Status = %v, want Error", s.Status.Code)
	}
	if s.Status.Description != "not_strictly_forward" {
		t.Errorf("Status.Description = %q, want the error's own text", s.Status.Description)
	}

	exceptions := 0
	for _, e := range s.Events {
		if e.Name == "exception" {
			exceptions++
		}
	}
	if exceptions != 1 {
		t.Errorf("got %d exception events, want exactly 1 (a double record overwrites the status description)", exceptions)
	}
}

// MarkPhase adds an EVENT, not a span: a milestone is an instant.
func TestMarkPhaseAddsAnEvent(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	tracing.SetTracerProvider(tp)

	ctx, end := tracing.WorkflowSpan(context.Background(), "init_tracking")
	tracing.MarkPhase(ctx, "user_resolved", "")
	tracing.MarkPhase(ctx, "creation_failed", "duplicate_order")
	end(nil)

	spans := exporter.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1 — MarkPhase must not open a span", len(spans))
	}
	names := map[string]bool{}
	var reason string
	for _, e := range spans[0].Events {
		names[e.Name] = true
		for _, a := range e.Attributes {
			if string(a.Key) == "reason" {
				reason = a.Value.AsString()
			}
		}
	}
	if !names["user_resolved"] || !names["creation_failed"] {
		t.Errorf("events = %v, want both phases", names)
	}
	if reason != "duplicate_order" {
		t.Errorf("reason = %q, want duplicate_order", reason)
	}
}

// Outside any recording span MarkPhase is a no-op, never a panic: the metrics
// ticker and startup code call into shared helpers with no span active.
func TestMarkPhaseOutsideASpanIsANoop(t *testing.T) {
	tracing.MarkPhase(context.Background(), "user_resolved", "")
}

// The health probe is excluded from tracing: Python does it with
// OTEL_PYTHON_FASTAPI_EXCLUDED_URLS, Go needs a filter.
func TestGinFilterExcludesHealth(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{"/v1/health", false},
		{"/v1/trackings/ord_1", true},
		{"/v1/trackings", true},
		// Only the exact route, not anything merely containing it.
		{"/v1/healthcheck", true},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			req := httptest.NewRequest(nethttp.MethodGet, tt.path, nil)
			if got := tracing.GinFilter(req); got != tt.want {
				t.Errorf("GinFilter(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}
```

`services/tracking-go/internal/adapter/otel/loghandler_test.go`:
```go
package otel_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"strings"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

var (
	traceIDHex = regexp.MustCompile(`^[0-9a-f]{32}$`)
	spanIDHex  = regexp.MustCompile(`^[0-9a-f]{16}$`)
)

func traceLogger(buf *bytes.Buffer) *slog.Logger {
	return slog.New(tracing.NewTraceHandler(
		logging.NewHandler(buf, "tracking", "local", slog.LevelDebug)))
}

func TestTraceIDsAreLowercaseHexOfTheRightWidth(t *testing.T) {
	tp := sdktrace.NewTracerProvider()
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	ctx, span := tp.Tracer("test").Start(context.Background(), "s")
	defer span.End()

	var buf bytes.Buffer
	traceLogger(&buf).InfoContext(ctx, "m")

	var got map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &got); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	traceID, _ := got["trace_id"].(string)
	spanID, _ := got["span_id"].(string)
	if !traceIDHex.MatchString(traceID) {
		t.Errorf("trace_id = %q, want 32 lowercase hex chars", traceID)
	}
	if !spanIDHex.MatchString(spanID) {
		t.Errorf("span_id = %q, want 16 lowercase hex chars", spanID)
	}
}

// OMITTED, never zeroed, when there is no valid span. A "000...0" trace_id
// reads as a real id and makes 30 unrelated lines appear to share a trace.
func TestTraceIDsOmittedWithoutASpan(t *testing.T) {
	var buf bytes.Buffer
	traceLogger(&buf).InfoContext(context.Background(), "startup")

	var got map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &got); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if v, present := got["trace_id"]; present {
		t.Errorf("trace_id = %v on a line with no span; it must be omitted, never zeroed", v)
	}
	if v, present := got["span_id"]; present {
		t.Errorf("span_id = %v on a line with no span; it must be omitted", v)
	}
}

// An explicit trace_id at the call site is left alone, matching the precedence
// rule the log context follows.
func TestExplicitTraceIDWins(t *testing.T) {
	tp := sdktrace.NewTracerProvider()
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	ctx, span := tp.Tracer("test").Start(context.Background(), "s")
	defer span.End()

	var buf bytes.Buffer
	traceLogger(&buf).InfoContext(ctx, "m", slog.String("trace_id", "deadbeef"))

	var got map[string]any
	_ = json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &got)
	if got["trace_id"] != "deadbeef" {
		t.Errorf("trace_id = %v, want the call-site value", got["trace_id"])
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && go test ./internal/adapter/otel/...
```

Expected: `no required module provides package .../internal/adapter/otel` (after `go get` of the OTel modules, `undefined: tracing.WorkflowSpan`).

- [ ] **Step 3: Write minimal implementation**

First add the dependencies:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && \
go get go.opentelemetry.io/otel \
       go.opentelemetry.io/otel/sdk \
       go.opentelemetry.io/otel/trace \
       go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp \
       go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin
```

`services/tracking-go/internal/adapter/otel/provider.go`:
```go
// Package otel wires OpenTelemetry for this service.
//
// Go has NO `opentelemetry-instrument` equivalent, so every surface the Python
// service got for free must be wired here in code: otelgin for inbound HTTP,
// otelsql around the driver, otelgrpc on the outbound client, and a
// hand-instrumented SQS producer.
//
// What does NOT live in code is the configuration. Endpoint, protocol and the
// disabling of the metrics/logs exporters all come from the standard OTLP
// environment variables, and that is a rule with three recorded silent failures
// behind it in this repo:
//
//	OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4318
//	OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
//	OTEL_METRICS_EXPORTER=none
//	OTEL_LOGS_EXPORTER=none
//	OTEL_SERVICE_NAME=tracking          (set in the Dockerfile)
//
// Logs and traces BOTH go to OpenObserve; there is no Jaeger any more.
package otel

import (
	"context"
	nethttp "net/http"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	oteltrace "go.opentelemetry.io/otel/trace"
)

// Tracer names, exactly as the other services spell them. One query in
// OpenObserve must mean the same thing in every runtime.
const (
	TracerWorkflow  = "tracking-workflow"
	TracerMessaging = "tracking-messaging"
	TracerMetrics   = "tracking-metrics"
	TracerCache     = "tracking-cache"
)

// HealthRoute is excluded from tracing. Python does this with
// OTEL_PYTHON_FASTAPI_EXCLUDED_URLS="/v1/health$"; Go has no such variable, so
// the exclusion is a filter passed to otelgin.
const HealthRoute = "/v1/health"

// provider is the tracer provider these helpers read from. Package-level rather
// than a parameter so a use case can open a workflow span without being handed
// a provider through every constructor; tests swap it with SetTracerProvider.
var provider oteltrace.TracerProvider = otel.GetTracerProvider()

// SetTracerProvider points the helpers at tp. Used by SetupTracing and by tests.
func SetTracerProvider(tp oteltrace.TracerProvider) { provider = tp }

// SetupTracing installs the OTLP exporter and the W3C propagator.
//
// No endpoint, protocol or header is passed here: otlptracehttp.New reads them
// from OTEL_EXPORTER_OTLP_*. Passing an SDK option whose value came out
// `undefined` is exactly how the three silent failures happened — an explicit
// option LOSES to auto-detection in a way that produces no error at all.
//
// The returned shutdown flushes pending spans; call it on graceful exit or the
// last batch never leaves the process.
func SetupTracing(ctx context.Context) (func(context.Context) error, error) {
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}

	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter))
	otel.SetTracerProvider(tp)
	SetTracerProvider(tp)

	// W3C trace context plus baggage: the same propagator the SQS publisher
	// injects with and the events-pipeline extracts with.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	return tp.Shutdown, nil
}

// GinFilter reports whether a request should be traced. Returns false for the
// liveness probe, which runs forever at a fixed interval and would otherwise be
// most of the spans this service produces.
func GinFilter(req *nethttp.Request) bool {
	return req.URL.Path != HealthRoute
}
```

`services/tracking-go/internal/adapter/otel/workflow.go`:
```go
package otel

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	oteltrace "go.opentelemetry.io/otel/trace"
)

// EndFunc closes a workflow span. Pass the flow's error, or nil on success.
type EndFunc func(err error)

// WorkflowSpan opens one INTERNAL span named after a business flow.
//
// Auto-instrumentation can only see what a library does: an HTTP request, a SQL
// statement, an outbound gRPC call. It cannot see that four of those together
// are "a tracking was created", which is the unit a person actually asks about.
//
// The returned EndFunc MUST be called on every path, success and failure alike —
// `defer`red where the error is available, or called explicitly. An unclosed
// span is not an error anywhere: it silently never reaches the backend, and the
// flow disappears from the cascade while the code still looks instrumented.
//
// THE ERROR IS RECORDED EXACTLY ONCE. Python passes record_exception=False and
// set_status_on_exception=False because the SDK's own __exit__ runs AFTER the
// except arm and would record the exception a SECOND time and overwrite the
// chosen status description. The Go equivalent of that discipline is here:
// RecordError once, SetStatus explicitly, and no second deferred recorder
// anywhere. Verified, not theoretical.
func WorkflowSpan(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, EndFunc) {
	ctx, span := provider.Tracer(TracerWorkflow).Start(ctx, name,
		oteltrace.WithSpanKind(oteltrace.SpanKindInternal),
		oteltrace.WithAttributes(attrs...),
	)

	return ctx, func(err error) {
		if err != nil {
			span.RecordError(err)
			// The description is the error's own text; the machine-readable
			// `reason` is a separate attribute the caller sets, matching its log
			// line's `reason` so trace and logs tell one story.
			span.SetStatus(codes.Error, err.Error())
		} else {
			span.SetStatus(codes.Ok, "")
		}
		span.End()
	}
}

// SetSpanAttributes attaches what a flow only learns part-way through — the
// tracking_id it just wrote, the reason a failure branch logged.
func SetSpanAttributes(ctx context.Context, attrs ...attribute.KeyValue) {
	span := oteltrace.SpanFromContext(ctx)
	if span.IsRecording() {
		span.SetAttributes(attrs...)
	}
}

// MarkPhase records a lifecycle milestone as an EVENT on the active span.
//
// An event, not a span, because a milestone is an INSTANT — it has no duration
// to draw. What it buys is the answer to "how far did this request get?" on a
// flow that failed: the span alone shows a workflow that ended, while the events
// show it resolved the user and then died creating the tracking.
//
// No-ops when nothing is recording, so it is safe on paths that also run outside
// a request. No PII, by the same rule the log lines follow: lifecycle vocabulary
// only, never the payload, never an address, never an email. `reason` carries
// the same already-sanitized token the matching *_failed line does, and is
// omitted when empty.
func MarkPhase(ctx context.Context, name, reason string) {
	span := oteltrace.SpanFromContext(ctx)
	if !span.IsRecording() {
		return
	}
	if reason == "" {
		span.AddEvent(name)
		return
	}
	span.AddEvent(name, oteltrace.WithAttributes(attribute.String("reason", reason)))
}
```

`services/tracking-go/internal/adapter/otel/loghandler.go`:
```go
package otel

import (
	"context"
	"log/slog"

	oteltrace "go.opentelemetry.io/otel/trace"
)

// TraceHandler stamps the active span's ids onto every log record.
//
// Logs and traces travel two different paths: stdout -> Docker's fluentd driver
// -> OpenObserve for logs, OTLP -> the collector -> OpenObserve for traces.
// Nothing joins them automatically. trace_id on the log line is the ONLY thing
// that lets a dashboard answer "show me every line, in every service, for the
// request that produced this slow span".
//
// Measured before the Python equivalent existed: Tracking emitted 0 of 348 log
// lines with a trace_id, while Users emitted 32/42 and Orders 53/64 — so a trace
// that crossed into Tracking simply lost its logs at the boundary.
//
// THE TWO RULES THAT MATTER:
//
//  1. LOWERCASE HEX, zero-padded to 32 and 16 characters. Users and Orders emit
//     that form, and a join is string equality — any other rendering silently
//     matches nothing.
//  2. OMITTED, NEVER ZEROED, when there is no valid span. Startup lines, the
//     metrics ticker and background work have no span; writing
//     trace_id: "000...0" would be worse than writing nothing, because it reads
//     as a real id and 30 unrelated lines would appear to share a trace.
type TraceHandler struct{ inner slog.Handler }

// NewTraceHandler wraps inner so records carry trace_id/span_id when a span is
// active.
func NewTraceHandler(inner slog.Handler) slog.Handler { return &TraceHandler{inner: inner} }

func (h *TraceHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h *TraceHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &TraceHandler{inner: h.inner.WithAttrs(attrs)}
}

func (h *TraceHandler) WithGroup(name string) slog.Handler {
	return &TraceHandler{inner: h.inner.WithGroup(name)}
}

func (h *TraceHandler) Handle(ctx context.Context, r slog.Record) error {
	sc := oteltrace.SpanContextFromContext(ctx)
	// IsValid is false both when there is no span at all and when the context is
	// the all-zero invalid one — exactly the cases where the fields must be
	// absent rather than zeroed.
	if !sc.IsValid() {
		return h.inner.Handle(ctx, r)
	}

	enriched := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	// Call-site attributes first, so an explicit trace_id wins — the same
	// precedence rule the log context follows.
	r.Attrs(func(a slog.Attr) bool {
		enriched.AddAttrs(a)
		return true
	})
	// TraceID.String() and SpanID.String() are already lowercase hex, padded to
	// 32 and 16 characters.
	enriched.AddAttrs(
		slog.String("trace_id", sc.TraceID().String()),
		slog.String("span_id", sc.SpanID().String()),
	)
	return h.inner.Handle(ctx, enriched)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && gofmt -s -w ./internal/adapter/otel && go test ./internal/adapter/otel/... -v
```

Expected: every subtest `--- PASS`, ending `ok  .../internal/adapter/otel`.

- [ ] **Step 5: Commit**

```
feat(tracking): OTel provider, workflow spans, and trace ids on log lines
```

---

### Task 12: CloudWatch metrics publisher and the periodic ticker

**Files:**
- Create: `services/tracking-go/internal/adapter/cloudwatch/publisher.go`
- Create: `services/tracking-go/internal/adapter/cloudwatch/ticker.go`
- Test: `services/tracking-go/internal/adapter/cloudwatch/publisher_test.go`
- Test: `services/tracking-go/internal/adapter/cloudwatch/ticker_test.go`

**Interfaces:**
- Consumes: `github.com/aws/aws-sdk-go-v2/service/cloudwatch`, and a narrow status-count port declared here (the consumer declares the port):
  ```go
  // StatusCounter is declared HERE, by the ticker that consumes it. The MySQL
  // adapter satisfies it without importing this package.
  type StatusCounter interface {
      CountByStatus(ctx context.Context) (map[string]int64, error)
  }
  ```
- Produces:
  ```go
  type Publisher interface {
      Publish(ctx context.Context, name string, value float64, dimensions [][2]string)
  }
  func NewPublisher(client PutMetricDataAPI) Publisher
  func NewNoopPublisher() Publisher
  func RunTicker(ctx context.Context, p Publisher, counts StatusCounter, interval time.Duration, log *slog.Logger)
  func SplitStatusCounts(raw map[string]int64) (delivered, inProgress int64)
  ```

Namespace `3MRAI` — **one namespace across all four services**, never a per-service one. `Service` dimension value `tracking`. Unit always `Count`. **One datum per `PutMetricData` call.**

| Metric | Dimensions |
|---|---|
| `orders_by_tracking_status_total` | `Service=tracking`, `Status=DELIVERED` / `IN_PROGRESS` / `ALL` |
| `http_errors_total` | `Service=tracking`, `StatusClass=4xx` / `5xx` |
| `cache_requests_total` | `Service=tracking`, `KeyPrefix=<prefix>`, `Result=hit`/`miss`/`bypass` |
| `cache_operation_duration_ms` | `Service=tracking`, `Operation=get`/`set`/`invalidate`/`invalidate_index` |

The dimension **set** is load-bearing: Floci does not aggregate across dimensions, so a query that omits one returns `Values: []` with `StatusCode: "Complete"` — a silent empty result rather than an error. Dimensions are therefore low-cardinality labels only; never a user id, an email or an order id.

**Cadence.** A ticker publishing every `METRICS_INTERVAL_SECONDS` (default 15.0), started only when `METRICS_ENABLED`. It **sleeps first, then publishes**: at startup the database may still be unreachable, and a tick before the first interval yields only an unactionable failure line.

**Each tick publishes 5 data points:** the 3 status series plus 2 `http_errors_total` seeds **at zero**, so a dashboard panel renders "no errors" rather than "Error Loading Data".

**Both status series are ALWAYS published, including 0.** A series that stops being published reads as "no data" in a dashboard, not as zero — so an empty `DELIVERED` bucket must publish a `0` rather than skip the datum. `ALL` is a **pre-summed published series**, not a dashboard sum: the collector queries these with `Maximum`, and a `Sum` across a window would double the count whenever two publishes land in one window.

**Counting query:** `SELECT status, COUNT(*) FROM tracking WHERE deleted_at IS NULL GROUP BY status`, on the **read** connection. Soft-deleted rows are excluded — a deleted tracking is not an order in flight, and counting it would make the gauge disagree with every user-facing read. **Anything not `DELIVERED` counts as `IN_PROGRESS`, including an unknown status**: a new status added to the progression should land in "still in flight" by default rather than disappear from both series.

**`Publish` NEVER returns an error to callers** (log and swallow). A per-tick failure is swallowed and **the loop continues** — unlike a TestMode run, which ends. Only context cancellation ends the ticker: this loop has no natural end, so a transient database blip or a CloudWatch outage must cost one datapoint, not the rest of the process's metrics.

**`KeyPrefix` is always the first 3 colon-segments, never a full key** — a full key embeds identity, and dimension cardinality is billed. (Group C builds the prefix; this task only declares the dimension.)

- [ ] **Step 1: Write the failing test**

`services/tracking-go/internal/adapter/cloudwatch/publisher_test.go`:
```go
package cloudwatch_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	awscw "github.com/aws/aws-sdk-go-v2/service/cloudwatch"
	cwtypes "github.com/aws/aws-sdk-go-v2/service/cloudwatch/types"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/cloudwatch"
)

// fakeCW records every PutMetricData call and can be made to fail.
type fakeCW struct {
	mu    sync.Mutex
	calls []*awscw.PutMetricDataInput
	err   error
}

func (f *fakeCW) PutMetricData(_ context.Context, in *awscw.PutMetricDataInput, _ ...func(*awscw.Options)) (*awscw.PutMetricDataOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, in)
	if f.err != nil {
		return nil, f.err
	}
	return &awscw.PutMetricDataOutput{}, nil
}

func (f *fakeCW) snapshot() []*awscw.PutMetricDataInput {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*awscw.PutMetricDataInput(nil), f.calls...)
}

func TestPublishShape(t *testing.T) {
	client := &fakeCW{}
	p := cloudwatch.NewPublisher(client)

	p.Publish(context.Background(), "orders_by_tracking_status_total", 7,
		[][2]string{{"Service", "tracking"}, {"Status", "DELIVERED"}})

	calls := client.snapshot()
	if len(calls) != 1 {
		t.Fatalf("got %d PutMetricData calls, want 1", len(calls))
	}
	in := calls[0]
	if *in.Namespace != "3MRAI" {
		t.Errorf("Namespace = %q, want 3MRAI (one namespace across all four services)", *in.Namespace)
	}
	// One datum per call.
	if len(in.MetricData) != 1 {
		t.Fatalf("got %d data in one call, want exactly 1", len(in.MetricData))
	}
	d := in.MetricData[0]
	if *d.MetricName != "orders_by_tracking_status_total" {
		t.Errorf("MetricName = %q", *d.MetricName)
	}
	if *d.Value != 7 {
		t.Errorf("Value = %v, want 7", *d.Value)
	}
	if d.Unit != cwtypes.StandardUnitCount {
		t.Errorf("Unit = %v, want Count", d.Unit)
	}
	// The dimension SET is a contract: Floci does not aggregate across
	// dimensions, so a query naming a different set returns an empty result.
	if len(d.Dimensions) != 2 {
		t.Fatalf("got %d dimensions, want 2", len(d.Dimensions))
	}
	if *d.Dimensions[0].Name != "Service" || *d.Dimensions[0].Value != "tracking" {
		t.Errorf("dimension 0 = %s=%s", *d.Dimensions[0].Name, *d.Dimensions[0].Value)
	}
	if *d.Dimensions[1].Name != "Status" || *d.Dimensions[1].Value != "DELIVERED" {
		t.Errorf("dimension 1 = %s=%s", *d.Dimensions[1].Name, *d.Dimensions[1].Value)
	}
}

// A zero is published as given: a series that stops being published reads as
// "no data" in a dashboard, not as zero.
func TestPublishDoesNotShortCircuitOnZero(t *testing.T) {
	client := &fakeCW{}
	cloudwatch.NewPublisher(client).Publish(context.Background(),
		"http_errors_total", 0, [][2]string{{"Service", "tracking"}, {"StatusClass", "5xx"}})

	calls := client.snapshot()
	if len(calls) != 1 {
		t.Fatalf("a zero value was not published; got %d calls", len(calls))
	}
	if *calls[0].MetricData[0].Value != 0 {
		t.Errorf("Value = %v, want 0", *calls[0].MetricData[0].Value)
	}
}

// Publish NEVER returns an error to callers — a metrics backend being
// unreachable may not break the request or the loop that produced the metric.
func TestPublishSwallowsFailures(t *testing.T) {
	client := &fakeCW{err: errors.New("cloudwatch is down")}
	p := cloudwatch.NewPublisher(client)

	// Compiles only if Publish returns nothing, and must not panic.
	p.Publish(context.Background(), "http_errors_total", 1,
		[][2]string{{"Service", "tracking"}, {"StatusClass", "4xx"}})
}

func TestNoopPublisherMakesNoCalls(t *testing.T) {
	// Nothing to assert against a client — the point is that it needs none and
	// never panics. Used by suites that must not reach AWS.
	cloudwatch.NewNoopPublisher().Publish(context.Background(), "m", 1, nil)
}

// Anything that is not DELIVERED counts as IN_PROGRESS, an unknown status
// included: a new status should land in "still in flight" by default rather
// than disappear from both series.
func TestSplitStatusCounts(t *testing.T) {
	tests := []struct {
		name           string
		raw            map[string]int64
		wantDelivered  int64
		wantInProgress int64
	}{
		{"empty table", map[string]int64{}, 0, 0},
		{"only delivered", map[string]int64{"DELIVERED": 4}, 4, 0},
		{"mixed", map[string]int64{"DELIVERED": 4, "PLACED": 2, "IN_TRANSIT": 3}, 4, 5},
		{"unknown status counts as in progress", map[string]int64{"WAREHOUSED": 6}, 0, 6},
		{"nil map", nil, 0, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			delivered, inProgress := cloudwatch.SplitStatusCounts(tt.raw)
			if delivered != tt.wantDelivered || inProgress != tt.wantInProgress {
				t.Errorf("SplitStatusCounts(%v) = (%d, %d), want (%d, %d)",
					tt.raw, delivered, inProgress, tt.wantDelivered, tt.wantInProgress)
			}
		})
	}
}
```

`services/tracking-go/internal/adapter/cloudwatch/ticker_test.go`:
```go
package cloudwatch_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/cloudwatch"
)

type recordedDatum struct {
	name       string
	value      float64
	dimensions [][2]string
}

type recordingPublisher struct {
	mu   sync.Mutex
	data []recordedDatum
	// notify fires after each Publish so a test can wait deterministically.
	notify chan struct{}
}

func newRecordingPublisher() *recordingPublisher {
	return &recordingPublisher{notify: make(chan struct{}, 128)}
}

func (r *recordingPublisher) Publish(_ context.Context, name string, value float64, dimensions [][2]string) {
	r.mu.Lock()
	r.data = append(r.data, recordedDatum{name, value, dimensions})
	r.mu.Unlock()
	select {
	case r.notify <- struct{}{}:
	default:
	}
}

func (r *recordingPublisher) snapshot() []recordedDatum {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]recordedDatum(nil), r.data...)
}

// waitFor blocks until n data points have been published or the deadline passes.
func (r *recordingPublisher) waitFor(t *testing.T, n int) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		if len(r.snapshot()) >= n {
			return
		}
		select {
		case <-r.notify:
		case <-deadline:
			t.Fatalf("timed out waiting for %d data points; got %d", n, len(r.snapshot()))
		}
	}
}

type stubCounter struct {
	mu     sync.Mutex
	counts map[string]int64
	err    error
	calls  int
}

func (s *stubCounter) CountByStatus(context.Context) (map[string]int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	return s.counts, s.err
}

func (s *stubCounter) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// Each tick publishes FIVE data points: 3 status series + 2 http_errors_total
// seeds at zero, so a panel renders "no errors" rather than "Error Loading Data".
func TestOneTickPublishesFiveDataPoints(t *testing.T) {
	pub := newRecordingPublisher()
	counts := &stubCounter{counts: map[string]int64{"DELIVERED": 2, "PLACED": 3}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go cloudwatch.RunTicker(ctx, pub, counts, 10*time.Millisecond, quietLogger())

	pub.waitFor(t, 5)
	cancel()

	got := pub.snapshot()[:5]
	want := map[string]float64{
		"orders_by_tracking_status_total|DELIVERED":   2,
		"orders_by_tracking_status_total|IN_PROGRESS": 3,
		// ALL is a PRE-SUMMED published series, not a dashboard sum.
		"orders_by_tracking_status_total|ALL": 5,
		"http_errors_total|4xx":               0,
		"http_errors_total|5xx":               0,
	}
	seen := map[string]float64{}
	for _, d := range got {
		label := d.dimensions[len(d.dimensions)-1][1]
		seen[d.name+"|"+label] = d.value
	}
	for key, wantValue := range want {
		gotValue, present := seen[key]
		if !present {
			t.Errorf("datum %s was not published", key)
			continue
		}
		if gotValue != wantValue {
			t.Errorf("%s = %v, want %v", key, gotValue, wantValue)
		}
	}
}

// Both status series are published even at zero.
func TestZeroCountsAreStillPublished(t *testing.T) {
	pub := newRecordingPublisher()
	counts := &stubCounter{counts: map[string]int64{}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go cloudwatch.RunTicker(ctx, pub, counts, 10*time.Millisecond, quietLogger())

	pub.waitFor(t, 5)
	cancel()

	labels := map[string]bool{}
	for _, d := range pub.snapshot() {
		if d.name == "orders_by_tracking_status_total" {
			labels[d.dimensions[len(d.dimensions)-1][1]] = true
		}
	}
	for _, label := range []string{"DELIVERED", "IN_PROGRESS", "ALL"} {
		if !labels[label] {
			t.Errorf("%s was skipped at zero; a series that stops being published reads as 'no data', not zero", label)
		}
	}
}

// It SLEEPS FIRST. At startup the DB may be unreachable, and a tick before the
// first interval yields only an unactionable failure line.
func TestTickerSleepsBeforeItsFirstPublish(t *testing.T) {
	pub := newRecordingPublisher()
	counts := &stubCounter{counts: map[string]int64{"DELIVERED": 1}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go cloudwatch.RunTicker(ctx, pub, counts, 300*time.Millisecond, quietLogger())

	time.Sleep(80 * time.Millisecond)
	if n := len(pub.snapshot()); n != 0 {
		t.Fatalf("published %d data points before the first interval elapsed; the ticker must sleep first", n)
	}
	if c := counts.callCount(); c != 0 {
		t.Fatalf("queried the database %d times before the first interval; the ticker must sleep first", c)
	}
}

// A per-tick failure is swallowed and THE LOOP CONTINUES. Unlike a TestMode run,
// this loop has no natural end: a blip must cost one datapoint, not the rest of
// the process's metrics.
func TestTickerContinuesAfterAFailedTick(t *testing.T) {
	pub := newRecordingPublisher()
	counts := &stubCounter{err: errors.New("database is unreachable")}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go cloudwatch.RunTicker(ctx, pub, counts, 10*time.Millisecond, quietLogger())

	// Let several ticks fail.
	time.Sleep(120 * time.Millisecond)
	if counts.callCount() < 2 {
		t.Fatalf("the loop stopped after a failed tick; got %d queries", counts.callCount())
	}

	// Once the database recovers, publishing resumes.
	counts.mu.Lock()
	counts.err = nil
	counts.counts = map[string]int64{"DELIVERED": 1}
	counts.mu.Unlock()

	pub.waitFor(t, 5)
	cancel()
}

// Only context cancellation ends it.
func TestTickerStopsOnContextCancellation(t *testing.T) {
	pub := newRecordingPublisher()
	counts := &stubCounter{counts: map[string]int64{"DELIVERED": 1}}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		cloudwatch.RunTicker(ctx, pub, counts, 10*time.Millisecond, quietLogger())
		close(done)
	}()

	pub.waitFor(t, 5)
	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("RunTicker did not return after its context was cancelled")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && go test ./internal/adapter/cloudwatch/...
```

Expected: `no required module provides package .../internal/adapter/cloudwatch`.

- [ ] **Step 3: Write minimal implementation**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && \
go get github.com/aws/aws-sdk-go-v2/config github.com/aws/aws-sdk-go-v2/service/cloudwatch
```

`services/tracking-go/internal/adapter/cloudwatch/publisher.go`:
```go
// Package cloudwatch publishes this service's custom business metrics.
//
// ONE RESPONSIBILITY. This file turns a (name, value, dimensions) triple into one
// PutMetricData call and nothing else; the SCHEDULING and the QUERIES live in
// ticker.go. That split is what makes the publisher unit-testable with a
// recording double and the loop testable with an injected interval.
//
// FAILURE POLICY: LOG AND SWALLOW, deliberately. Publish never returns an error.
// A metrics backend being unreachable may never break the request or the loop
// that produced the metric — the metric is a secondary observation of work that
// already happened. This is NOT silent: every failure is an ERROR line carrying
// app_event=metric_publish_failed, which is what makes it alertable.
//
// THE NAMESPACE AND THE DIMENSIONS ARE A CONTRACT. Every 3MRAI metric, in every
// service, is published under the single namespace 3MRAI. The dimension SET is
// equally load-bearing: Floci does not aggregate across dimensions, so the
// collector's GetMetricData query must name the exact same set the datum was
// published with — a query that omits one returns Values: [] with
// StatusCode: "Complete", a silent empty result rather than an error. Dimensions
// are therefore low-cardinality labels only; never a user id, an email or an
// order id.
package cloudwatch

import (
	"context"
	"log/slog"

	"github.com/aws/aws-sdk-go-v2/aws"
	awscw "github.com/aws/aws-sdk-go-v2/service/cloudwatch"
	cwtypes "github.com/aws/aws-sdk-go-v2/service/cloudwatch/types"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	oteltrace "go.opentelemetry.io/otel/trace"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
)

// Namespace is the ONE namespace every 3MRAI metric is published under, across
// all four services. Never a per-service namespace.
const Namespace = "3MRAI"

// ServiceDimension is the Service dimension value every metric from THIS service
// carries.
const ServiceDimension = "tracking"

// Metric names. Shared with the collector's queries and with the dashboards.
const (
	MetricOrdersByStatus        = "orders_by_tracking_status_total"
	MetricHTTPErrors            = "http_errors_total"
	MetricCacheRequests         = "cache_requests_total"
	MetricCacheOperationDuration = "cache_operation_duration_ms"
)

// PutMetricDataAPI is the one CloudWatch call this package makes. Declared here,
// by the consumer, so the SDK client satisfies it without any wrapper.
type PutMetricDataAPI interface {
	PutMetricData(ctx context.Context, in *awscw.PutMetricDataInput, opts ...func(*awscw.Options)) (*awscw.PutMetricDataOutput, error)
}

// Publisher emits one metric datum. Publish NEVER returns an error — that is
// part of the contract, not an implementation detail, and every caller relies on
// it.
type Publisher interface {
	Publish(ctx context.Context, name string, value float64, dimensions [][2]string)
}

type publisher struct {
	client PutMetricDataAPI
	log    *slog.Logger
}

// NewPublisher builds a CloudWatch-backed publisher (Floci locally).
func NewPublisher(client PutMetricDataAPI) Publisher {
	return &publisher{client: client, log: slog.Default()}
}

// Publish emits one datum. Never returns an error — see the package docstring.
//
// value is published as given, 0 INCLUDED: a series that stops being published
// reads as "no data" in a dashboard, not as zero, so there is no falsy
// short-circuit here.
func (p *publisher) Publish(ctx context.Context, name string, value float64, dimensions [][2]string) {
	// A span NAMING THE METRIC. The metric name goes in the SPAN NAME, not only
	// an attribute: a waterfall renders names, and `PutMetricData` repeated N
	// times answers nothing.
	ctx, span := otelTracer().Start(ctx, "cloudwatch PutMetricData "+name,
		oteltrace.WithSpanKind(oteltrace.SpanKindClient),
		oteltrace.WithAttributes(
			attribute.String("rpc.system", "aws-api"),
			attribute.String("rpc.service", "CloudWatch"),
			attribute.String("rpc.method", "PutMetricData"),
			attribute.String("metric.name", name),
		),
	)
	defer span.End()

	dims := make([]cwtypes.Dimension, 0, len(dimensions))
	for _, d := range dimensions {
		dims = append(dims, cwtypes.Dimension{
			Name:  aws.String(d[0]),
			Value: aws.String(d[1]),
		})
	}

	_, err := p.client.PutMetricData(ctx, &awscw.PutMetricDataInput{
		Namespace: aws.String(Namespace),
		// ONE datum per call.
		MetricData: []cwtypes.MetricDatum{{
			MetricName: aws.String(name),
			Value:      aws.Float64(value),
			Unit:       cwtypes.StandardUnitCount,
			Dimensions: dims,
		}},
	})
	if err != nil {
		// The span records what happened to the CALL; Publish still returns
		// normally, because its contract is that it never fails a caller.
		span.SetStatus(codes.Error, "put_metric_data_failed")
		p.log.ErrorContext(ctx, "metric_publish_failed",
			slog.String("app_event", "metric_publish_failed"),
			slog.String("reason", "put_metric_data_failed"),
			slog.String("metric_name", name),
			slog.String("exception", err.Error()),
		)
		return
	}
	span.SetStatus(codes.Ok, "")
}

func otelTracer() oteltrace.Tracer { return tracing.Tracer(tracing.TracerMetrics) }

type noopPublisher struct{}

// NewNoopPublisher returns a publisher for suites (and runtimes) that must not
// reach CloudWatch.
func NewNoopPublisher() Publisher { return noopPublisher{} }

func (noopPublisher) Publish(context.Context, string, float64, [][2]string) {}
```

Add to `services/tracking-go/internal/adapter/otel/provider.go` (the metrics package needs a named tracer):
```go
// Tracer returns a named tracer from the configured provider.
func Tracer(name string) oteltrace.Tracer { return provider.Tracer(name) }
```

`services/tracking-go/internal/adapter/cloudwatch/ticker.go`:
```go
package cloudwatch

import (
	"context"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel/attribute"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
)

// StatusCounter is the ONE query the ticker needs, declared HERE by the code that
// consumes it. The MySQL adapter satisfies it without importing this package and
// without a shared repository interface.
//
// It runs on the READ connection and excludes soft-deleted rows:
//
//	SELECT status, COUNT(*) FROM tracking WHERE deleted_at IS NULL GROUP BY status
//
// A deleted tracking is not an order in flight, and counting it would make the
// gauge disagree with every user-facing read, all of which filter the same way.
type StatusCounter interface {
	CountByStatus(ctx context.Context) (map[string]int64, error)
}

// TerminalStatus is the state machine's end state. Everything else is in flight.
const TerminalStatus = "DELIVERED"

// The three published status series. ALL is PRE-SUMMED and published as its own
// series, never computed by the dashboard: the collector queries these with
// Maximum, and a Sum across a window would double the count whenever two
// publishes land in one window.
const (
	StatusDelivered  = "DELIVERED"
	StatusInProgress = "IN_PROGRESS"
	StatusAll        = "ALL"
)

// httpErrorClasses are seeded at ZERO on every tick, so a dashboard panel renders
// "no errors" instead of "Error Loading Data".
var httpErrorClasses = []string{"4xx", "5xx"}

// SplitStatusCounts splits raw per-status counts into (delivered, inProgress).
//
// Pure, so the split is unit-testable without a database. BOTH values are always
// returned, 0 included: a series that stops being published reads as "no data"
// in a dashboard rather than as zero.
//
// Anything that is not the terminal status counts as in progress — INCLUDING a
// status this code does not know about. That direction is deliberate: a new
// status added to the progression should land in "still in flight" by default
// rather than silently disappear from both series.
func SplitStatusCounts(raw map[string]int64) (delivered, inProgress int64) {
	for status, count := range raw {
		if status == TerminalStatus {
			delivered += count
			continue
		}
		inProgress += count
	}
	return delivered, inProgress
}

// RunTicker publishes the gauge series every interval until ctx is cancelled.
//
// IT SLEEPS FIRST, THEN PUBLISHES. At startup the database may still be
// unreachable, and a tick before the first interval elapses yields only an
// unactionable failure line — noise at exactly the moment the log is being read
// for something else.
//
// A PER-TICK FAILURE IS SWALLOWED AND THE LOOP CONTINUES. This loop has no
// natural end, so a transient database blip or a CloudWatch outage must cost one
// datapoint, not the rest of the process's metrics. Only cancellation ends it.
//
// Start it only when METRICS_ENABLED — the caller decides, so this function has
// no flag inside it.
func RunTicker(ctx context.Context, p Publisher, counts StatusCounter, interval time.Duration, log *slog.Logger) {
	if interval <= 0 {
		interval = 15 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			publishTick(ctx, p, counts, log)
		}
	}
}

// publishTick runs one tick's query and its five publishes inside a metrics-tick
// span.
//
// The loop runs on a timer, outside any request, so without a wrapper every
// tick's SQL and AWS spans would reach the backend as their OWN root traces — 60
// orphans named `connect` and `SELECT tracking` were measured in one hour, which
// buries the real request traces under fragments nobody can attribute.
//
// The span name is shared with Users and events-pipeline on purpose, so one query
// means the same thing in every service. INTERNAL, not CONSUMER: events-pipeline's
// is CONSUMER because EventBridge wakes it; this one is our own timer.
func publishTick(ctx context.Context, p Publisher, counts StatusCounter, log *slog.Logger) {
	ctx, end := tracing.WorkflowSpan(ctx, "metrics-tick",
		attribute.String("app_event", "metrics_tick_started"))

	raw, err := counts.CountByStatus(ctx)
	if err != nil {
		log.ErrorContext(ctx, "metrics_tick_failed",
			slog.String("app_event", "metrics_tick_failed"),
			slog.String("reason", "status_query_failed"),
			slog.String("exception", err.Error()),
		)
		end(err)
		return
	}

	delivered, inProgress := SplitStatusCounts(raw)

	// All three series are published every tick, zeros included.
	p.Publish(ctx, MetricOrdersByStatus, float64(delivered),
		[][2]string{{"Service", ServiceDimension}, {"Status", StatusDelivered}})
	p.Publish(ctx, MetricOrdersByStatus, float64(inProgress),
		[][2]string{{"Service", ServiceDimension}, {"Status", StatusInProgress}})
	p.Publish(ctx, MetricOrdersByStatus, float64(delivered+inProgress),
		[][2]string{{"Service", ServiceDimension}, {"Status", StatusAll}})

	// Seeded at zero so a panel renders "no errors" rather than an error.
	for _, class := range httpErrorClasses {
		p.Publish(ctx, MetricHTTPErrors, 0,
			[][2]string{{"Service", ServiceDimension}, {"StatusClass", class}})
	}

	end(nil)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && gofmt -s -w ./internal/adapter && go test ./internal/adapter/cloudwatch/... -race -v
```

Expected: every subtest `--- PASS`, no race warnings.

- [ ] **Step 5: Commit**

```
feat(tracking): CloudWatch publisher and the pre-summed status-gauge ticker
```

---

## Group C — Cache (Redis)

Runs concurrently with A, B and D. It touches only `internal/adapter/redis/**`.

### Task 13: Cache key builders

**Files:**
- Create: `services/tracking-go/internal/adapter/redis/keys.go`
- Test: `services/tracking-go/internal/adapter/redis/keys_test.go`

**Interfaces:**
- Consumes: `crypto/sha256` only. No config, no client.
- Produces:
  ```go
  func TrackingOrderKey(cognitoSub, userID, orderID string) (string, bool)
  func TrackingListKey(cognitoSub, userID string, orderIDs []string) (string, bool)
  func IdentityKey(cognitoSub string) string
  func UserIndexKey(cognitoSub, userID string) string
  func PrefixOf(key string) string
  const Version = "v1"
  ```

Exact formats, `VERSION = "v1"`:

| Purpose | Key |
|---|---|
| single read | `tracking:order:v1:{cognito_sub}:{user_id}:{order_id}` |
| batch read | `tracking:list:v1:{cognito_sub}:{user_id}:{digest}` |
| identity | `identity:sub-to-user:v1:{cognito_sub}` |
| per-user index (a Redis SET) | `tracking:index:v1:{cognito_sub}:{user_id}` |

`digest` = **first 16 hex chars of sha256** of `sorted(unique(order_ids))` joined by `\n`. Sorting and deduplicating first collapses every ordering and every repetition of one set onto one key, which is both a cardinality bound and a hit-rate improvement. The `\n` separator cannot appear inside an order id, so `["ab","c"]` and `["a","bc"]` cannot collide.

**The digest MUST be a stable hash.** Python notes `PYTHONHASHSEED` salting would make two replicas compute different keys for the same request, so the cache would never hit across them. **In Go, never use `maphash`** (explicitly per-process seeded) and never `hash/fnv` on its own — sha256 is the contract.

**Every response key carries TWO identities.** `cognito_sub` is the ownership key every user-scoped read filters by; `user_id` is the internal `usr_` id. Both travel so a key is unambiguous under either identity model.

**The `cognitoSub` parameter is the RAW `x-user-id` header, not always a Cognito sub.** Clients legitimately send either identifier — Users' `GetUserById` resolves both, and the E2E suite sends the `usr_` id on the direct path. So these are all live key shapes for ONE person:

```
tracking:order:v1:<uuid-sub>:usr_abc:ord_1
tracking:order:v1:usr_abc:usr_abc:ord_1
identity:sub-to-user:v1:<uuid-sub>
identity:sub-to-user:v1:usr_abc
```

The `user_id` segment is stable; the FIRST is not. Assuming otherwise is what let a deleted account's entries survive their full TTL (Task 15).

**A builder answers "no key" when `user_id` is empty.** `user_id` is resolved lazily over gRPC and that resolution is allowed to fail, so a fully authenticated caller can reach a handler with no `user_id`. Formatting an empty segment would produce a key that lies about what it is scoped by, and the index keyed on the same empty value would collapse. The route then **skips caching entirely**: it emits MISS, makes no Redis call, and writes nothing.

`PrefixOf` returns the first **3** colon-segments — the only part of a key that may appear in a span attribute, a metric dimension or a log line. Everything after it is identity.

- [ ] **Step 1: Write the failing test**

`services/tracking-go/internal/adapter/redis/keys_test.go`:
```go
package redis_test

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
)

func TestTrackingOrderKey(t *testing.T) {
	got, ok := cache.TrackingOrderKey("sub-abc", "usr_1", "ord_9")
	if !ok {
		t.Fatal("TrackingOrderKey returned no key for a fully identified request")
	}
	want := "tracking:order:v1:sub-abc:usr_1:ord_9"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestIdentityKey(t *testing.T) {
	if got, want := cache.IdentityKey("sub-abc"), "identity:sub-to-user:v1:sub-abc"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestUserIndexKey(t *testing.T) {
	if got, want := cache.UserIndexKey("sub-abc", "usr_1"), "tracking:index:v1:sub-abc:usr_1"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// An empty user_id means NO KEY: the route then skips caching entirely rather
// than writing a key whose scoping segment is a lie.
func TestBuildersAnswerNoKeyWithoutAUserID(t *testing.T) {
	if key, ok := cache.TrackingOrderKey("sub-abc", "", "ord_9"); ok {
		t.Errorf("TrackingOrderKey built %q with an empty user_id", key)
	}
	if key, ok := cache.TrackingListKey("sub-abc", "", []string{"ord_9"}); ok {
		t.Errorf("TrackingListKey built %q with an empty user_id", key)
	}
}

// Sorting and deduplicating BEFORE hashing collapses every ordering and every
// repetition of one set onto one key.
func TestTrackingListKeyNormalizesBeforeHashing(t *testing.T) {
	a, ok := cache.TrackingListKey("s", "usr_1", []string{"b", "a"})
	if !ok {
		t.Fatal("no key")
	}
	b, _ := cache.TrackingListKey("s", "usr_1", []string{"a", "b"})
	c, _ := cache.TrackingListKey("s", "usr_1", []string{"a", "b", "a"})

	if a != b || b != c {
		t.Errorf("orderings and repetitions produced different keys:\n%s\n%s\n%s", a, b, c)
	}
}

// The digest is sha256 of the newline-joined sorted unique ids, truncated to 16
// hex chars. Recomputed here so the test fails if the algorithm ever changes.
func TestTrackingListKeyDigestIsSHA256(t *testing.T) {
	ids := []string{"ord_b", "ord_a", "ord_b"}
	got, ok := cache.TrackingListKey("sub-abc", "usr_1", ids)
	if !ok {
		t.Fatal("no key")
	}

	sum := sha256.Sum256([]byte("ord_a\nord_b"))
	wantDigest := hex.EncodeToString(sum[:])[:16]
	want := "tracking:list:v1:sub-abc:usr_1:" + wantDigest
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// A stable hash across processes. Python's per-process PYTHONHASHSEED salting
// would make two replicas compute different keys for the same request; in Go the
// equivalent trap is maphash. Two separate computations must agree.
func TestTrackingListKeyIsStableAcrossCalls(t *testing.T) {
	ids := []string{"ord_1", "ord_2", "ord_3"}
	first, _ := cache.TrackingListKey("s", "usr_1", ids)
	for i := 0; i < 50; i++ {
		again, _ := cache.TrackingListKey("s", "usr_1", ids)
		if again != first {
			t.Fatalf("key is not stable: %q then %q", first, again)
		}
	}
}

// The newline separator cannot appear inside an order id, so these cannot
// collide.
func TestTrackingListKeySeparatorPreventsCollision(t *testing.T) {
	a, _ := cache.TrackingListKey("s", "usr_1", []string{"ab", "c"})
	b, _ := cache.TrackingListKey("s", "usr_1", []string{"a", "bc"})
	if a == b {
		t.Errorf("['ab','c'] and ['a','bc'] produced the same key: %q", a)
	}
}

func TestTrackingListKeyWithNoIDs(t *testing.T) {
	got, ok := cache.TrackingListKey("s", "usr_1", nil)
	if !ok {
		t.Fatal("an empty id list is still keyable")
	}
	if !strings.HasPrefix(got, "tracking:list:v1:s:usr_1:") {
		t.Errorf("got %q", got)
	}
}

// PrefixOf keeps the first THREE segments and nothing more. A full key carries
// cognito_sub and user_id; a span, a dimension and a log field are all export
// destinations.
func TestPrefixOf(t *testing.T) {
	tests := []struct {
		key  string
		want string
	}{
		{"tracking:order:v1:sub-abc:usr_1:ord_9", "tracking:order:v1"},
		{"tracking:list:v1:sub-abc:usr_1:abcdef0123456789", "tracking:list:v1"},
		{"identity:sub-to-user:v1:sub-abc", "identity:sub-to-user:v1"},
		{"tracking:index:v1:sub-abc:usr_1", "tracking:index:v1"},
		{"short:key", "short:key"},
		{"", ""},
	}
	for _, tt := range tests {
		t.Run(tt.key, func(t *testing.T) {
			got := cache.PrefixOf(tt.key)
			if got != tt.want {
				t.Errorf("PrefixOf(%q) = %q, want %q", tt.key, got, tt.want)
			}
			if strings.Contains(got, "sub-abc") || strings.Contains(got, "usr_1") {
				t.Errorf("PrefixOf(%q) = %q leaked identity", tt.key, got)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && go test ./internal/adapter/redis/...
```

Expected: `no required module provides package .../internal/adapter/redis`.

- [ ] **Step 3: Write minimal implementation**

`services/tracking-go/internal/adapter/redis/keys.go`:
```go
// Package redis is the cache adapter: key construction, the Redis gateway, the
// identity cache and invalidation.
//
// # Why every response key carries TWO identities
//
// cognito_sub is the ownership key every user-scoped read filters by; user_id is
// the internal usr_ id. Both travel so a key is unambiguous under either identity
// model, and so the per-user index can be reconstructed from either.
//
// # The cognitoSub parameter is the RAW header, not always a Cognito sub
//
// Read this before writing anything that INVALIDATES a key. Every builder here is
// called with the x-user-id header verbatim — whichever identifier the client
// chose to send. Clients legitimately send either: Users' GetUserById resolves the
// Cognito sub and the internal usr_ id alike, which is why the E2E suite sends the
// usr_ id on the direct path. So these are all live key shapes for ONE person:
//
//	tracking:order:v1:<uuid-sub>:usr_abc:ord_1
//	tracking:order:v1:usr_abc:usr_abc:ord_1
//	identity:sub-to-user:v1:<uuid-sub>
//	identity:sub-to-user:v1:usr_abc
//
// The user_id segment is stable (always the resolved usr_ id); the FIRST segment
// is not. Assuming otherwise is what let a deleted account's entries survive
// their full TTL — see InvalidateUser.
//
// # Why a builder may answer "no key"
//
// user_id is resolved lazily over gRPC to Users, and that resolution is allowed to
// fail: enriching a log line must never fail a request. So a fully authenticated
// caller can reach a handler with no user_id. Formatting an empty segment would
// produce a key that LIES about what it is scoped by, and the per-user index keyed
// on the same empty value would collapse. Answering "no key" makes the route skip
// caching for that request entirely: it pays a MISS, serves from MySQL, and writes
// nothing.
//
// # Why the list key is a hash
//
// order_ids is an arbitrary caller-supplied list of up to 100 ids. Keying on the
// raw list would make the key length proportional to the request and the key SPACE
// combinatorial. Sorting and deduplicating first, then hashing, collapses every
// ordering and every repetition of one set onto one fixed-length key.
package redis

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
)

// Version is bumped when a cached DTO's shape changes, which mass-invalidates
// every entry of that shape without touching Redis: the old keys simply stop
// being read and expire on their own TTL.
const Version = "v1"

// prefixSegments is how many colon-separated segments make up a key's PREFIX —
// the only part of a key that may appear in a span attribute, a metric dimension
// or a log line. Everything after it is identity.
const prefixSegments = 3

// digestLength in hex characters. 64 bits, which for a keyspace of at most a few
// million live list entries makes a collision negligible, while keeping the key
// short enough to read in redis-cli.
const digestLength = 16

// TrackingOrderKey builds the key for GET /v1/trackings/{order_id}. The second
// return is false when the request is unkeyable — see the package docstring.
func TrackingOrderKey(cognitoSub, userID, orderID string) (string, bool) {
	if userID == "" {
		return "", false
	}
	return "tracking:order:" + Version + ":" + cognitoSub + ":" + userID + ":" + orderID, true
}

// TrackingListKey builds the key for GET /v1/trackings?order_ids=. Normalizes
// (sort + dedup) BEFORE hashing, so ?order_ids=b,a and ?order_ids=a,b,a are one
// key.
func TrackingListKey(cognitoSub, userID string, orderIDs []string) (string, bool) {
	if userID == "" {
		return "", false
	}
	return "tracking:list:" + Version + ":" + cognitoSub + ":" + userID + ":" + hashOrderIDs(orderIDs), true
}

// IdentityKey builds the key for the identifier -> user_id mapping.
//
// Never answers "no key": this is the cache consulted to OBTAIN a user_id, so it
// cannot require one. That identity is whatever the caller sent, not necessarily
// a Cognito sub — an invalidator must not assume this key is reachable under the
// canonical sub only.
func IdentityKey(cognitoSub string) string {
	return "identity:sub-to-user:" + Version + ":" + cognitoSub
}

// UserIndexKey builds the key of the Redis SET holding this user's live response
// keys.
//
// Required because a list key embeds a HASH of an arbitrary id list and therefore
// cannot be reconstructed at invalidation time. KEYS and SCAN are the wrong
// answer: both are O(N) over the whole keyspace, and KEYS blocks the server while
// it runs.
//
// Same warning as IdentityKey: the first segment is the RAW header value, so one
// person can own more than one index.
func UserIndexKey(cognitoSub, userID string) string {
	return "tracking:index:" + Version + ":" + cognitoSub + ":" + userID
}

// PrefixOf returns the telemetry-safe prefix: everything up to and including v1.
//
// A full key carries cognito_sub and user_id. A span is an export destination
// like any other, and a CloudWatch dimension VALUE is cardinality the account is
// billed for, so neither ever sees more than this.
func PrefixOf(key string) string {
	parts := strings.Split(key, ":")
	if len(parts) <= prefixSegments {
		return key
	}
	return strings.Join(parts[:prefixSegments], ":")
}

// hashOrderIDs normalizes then hashes: sorted, deduplicated, newline-joined,
// sha256, truncated.
//
// The newline join is a separator that cannot appear inside an order id, so
// ["ab","c"] and ["a","bc"] cannot collide.
//
// sha256 rather than a runtime hash: Go's maphash is explicitly per-process
// seeded (as Python's str hash is under PYTHONHASHSEED), so two replicas would
// compute DIFFERENT keys for the same request and the cache would never hit
// across them. Never use maphash here.
func hashOrderIDs(orderIDs []string) string {
	seen := make(map[string]struct{}, len(orderIDs))
	unique := make([]string, 0, len(orderIDs))
	for _, id := range orderIDs {
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
	}
	sort.Strings(unique)

	sum := sha256.Sum256([]byte(strings.Join(unique, "\n")))
	return hex.EncodeToString(sum[:])[:digestLength]
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && gofmt -s -w ./internal/adapter/redis && go test ./internal/adapter/redis/... -v
```

Expected: every subtest `--- PASS`.

- [ ] **Step 5: Commit**

```
feat(tracking): cache key builders with sha256 list digests and prefix redaction
```

---

### Task 14: The cache gateway, the Redis client, and `X-Cache` semantics

**Files:**
- Create: `services/tracking-go/internal/adapter/redis/gateway.go`
- Create: `services/tracking-go/internal/adapter/redis/client.go`
- Test: `services/tracking-go/internal/adapter/redis/gateway_test.go`

**Interfaces:**
- Consumes: `github.com/redis/go-redis/v9`, `cloudwatch.Publisher` (Task 12), `otel` tracer (Task 11).
- Produces:
  ```go
  type Entry struct {
      Hit          bool
      Value        []byte
      TTLRemaining int   // seconds; 0 means unknown
      Bypassed     bool
  }
  type Gateway interface {
      Get(ctx context.Context, key string) Entry
      Set(ctx context.Context, key string, value any, ttl time.Duration, indexKey string)
      Invalidate(ctx context.Context, keys ...string)
      InvalidateIndex(ctx context.Context, indexKey string)
  }
  func NewGateway(client RedisLike, metrics cloudwatch.Publisher, log *slog.Logger) Gateway
  func NewNullGateway() Gateway
  func NewClient(host string, port, timeoutMS int) *goredis.Client
  ```

**TTLs:** read entries **60s**; identity **3600s**; index SET **3600s**. The index TTL is deliberately **longer than any entry it tracks**, so the index can never expire out from under keys it is the only handle on — an index that expired first would leave orphaned entries no invalidation could reach, and they would serve stale data for the remainder of their own TTL.

**`X-Cache` header values exactly `HIT` / `MISS` / `BYPASS`, uppercase.** Plus `X-Cache-TTL` (decimal string of remaining seconds) **only on HIT and only when the TTL is known** — Redis answers `-1` for a key with no expiry and `-2` for one that no longer exists; neither is a duration, so both mean "unknown" and the header is omitted. When `CACHE_ENABLED=false`, emit **no `X-Cache` header at all** — not MISS, not BYPASS.

**Three outcomes, not two.** A MISS means "Redis answered, and had nothing"; a BYPASS means "Redis did not answer". Collapsing them would make an outage read as a poor hit rate on the dashboard, which is the one reading that would send an operator to look at the wrong system.

- A **malformed cached payload is a MISS** (not BYPASS), logged `cache_entry_unreadable` / `reason=malformed_payload`. Redis is fine; the *entry* is not, so the right answer is to recompute and overwrite it.
- **Any other Redis failure is BYPASS**, logged `cache_unavailable` / `reason=redis_unavailable`. `exc_info`/stack traces are deliberately off: a Redis outage produces one of these per request, and a stack trace per request buries every other signal.
- **The gateway NEVER returns an error to the handler.** A cache is an optimization, and an optimization that can fail a request is a liability.

**Redis client:** same timeout budget for connect and socket from `CACHE_TIMEOUT_MS` (default 50ms), **retries DISABLED** — a retry would spend the budget twice, turning the fail-open guarantee into a 100ms one on exactly the path the cache exists to speed up. When `CACHE_ENABLED=false`, **construct no client at all** — use the null gateway, so a service running with the cache off needs no reachable Redis to start.

**Spans:** `cache.get` / `cache.set` / `cache.invalidate` / `cache.invalidate_index`, all **CLIENT** kind, attributes `cache.key_prefix` (never the full key), `cache.result`, `cache.ttl_remaining`, `cache.key_count`. Spans are hand-written rather than taken from an instrumentation package: `cache.result` and `cache.ttl_remaining` are business facts, not transport facts, and no instrumentation can know them.

`InvalidateIndex` uses **SMEMBERS + DEL**, explicitly **not** `KEYS`/`SCAN`.

- [ ] **Step 1: Write the failing test**

`services/tracking-go/internal/adapter/redis/gateway_test.go`:
```go
package redis_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/cloudwatch"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// live starts a miniredis and returns a gateway over it.
func live(t *testing.T) (cache.Gateway, *miniredis.Miniredis) {
	t.Helper()
	server := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return cache.NewGateway(client, cloudwatch.NewNoopPublisher(), quiet()), server
}

func TestGetMissThenSetThenHit(t *testing.T) {
	gw, _ := live(t)
	ctx := context.Background()
	key := "tracking:order:v1:sub:usr_1:ord_1"

	if entry := gw.Get(ctx, key); entry.Hit || entry.Bypassed {
		t.Fatalf("cold key: Hit=%v Bypassed=%v, want a plain MISS", entry.Hit, entry.Bypassed)
	}

	gw.Set(ctx, key, map[string]string{"order_id": "ord_1"}, 60*time.Second, "")

	entry := gw.Get(ctx, key)
	if !entry.Hit {
		t.Fatal("expected a HIT after Set")
	}
	if !strings.Contains(string(entry.Value), `"order_id":"ord_1"`) {
		t.Errorf("Value = %s", entry.Value)
	}
	if entry.TTLRemaining <= 0 || entry.TTLRemaining > 60 {
		t.Errorf("TTLRemaining = %d, want 1..60", entry.TTLRemaining)
	}
}

// Redis -1 (no expiry) and -2 (gone) both mean "unknown": omit X-Cache-TTL.
func TestTTLUnknownIsZero(t *testing.T) {
	gw, server := live(t)
	ctx := context.Background()
	key := "tracking:order:v1:sub:usr_1:ord_1"

	// Written with no expiry at all -> Redis answers -1.
	server.Set(key, `{"order_id":"ord_1"}`)

	entry := gw.Get(ctx, key)
	if !entry.Hit {
		t.Fatal("expected a HIT")
	}
	if entry.TTLRemaining != 0 {
		t.Errorf("TTLRemaining = %d for a key with no expiry, want 0 (unknown, header omitted)", entry.TTLRemaining)
	}
}

// A malformed payload is a MISS, not a BYPASS: Redis is fine, the ENTRY is not,
// so the right answer is to recompute and overwrite it.
func TestMalformedPayloadIsAMissNotABypass(t *testing.T) {
	gw, server := live(t)
	ctx := context.Background()
	key := "tracking:order:v1:sub:usr_1:ord_1"

	server.Set(key, "{not json")

	entry := gw.Get(ctx, key)
	if entry.Hit {
		t.Error("a malformed payload must not be a HIT")
	}
	if entry.Bypassed {
		t.Error("a malformed payload is a MISS, not a BYPASS: collapsing them makes an outage read as a poor hit rate")
	}
}

// Any OTHER Redis failure is a BYPASS.
func TestRedisFailureIsABypass(t *testing.T) {
	server := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: server.Addr()})
	gw := cache.NewGateway(client, cloudwatch.NewNoopPublisher(), quiet())

	server.Close() // the server is now unreachable

	entry := gw.Get(context.Background(), "tracking:order:v1:sub:usr_1:ord_1")
	if entry.Hit {
		t.Error("an unreachable Redis must not report a HIT")
	}
	if !entry.Bypassed {
		t.Error("an unreachable Redis must report a BYPASS, distinguishable from a MISS")
	}
}

// The gateway never returns an error to the handler — every method's signature
// makes that structural, and none of them may panic against a dead server.
func TestGatewayNeverFailsTheCaller(t *testing.T) {
	server := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: server.Addr()})
	gw := cache.NewGateway(client, cloudwatch.NewNoopPublisher(), quiet())
	server.Close()

	ctx := context.Background()
	gw.Get(ctx, "tracking:order:v1:s:u:o")
	gw.Set(ctx, "tracking:order:v1:s:u:o", map[string]string{"a": "b"}, time.Minute, "tracking:index:v1:s:u")
	gw.Invalidate(ctx, "tracking:order:v1:s:u:o")
	gw.InvalidateIndex(ctx, "tracking:index:v1:s:u")
}

// Set records the key in the per-user index SET and gives the SET its own,
// LONGER TTL — an index that expired first would orphan the entries it is the
// only handle on.
func TestSetRecordsTheKeyInTheIndexWithALongerTTL(t *testing.T) {
	gw, server := live(t)
	ctx := context.Background()
	key := "tracking:list:v1:sub:usr_1:abcdef0123456789"
	indexKey := "tracking:index:v1:sub:usr_1"

	gw.Set(ctx, key, []string{"ord_1"}, 60*time.Second, indexKey)

	members, err := server.SMembers(indexKey)
	if err != nil {
		t.Fatalf("index SET missing: %v", err)
	}
	if len(members) != 1 || members[0] != key {
		t.Errorf("index members = %v, want [%s]", members, key)
	}

	entryTTL := server.TTL(key)
	indexTTL := server.TTL(indexKey)
	if indexTTL <= entryTTL {
		t.Errorf("index TTL %v is not longer than the entry TTL %v; the index must never expire first", indexTTL, entryTTL)
	}
	if indexTTL != time.Hour {
		t.Errorf("index TTL = %v, want 1h", indexTTL)
	}
}

// InvalidateIndex deletes every member and then the SET, using SMEMBERS+DEL —
// never KEYS/SCAN, both of which are O(N) over the whole keyspace.
func TestInvalidateIndexDeletesMembersAndTheSet(t *testing.T) {
	gw, server := live(t)
	ctx := context.Background()
	indexKey := "tracking:index:v1:sub:usr_1"
	a := "tracking:list:v1:sub:usr_1:aaaaaaaaaaaaaaaa"
	b := "tracking:order:v1:sub:usr_1:ord_2"

	gw.Set(ctx, a, []string{"x"}, time.Minute, indexKey)
	gw.Set(ctx, b, map[string]string{"y": "z"}, time.Minute, indexKey)

	gw.InvalidateIndex(ctx, indexKey)

	for _, key := range []string{a, b, indexKey} {
		if server.Exists(key) {
			t.Errorf("%s survived InvalidateIndex", key)
		}
	}
}

func TestInvalidateDeletesNamedKeysAndToleratesAbsentOnes(t *testing.T) {
	gw, server := live(t)
	ctx := context.Background()
	key := "tracking:order:v1:sub:usr_1:ord_1"

	gw.Set(ctx, key, map[string]string{"a": "b"}, time.Minute, "")
	gw.Invalidate(ctx, key, "tracking:order:v1:sub:usr_1:never_written")

	if server.Exists(key) {
		t.Error("the named key survived Invalidate")
	}
}

func TestInvalidateWithNoKeysIsANoop(t *testing.T) {
	gw, _ := live(t)
	gw.Invalidate(context.Background())
}

// The null gateway is what CACHE_ENABLED=false binds. Its Get is a plain MISS
// with Bypassed=false, and the routes read the flag to decide whether to emit a
// header at all — so a disabled cache emits NO X-Cache header.
func TestNullGateway(t *testing.T) {
	gw := cache.NewNullGateway()
	ctx := context.Background()

	entry := gw.Get(ctx, "tracking:order:v1:s:u:o")
	if entry.Hit {
		t.Error("the null gateway must never report a HIT")
	}
	if entry.Bypassed {
		t.Error("the null gateway reports a plain MISS, not a BYPASS")
	}
	gw.Set(ctx, "k", "v", time.Minute, "i")
	gw.Invalidate(ctx, "k")
	gw.InvalidateIndex(ctx, "i")
}

// Both timeouts share one budget, and retries are DISABLED: a retry would spend
// the budget twice, turning a 50ms fail-open guarantee into a 100ms one.
func TestNewClientTimeoutsAndRetries(t *testing.T) {
	client := cache.NewClient("localhost", 6379, 50)
	t.Cleanup(func() { _ = client.Close() })

	opts := client.Options()
	want := 50 * time.Millisecond
	if opts.DialTimeout != want {
		t.Errorf("DialTimeout = %v, want %v", opts.DialTimeout, want)
	}
	if opts.ReadTimeout != want {
		t.Errorf("ReadTimeout = %v, want %v", opts.ReadTimeout, want)
	}
	if opts.WriteTimeout != want {
		t.Errorf("WriteTimeout = %v, want %v", opts.WriteTimeout, want)
	}
	// go-redis disables retries with -1; 0 means "use the default of 3".
	if opts.MaxRetries != -1 {
		t.Errorf("MaxRetries = %d, want -1 (disabled); a retry doubles the timeout budget", opts.MaxRetries)
	}
	if opts.Addr != "localhost:6379" {
		t.Errorf("Addr = %q", opts.Addr)
	}
}

// Redis errors reach the caller as a BYPASS and are logged with a
// machine-readable reason, but never with a stack trace: an outage produces one
// of these per request.
func TestBypassIsLoggedWithAReason(t *testing.T) {
	var buf strings.Builder
	server := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: server.Addr()})
	gw := cache.NewGateway(client, cloudwatch.NewNoopPublisher(),
		slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	server.Close()

	gw.Get(context.Background(), "tracking:order:v1:sub-abc:usr_1:ord_1")

	out := buf.String()
	if !strings.Contains(out, "cache_unavailable") {
		t.Errorf("no cache_unavailable line in: %s", out)
	}
	if !strings.Contains(out, "redis_unavailable") {
		t.Errorf("no reason=redis_unavailable in: %s", out)
	}
	// The full key embeds identity; only the prefix may be logged.
	if strings.Contains(out, "sub-abc") || strings.Contains(out, "usr_1") {
		t.Errorf("the log line leaked identity from the key: %s", out)
	}
	if !strings.Contains(out, "tracking:order:v1") {
		t.Errorf("the log line should carry the redacted prefix: %s", out)
	}
}

var _ = errors.New // keep the import if a future case needs it
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && go test ./internal/adapter/redis/...
```

Expected: `undefined: cache.NewGateway`, `undefined: cache.NewClient`, `undefined: cache.NewNullGateway`, plus missing `miniredis`/`go-redis` modules.

- [ ] **Step 3: Write minimal implementation**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && \
go get github.com/redis/go-redis/v9 && go get -t github.com/alicebob/miniredis/v2
```

`services/tracking-go/internal/adapter/redis/gateway.go`:
```go
package redis

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel/attribute"
	oteltrace "go.opentelemetry.io/otel/trace"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/cloudwatch"
	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
)

// The three X-Cache values, exactly as they appear on the wire. Uppercase.
const (
	ResultHit    = "hit"
	ResultMiss   = "miss"
	ResultBypass = "bypass"

	HeaderHit    = "HIT"
	HeaderMiss   = "MISS"
	HeaderBypass = "BYPASS"
)

// TTLs. The index SET's is deliberately LONGER than any entry it tracks: an
// index that expired FIRST would leave orphaned entries no invalidation could
// ever reach, and they would then serve stale data for the remainder of their own
// TTL. Short enough that a user who stops reading does not leave a SET forever.
const (
	EntryTTL    = 60 * time.Second
	IdentityTTL = time.Hour
	IndexTTL    = time.Hour
)

// RedisLike is the subset of the go-redis API this gateway uses, declared here
// by the consumer so miniredis-backed clients and hand-written doubles satisfy
// it without inheritance.
type RedisLike interface {
	Get(ctx context.Context, key string) *goredis.StringCmd
	Set(ctx context.Context, key string, value any, ttl time.Duration) *goredis.StatusCmd
	Del(ctx context.Context, keys ...string) *goredis.IntCmd
	TTL(ctx context.Context, key string) *goredis.DurationCmd
	SAdd(ctx context.Context, key string, members ...any) *goredis.IntCmd
	SMembers(ctx context.Context, key string) *goredis.StringSliceCmd
	Expire(ctx context.Context, key string, ttl time.Duration) *goredis.BoolCmd
}

// Entry is the outcome of a Get.
//
// THREE states, and Bypassed is why there are three rather than two: a MISS
// means "Redis answered, and had nothing"; a BYPASS means "Redis did not
// answer". Collapsing them would make an outage read as a poor hit rate on the
// dashboard, which is the one reading that would send an operator to look at the
// wrong system.
type Entry struct {
	Hit   bool
	Value []byte
	// TTLRemaining in seconds. ZERO means UNKNOWN: Redis answers -1 for a key
	// with no expiry and -2 for one that no longer exists, and neither is a
	// duration — the route then omits X-Cache-TTL entirely.
	TTLRemaining int
	Bypassed     bool
}

// Gateway reads, writes and invalidates cache entries. No method returns an
// error: a cache is an optimization, and an optimization that can fail a request
// is a liability.
type Gateway interface {
	Get(ctx context.Context, key string) Entry
	Set(ctx context.Context, key string, value any, ttl time.Duration, indexKey string)
	Invalidate(ctx context.Context, keys ...string)
	InvalidateIndex(ctx context.Context, indexKey string)
}

type gateway struct {
	client  RedisLike
	metrics cloudwatch.Publisher
	log     *slog.Logger
}

// NewGateway builds the real gateway.
//
// The spans below are hand-written rather than taken from an instrumentation
// package, and deliberately: cache.result and cache.ttl_remaining are BUSINESS
// facts, not transport facts, and no instrumentation can know them.
//
// The full key never leaves this file. Every response key embeds cognito_sub and
// user_id; a span attribute, a metric dimension and a log field are all export
// destinations, so all three receive PrefixOf(key) and nothing more. The rule is
// enforced by there being exactly one place — this file — holding both the key
// and a telemetry call.
func NewGateway(client RedisLike, metrics cloudwatch.Publisher, log *slog.Logger) Gateway {
	if log == nil {
		log = slog.Default()
	}
	return &gateway{client: client, metrics: metrics, log: log}
}

func (g *gateway) Get(ctx context.Context, key string) Entry {
	prefix := PrefixOf(key)
	started := time.Now()

	ctx, span := tracing.Tracer(tracing.TracerCache).Start(ctx, "cache.get",
		oteltrace.WithSpanKind(oteltrace.SpanKindClient),
		oteltrace.WithAttributes(attribute.String("cache.key_prefix", prefix)),
	)
	defer span.End()

	raw, err := g.client.Get(ctx, key).Bytes()
	switch {
	case errors.Is(err, goredis.Nil):
		span.SetAttributes(attribute.String("cache.result", ResultMiss))
		g.record(ctx, ResultMiss, prefix, "get", started)
		return Entry{}
	case err != nil:
		span.SetAttributes(attribute.String("cache.result", ResultBypass))
		g.warnUnavailable(ctx, "get", prefix)
		g.record(ctx, ResultBypass, prefix, "get", started)
		return Entry{Bypassed: true}
	}

	// A payload Redis returned but JSON cannot parse: a truncated write, a key
	// someone else wrote, a shape predating a v1 bump. Treated as a MISS, NOT a
	// BYPASS — Redis is fine, the ENTRY is not, so the right answer is to
	// recompute and overwrite it.
	if !json.Valid(raw) {
		span.SetAttributes(attribute.String("cache.result", ResultMiss))
		g.log.WarnContext(ctx, "cache_entry_unreadable",
			slog.String("app_event", "cache_entry_unreadable"),
			slog.String("reason", "malformed_payload"),
			slog.String("cache_key_prefix", prefix),
		)
		g.record(ctx, ResultMiss, prefix, "get", started)
		return Entry{}
	}

	ttl := g.readTTL(ctx, key)
	span.SetAttributes(attribute.String("cache.result", ResultHit))
	if ttl > 0 {
		span.SetAttributes(attribute.Int("cache.ttl_remaining", ttl))
	}
	g.record(ctx, ResultHit, prefix, "get", started)
	return Entry{Hit: true, Value: raw, TTLRemaining: ttl}
}

func (g *gateway) Set(ctx context.Context, key string, value any, ttl time.Duration, indexKey string) {
	prefix := PrefixOf(key)
	started := time.Now()

	ctx, span := tracing.Tracer(tracing.TracerCache).Start(ctx, "cache.set",
		oteltrace.WithSpanKind(oteltrace.SpanKindClient),
		oteltrace.WithAttributes(
			attribute.String("cache.key_prefix", prefix),
			attribute.Int("cache.ttl_remaining", int(ttl.Seconds())),
		),
	)
	defer span.End()
	defer g.record(ctx, "", prefix, "set", started)

	encoded, err := json.Marshal(value)
	if err != nil {
		g.warnUnavailable(ctx, "set", prefix)
		return
	}
	if err := g.client.Set(ctx, key, encoded, ttl).Err(); err != nil {
		g.warnUnavailable(ctx, "set", prefix)
		return
	}
	if indexKey == "" {
		return
	}
	if err := g.client.SAdd(ctx, indexKey, key).Err(); err != nil {
		g.warnUnavailable(ctx, "set", prefix)
		return
	}
	// Deliberately longer than any entry it indexes — see IndexTTL.
	if err := g.client.Expire(ctx, indexKey, IndexTTL).Err(); err != nil {
		g.warnUnavailable(ctx, "set", prefix)
	}
}

func (g *gateway) Invalidate(ctx context.Context, keys ...string) {
	if len(keys) == 0 {
		return
	}
	prefix := PrefixOf(keys[0])
	started := time.Now()

	ctx, span := tracing.Tracer(tracing.TracerCache).Start(ctx, "cache.invalidate",
		oteltrace.WithSpanKind(oteltrace.SpanKindClient),
		oteltrace.WithAttributes(
			attribute.String("cache.key_prefix", prefix),
			attribute.Int("cache.key_count", len(keys)),
		),
	)
	defer span.End()
	defer g.record(ctx, "", prefix, "invalidate", started)

	// Deleting an absent key is fine, and not an error.
	if err := g.client.Del(ctx, keys...).Err(); err != nil {
		g.warnUnavailable(ctx, "invalidate", prefix)
	}
}

// InvalidateIndex deletes every key the index names, then the index itself.
//
// This is the answer to "the list key embeds a hash I cannot reconstruct".
// KEYS/SCAN would be the other answer and is the wrong one: both are O(N) over
// the ENTIRE keyspace, KEYS blocks the server for the duration of the sweep, and
// neither is acceptable on a write path — every carrier callback would pay for
// the size of the whole cache.
func (g *gateway) InvalidateIndex(ctx context.Context, indexKey string) {
	prefix := PrefixOf(indexKey)
	started := time.Now()

	ctx, span := tracing.Tracer(tracing.TracerCache).Start(ctx, "cache.invalidate_index",
		oteltrace.WithSpanKind(oteltrace.SpanKindClient),
		oteltrace.WithAttributes(attribute.String("cache.key_prefix", prefix)),
	)
	defer span.End()
	defer g.record(ctx, "", prefix, "invalidate_index", started)

	members, err := g.client.SMembers(ctx, indexKey).Result()
	if err != nil {
		g.warnUnavailable(ctx, "invalidate_index", prefix)
		return
	}
	span.SetAttributes(attribute.Int("cache.key_count", len(members)))

	if len(members) > 0 {
		if err := g.client.Del(ctx, members...).Err(); err != nil {
			g.warnUnavailable(ctx, "invalidate_index", prefix)
			return
		}
	}
	if err := g.client.Del(ctx, indexKey).Err(); err != nil {
		g.warnUnavailable(ctx, "invalidate_index", prefix)
	}
}

// readTTL returns the seconds left on key, or 0 when Redis will not say.
//
// go-redis maps Redis's -1 (no expiry) and -2 (gone) onto negative durations;
// neither is a duration the caller can publish, so both become 0 and the route
// simply omits X-Cache-TTL.
func (g *gateway) readTTL(ctx context.Context, key string) int {
	ttl, err := g.client.TTL(ctx, key).Result()
	if err != nil || ttl <= 0 {
		return 0
	}
	return int(ttl.Seconds())
}

// warnUnavailable emits one WARN per failed operation, with a machine-readable
// reason.
//
// app_event=cache_unavailable is the token a dashboard alerts on. A stack trace
// is deliberately omitted: a Redis outage produces one of these per request, and
// a trace per request buries every other signal in the stream.
func (g *gateway) warnUnavailable(ctx context.Context, operation, prefix string) {
	g.log.WarnContext(ctx, "cache_unavailable",
		slog.String("app_event", "cache_unavailable"),
		slog.String("reason", "redis_unavailable"),
		slog.String("cache_operation", operation),
		slog.String("cache_key_prefix", prefix),
	)
}

// record publishes the two metrics for one operation. The publisher's contract
// is that it never fails, so there is no error handling here.
func (g *gateway) record(ctx context.Context, result, prefix, operation string, started time.Time) {
	if result != "" {
		g.metrics.Publish(ctx, cloudwatch.MetricCacheRequests, 1, [][2]string{
			{"Service", cloudwatch.ServiceDimension},
			{"KeyPrefix", prefix},
			{"Result", result},
		})
	}
	g.metrics.Publish(ctx, cloudwatch.MetricCacheOperationDuration,
		float64(time.Since(started).Microseconds())/1000.0,
		[][2]string{
			{"Service", cloudwatch.ServiceDimension},
			{"Operation", operation},
		})
}

// nullGateway is the binding used when CACHE_ENABLED=false.
//
// NOT a gateway with a flag inside it: a null object means the routes have
// exactly one code path, and "the cache is off" is expressed by which object is
// bound rather than by a branch in every handler. Its Get returns a plain MISS
// with Bypassed=false, and the routes read the flag to decide whether to emit a
// header at all — so a disabled cache emits NO X-Cache header, never MISS and
// never BYPASS.
type nullGateway struct{}

// NewNullGateway returns the no-op gateway.
func NewNullGateway() Gateway { return nullGateway{} }

func (nullGateway) Get(context.Context, string) Entry                            { return Entry{} }
func (nullGateway) Set(context.Context, string, any, time.Duration, string)      {}
func (nullGateway) Invalidate(context.Context, ...string)                        {}
func (nullGateway) InvalidateIndex(context.Context, string)                      {}
```

`services/tracking-go/internal/adapter/redis/client.go`:
```go
package redis

import (
	"strconv"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// NewClient builds the process-wide Redis client.
//
// BOTH timeouts get the SAME budget: a connect that takes longer than the
// operation is allowed to take has already blown it, so there is no reason to
// give the two different numbers.
//
// MaxRetries is -1, which is how go-redis spells "disabled" (0 means "use the
// default of 3"). That is load-bearing rather than a default worth restating: a
// retry would spend the budget TWICE, turning the 50ms fail-open guarantee into a
// 100ms one on exactly the path the cache exists to speed up.
//
// Call this ONLY when CACHE_ENABLED is true. With the cache disabled, nothing
// should build a client at all — bind NewNullGateway instead, so a service
// running with CACHE_ENABLED=false needs no reachable Redis to start.
func NewClient(host string, port, timeoutMS int) *goredis.Client {
	budget := time.Duration(timeoutMS) * time.Millisecond
	return goredis.NewClient(&goredis.Options{
		Addr:         host + ":" + strconv.Itoa(port),
		DialTimeout:  budget,
		ReadTimeout:  budget,
		WriteTimeout: budget,
		MaxRetries:   -1,
	})
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && gofmt -s -w ./internal/adapter/redis && go test ./internal/adapter/redis/... -race -v
```

Expected: every subtest `--- PASS`.

- [ ] **Step 5: Commit**

```
feat(tracking): fail-open Redis cache gateway with HIT/MISS/BYPASS semantics
```

---

### Task 15: Identity cache and invalidation

**Files:**
- Create: `services/tracking-go/internal/adapter/redis/identity.go`
- Create: `services/tracking-go/internal/adapter/redis/invalidation.go`
- Test: `services/tracking-go/internal/adapter/redis/identity_test.go`
- Test: `services/tracking-go/internal/adapter/redis/invalidation_test.go`

**Interfaces:**
- Consumes: `Gateway` (Task 14), the key builders (Task 13).
- Produces:
  ```go
  type IdentityCache struct{ /* … */ }
  func NewIdentityCache(gw Gateway) *IdentityCache
  func (c *IdentityCache) Resolve(ctx context.Context, cognitoSub string, loader func(context.Context) (string, error)) string

  func InvalidateTracking(ctx context.Context, gw Gateway, log *slog.Logger, orderID, cognitoSub, userID string)
  func InvalidateUser(ctx context.Context, gw Gateway, log *slog.Logger, cognitoSub, userID string)
  ```

**`InvalidateTracking`** — the carrier webhook, one order changed status:
- Skip with `cache_invalidation_skipped` / `reason=no_owner_sub` when the sub is empty. The column is nullable: such a row is unreachable over both user-scoped reads (the filter compares against a sub, and NULL matches nobody), so a row that can never be read can never have been cached.
- Skip with `reason=no_owner_user_id` when `userID` is empty. Both key shapes embed `user_id`; without one there is nothing addressable to delete, and building `tracking:index:v1:<sub>:` would delete a key nobody ever wrote — which reads as a successful invalidation while evicting nothing.
- Otherwise: delete the single read key, then delete **every member of the user's index SET and the SET itself**. **SMEMBERS + DEL, explicitly not `KEYS`/`SCAN`** — both are O(N) over the entire keyspace and `KEYS` blocks the server, so putting either on a write path makes every carrier callback pay for the size of the whole cache.

**`InvalidateUser`** — the account-deletion cascade. It sweeps **both identifiers in the FIRST key position** (deduplicated, order-preserving), because that segment is the raw `x-user-id` header, which may be a Cognito sub OR a `usr_` id. Sweeping only the canonical pair leaked deleted-account data for its full TTL — **verified live in Orders**, which has the identical design: the cascade logged success, the deletion returned 204, the key count did not move, and a re-read answered `X-Cache: HIT` with the deleted user's data.

Reachable keys, given canonical `(<sub>, usr_x)`:
```
tracking:index:v1:<sub>:usr_x
tracking:index:v1:usr_x:usr_x
identity:sub-to-user:v1:<sub>
identity:sub-to-user:v1:usr_x
```
`user_id` is always the canonical `usr_` id in the SECOND position, so the first position is the only one that varies.

> **Known limitation, accepted deliberately.** Sweeping both identifiers fixes the leak but not its cause: the same person still gets a separate set of entries depending on which identifier they authenticated with. Normalizing every key onto the canonical sub would fix both and was considered and not chosen. If the duplication ever shows up as a memory or hit-rate problem, normalization is the fix.

**Identity cache: NEGATIVES ARE NEVER CACHED.** A loader failure returns "not found" and is re-asked next request. Caching it would keep a real user's `user_id` out of their keys for an hour after the cause cleared — and because the key builders skip caching entirely without a `user_id`, it would quietly disable the response cache for that caller for the whole hour. Re-asking costs exactly the call the request would have made anyway.

- [ ] **Step 1: Write the failing test**

`services/tracking-go/internal/adapter/redis/identity_test.go`:
```go
package redis_test

import (
	"context"
	"errors"
	"testing"

	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
)

func TestIdentityCacheMissThenLoadThenHit(t *testing.T) {
	gw, _ := live(t)
	ic := cache.NewIdentityCache(gw)
	ctx := context.Background()

	calls := 0
	loader := func(context.Context) (string, error) {
		calls++
		return "usr_abc", nil
	}

	if got := ic.Resolve(ctx, "sub-1", loader); got != "usr_abc" {
		t.Fatalf("first Resolve = %q, want usr_abc", got)
	}
	if got := ic.Resolve(ctx, "sub-1", loader); got != "usr_abc" {
		t.Fatalf("second Resolve = %q, want usr_abc", got)
	}
	if calls != 1 {
		t.Errorf("the loader ran %d times, want 1 — the second call must hit the cache", calls)
	}
}

// NEGATIVES ARE NEVER CACHED. Caching one would keep a real user's user_id out
// of their keys for an hour after the cause cleared, silently disabling the
// response cache for that caller.
func TestIdentityCacheNeverCachesANegative(t *testing.T) {
	gw, server := live(t)
	ic := cache.NewIdentityCache(gw)
	ctx := context.Background()

	calls := 0
	failing := func(context.Context) (string, error) {
		calls++
		return "", errors.New("users is unreachable")
	}

	if got := ic.Resolve(ctx, "sub-1", failing); got != "" {
		t.Fatalf("Resolve = %q, want empty on a failed load", got)
	}
	if server.Exists(cache.IdentityKey("sub-1")) {
		t.Fatal("a negative answer was written to Redis; negatives are never cached")
	}

	// Re-asked next request.
	ic.Resolve(ctx, "sub-1", failing)
	if calls != 2 {
		t.Errorf("the loader ran %d times, want 2 — a negative must be re-asked", calls)
	}
}

// A loader returning "not found" with no error is also a negative.
func TestIdentityCacheEmptyAnswerIsNotCached(t *testing.T) {
	gw, server := live(t)
	ic := cache.NewIdentityCache(gw)

	ic.Resolve(context.Background(), "sub-1", func(context.Context) (string, error) { return "", nil })

	if server.Exists(cache.IdentityKey("sub-1")) {
		t.Fatal("an empty answer was cached")
	}
}

// The stored value is a BARE JSON string, so redis-cli shows "usr_abc".
func TestIdentityCacheStoresABareJSONString(t *testing.T) {
	gw, server := live(t)
	ic := cache.NewIdentityCache(gw)

	ic.Resolve(context.Background(), "sub-1", func(context.Context) (string, error) { return "usr_abc", nil })

	got, err := server.Get(cache.IdentityKey("sub-1"))
	if err != nil {
		t.Fatalf("identity key missing: %v", err)
	}
	if got != `"usr_abc"` {
		t.Errorf("stored %q, want a bare JSON string %q", got, `"usr_abc"`)
	}
}

// A gateway BYPASS still resolves through the loader — the cache never fails a
// request.
func TestIdentityCacheFallsBackWhenRedisIsDown(t *testing.T) {
	ic := cache.NewIdentityCache(cache.NewNullGateway())

	got := ic.Resolve(context.Background(), "sub-1",
		func(context.Context) (string, error) { return "usr_abc", nil })
	if got != "usr_abc" {
		t.Errorf("Resolve = %q, want usr_abc via the loader", got)
	}
}
```

`services/tracking-go/internal/adapter/redis/invalidation_test.go`:
```go
package redis_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"log/slog"

	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
)

func TestInvalidateTrackingDeletesTheReadKeyAndTheIndex(t *testing.T) {
	gw, server := live(t)
	ctx := context.Background()
	sub, userID, orderID := "sub-1", "usr_1", "ord_9"

	single, _ := cache.TrackingOrderKey(sub, userID, orderID)
	list, _ := cache.TrackingListKey(sub, userID, []string{"ord_9", "ord_8"})
	indexKey := cache.UserIndexKey(sub, userID)

	gw.Set(ctx, single, map[string]string{"a": "b"}, time.Minute, indexKey)
	gw.Set(ctx, list, []string{"x"}, time.Minute, indexKey)

	cache.InvalidateTracking(ctx, gw, quiet(), orderID, sub, userID)

	for _, key := range []string{single, list, indexKey} {
		if server.Exists(key) {
			t.Errorf("%s survived InvalidateTracking", key)
		}
	}
}

// An empty sub is a NO-OP, and safe: a row with a NULL cognito_sub is
// unreachable over both user-scoped reads, so it can never have been cached.
func TestInvalidateTrackingSkipsWithoutASub(t *testing.T) {
	gw, _ := live(t)
	var buf strings.Builder
	log := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	cache.InvalidateTracking(context.Background(), gw, log, "ord_9", "", "usr_1")

	out := buf.String()
	if !strings.Contains(out, "cache_invalidation_skipped") {
		t.Errorf("no cache_invalidation_skipped line: %s", out)
	}
	if !strings.Contains(out, "no_owner_sub") {
		t.Errorf("reason must be no_owner_sub: %s", out)
	}
}

func TestInvalidateTrackingSkipsWithoutAUserID(t *testing.T) {
	gw, _ := live(t)
	var buf strings.Builder
	log := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	cache.InvalidateTracking(context.Background(), gw, log, "ord_9", "sub-1", "")

	out := buf.String()
	if !strings.Contains(out, "no_owner_user_id") {
		t.Errorf("reason must be no_owner_user_id: %s", out)
	}
}

// The cascade sweeps BOTH identifiers in the FIRST key position. Sweeping only
// the canonical pair leaked deleted-account data for its full TTL — verified
// live in Orders.
func TestInvalidateUserSweepsBothIdentifiers(t *testing.T) {
	gw, server := live(t)
	ctx := context.Background()
	sub, userID := "sub-uuid", "usr_x"

	// The client authenticated with the SUB on some requests...
	subIndex := cache.UserIndexKey(sub, userID)
	subEntry, _ := cache.TrackingOrderKey(sub, userID, "ord_1")
	gw.Set(ctx, subEntry, map[string]string{"a": "b"}, time.Minute, subIndex)

	// ...and with the usr_ id on others (the E2E suite's direct path).
	idIndex := cache.UserIndexKey(userID, userID)
	idEntry, _ := cache.TrackingOrderKey(userID, userID, "ord_1")
	gw.Set(ctx, idEntry, map[string]string{"a": "b"}, time.Minute, idIndex)

	// Both identity mappings are live too.
	gw.Set(ctx, cache.IdentityKey(sub), userID, time.Hour, "")
	gw.Set(ctx, cache.IdentityKey(userID), userID, time.Hour, "")

	cache.InvalidateUser(ctx, gw, quiet(), sub, userID)

	for _, key := range []string{
		subIndex, subEntry, idIndex, idEntry,
		cache.IdentityKey(sub), cache.IdentityKey(userID),
	} {
		if server.Exists(key) {
			t.Errorf("%s survived InvalidateUser; a deleted account's data stays readable for its full TTL", key)
		}
	}
}

// On the direct path both fields hold the SAME value. Issuing the same DELETE
// twice is pointless noise on a write path.
func TestInvalidateUserDeduplicatesIdenticalIdentifiers(t *testing.T) {
	gw, server := live(t)
	ctx := context.Background()

	indexKey := cache.UserIndexKey("usr_x", "usr_x")
	entry, _ := cache.TrackingOrderKey("usr_x", "usr_x", "ord_1")
	gw.Set(ctx, entry, map[string]string{"a": "b"}, time.Minute, indexKey)
	gw.Set(ctx, cache.IdentityKey("usr_x"), "usr_x", time.Hour, "")

	cache.InvalidateUser(ctx, gw, quiet(), "usr_x", "usr_x")

	for _, key := range []string{indexKey, entry, cache.IdentityKey("usr_x")} {
		if server.Exists(key) {
			t.Errorf("%s survived InvalidateUser", key)
		}
	}
}

// Never fails the caller: the deletion has already COMMITTED by the time this
// runs, so raising would tell Users the cascade failed when it did not.
func TestInvalidateUserNeverFailsWithRedisDown(t *testing.T) {
	cache.InvalidateUser(context.Background(), cache.NewNullGateway(), quiet(), "sub-1", "usr_1")
	cache.InvalidateTracking(context.Background(), cache.NewNullGateway(), quiet(), "ord_1", "sub-1", "usr_1")
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && go test ./internal/adapter/redis/...
```

Expected: `undefined: cache.NewIdentityCache`, `undefined: cache.InvalidateTracking`, `undefined: cache.InvalidateUser`.

- [ ] **Step 3: Write minimal implementation**

`services/tracking-go/internal/adapter/redis/identity.go`:
```go
package redis

import (
	"context"
	"encoding/json"
)

// IdentityCache resolves an identifier to the internal usr_ id, consulting Redis
// first.
//
// # Why this exists at all
//
// Every response key carries user_id as well as cognito_sub. user_id is not on
// the request — it is an internal usr_ id that only Users knows, obtained with a
// gRPC call. So building a response key requires resolving it FIRST, on every
// request, cache hit included. Without this, a "fast" cache hit would still pay a
// network round trip to another service, which is most of the latency the
// response cache was supposed to remove.
//
// # Why TTL-only invalidation is correct here, not a gap
//
// A sub never resolves to a DIFFERENT usr_ id while the account exists, so a
// stale entry cannot serve a WRONG answer — only a late one. The one case that
// CAN, an account that has stopped existing, is handled explicitly by
// InvalidateUser; the 1h TTL is the backstop for the path where that eviction
// could not run (a Redis outage during the cascade, which fails open by design).
//
// ONE PERSON CAN OWN MORE THAN ONE ENTRY here, because the key is built from the
// raw x-user-id header and a client may authenticate with either identifier. The
// values agree, so a duplicate cannot serve a wrong answer — but the cascade has
// to delete BOTH or the leftover one keeps resolving a deleted account for the
// rest of its hour.
type IdentityCache struct{ gateway Gateway }

// NewIdentityCache builds the cache over gw.
func NewIdentityCache(gw Gateway) *IdentityCache { return &IdentityCache{gateway: gw} }

// Resolve returns the cached mapping, falling back to loader on a miss. Answers
// "" when the identity cannot be resolved.
//
// NEGATIVES ARE NEVER CACHED. A "" answer means one of: Users has no record,
// Users was unreachable, or no client could be built. Caching that would keep a
// real user's user_id out of their keys for an hour after the cause cleared — and
// because the key builders skip caching entirely without a user_id, it would
// quietly disable the response cache for that caller for the whole hour.
// Re-asking each request costs exactly the call the request would have made
// anyway.
//
// loader is allowed to fail; anything it returns as an error becomes "", because
// this whole mechanism is an optimization on top of an enrichment that must never
// fail a request.
func (c *IdentityCache) Resolve(ctx context.Context, cognitoSub string, loader func(context.Context) (string, error)) string {
	key := IdentityKey(cognitoSub)

	if entry := c.gateway.Get(ctx, key); entry.Hit {
		var userID string
		// The value is a bare JSON string, so redis-cli shows "usr_abc".
		if err := json.Unmarshal(entry.Value, &userID); err == nil && userID != "" {
			return userID
		}
	}

	userID, err := loader(ctx)
	if err != nil || userID == "" {
		return ""
	}
	c.gateway.Set(ctx, key, userID, IdentityTTL, "")
	return userID
}
```

`services/tracking-go/internal/adapter/redis/invalidation.go`:
```go
package redis

import (
	"context"
	"log/slog"
)

// InvalidateTracking evicts everything a status change on orderID could have made
// stale.
//
// Never fails the caller: the gateway swallows its own failures, and a missed
// eviction costs at most the 60s TTL of the entries it failed to clear — which is
// precisely why the TTL is short.
//
// # The webhook has no caller identity
//
// PUT /v1/trackings/{order_id}/status authenticates with x-api-key and receives
// no x-user-id at all, so it cannot build a key from the request. The owner comes
// off the PERSISTED ROW instead — the same value the reads' ownership filter
// compares against. That is the only identity in play here, and it is the right
// one.
func InvalidateTracking(ctx context.Context, gw Gateway, log *slog.Logger, orderID, cognitoSub, userID string) {
	if log == nil {
		log = slog.Default()
	}

	if cognitoSub == "" {
		// The column is nullable: a row with a NULL sub is UNREACHABLE over both
		// user-scoped reads (the filter compares against a sub, and NULL matches
		// nobody, including the rightful owner). A row that can never be read can
		// never have been cached, so there is nothing to evict.
		log.DebugContext(ctx, "cache_invalidation_skipped",
			slog.String("app_event", "cache_invalidation_skipped"),
			slog.String("reason", "no_owner_sub"),
			slog.String("order_id", orderID),
		)
		return
	}

	if userID == "" {
		// Both key shapes embed user_id, so without one there is nothing
		// addressable to delete. Building tracking:index:v1:<sub>: would delete a
		// key nobody ever wrote, which reads as a successful invalidation while
		// evicting nothing.
		log.DebugContext(ctx, "cache_invalidation_skipped",
			slog.String("app_event", "cache_invalidation_skipped"),
			slog.String("reason", "no_owner_user_id"),
			slog.String("order_id", orderID),
		)
		return
	}

	if key, ok := TrackingOrderKey(cognitoSub, userID, orderID); ok {
		gw.Invalidate(ctx, key)
	}
	// The list keys are not reconstructible at any price — each embeds a sha256
	// of an arbitrary caller-supplied id list — so they are cleared through the
	// per-user index. Not KEYS and not SCAN: both are O(N) over the entire
	// keyspace, KEYS blocks the server for the duration, and putting either on a
	// write path makes every carrier callback pay for the size of the whole cache.
	gw.InvalidateIndex(ctx, UserIndexKey(cognitoSub, userID))

	log.InfoContext(ctx, "cache_invalidated",
		slog.String("app_event", "cache_invalidated"),
		slog.String("order_id", orderID),
		slog.String("cognito_sub", cognitoSub),
	)
}

// InvalidateUser evicts everything the account-deletion cascade leaves behind:
// every response entry through the per-user index, and the identity mapping.
//
// # Why BOTH identifiers are swept, not just the canonical pair
//
// This is the bug that made a deleted account's data readable for its full TTL,
// and it comes from the two paths disagreeing about what "the caller's identity"
// is.
//
// A response key is built from the RAW x-user-id header — whatever the client
// happened to send — plus the usr_ id resolved from it. Users' GetUserById accepts
// BOTH identifiers, so a client authenticating with the usr_ id resolves exactly
// as well as one sending the Cognito sub, and the E2E suite does precisely that
// on the direct path. The usr_ id therefore lands in the SUB POSITION of a live
// key:
//
//	tracking:index:v1:usr_abc:usr_abc          (header = usr_ id)
//	tracking:index:v1:<uuid-sub>:usr_abc       (header = cognito sub)
//	identity:sub-to-user:v1:usr_abc            (header = usr_ id)
//	identity:sub-to-user:v1:<uuid-sub>         (header = cognito sub)
//
// The cascade, by contrast, receives the CANONICAL pair. Sweeping only
// UserIndexKey(sub, userID) and IdentityKey(sub) therefore deletes keys that were
// never written whenever the client authenticated with the usr_ id, and leaves
// the live ones to expire on their own. Verified live in Orders, which has the
// identical design: the cascade logged success, the deletion returned 204, the
// key count did not move, and a re-read answered X-Cache: HIT with the deleted
// user's data.
//
// user_id is always the canonical usr_ id in the SECOND position, so the first
// position is the only one that varies.
//
// # KNOWN LIMITATION — keys are not normalized to a canonical identity
//
// Sweeping both identifiers fixes the leak but not its cause: the same person
// still gets a SEPARATE set of entries depending on which identifier they
// authenticated with. That is wasted memory and a lower hit rate than the design
// assumes. Normalizing every key onto the canonical sub would fix both, and was
// considered and deliberately not chosen. An accepted trade-off, not an oversight.
//
// Never fails the caller: the deletion has already COMMITTED by the time this
// runs, so failing would tell Users the cascade failed when it did not, and would
// fail the whole account deletion for the person.
func InvalidateUser(ctx context.Context, gw Gateway, log *slog.Logger, cognitoSub, userID string) {
	if log == nil {
		log = slog.Default()
	}

	identifiers := distinct(cognitoSub, userID)

	indexKeys := make([]string, 0, len(identifiers))
	for _, identifier := range identifiers {
		indexKeys = append(indexKeys, UserIndexKey(identifier, userID))
	}
	for _, indexKey := range distinct(indexKeys...) {
		gw.InvalidateIndex(ctx, indexKey)
	}

	for _, identifier := range identifiers {
		gw.Invalidate(ctx, IdentityKey(identifier))
	}

	log.InfoContext(ctx, "cache_invalidated",
		slog.String("app_event", "cache_invalidated"),
		slog.String("reason", "account_deleted"),
		slog.String("cognito_sub", cognitoSub),
	)
}

// distinct returns the non-empty values, deduplicated, IN THE ORDER GIVEN.
//
// A slice rather than a set so the sweep is deterministic — a test asserting
// which keys were deleted, and a log or trace read afterwards, both see a stable
// order. Empty values are dropped rather than formatted into a key: UserIndexKey("", "")
// is a real, well-formed key that some other caller could own.
func distinct(values ...string) []string {
	seen := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		duplicate := false
		for _, already := range seen {
			if already == value {
				duplicate = true
				break
			}
		}
		if !duplicate {
			seen = append(seen, value)
		}
	}
	return seen
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && gofmt -s -w ./internal/adapter/redis && go test ./internal/adapter/redis/... -race -v
```

Expected: every subtest `--- PASS`, `TestInvalidateUserSweepsBothIdentifiers` included.

- [ ] **Step 5: Commit**

```
feat(tracking): identity cache and dual-identifier cache invalidation
```

---

## Group D — Auth + gRPC client + SQS publisher

Runs concurrently with A, B and C. It touches `internal/adapter/http/auth*.go` (middleware only — the routers are wave 2), `internal/adapter/grpcusers/**` and `internal/adapter/sqs/**`.

### Task 16: The four auth schemes and the two request flags

**Files:**
- Create: `services/tracking-go/internal/adapter/http/auth.go`
- Create: `services/tracking-go/internal/adapter/http/flags.go`
- Create: `services/tracking-go/internal/domain/audit/actor.go`
- Test: `services/tracking-go/internal/adapter/http/auth_test.go`
- Test: `services/tracking-go/internal/adapter/http/flags_test.go`

**Interfaces:**
- Consumes: `crypto/subtle`, Gin, `config.Bool` (Task 8) for the E2E flag.
- Produces:
  ```go
  func RequireCallerSub() gin.HandlerFunc
  func CallerSub(c *gin.Context) string
  func RequireCarrierKey(expected string, log *slog.Logger) gin.HandlerFunc
  func RequireInternalKey(expected string, log *slog.Logger) gin.HandlerFunc
  func E2ESourceMiddleware(e2eEnabled bool) gin.HandlerFunc
  func IsE2ESource(c *gin.Context) bool
  func TestModeMiddleware() gin.HandlerFunc
  func IsTestMode(c *gin.Context) bool
  const E2ESourceTag = "E2E Source"
  ```

**Four auth schemes:**

| Scheme | Header | Secret env | Missing → | Wrong → |
|---|---|---|---|---|
| Gateway JWT sub | `x-user-id` | none (trusted) | 401 `{"detail":"missing x-user-id"}` | value trusted verbatim |
| Carrier key | `x-api-key` | `TRACKING_CARRIER_API_KEY` | 401 `{"detail":"invalid api key"}` | 401, **identical body** |
| Internal key | `x-api-key` | `GRPC_API_KEY` | 401 `{"detail":"invalid api key"}` | 401, **identical body** |
| None, flag-gated | — | `E2E_TESTING_ENABLED` | route not registered | — |

> **CRITICAL: the two `x-api-key` schemes share a header NAME but are DIFFERENT SECRETS IN DIFFERENT TRUST DOMAINS.** The carrier key goes to an outside vendor; `GRPC_API_KEY` is internal and shared between our own services. Reusing one as the other would hand that vendor a credential valid against every internal surface — including the mass soft-delete route. Never collapse them into one helper with a key argument: one file-level function per trust domain makes the wrong-key mistake structurally harder.

**Key comparison MUST use `crypto/subtle.ConstantTimeCompare`.** Go's `==` on strings short-circuits at the first differing byte, so the time it takes leaks how long a shared prefix the attacker guessed — enough to recover a key byte by byte given retries. A length mismatch is not hidden by any implementation; the key's *length* leaks, its *contents* do not, and that is the same trade Users makes with `timingSafeEqual`.

**Missing and wrong take the IDENTICAL code path and produce the IDENTICAL body** — deliberately indistinguishable, so a caller cannot tell a wrong key from an absent one and the endpoint reveals nothing about whether a key it was given is *nearly* right. 401, not 403: a bad key identifies nobody, so there is no principal to forbid.

Log `reason=invalid_api_key` plus the client IP. **NEVER log the key** — not a prefix, not its length.

**`x-user-id`: the empty string is treated EXACTLY as absent (401).** nginx sets it to `""` when the token is missing or malformed rather than omitting the header; accepting `""` would scope a read to `cognito_sub = ''`, matching nothing — a silent empty result instead of the 401 the caller deserves.

**`x-e2e-source`:** value `"true"` compared case-insensitively after trimming. The result is the **AND** of the header AND `E2E_TESTING_ENABLED`, evaluated **inside the middleware** so a handler cannot tag a row on the header alone. Without the conjunction, any client could tag its own rows by sending one header — and that tag is the exact predicate a mass soft-delete endpoint selects on. Never returns an error for an unrecognized value (no `1`, no `yes` — only `true` activates): failing the creation of a real shipment over a malformed test-harness header would be the worse trade.

**The tag string written to the DB is exactly `E2E Source`** — capital E, capital S, one space. Shared verbatim with Users; a near-miss like `e2e-source` would clean up nothing while looking correct.

**`x-test-mode`:** value `"true"`, same parsing, but **deliberately NOT guarded by `E2E_TESTING_ENABLED`** in this service. Orders guards its equivalent; this is a recorded known open item — **do not "fix" it here.**

**AuditActor values, exact strings:** `tracking_api:create_tracking`, `tracking_api:carrier_status_update`, `tracking_api:test_mode_progression`, `tracking_api:e2e_cleanup`, `tracking_api:delete_by_user`.

- [ ] **Step 1: Write the failing test**

`services/tracking-go/internal/adapter/http/auth_test.go`:
```go
package http_test

import (
	"encoding/json"
	"io"
	"log/slog"
	nethttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
)

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestRequireCallerSubAcceptsAHeader(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	var seen string
	r.GET("/x", adapterhttp.RequireCallerSub(), func(c *gin.Context) {
		seen = adapterhttp.CallerSub(c)
		c.Status(nethttp.StatusOK)
	})

	req := httptest.NewRequest(nethttp.MethodGet, "/x", nil)
	req.Header.Set("x-user-id", "sub-abc")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if seen != "sub-abc" {
		t.Errorf("CallerSub = %q, want sub-abc", seen)
	}
}

// EMPTY IS MISSING. nginx sets x-user-id to "" when the token is missing or
// malformed; accepting "" would scope a read to cognito_sub = '', matching
// nothing — a silent empty result instead of the 401 the caller deserves.
func TestRequireCallerSubRejectsAbsentAndEmptyIdentically(t *testing.T) {
	for _, tt := range []struct {
		name  string
		value string
		set   bool
	}{
		{"absent", "", false},
		{"empty string", "", true},
		{"whitespace only", "   ", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			r := gin.New()
			r.GET("/x", adapterhttp.RequireCallerSub(), func(c *gin.Context) { c.Status(nethttp.StatusOK) })

			req := httptest.NewRequest(nethttp.MethodGet, "/x", nil)
			if tt.set {
				req.Header.Set("x-user-id", tt.value)
			}
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			if rec.Code != nethttp.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
			var body map[string]any
			_ = json.Unmarshal(rec.Body.Bytes(), &body)
			if body["detail"] != "missing x-user-id" {
				t.Errorf("body = %s, want {\"detail\":\"missing x-user-id\"}", rec.Body.String())
			}
		})
	}
}

// The two x-api-key schemes are DIFFERENT SECRETS IN DIFFERENT TRUST DOMAINS.
// The carrier key must not open the internal route, and vice versa.
func TestCarrierAndInternalKeysAreNotInterchangeable(t *testing.T) {
	const carrierKey = "carrier-secret-value"
	const internalKey = "internal-secret-value"

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.PUT("/carrier", adapterhttp.RequireCarrierKey(carrierKey, discardLogger()),
		func(c *gin.Context) { c.Status(nethttp.StatusOK) })
	r.DELETE("/internal", adapterhttp.RequireInternalKey(internalKey, discardLogger()),
		func(c *gin.Context) { c.Status(nethttp.StatusOK) })

	tests := []struct {
		name       string
		method     string
		path       string
		key        string
		wantStatus int
	}{
		{"carrier route with carrier key", nethttp.MethodPut, "/carrier", carrierKey, nethttp.StatusOK},
		{"carrier route with INTERNAL key", nethttp.MethodPut, "/carrier", internalKey, nethttp.StatusUnauthorized},
		{"internal route with internal key", nethttp.MethodDelete, "/internal", internalKey, nethttp.StatusOK},
		{"internal route with CARRIER key", nethttp.MethodDelete, "/internal", carrierKey, nethttp.StatusUnauthorized},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, nil)
			req.Header.Set("x-api-key", tt.key)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
		})
	}
}

// Missing and wrong take the IDENTICAL path and produce the IDENTICAL body:
// deliberately indistinguishable.
func TestMissingAndWrongKeysAreIndistinguishable(t *testing.T) {
	for _, mw := range []struct {
		name string
		fn   gin.HandlerFunc
	}{
		{"carrier", adapterhttp.RequireCarrierKey("the-real-key", discardLogger())},
		{"internal", adapterhttp.RequireInternalKey("the-real-key", discardLogger())},
	} {
		t.Run(mw.name, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			r := gin.New()
			r.GET("/x", mw.fn, func(c *gin.Context) { c.Status(nethttp.StatusOK) })

			var bodies []string
			var statuses []int
			for _, key := range []string{"", "wrong-key", "the-real-ke", "the-real-keyy"} {
				req := httptest.NewRequest(nethttp.MethodGet, "/x", nil)
				if key != "" {
					req.Header.Set("x-api-key", key)
				}
				rec := httptest.NewRecorder()
				r.ServeHTTP(rec, req)
				statuses = append(statuses, rec.Code)
				bodies = append(bodies, rec.Body.String())
			}

			for i := range statuses {
				if statuses[i] != nethttp.StatusUnauthorized {
					t.Errorf("case %d: status = %d, want 401", i, statuses[i])
				}
				if bodies[i] != bodies[0] {
					t.Errorf("case %d body %q differs from case 0 %q; missing and wrong must be indistinguishable",
						i, bodies[i], bodies[0])
				}
			}
			var body map[string]any
			_ = json.Unmarshal([]byte(bodies[0]), &body)
			if body["detail"] != "invalid api key" {
				t.Errorf("body = %s, want {\"detail\":\"invalid api key\"}", bodies[0])
			}
		})
	}
}

// NEVER log the key — not the value, not a prefix, not its length.
func TestRejectionLogsAReasonAndTheIPButNeverTheKey(t *testing.T) {
	var buf strings.Builder
	log := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.PUT("/x", adapterhttp.RequireCarrierKey("super-secret-carrier-key", log),
		func(c *gin.Context) { c.Status(nethttp.StatusOK) })

	req := httptest.NewRequest(nethttp.MethodPut, "/x", nil)
	req.Header.Set("x-api-key", "attacker-guess-abcdef")
	r.ServeHTTP(httptest.NewRecorder(), req)

	out := buf.String()
	if !strings.Contains(out, "invalid_api_key") {
		t.Errorf("no reason=invalid_api_key in: %s", out)
	}
	if !strings.Contains(out, "client") {
		t.Errorf("the client IP should be logged: %s", out)
	}
	for _, forbidden := range []string{"super-secret-carrier-key", "attacker-guess-abcdef", "super-sec", "attacker-"} {
		if strings.Contains(out, forbidden) {
			t.Errorf("the log line leaked key material %q: %s", forbidden, out)
		}
	}
	// Not even the length.
	if strings.Contains(out, "key_length") || strings.Contains(out, "\"length\"") {
		t.Errorf("the log line reported a key length: %s", out)
	}
}
```

`services/tracking-go/internal/adapter/http/flags_test.go`:
```go
package http_test

import (
	nethttp "net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
)

func e2eResult(t *testing.T, e2eEnabled bool, header string, setHeader bool) bool {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	var got bool
	r.POST("/x", adapterhttp.E2ESourceMiddleware(e2eEnabled), func(c *gin.Context) {
		got = adapterhttp.IsE2ESource(c)
		c.Status(nethttp.StatusOK)
	})

	req := httptest.NewRequest(nethttp.MethodPost, "/x", nil)
	if setHeader {
		req.Header.Set("x-e2e-source", header)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != nethttp.StatusOK {
		t.Fatalf("status = %d; an unrecognized flag value must never fail the request", rec.Code)
	}
	return got
}

// The result is the AND of the header AND the flag. Without the conjunction any
// client could tag its own rows — and that tag is the exact predicate a mass
// soft-delete endpoint selects on.
func TestE2ESourceIsTheAndOfHeaderAndFlag(t *testing.T) {
	tests := []struct {
		name       string
		e2eEnabled bool
		header     string
		setHeader  bool
		want       bool
	}{
		{"flag on, header true", true, "true", true, true},
		{"flag on, header TRUE", true, "TRUE", true, true},
		{"flag on, header padded", true, "  true  ", true, true},
		{"flag OFF, header true", false, "true", true, false},
		{"flag on, no header", true, "", false, false},
		{"flag on, header false", true, "false", true, false},
		// Only the exact string activates it: no 1, no yes.
		{"flag on, header 1", true, "1", true, false},
		{"flag on, header yes", true, "yes", true, false},
		{"flag on, header garbage", true, "maybe", true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := e2eResult(t, tt.e2eEnabled, tt.header, tt.setHeader); got != tt.want {
				t.Errorf("IsE2ESource = %v, want %v", got, tt.want)
			}
		})
	}
}

// The tag written to the DB is exactly "E2E Source" — capital E, capital S, one
// space. Shared verbatim with Users; a near-miss cleans up nothing while looking
// correct.
func TestE2ESourceTagSpelling(t *testing.T) {
	if adapterhttp.E2ESourceTag != "E2E Source" {
		t.Errorf("E2ESourceTag = %q, want exactly \"E2E Source\"", adapterhttp.E2ESourceTag)
	}
}

// x-test-mode uses the same parsing but is deliberately NOT guarded by
// E2E_TESTING_ENABLED in this service. A recorded known open item — do not
// "fix" it here.
func TestTestModeParsingIsUnguarded(t *testing.T) {
	tests := []struct {
		header    string
		setHeader bool
		want      bool
	}{
		{"true", true, true},
		{"TRUE", true, true},
		{"  True  ", true, true},
		{"false", true, false},
		{"1", true, false},
		{"yes", true, false},
		{"", false, false},
	}
	for _, tt := range tests {
		t.Run(tt.header, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			r := gin.New()
			var got bool
			r.POST("/x", adapterhttp.TestModeMiddleware(), func(c *gin.Context) {
				got = adapterhttp.IsTestMode(c)
				c.Status(nethttp.StatusOK)
			})

			req := httptest.NewRequest(nethttp.MethodPost, "/x", nil)
			if tt.setHeader {
				req.Header.Set("x-test-mode", tt.header)
			}
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			if rec.Code != nethttp.StatusOK {
				t.Fatalf("status = %d; an unrecognized value must never fail the request", rec.Code)
			}
			if got != tt.want {
				t.Errorf("IsTestMode = %v, want %v", got, tt.want)
			}
		})
	}
}
```

Add `services/tracking-go/internal/domain/audit/actor_test.go`:
```go
package audit_test

import (
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// These strings are persisted in created_by/updated_by/deleted_by and read by
// dashboards and cleanup queries. Spelling is the contract.
func TestActorSpellings(t *testing.T) {
	tests := []struct {
		actor audit.Actor
		want  string
	}{
		{audit.CreateTracking, "tracking_api:create_tracking"},
		{audit.CarrierStatusUpdate, "tracking_api:carrier_status_update"},
		{audit.TestModeProgression, "tracking_api:test_mode_progression"},
		{audit.E2ECleanup, "tracking_api:e2e_cleanup"},
		{audit.DeleteByUser, "tracking_api:delete_by_user"},
	}
	for _, tt := range tests {
		if string(tt.actor) != tt.want {
			t.Errorf("actor = %q, want %q", string(tt.actor), tt.want)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && go test ./internal/adapter/http/... ./internal/domain/audit/...
```

Expected: `undefined: adapterhttp.RequireCallerSub`, `undefined: adapterhttp.RequireCarrierKey`, and `no required module provides package .../internal/domain/audit`.

- [ ] **Step 3: Write minimal implementation**

`services/tracking-go/internal/domain/audit/actor.go`:
```go
// Package audit holds the semantic actors stamped into created_by / updated_by /
// deleted_by.
//
// Format <source>:<action>, mirroring Orders' AuditActor and Users' enum: the
// value records WHAT PRODUCED THE ROW, not which user id happened to be on the
// request. That matters more here than elsewhere — two of Tracking's three write
// paths have no user identity at all to stamp (the carrier webhook carries no
// x-user-id, and TestMode progression runs on a timer with no request behind it).
//
// Add members when new write paths appear; never widen speculatively.
package audit

// Actor is what produced a row. Stamped by the repository on every write.
type Actor string

const (
	// CreateTracking — POST /v1/trackings/init-tracking, the only way a tracking
	// is created.
	CreateTracking Actor = "tracking_api:create_tracking"
	// CarrierStatusUpdate — PUT /v1/trackings/{orderId}/status, the third-party
	// carrier webhook.
	CarrierStatusUpdate Actor = "tracking_api:carrier_status_update"
	// TestModeProgression — the automatic PLACED -> ... -> DELIVERED walk.
	TestModeProgression Actor = "tracking_api:test_mode_progression"
	// E2ECleanup — DELETE /v1/trackings/e2e-cleanup. Its own actor rather than
	// the caller's identity: a row soft-deleted by the test harness must stay
	// distinguishable from one a real flow removed.
	E2ECleanup Actor = "tracking_api:e2e_cleanup"
	// DeleteByUser — DELETE /v1/trackings/by-user, the account-deletion cascade.
	DeleteByUser Actor = "tracking_api:delete_by_user"
)
```

`services/tracking-go/internal/adapter/http/auth.go`:
```go
package http

import (
	"crypto/subtle"
	"log/slog"
	nethttp "net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// APIKeyHeader carries both key schemes. SAME NAME, DIFFERENT VALUES, DIFFERENT
// ROUTES — the two never meet on one request.
const APIKeyHeader = "x-api-key"

// callerSubKey is where RequireCallerSub stashes the verified sub.
const callerSubKey = "caller_sub"

// RequireCallerSub returns the caller's COGNITO SUB, or 401 when the gateway
// injected none.
//
// # The header is named x-user-id but holds a Cognito SUB
//
// This is the single most misleading name on this surface. nginx sets it
// literally as `proxy_set_header x-user-id $jwt_sub` — it is the JWT's sub claim,
// NOT the internal usr_ id that tracking.user_id holds. The two are different
// strings for the same person, and a read scoped by the wrong one silently
// matches nothing. Never pass this value where an internal usr_ id is expected.
//
// # EMPTY IS MISSING
//
// nginx sets x-user-id to the EMPTY STRING when the token is missing or malformed
// rather than omitting the header, so an empty value must be treated exactly like
// an absent one. Accepting "" would scope a read to cognito_sub = '', which
// matches no row — a silent empty result instead of the 401 the caller deserves.
//
// 401, not 403: the request carries no usable credential at all, so this is a
// failure to authenticate, not a permission denial on an identified caller.
func RequireCallerSub() gin.HandlerFunc {
	return func(c *gin.Context) {
		sub := strings.TrimSpace(c.GetHeader(UserIDHeader))
		if sub == "" {
			c.AbortWithStatusJSON(nethttp.StatusUnauthorized, gin.H{"detail": "missing x-user-id"})
			return
		}
		c.Set(callerSubKey, sub)
		c.Next()
	}
}

// CallerSub returns the sub RequireCallerSub verified, or "" when the middleware
// did not run.
func CallerSub(c *gin.Context) string {
	sub, _ := c.Get(callerSubKey)
	value, _ := sub.(string)
	return value
}

// RequireCarrierKey validates TRACKING_CARRIER_API_KEY on the carrier webhook.
//
// The caller is a third-party carrier, not an end user. Its gateway route is
// declared auth = false, so the request never passes a Cognito authorizer and
// carries no x-user-id: THIS SERVICE IS THE ONLY THING STANDING IN FRONT OF AN
// ENDPOINT THAT MUTATES DELIVERY STATE.
//
// # A DIFFERENT key from the internal one, deliberately
//
// TRACKING_CARRIER_API_KEY is an EXTERNAL credential handed to a vendor;
// GRPC_API_KEY is the INTERNAL service-to-service secret. Reusing one as the
// other would give an outside party a credential that authenticates as an
// internal service against every internal surface — including the mass
// soft-delete route below. This lives in its own function, beside its sibling but
// never merged with it: one function per trust domain makes the wrong-key mistake
// structurally harder than a shared helper with a key argument would.
func RequireCarrierKey(expected string, log *slog.Logger) gin.HandlerFunc {
	return apiKeyGuard(expected, log, "carrier_status_update_failed")
}

// RequireInternalKey validates GRPC_API_KEY on DELETE /v1/trackings/by-user.
//
// This is the account-deletion cascade's leg, and a mass soft-delete surface is
// the widest blast radius this service has. Accepting the CARRIER's key here
// would let an outside vendor erase a user's delivery history.
func RequireInternalKey(expected string, log *slog.Logger) gin.HandlerFunc {
	return apiKeyGuard(expected, log, "internal_delete_by_user_failed")
}

// apiKeyGuard is the shared REJECTION path, never a shared secret. Both callers
// pass their own key from their own trust domain; nothing here can mix them up
// because neither key is reachable from this function except through its
// argument.
//
// # 401, not 403
//
// A missing or wrong key is answered 401. 403 would mean "we know who you are and
// you may not do this" — but a bad key identifies nobody, so there is no principal
// to forbid. It also keeps the two failure modes indistinguishable: a caller
// cannot tell a wrong key from an absent one, so the endpoint reveals nothing
// about whether a key it was given is NEARLY right.
func apiKeyGuard(expected string, log *slog.Logger, appEvent string) gin.HandlerFunc {
	if log == nil {
		log = slog.Default()
	}
	return func(c *gin.Context) {
		if apiKeyMatches(c.GetHeader(APIKeyHeader), expected) {
			c.Next()
			return
		}

		// Log the attempt — an unauthenticated, state-mutating endpoint is the
		// widest attack surface this service has, and failed-attempt visibility
		// is the cheapest mitigation available.
		//
		// NEVER log the key, provided or expected — not even a prefix or its
		// length.
		log.WarnContext(c.Request.Context(), appEvent,
			slog.String("app_event", appEvent),
			slog.String("reason", "invalid_api_key"),
			slog.String("client", c.ClientIP()),
		)
		c.AbortWithStatusJSON(nethttp.StatusUnauthorized, gin.H{"detail": "invalid api key"})
	}
}

// apiKeyMatches compares in CONSTANT TIME.
//
// Never `==`: Go's string comparison short-circuits at the first differing byte,
// so the time it takes leaks how long a shared prefix the attacker guessed —
// enough to recover a key byte by byte given retries. subtle.ConstantTimeCompare
// takes the same time regardless.
//
// A length mismatch is not hidden by any implementation (ConstantTimeCompare
// returns 0 immediately for differing lengths, as does Node's timingSafeEqual
// guard): the key's LENGTH leaks, its CONTENTS do not. That is the same trade
// Users makes.
//
// An empty provided key returns false rather than erroring, so an absent header
// and a wrong one take the same path.
func apiKeyMatches(provided, expected string) bool {
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}
```

`services/tracking-go/internal/adapter/http/flags.go`:
```go
package http

import (
	"strings"

	"github.com/gin-gonic/gin"
)

// The two request flags, and the ONE value that activates each (compared
// case-insensitively after trimming). A flag that switches on for several
// spellings is one a caller enables by accident, so there is no 1 and no yes.
const (
	E2ESourceHeader = "x-e2e-source"
	TestModeHeader  = "x-test-mode"
	activeValue     = "true"
)

// E2ESourceTag is the tag persisted on a row the E2E harness created, and the
// exact predicate DELETE /v1/trackings/e2e-cleanup selects on.
//
// EXACTLY "E2E Source": capital E, capital S, one space. Shared verbatim with
// Users (user.tags contains "E2E Source"); a near-miss like "e2e-source" would
// clean up nothing while looking correct.
const E2ESourceTag = "E2E Source"

const (
	e2eSourceKey = "e2e_source"
	testModeKey  = "test_mode"
)

// E2ESourceMiddleware decides whether this request's row should be tagged as an
// E2E fixture.
//
// # The flag is half of the condition, and it is the security half
//
//	e2e_source = headerSaysTrue AND E2E_TESTING_ENABLED
//
// Without the conjunction, any client anywhere could tag its own rows by sending
// one header — and while a tag is harmless on its own, it is the exact predicate
// a mass soft-delete endpoint selects on. In an environment where the flag is on
// but the caller is untrusted, self-tagging would let a client enlist its rows
// for deletion by somebody else's teardown.
//
// BOTH HALVES ARE EVALUATED HERE, in the middleware, so a handler cannot tag a
// row on the header alone and a second endpoint that ever wants the tag cannot
// acquire the header check without the flag check that makes it safe.
//
// Never returns an error: an unrecognized value means "not an E2E row", never a
// 400, because failing the creation of a real shipment over a malformed
// test-harness header would be the worse trade.
func E2ESourceMiddleware(e2eEnabled bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(e2eSourceKey, headerIsTrue(c.GetHeader(E2ESourceHeader)) && e2eEnabled)
		c.Next()
	}
}

// IsE2ESource reports whether the row this request creates carries E2ESourceTag.
func IsE2ESource(c *gin.Context) bool {
	value, _ := c.Get(e2eSourceKey)
	flag, _ := value.(bool)
	return flag
}

// TestModeMiddleware parses x-test-mode.
//
// # No E2E_TESTING_ENABLED guard in THIS service
//
// Orders guards its equivalent header with that flag. This middleware
// deliberately does not, and the reason is that the guard is not implemented here
// to be dropped: Tracking has never had the setting on this path, and adding one
// is a change to the generated env files and therefore to infra/**, outside this
// task. Recording it rather than silently doing nothing — the flag remains a
// KNOWN OPEN ITEM. Do not "fix" it during the migration; that would be a
// behavioural change the equivalence gate would flag.
func TestModeMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(testModeKey, headerIsTrue(c.GetHeader(TestModeHeader)))
		c.Next()
	}
}

// IsTestMode reports whether this request asked for the automatic progression.
func IsTestMode(c *gin.Context) bool {
	value, _ := c.Get(testModeKey)
	flag, _ := value.(bool)
	return flag
}

// headerIsTrue accepts only the exact string "true", case-insensitively after
// trimming. Case-insensitive because a header value is not a wire enum and `True`
// from a hand-written curl should not silently mean false — but nothing beyond
// that: no 1, no yes.
func headerIsTrue(value string) bool {
	return strings.EqualFold(strings.TrimSpace(value), activeValue)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && gofmt -s -w ./internal && go test ./internal/adapter/http/... ./internal/domain/audit/... -v
```

Expected: every subtest `--- PASS`, `TestCarrierAndInternalKeysAreNotInterchangeable` included.

- [ ] **Step 5: Commit**

```
feat(tracking): four auth schemes with constant-time keys and the two request flags
```

---

### Task 17: The outbound gRPC Users client

**Files:**
- Create: `services/tracking-go/internal/adapter/grpcusers/client.go`
- Create: `services/tracking-go/internal/adapter/grpcusers/target.go`
- Create: `services/tracking-go/proto/users.proto` (copied from Users' contract)
- Generate: `services/tracking-go/internal/adapter/grpcusers/gen/users.pb.go`, `users_grpc.pb.go`
- Test: `services/tracking-go/internal/adapter/grpcusers/client_test.go`
- Test: `services/tracking-go/internal/adapter/grpcusers/target_test.go`

**Interfaces:**
- Consumes: `google.golang.org/grpc`, `otelgrpc`, the log context (Task 10) for the request id.
- Produces:
  ```go
  type ResolvedUser struct {
      InternalID string
      CognitoSub string
      Email      string // "" means absent — the publisher must bail out
      FullName   string // "" kept as-is, cosmetic
  }
  var ErrUnknownUser = errors.New("grpcusers: no such user")

  type Client struct{ /* … */ }
  func Dial(target, apiKey string) (*Client, error)
  func (c *Client) Resolve(ctx context.Context, identifier string) (ResolvedUser, error)
  func (c *Client) Close() error
  func NormalizeTarget(target string) string
  ```

Method `/users.v1.Users/GetUserById`. Request `{id: string}` — it accepts **either** a `usr_` id **or** a Cognito sub, which is why the parameter is named `identifier` rather than pretending it must be one or the other. Response `{id, email, full_name, cognito_sub, address}` — **never request or use `address`** (PII, and no caller in this service needs it).

**The `Email`/`FullName` asymmetry is deliberate.** proto3 has no null, so an absent value arrives as `""`. An absent **email** means the notification cannot be delivered at all, so the publisher must be able to distinguish it and bail out. An absent **name** is cosmetic — the mail still sends, and the payload field is a plain string the template interpolates. Two spellings of "no name" would only give the publisher a nil to convert back into `""` before every send.

**Env:** `USERS_GRPC_URL` (default `users:50051`). **Strip any `http://`/`https://` prefix** — grpc-go wants a bare `host:port`, and a value carrying a scheme resolves to a nonsense authority and fails at connect time with a DNS error that names neither the setting nor the cause. Orders' .NET `GrpcChannel.ForAddress` *requires* the scheme, so both spellings must be accepted from one shared env var.

**The API key travels as PER-CALL metadata key `x-api-key`**, never baked into channel credentials — so the channel stays a plain, inspectable object and the credential appears at exactly the place it is used. Also forward **`x-request-id` metadata when the context has one**, and **omit it when empty**: an `x-request-id: ""` on the wire would be a correlation value that correlates nothing, indistinguishable in Users' logs from a real one until someone tried to search for it. gRPC lowercases metadata keys on the wire, so both must be lowercase to match what Users reads.

**Timeout 2.0s.** A gRPC call with no deadline waits forever, which in a request path means a hung Users pins a worker until something else times out. Short because the call is a single indexed lookup: if it has not answered in two seconds it is not about to. **Insecure channel** — the hop is inside the private network and is authenticated by the shared key.

> **CRITICAL: ONLY `codes.NotFound` maps to "no such user".** Every other status — `Unavailable`, `DeadlineExceeded`, `Unauthenticated`, … — must **propagate**. An outage must never read as "this user does not exist", or a caller would write a row attributing the shipment to nobody. At the HTTP layer: `NotFound` → 404 `unknown_user`, everything else → 500.

- [ ] **Step 1: Write the failing test**

`services/tracking-go/internal/adapter/grpcusers/target_test.go`:
```go
package grpcusers_test

import (
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers"
)

// grpc-go wants a bare host:port. Orders' .NET channel REQUIRES the scheme, and
// both services read the same USERS_GRPC_URL, so both spellings must work.
func TestNormalizeTarget(t *testing.T) {
	tests := []struct{ in, want string }{
		{"users:50051", "users:50051"},
		{"http://users:50051", "users:50051"},
		{"https://users:50051", "users:50051"},
		{"http://127.0.0.1:50051", "127.0.0.1:50051"},
		{"", ""},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := grpcusers.NormalizeTarget(tt.in); got != tt.want {
				t.Errorf("NormalizeTarget(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}
```

`services/tracking-go/internal/adapter/grpcusers/client_test.go`:
```go
package grpcusers_test

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers"
	usersv1 "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers/gen"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
	"log/slog"
)

// fakeUsers is a real gRPC server implementing users.v1.Users.
type fakeUsers struct {
	usersv1.UnimplementedUsersServer

	mu       sync.Mutex
	response *usersv1.UserResponse
	err      error
	// lastMetadata records what the client actually put on the wire.
	lastMetadata metadata.MD
	lastID       string
}

func (f *fakeUsers) GetUserById(ctx context.Context, req *usersv1.GetUserByIdRequest) (*usersv1.UserResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastMetadata, _ = metadata.FromIncomingContext(ctx)
	f.lastID = req.GetId()
	if f.err != nil {
		return nil, f.err
	}
	return f.response, nil
}

// dialFake starts the fake over bufconn and returns a client wired to it.
func dialFake(t *testing.T, fake *fakeUsers, apiKey string) *grpcusers.Client {
	t.Helper()
	listener := bufconn.Listen(1024 * 1024)
	server := grpc.NewServer()
	usersv1.RegisterUsersServer(server, fake)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return listener.DialContext(ctx)
		}),
		grpc.WithInsecure(),
	)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	return grpcusers.NewClient(conn, apiKey)
}

func TestResolveMapsTheResponse(t *testing.T) {
	fake := &fakeUsers{response: &usersv1.UserResponse{
		Id:         "usr_abc",
		Email:      "person@example.com",
		FullName:   "Ada Lovelace",
		CognitoSub: "sub-uuid",
		Address:    "1 Main St",
	}}
	client := dialFake(t, fake, "internal-key")

	got, err := client.Resolve(context.Background(), "sub-uuid")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got.InternalID != "usr_abc" {
		t.Errorf("InternalID = %q", got.InternalID)
	}
	if got.CognitoSub != "sub-uuid" {
		t.Errorf("CognitoSub = %q", got.CognitoSub)
	}
	if got.Email != "person@example.com" {
		t.Errorf("Email = %q", got.Email)
	}
	if got.FullName != "Ada Lovelace" {
		t.Errorf("FullName = %q", got.FullName)
	}
}

// ONLY NotFound is "no such user". Every other status must PROPAGATE — an outage
// must never read as "this user does not exist".
func TestOnlyNotFoundMeansUnknownUser(t *testing.T) {
	tests := []struct {
		code        codes.Code
		wantUnknown bool
	}{
		{codes.NotFound, true},
		{codes.Unavailable, false},
		{codes.DeadlineExceeded, false},
		{codes.Unauthenticated, false},
		{codes.PermissionDenied, false},
		{codes.Internal, false},
		{codes.ResourceExhausted, false},
	}
	for _, tt := range tests {
		t.Run(tt.code.String(), func(t *testing.T) {
			fake := &fakeUsers{err: status.Error(tt.code, "boom")}
			client := dialFake(t, fake, "internal-key")

			_, err := client.Resolve(context.Background(), "sub-uuid")
			if err == nil {
				t.Fatal("Resolve returned no error")
			}
			isUnknown := errors.Is(err, grpcusers.ErrUnknownUser)
			if isUnknown != tt.wantUnknown {
				t.Errorf("errors.Is(err, ErrUnknownUser) = %v for %s, want %v — an outage must not read as 'no such user'",
					isUnknown, tt.code, tt.wantUnknown)
			}
			if !tt.wantUnknown {
				// The transport status must survive for the HTTP layer to map to 500.
				if st, ok := status.FromError(err); !ok || st.Code() != tt.code {
					t.Errorf("the gRPC status did not propagate: %v", err)
				}
			}
		})
	}
}

// The api key travels as PER-CALL metadata, lowercase, never in channel creds.
func TestAPIKeyTravelsAsPerCallMetadata(t *testing.T) {
	fake := &fakeUsers{response: &usersv1.UserResponse{Id: "usr_abc"}}
	client := dialFake(t, fake, "internal-key-value")

	if _, err := client.Resolve(context.Background(), "sub-uuid"); err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	got := fake.lastMetadata.Get("x-api-key")
	if len(got) != 1 || got[0] != "internal-key-value" {
		t.Errorf("x-api-key metadata = %v, want [internal-key-value]", got)
	}
}

// x-request-id is forwarded when the context has one.
func TestRequestIDIsForwarded(t *testing.T) {
	fake := &fakeUsers{response: &usersv1.UserResponse{Id: "usr_abc"}}
	client := dialFake(t, fake, "k")

	ctx := logging.WithLogFields(context.Background(),
		slog.String(logging.KeyRequestID, "req_7gK3mP1vXz9wLq2bN8rRt4Yc"))
	if _, err := client.Resolve(ctx, "sub-uuid"); err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	got := fake.lastMetadata.Get("x-request-id")
	if len(got) != 1 || got[0] != "req_7gK3mP1vXz9wLq2bN8rRt4Yc" {
		t.Errorf("x-request-id metadata = %v, want the context's id", got)
	}
}

// OMITTED, never sent empty: an x-request-id: "" would be a correlation value
// that correlates nothing, indistinguishable in Users' logs from a real one.
func TestRequestIDIsOmittedWhenAbsent(t *testing.T) {
	fake := &fakeUsers{response: &usersv1.UserResponse{Id: "usr_abc"}}
	client := dialFake(t, fake, "k")

	if _, err := client.Resolve(context.Background(), "sub-uuid"); err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if got := fake.lastMetadata.Get("x-request-id"); len(got) != 0 {
		t.Errorf("x-request-id = %v on a context with no id; it must be omitted, never empty", got)
	}
}

// The request accepts EITHER identifier and is passed through verbatim.
func TestResolveAcceptsEitherIdentifier(t *testing.T) {
	for _, identifier := range []string{"sub-uuid", "usr_abc"} {
		t.Run(identifier, func(t *testing.T) {
			fake := &fakeUsers{response: &usersv1.UserResponse{Id: "usr_abc"}}
			client := dialFake(t, fake, "k")

			if _, err := client.Resolve(context.Background(), identifier); err != nil {
				t.Fatalf("Resolve: %v", err)
			}
			fake.mu.Lock()
			defer fake.mu.Unlock()
			if fake.lastID != identifier {
				t.Errorf("id = %q, want %q passed through verbatim", fake.lastID, identifier)
			}
		})
	}
}

// The asymmetry is deliberate: an absent EMAIL disqualifies the notification, an
// absent NAME is cosmetic and stays "".
func TestEmptyEmailAndNameAreCarriedAsEmptyStrings(t *testing.T) {
	fake := &fakeUsers{response: &usersv1.UserResponse{Id: "usr_abc", CognitoSub: "sub"}}
	client := dialFake(t, fake, "k")

	got, err := client.Resolve(context.Background(), "sub")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got.Email != "" {
		t.Errorf("Email = %q, want \"\" — the publisher checks for it and bails out", got.Email)
	}
	if got.FullName != "" {
		t.Errorf("FullName = %q, want \"\" kept as-is", got.FullName)
	}
}

// An empty api key is a construction-time failure, not a runtime UNAUTHENTICATED.
func TestDialRejectsAnEmptyAPIKey(t *testing.T) {
	if _, err := grpcusers.Dial("users:50051", ""); err == nil {
		t.Fatal("Dial accepted an empty api key")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && go test ./internal/adapter/grpcusers/...
```

Expected: `no required module provides package .../internal/adapter/grpcusers`.

- [ ] **Step 3: Write minimal implementation**

Copy the contract and generate the stubs. The `.proto` is the authority; do not hand-write the messages.

```bash
\
mkdir -p services/tracking-go/proto services/tracking-go/internal/adapter/grpcusers/gen && \
cp services/tracking/proto/users.proto services/tracking-go/proto/users.proto 2>/dev/null || \
  cp services/users/proto/users.proto services/tracking-go/proto/users.proto

cd services/tracking-go && goenv local 1.25.14 && \
go get google.golang.org/grpc google.golang.org/protobuf \
       go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc && \
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest && \
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest && \
protoc --proto_path=proto \
  --go_out=internal/adapter/grpcusers/gen --go_opt=paths=source_relative \
  --go-grpc_out=internal/adapter/grpcusers/gen --go-grpc_opt=paths=source_relative \
  proto/users.proto
```

If the generated package name is not `gen`, add `option go_package` handling via `--go_opt=M...`; the import path used in this task is `.../internal/adapter/grpcusers/gen` aliased as `usersv1`.

`services/tracking-go/internal/adapter/grpcusers/target.go`:
```go
package grpcusers

import "strings"

// NormalizeTarget strips an http:// or https:// scheme from a gRPC target.
//
// grpc-go wants a bare host:port; a value carrying a scheme resolves to a
// nonsense authority and fails at connect time with a DNS error that names
// neither the setting nor the cause.
//
// Orders' .NET channel REQUIRES the scheme (GrpcChannel.ForAddress), so the
// shared USERS_GRPC_URL value legitimately has one. Accepting both forms here
// means the two services read the exact same environment variable instead of
// needing two spellings of one address.
func NormalizeTarget(target string) string {
	for _, scheme := range []string{"http://", "https://"} {
		if strings.HasPrefix(target, scheme) {
			return strings.TrimPrefix(target, scheme)
		}
	}
	return target
}
```

`services/tracking-go/internal/adapter/grpcusers/client.go`:
```go
// Package grpcusers is the OUTBOUND gRPC client to the Users service.
//
// It exists for exactly one question — "which internal usr_ id belongs to this
// identifier?" — because the gateway only ever hands this service a Cognito sub
// while a persisted tracking.user_id is a usr_ id. Everything here points one
// way: outward, calling users.v1.Users. This service serves no gRPC.
//
// # NOT_FOUND is an answer, not an error
//
// Users answers NotFound for an identifier it has never seen. That is a
// perfectly ordinary outcome — a token minted for a Cognito user whose record was
// never created, or was deleted — and it becomes ErrUnknownUser here rather than
// leaking a transport error into handlers that have no business knowing this
// service talks gRPC at all.
//
// EVERY OTHER STATUS PROPAGATES, deliberately: Unavailable, DeadlineExceeded,
// Unauthenticated and the rest keep their gRPC status so the HTTP layer maps them
// to 500. A caller must never treat an outage as "this user doesn't exist" and,
// say, write a row attributing the shipment to nobody.
//
// # Never log a UserResponse
//
// The response carries the user's address and email — PII. Nothing here logs the
// message, and nothing that receives a ResolvedUser should either; log email_hash
// instead.
package grpcusers

import (
	"context"
	"errors"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	usersv1 "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers/gen"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// Metadata keys. gRPC LOWERCASES metadata keys on the wire, so these must be
// lowercase to match what Users reads them as.
const (
	apiKeyMetadataKey    = "x-api-key"
	requestIDMetadataKey = "x-request-id"
)

// DefaultTimeout bounds every call. A gRPC call with NO deadline waits forever,
// which in a request path means a hung Users pins a worker until something else
// times out. Short because the call is a single indexed lookup: if it has not
// answered in two seconds it is not about to.
const DefaultTimeout = 2 * time.Second

// ErrUnknownUser is the domain fact behind a NotFound. The HTTP layer maps it to
// 404 unknown_user; everything else maps to 500.
var ErrUnknownUser = errors.New("grpcusers: no such user")

// ResolvedUser is the subset of users.v1.UserResponse this service has a use for.
//
// A domain value, not the proto message, so nothing downstream imports the
// generated package or holds a reference into gRPC's object graph.
//
// Deliberately NOT carrying the ADDRESS, even though UserResponse.address exists:
// no caller in this service needs it, and pulling it through would carry PII
// around for nothing. The REST creation endpoint takes shipping_address in the
// request body.
type ResolvedUser struct {
	// InternalID is the usr_ id — what tracking.user_id stores.
	InternalID string
	// CognitoSub is the sub Users has on file. Echoed back for the caller to
	// sanity check; the RPC accepts either identifier.
	CognitoSub string
	// Email is PII, consumed ONLY by the events publisher to address the
	// notification. Never logged, never returned over REST.
	//
	// "" means ABSENT (proto3 has no null). The publisher checks for it and
	// aborts before building anything, because the pipeline's handler rejects a
	// payload without an email as a PERMANENT error — the record is consumed and
	// the mail is never sent.
	Email string
	// FullName is PII too, and its "" is KEPT AS-IS rather than normalized —
	// deliberately different from Email. The two are different kinds of missing:
	// an absent address means the notification cannot be delivered at all, so the
	// publisher must distinguish it; an absent name is cosmetic, the mail still
	// sends, and the payload field is a plain string the template interpolates.
	FullName string
}

// Client resolves an identifier through users.v1.Users.
type Client struct {
	conn    *grpc.ClientConn
	stub    usersv1.UsersClient
	apiKey  string
	timeout time.Duration
}

// Dial builds a client over a NEW insecure channel to target.
//
// Insecure because this hop is inside the private network and is authenticated by
// the shared internal key. The channel is a connection pool — building one per
// call would pay TCP + HTTP/2 setup on every request and leak sockets under load.
func Dial(target, apiKey string) (*Client, error) {
	if apiKey == "" {
		// An empty key would be sent as an empty x-api-key and rejected by Users
		// with UNAUTHENTICATED at runtime — a failure much better detected here,
		// where the misconfiguration actually is.
		return nil, errors.New("grpcusers: api key must not be empty")
	}
	conn, err := grpc.NewClient(NormalizeTarget(target),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		// Go has no opentelemetry-instrument equivalent: the outbound spans are
		// wired here, in code.
		grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
	)
	if err != nil {
		return nil, err
	}
	return NewClient(conn, apiKey), nil
}

// NewClient wraps an existing connection. Used by Dial and by tests over bufconn.
func NewClient(conn *grpc.ClientConn, apiKey string) *Client {
	return &Client{
		conn:    conn,
		stub:    usersv1.NewUsersClient(conn),
		apiKey:  apiKey,
		timeout: DefaultTimeout,
	}
}

// Close releases the channel.
func (c *Client) Close() error {
	if c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// Resolve looks up a user by Cognito sub OR internal usr_ id.
//
// GetUserById accepts BOTH identifiers — the .proto says so and Users' handler
// implements it — so the parameter takes the neutral name `identifier` rather
// than pretending it must be one or the other.
//
// Only NotFound becomes ErrUnknownUser; every other status propagates with its
// gRPC status intact.
func (c *Client) Resolve(ctx context.Context, identifier string) (ResolvedUser, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	ctx = metadata.NewOutgoingContext(ctx, c.callMetadata(ctx))

	response, err := c.stub.GetUserById(ctx, &usersv1.GetUserByIdRequest{Id: identifier})
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return ResolvedUser{}, ErrUnknownUser
		}
		return ResolvedUser{}, err
	}

	return ResolvedUser{
		InternalID: response.GetId(),
		CognitoSub: response.GetCognitoSub(),
		Email:      response.GetEmail(),
		FullName:   response.GetFullName(),
		// response.GetAddress() is deliberately NOT read — PII with no consumer.
	}, nil
}

// callMetadata builds what every outbound call carries.
//
// The api key travels PER-CALL rather than baked into channel credentials, so the
// channel stays a plain, inspectable object and the credential appears at exactly
// the place it is used.
//
// x-request-id is read from the ambient log context rather than threaded through
// Resolve's signature: the context is already how this service carries per-request
// identity into depth, and adding a correlation argument to every caller of a
// lookup would be a signature change per hop for a value none of them care about.
//
// The entry is OMITTED, not sent empty, when the context has no id — that happens
// outside a request (the TestMode progression's goroutine, a CLI or startup call),
// and an x-request-id: "" on the wire would be a correlation value that correlates
// nothing, indistinguishable in Users' logs from a real one until someone tried to
// search for it.
func (c *Client) callMetadata(ctx context.Context) metadata.MD {
	md := metadata.Pairs(apiKeyMetadataKey, c.apiKey)
	for _, field := range logging.LogFields(ctx) {
		if field.Key == logging.KeyRequestID {
			if id := field.Value.String(); id != "" {
				md.Set(requestIDMetadataKey, id)
			}
			break
		}
	}
	return md
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && gofmt -s -w ./internal/adapter/grpcusers && go test ./internal/adapter/grpcusers/... -race -v
```

Expected: every subtest `--- PASS`, `TestOnlyNotFoundMeansUnknownUser` covering all seven status codes.

- [ ] **Step 5: Commit**

```
feat(tracking): outbound gRPC Users client with NotFound-only unknown-user mapping
```

---

### Task 18: The SQS event publisher

**Files:**
- Create: `services/tracking-go/internal/adapter/sqs/publisher.go`
- Create: `services/tracking-go/internal/adapter/sqs/envelope.go`
- Create: `services/tracking-go/internal/adapter/sqs/emailhash.go`
- Test: `services/tracking-go/internal/adapter/sqs/publisher_test.go`
- Test: `services/tracking-go/internal/adapter/sqs/emailhash_test.go`

**Interfaces:**
- Consumes: `aws-sdk-go-v2/service/sqs`, the OTel propagator (Task 11), and a narrow resolver port declared **here**, by the consumer:
  ```go
  // UserResolver is declared HERE by the publisher that consumes it. The
  // grpcusers client satisfies it without importing this package.
  type UserResolver interface {
      Resolve(ctx context.Context, identifier string) (grpcusers.ResolvedUser, error)
  }
  ```
- Produces:
  ```go
  type Publisher interface {
      PublishTrackingStatusChanged(ctx context.Context, in StatusChanged)
  }
  type StatusChanged struct {
      OrderID, UserID, Status, PreviousStatus string
      TrackingNumber string
      ChangedAt      time.Time
      ShippingAddress *string
      History        []HistoryEntry
      Actor          audit.Actor
      CognitoSub     string
  }
  func NewPublisher(client SendMessageAPI, queueURL string, resolve UserResolver, log *slog.Logger) Publisher
  func NewNoopPublisher() Publisher
  func DeriveEventID(orderID, status string) string
  func HashEmail(email string) string
  ```

Event type `TRACKING_STATUS_CHANGED`, source `tracking`, queue from `EVENTS_QUEUE_URL`.

**`event_id` is DETERMINISTIC:** `evt_` + first 16 hex chars of `sha256(order_id + "|" + status)`. **Not random.** The pipeline dedupes on a unique index over `event_id`, so a redelivery is only collapsed if the retried message carries the *same* id; a UUID per attempt would slip past that index and send a **second** notification email. `(order_id, status)` is a genuine natural key: the state machine is forward-only and `tracking_history`'s PK is `(tracking_id, status)`, so an order enters each status at most once. Hashed rather than interpolated so the id has a fixed shape and length whatever an order id contains.

**Envelope, exact shape:**
```
{ event_id, type, source, user_id, order_id, request_id?,
  author: { actor, cognito_sub? },
  payload: { status, previous_status, changed_at, email, full_name,
             order_id, tracking_number, shipping_address?, history: [{status, datetime}] } }
```

**OMISSION RULES.** A Zod schema downstream rejects nulls, and a violation consumes the record and **LOSES the email and the push** — nothing upstream notices. "Almost identical" is a failure.

| Field | Rule |
|---|---|
| `request_id` | omitted when empty; never null, never `""` |
| `author.cognito_sub` | omitted when empty; comes off the **persisted row**, never the request |
| `author.user_id` | **NEVER present** — no write path has a human author. The tracking's `user_id` is the SUBJECT and travels at the envelope root |
| `author.source` | **NEVER present** — the root `source` already names the producer |
| `payload.shipping_address` | omitted when NULL (**explicit nil check**, not truthiness) |
| `payload.full_name` | **ALWAYS present**, `""` when unknown — deliberately different from `shipping_address` |
| `payload.email` | always present; if unresolvable the publish **ABORTS before building anything**, logging `no_email_for_user` |

**`author.actor` is the actor the COMMAND received, threaded through** — never a constant chosen by the publisher. `update_status` is the shared write path behind both the carrier webhook and TestMode progression; hardcoding `carrier_status_update` would relabel every automatic progression as a carrier update, and the two would stop being distinguishable — which is precisely the confusion the semantic actor exists to prevent.

**SQS message attributes:** `type` and `source`, plus **W3C trace propagation injected as attributes** (`traceparent`/`tracestate`) — **not inside the envelope body.** The envelope is the domain contract with `events-pipeline` and a transport concern has no business in it; the consumer reads `record.messageAttributes.traceparent.stringValue`, which needs no schema change. The injection must happen **inside the publish span** — the propagator reads whatever span is active when it runs, so evaluated one line earlier it would write the enclosing *workflow* span's id and the pipeline's spans would hang beside the publish rather than under it, a trace that still looks complete. **Omitted, never empty**: with no valid active span the propagator writes nothing, and a blank `traceparent` is strictly worse than an absent one.

**Publish span:** name exactly `sqs.publish tracking_status_changed`, kind **PRODUCER**, attributes `app_event`, `messaging.system=aws_sqs`, `event_type`, `event_id`, `order_id`. Named after **what** is published, not where it goes: all producers publish onto the same shared queue, so a name identifying the transport tells a reader nothing.

**Four distinct failure reasons, all logged and SWALLOWED (never returned):** `email_resolution_failed`, `no_email_for_user`, `sqs_send_failed` (this one **also carries `email_hash`**), `publisher_unavailable`. The transition is already persisted and committed by the time this runs; the carrier would retry a PUT the forward-only state machine then rejects with a 400, so it would see a permanent-looking failure for a change we actually recorded. The trade accepted is at-most-once delivery of the notification, which is the correct direction: a missed "out for delivery" email is a degraded experience, a duplicate one is a bug report.

**`HashEmail`** = sha256 of the **trimmed, lowercased** address, hex, **first 16 chars** — must match Users' `hashEmail` and Orders' `EmailHash.Compute`. If the three drift, filtering one user's lines across services silently returns nothing instead of erroring.

**Provide a Noop publisher** for suites that must not emit. It records nothing deliberately: a test that needs to assert uses its own recording fake, because a Noop that silently swallowed the call cannot fail when the call stops happening.

> **INVARIANT: creation NEVER emits an event. Only status updates do.** A TestMode run produces **5 history rows and 4 events**.

- [ ] **Step 1: Write the failing test**

`services/tracking-go/internal/adapter/sqs/emailhash_test.go`:
```go
package sqs_test

import (
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/sqs"
)

// The CROSS-SERVICE contract: sha256 of the trimmed, lowercased address, hex,
// first 16 chars — identical to Users' hashEmail and Orders' EmailHash.Compute.
// If the three drift, filtering one user's lines across services silently
// returns nothing instead of erroring.
func TestHashEmail(t *testing.T) {
	// Precomputed: sha256("person@example.com")[:16] in hex.
	const want = "542d240129883c01"

	for _, in := range []string{
		"person@example.com",
		"PERSON@EXAMPLE.COM",
		"  person@example.com  ",
		"\tPerson@Example.Com\n",
	} {
		if got := sqs.HashEmail(in); got != want {
			t.Errorf("HashEmail(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestHashEmailLength(t *testing.T) {
	if got := sqs.HashEmail("a@b.com"); len(got) != 16 {
		t.Errorf("HashEmail returned %d chars, want 16", len(got))
	}
}
```

> If `542d240129883c01` does not match, compute the expected value once with
> `printf 'person@example.com' | shasum -a 256 | cut -c1-16` and pin THAT — the
> requirement is that Go, TypeScript and C# agree, not the literal in this plan.

`services/tracking-go/internal/adapter/sqs/publisher_test.go`:
```go
package sqs_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	awssqs "github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/sqs"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

type fakeSQS struct {
	mu   sync.Mutex
	sent []*awssqs.SendMessageInput
	err  error
}

func (f *fakeSQS) SendMessage(_ context.Context, in *awssqs.SendMessageInput, _ ...func(*awssqs.Options)) (*awssqs.SendMessageOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, in)
	if f.err != nil {
		return nil, f.err
	}
	return &awssqs.SendMessageOutput{}, nil
}

func (f *fakeSQS) last() *awssqs.SendMessageInput {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.sent) == 0 {
		return nil
	}
	return f.sent[len(f.sent)-1]
}

func (f *fakeSQS) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

type stubResolver struct {
	user grpcusers.ResolvedUser
	err  error
}

func (s stubResolver) Resolve(context.Context, string) (grpcusers.ResolvedUser, error) {
	return s.user, s.err
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func fullInput() sqs.StatusChanged {
	address := "1 Main St, Springfield"
	return sqs.StatusChanged{
		OrderID:         "ord_abc",
		UserID:          "usr_abc",
		Status:          "IN_TRANSIT",
		PreviousStatus:  "PLACED",
		TrackingNumber:  "TRK123456789",
		ChangedAt:       time.Date(2026, 8, 27, 12, 34, 56, 0, time.UTC),
		ShippingAddress: &address,
		History: []sqs.HistoryEntry{
			{Status: "PLACED", Datetime: time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)},
			{Status: "IN_TRANSIT", Datetime: time.Date(2026, 8, 27, 12, 34, 56, 0, time.UTC)},
		},
		Actor:      audit.CarrierStatusUpdate,
		CognitoSub: "sub-uuid",
	}
}

func decodeEnvelope(t *testing.T, in *awssqs.SendMessageInput) map[string]any {
	t.Helper()
	if in == nil {
		t.Fatal("nothing was sent")
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(*in.MessageBody), &envelope); err != nil {
		t.Fatalf("body is not JSON: %v\n%s", err, *in.MessageBody)
	}
	return envelope
}

func TestEnvelopeShape(t *testing.T) {
	client := &fakeSQS{}
	resolver := stubResolver{user: grpcusers.ResolvedUser{
		InternalID: "usr_abc", Email: "person@example.com", FullName: "Ada Lovelace"}}
	p := sqs.NewPublisher(client, "https://sqs/queue", resolver, quietLog())

	ctx := logging.WithLogFields(context.Background(),
		slog.String(logging.KeyRequestID, "req_7gK3mP1vXz9wLq2bN8rRt4Yc"))
	p.PublishTrackingStatusChanged(ctx, fullInput())

	envelope := decodeEnvelope(t, client.last())

	if envelope["type"] != "TRACKING_STATUS_CHANGED" {
		t.Errorf("type = %v", envelope["type"])
	}
	if envelope["source"] != "tracking" {
		t.Errorf("source = %v", envelope["source"])
	}
	if envelope["user_id"] != "usr_abc" {
		t.Errorf("user_id = %v", envelope["user_id"])
	}
	if envelope["order_id"] != "ord_abc" {
		t.Errorf("order_id = %v", envelope["order_id"])
	}
	if envelope["request_id"] != "req_7gK3mP1vXz9wLq2bN8rRt4Yc" {
		t.Errorf("request_id = %v", envelope["request_id"])
	}

	author, _ := envelope["author"].(map[string]any)
	if author["actor"] != "tracking_api:carrier_status_update" {
		t.Errorf("author.actor = %v", author["actor"])
	}
	if author["cognito_sub"] != "sub-uuid" {
		t.Errorf("author.cognito_sub = %v", author["cognito_sub"])
	}
	// NEVER present: there is no human author, and no producer field inside author.
	if _, present := author["user_id"]; present {
		t.Error("author.user_id must NEVER be present; the tracking's user_id is the SUBJECT and lives at the root")
	}
	if _, present := author["source"]; present {
		t.Error("author.source must NEVER be present; the root source already names the producer")
	}

	payload, _ := envelope["payload"].(map[string]any)
	if payload["status"] != "IN_TRANSIT" || payload["previous_status"] != "PLACED" {
		t.Errorf("transition = %v -> %v", payload["previous_status"], payload["status"])
	}
	if payload["email"] != "person@example.com" {
		t.Errorf("payload.email = %v", payload["email"])
	}
	if payload["full_name"] != "Ada Lovelace" {
		t.Errorf("payload.full_name = %v", payload["full_name"])
	}
	if payload["order_id"] != "ord_abc" {
		t.Errorf("payload.order_id = %v", payload["order_id"])
	}
	if payload["tracking_number"] != "TRK123456789" {
		t.Errorf("payload.tracking_number = %v", payload["tracking_number"])
	}
	if payload["shipping_address"] != "1 Main St, Springfield" {
		t.Errorf("payload.shipping_address = %v", payload["shipping_address"])
	}
	history, _ := payload["history"].([]any)
	if len(history) != 2 {
		t.Fatalf("history has %d entries, want 2", len(history))
	}
	first, _ := history[0].(map[string]any)
	if first["status"] != "PLACED" {
		t.Errorf("history[0].status = %v", first["status"])
	}
	if _, present := first["datetime"]; !present {
		t.Error("history entries carry status and datetime")
	}
	// Only those two keys per entry — the rest are identical across all of them
	// and already at the envelope root.
	if len(first) != 2 {
		t.Errorf("history entry has %d keys, want exactly status and datetime: %v", len(first), first)
	}
}

// event_id is DETERMINISTIC. The pipeline dedupes on a unique index over it, so
// a random id per attempt would send a SECOND notification email.
func TestEventIDIsDeterministic(t *testing.T) {
	a := sqs.DeriveEventID("ord_abc", "IN_TRANSIT")
	b := sqs.DeriveEventID("ord_abc", "IN_TRANSIT")
	if a != b {
		t.Fatalf("DeriveEventID is not deterministic: %q then %q", a, b)
	}
	if !strings.HasPrefix(a, "evt_") {
		t.Errorf("event id %q has no evt_ prefix", a)
	}
	if len(a) != len("evt_")+16 {
		t.Errorf("event id %q is %d chars, want evt_ + 16", a, len(a))
	}
	if c := sqs.DeriveEventID("ord_abc", "DELIVERED"); c == a {
		t.Error("a different status must produce a different event id")
	}
	if d := sqs.DeriveEventID("ord_xyz", "IN_TRANSIT"); d == a {
		t.Error("a different order must produce a different event id")
	}
}

func TestEnvelopeEventIDMatchesDerive(t *testing.T) {
	client := &fakeSQS{}
	p := sqs.NewPublisher(client, "q",
		stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())
	p.PublishTrackingStatusChanged(context.Background(), fullInput())

	envelope := decodeEnvelope(t, client.last())
	if envelope["event_id"] != sqs.DeriveEventID("ord_abc", "IN_TRANSIT") {
		t.Errorf("event_id = %v", envelope["event_id"])
	}
}

// OMITTED, never null: a Zod schema downstream rejects nulls, and a violation
// consumes the record and LOSES the email and the push.
func TestOmissionRules(t *testing.T) {
	t.Run("request_id omitted when the context has none", func(t *testing.T) {
		client := &fakeSQS{}
		p := sqs.NewPublisher(client, "q",
			stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())
		p.PublishTrackingStatusChanged(context.Background(), fullInput())

		envelope := decodeEnvelope(t, client.last())
		if _, present := envelope["request_id"]; present {
			t.Errorf("request_id = %v, want the key absent", envelope["request_id"])
		}
		if strings.Contains(*client.last().MessageBody, `"request_id":null`) {
			t.Error("request_id was emitted as null")
		}
	})

	t.Run("author.cognito_sub omitted when the row has none", func(t *testing.T) {
		client := &fakeSQS{}
		p := sqs.NewPublisher(client, "q",
			stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())
		in := fullInput()
		in.CognitoSub = ""
		p.PublishTrackingStatusChanged(context.Background(), in)

		envelope := decodeEnvelope(t, client.last())
		author, _ := envelope["author"].(map[string]any)
		if _, present := author["cognito_sub"]; present {
			t.Errorf("author.cognito_sub = %v, want the key absent", author["cognito_sub"])
		}
	})

	t.Run("shipping_address omitted on an explicit nil, not on emptiness", func(t *testing.T) {
		client := &fakeSQS{}
		p := sqs.NewPublisher(client, "q",
			stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())

		in := fullInput()
		in.ShippingAddress = nil
		p.PublishTrackingStatusChanged(context.Background(), in)
		payload, _ := decodeEnvelope(t, client.last())["payload"].(map[string]any)
		if _, present := payload["shipping_address"]; present {
			t.Errorf("shipping_address = %v on a nil address, want the key absent", payload["shipping_address"])
		}

		// An EXPLICIT empty string is a value, not an absence: the check is a nil
		// check, never truthiness.
		empty := ""
		in.ShippingAddress = &empty
		p.PublishTrackingStatusChanged(context.Background(), in)
		payload, _ = decodeEnvelope(t, client.last())["payload"].(map[string]any)
		if got, present := payload["shipping_address"]; !present || got != "" {
			t.Errorf("shipping_address = %v (present=%v), want an empty string present", got, present)
		}
	})

	t.Run("full_name ALWAYS present, empty when unknown", func(t *testing.T) {
		client := &fakeSQS{}
		p := sqs.NewPublisher(client, "q",
			stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com", FullName: ""}}, quietLog())
		p.PublishTrackingStatusChanged(context.Background(), fullInput())

		payload, _ := decodeEnvelope(t, client.last())["payload"].(map[string]any)
		got, present := payload["full_name"]
		if !present {
			t.Fatal("full_name is ALWAYS present, deliberately unlike shipping_address")
		}
		if got != "" {
			t.Errorf("full_name = %v, want \"\"", got)
		}
	})
}

// The actor is threaded through from the command, never chosen here. Hardcoding
// one would relabel every automatic progression as a carrier update.
func TestActorIsThreadedThroughNotConstant(t *testing.T) {
	for _, actor := range []audit.Actor{audit.CarrierStatusUpdate, audit.TestModeProgression} {
		t.Run(string(actor), func(t *testing.T) {
			client := &fakeSQS{}
			p := sqs.NewPublisher(client, "q",
				stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())
			in := fullInput()
			in.Actor = actor
			p.PublishTrackingStatusChanged(context.Background(), in)

			author, _ := decodeEnvelope(t, client.last())["author"].(map[string]any)
			if author["actor"] != string(actor) {
				t.Errorf("author.actor = %v, want %s", author["actor"], actor)
			}
		})
	}
}

// type and source travel as message attributes so the queue can be inspected
// without deserializing the body, and the W3C context rides beside them — NOT
// inside the envelope.
func TestMessageAttributes(t *testing.T) {
	client := &fakeSQS{}
	p := sqs.NewPublisher(client, "q",
		stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())
	p.PublishTrackingStatusChanged(context.Background(), fullInput())

	in := client.last()
	attrs := in.MessageAttributes
	if attrs["type"].StringValue == nil || *attrs["type"].StringValue != "TRACKING_STATUS_CHANGED" {
		t.Errorf("type attribute = %v", attrs["type"])
	}
	if attrs["source"].StringValue == nil || *attrs["source"].StringValue != "tracking" {
		t.Errorf("source attribute = %v", attrs["source"])
	}
	if attrs["type"].DataType == nil || *attrs["type"].DataType != "String" {
		t.Errorf("type DataType = %v", attrs["type"].DataType)
	}

	// The envelope must NOT carry transport concerns.
	envelope := decodeEnvelope(t, in)
	for _, key := range []string{"traceparent", "tracestate"} {
		if _, present := envelope[key]; present {
			t.Errorf("%s is inside the envelope; it belongs in MessageAttributes", key)
		}
	}
}

// With no valid active span the propagator writes nothing: omitted, never blank.
func TestTraceparentOmittedWithoutASpan(t *testing.T) {
	client := &fakeSQS{}
	p := sqs.NewPublisher(client, "q",
		stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())
	p.PublishTrackingStatusChanged(context.Background(), fullInput())

	if attr, present := client.last().MessageAttributes["traceparent"]; present {
		if attr.StringValue != nil && *attr.StringValue == "" {
			t.Error("a blank traceparent was sent; it must be omitted entirely")
		}
	}
}

// Four failure reasons, ALL logged and SWALLOWED. The transition is already
// committed; a raise would make the carrier retry into a 400.
func TestFailuresAreLoggedAndSwallowed(t *testing.T) {
	t.Run("email_resolution_failed", func(t *testing.T) {
		var buf strings.Builder
		client := &fakeSQS{}
		p := sqs.NewPublisher(client, "q",
			stubResolver{err: errors.New("users is unreachable")},
			slog.New(slog.NewJSONHandler(&buf, nil)))

		p.PublishTrackingStatusChanged(context.Background(), fullInput())

		if client.count() != 0 {
			t.Error("a message was sent despite a failed resolution")
		}
		if !strings.Contains(buf.String(), "email_resolution_failed") {
			t.Errorf("no reason=email_resolution_failed: %s", buf.String())
		}
	})

	t.Run("no_email_for_user aborts before building anything", func(t *testing.T) {
		var buf strings.Builder
		client := &fakeSQS{}
		p := sqs.NewPublisher(client, "q",
			stubResolver{user: grpcusers.ResolvedUser{InternalID: "usr_abc", Email: ""}},
			slog.New(slog.NewJSONHandler(&buf, nil)))

		p.PublishTrackingStatusChanged(context.Background(), fullInput())

		if client.count() != 0 {
			t.Error("a message was sent with no email")
		}
		if !strings.Contains(buf.String(), "no_email_for_user") {
			t.Errorf("no reason=no_email_for_user: %s", buf.String())
		}
	})

	t.Run("sqs_send_failed carries email_hash", func(t *testing.T) {
		var buf strings.Builder
		client := &fakeSQS{err: errors.New("queue unreachable")}
		p := sqs.NewPublisher(client, "q",
			stubResolver{user: grpcusers.ResolvedUser{Email: "person@example.com"}},
			slog.New(slog.NewJSONHandler(&buf, nil)))

		p.PublishTrackingStatusChanged(context.Background(), fullInput())

		out := buf.String()
		if !strings.Contains(out, "sqs_send_failed") {
			t.Errorf("no reason=sqs_send_failed: %s", out)
		}
		if !strings.Contains(out, sqs.HashEmail("person@example.com")) {
			t.Errorf("sqs_send_failed must carry email_hash: %s", out)
		}
		// NEVER the plaintext address.
		if strings.Contains(out, "person@example.com") {
			t.Errorf("the log line leaked a plaintext email: %s", out)
		}
	})

	t.Run("publisher_unavailable when the queue url is empty", func(t *testing.T) {
		var buf strings.Builder
		client := &fakeSQS{}
		p := sqs.NewPublisher(client, "",
			stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}},
			slog.New(slog.NewJSONHandler(&buf, nil)))

		p.PublishTrackingStatusChanged(context.Background(), fullInput())

		if client.count() != 0 {
			t.Error("a message was sent with no queue url")
		}
		if !strings.Contains(buf.String(), "publisher_unavailable") {
			t.Errorf("no reason=publisher_unavailable: %s", buf.String())
		}
	})
}

// The address, the name and the email never appear in any log line.
func TestNoPIIIsLogged(t *testing.T) {
	var buf strings.Builder
	client := &fakeSQS{err: errors.New("boom")}
	p := sqs.NewPublisher(client, "q",
		stubResolver{user: grpcusers.ResolvedUser{
			Email: "person@example.com", FullName: "Ada Lovelace"}},
		slog.New(slog.NewJSONHandler(&buf, nil)))

	p.PublishTrackingStatusChanged(context.Background(), fullInput())

	for _, forbidden := range []string{"person@example.com", "Ada Lovelace", "1 Main St"} {
		if strings.Contains(buf.String(), forbidden) {
			t.Errorf("the log leaked PII %q: %s", forbidden, buf.String())
		}
	}
}

func TestNoopPublisherSendsNothing(t *testing.T) {
	sqs.NewNoopPublisher().PublishTrackingStatusChanged(context.Background(), fullInput())
}

var _ = sqstypes.MessageAttributeValue{}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && go test ./internal/adapter/sqs/...
```

Expected: `no required module provides package .../internal/adapter/sqs`.

- [ ] **Step 3: Write minimal implementation**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && go get github.com/aws/aws-sdk-go-v2/service/sqs
```

`services/tracking-go/internal/adapter/sqs/emailhash.go`:
```go
package sqs

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// HashEmail returns a non-reversible id for an email, safe to log.
//
// The CROSS-SERVICE contract: SHA-256 of the TRIMMED, LOWERCASED address, hex,
// first 16 chars — identical to Users' hashEmail and Orders' EmailHash.Compute.
// If the three ever drift, filtering one user's lines across services silently
// returns NOTHING instead of erroring, which is the failure mode worth a test of
// its own.
func HashEmail(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return hex.EncodeToString(sum[:])[:16]
}
```

`services/tracking-go/internal/adapter/sqs/envelope.go`:
```go
package sqs

import (
	"crypto/sha256"
	"encoding/hex"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// The envelope's type and source. type must match the key the pipeline's handler
// map dispatches on — an unknown type dead-ends in FAILED "Unknown event type".
const (
	EventType   = "TRACKING_STATUS_CHANGED"
	EventSource = "tracking"
)

const (
	eventIDPrefix     = "evt_"
	eventIDHashLength = 16
)

// HistoryEntry is one transition in the published timeline.
//
// Only status and datetime: tracking_id, order_id, user_id and cognito_sub are on
// every row but are identical across all of them and already present at the
// envelope root, so repeating them per entry would be five copies of one fact —
// and cognito_sub in particular is an ownership key with no business leaving the
// service.
type HistoryEntry struct {
	Status   string
	Datetime time.Time
}

// StatusChanged is everything the publisher needs about one transition. Every
// subject-side field comes off the PERSISTED ROW; none comes from the request,
// because the carrier webhook carries no caller identity at all.
type StatusChanged struct {
	OrderID string
	// UserID is the event's SUBJECT (the order's owner) and travels at the
	// envelope ROOT — never inside author.
	UserID string
	Status string
	// PreviousStatus is the one field that cannot come off the entity: the row's
	// status is already the NEW one by the time this runs.
	PreviousStatus string
	TrackingNumber string
	// ChangedAt is the transition's own timestamp, NOT updated_at, which moves on
	// any write.
	ChangedAt time.Time
	// ShippingAddress is nil when the row holds NULL. The omission check is an
	// EXPLICIT nil check, never truthiness — an empty string is a value.
	ShippingAddress *string
	History         []HistoryEntry
	// Actor is what ORIGINATED the transition, threaded down from the command.
	// Never a constant chosen here: this publisher serves both the carrier
	// webhook and TestMode progression, and a constant would relabel every
	// automatic progression as a real carrier update.
	Actor audit.Actor
	// CognitoSub comes off the PERSISTED ROW, never the request. It becomes the
	// optional author.cognito_sub, which the pipeline uses to route the realtime
	// WebSocket push — handing that index a usr_ id returns an empty list with no
	// error, so the push would silently reach nobody.
	CognitoSub string
}

// envelope is marshalled directly. Every omitempty here implements a rule from
// the downstream Zod schema, which REJECTS NULLS: a violation is a PermanentError
// that consumes the record and LOSES the email and the push, and nothing upstream
// notices.
type envelope struct {
	EventID string `json:"event_id"`
	Type    string `json:"type"`
	Source  string `json:"source"`
	UserID  string `json:"user_id"`
	OrderID string `json:"order_id"`
	// Omitted when empty, never null, never "" — the schema declares it
	// .optional() with .min(1).
	RequestID string  `json:"request_id,omitempty"`
	Author    author  `json:"author"`
	Payload   payload `json:"payload"`
}

// author carries ONLY actor and an optional cognito_sub.
//
// There is deliberately no user_id field and no source field, and their absence
// is structural rather than conditional: no write path here has a human author,
// and the root `source` already names the producer. A field that must never
// appear is best represented by not existing.
type author struct {
	Actor      string `json:"actor"`
	CognitoSub string `json:"cognito_sub,omitempty"`
}

type payload struct {
	Status         string `json:"status"`
	PreviousStatus string `json:"previous_status"`
	// ISO-8601 string, not a time.Time: the wire shape is the contract, and a
	// marshalling default is not something to leave to the encoder.
	ChangedAt string `json:"changed_at"`
	Email     string `json:"email"`
	// ALWAYS present, "" when unknown — deliberately different from
	// ShippingAddress. An absent address means the notification cannot be
	// delivered at all; an absent name is cosmetic, the mail still sends, and the
	// template interpolates a plain string.
	FullName       string `json:"full_name"`
	OrderID        string `json:"order_id"`
	TrackingNumber string `json:"tracking_number"`
	// A POINTER with omitempty semantics via the nil check in the builder: the
	// key is OMITTED when the row's column is NULL, never sent as null. A
	// "shipping_address": null would make the template branch on two spellings of
	// "no address" instead of one.
	ShippingAddress *string        `json:"shipping_address,omitempty"`
	History         []historyEntry `json:"history"`
}

type historyEntry struct {
	Status   string `json:"status"`
	Datetime string `json:"datetime"`
}

// DeriveEventID is the idempotency key for one transition.
//
// DETERMINISTIC ON PURPOSE — never a fresh id per attempt. The pipeline dedupes
// on a unique index over event_id, so a redelivery is only collapsed if the
// retried message carries the SAME id. A randomly generated one would slip past
// that index and send a SECOND notification email for a transition that already
// succeeded.
//
// (order_id, status) is a genuine natural key, not a convenient one: the state
// machine is forward-only and tracking_history's primary key is
// (tracking_id, status), so a given order enters each status at most once. Two
// events with this id are therefore, by construction, the same transition.
//
// This matters most under TestMode, which walks all five statuses in ~40 seconds:
// a transient SQS error anywhere in that burst retries into the same id rather
// than into a duplicate email.
//
// The pair is HASHED rather than interpolated so the id has a fixed shape and
// length whatever an order id contains. The hash is not a security boundary; it
// is a formatting one.
func DeriveEventID(orderID, status string) string {
	sum := sha256.Sum256([]byte(orderID + "|" + status))
	return eventIDPrefix + hex.EncodeToString(sum[:])[:eventIDHashLength]
}
```

`services/tracking-go/internal/adapter/sqs/publisher.go`:
```go
// Package sqs publishes TRACKING_STATUS_CHANGED onto the shared events queue.
//
// # The wire contract, and where it comes from
//
// THE AUTHORITY IS THE CONSUMER, not this file:
// functions/events-pipeline/src/domain/envelope.ts and
// .../handlers/tracking-status-changed.ts. A missing or misnamed field is NOT a
// loud failure — the handler rejects it as a PermanentError, the record is
// consumed rather than retried, and the user never gets an email. Nothing
// upstream notices. That is why the envelope is built literally against those two
// schemas.
//
// # FAILURE POLICY: LOG AND SWALLOW
//
// Neither a failed email resolution nor a failed send propagates. The transition
// is already persisted and COMMITTED by the time this runs, and this endpoint's
// two callers make raising the worse option:
//
//   - The CARRIER WEBHOOK is an external third party. A 500 makes it retry the
//     PUT — and the retry hits the SAME transition it already applied, which the
//     forward-only state machine rejects with a 400. So the carrier would see a
//     permanent-looking failure for a status change we actually recorded, and
//     would keep redelivering until it gave up.
//   - TESTMODE PROGRESSION already swallows everything by design; an error here
//     would silently end the run three transitions early.
//
// The trade accepted is AT-MOST-ONCE delivery of the notification, which is the
// correct direction for this event: a missed "out for delivery" email is a
// degraded experience, while a duplicate one is a bug report.
//
// This is NOT silent: every failure is an ERROR line with a machine-readable
// reason, which is what makes it alertable.
//
// # PII
//
// email, full_name and shipping_address travel in the payload because the
// pipeline needs somewhere to send the mail and something to render in it, and
// NOWHERE else. None is ever logged: failure lines carry email_hash plus user_id
// and order_id, never the address, the name, or the delivery address.
package sqs

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/aws/aws-sdk-go-v2/aws"
	awssqs "github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	oteltrace "go.opentelemetry.io/otel/trace"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers"
	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// PublishSpanName is the queue hop's span name, NAMED AFTER WHAT IS PUBLISHED,
// not after where it goes.
//
// All three producers publish every event type onto the SAME shared queue, so a
// name identifying the transport reads as a distinction and is not one: a reader
// looking at a cascade could not tell a tracking transition from an order
// confirmation. This is the same shape Orders uses (`sqs.publish order_created`),
// so one query reads the queue hop across all producers.
const PublishSpanName = "sqs.publish tracking_status_changed"

const appEventPublishFailed = "tracking_status_changed_publish_failed"

// SendMessageAPI is the one SQS call this package makes, declared here by the
// consumer so the SDK client satisfies it directly.
type SendMessageAPI interface {
	SendMessage(ctx context.Context, in *awssqs.SendMessageInput, opts ...func(*awssqs.Options)) (*awssqs.SendMessageOutput, error)
}

// UserResolver is declared HERE, by the publisher that consumes it — narrow, one
// method, never a central interface file. The grpcusers client satisfies it
// without importing this package.
//
// The publisher resolves the user itself because the pipeline's handler REQUIRES
// email (and now full_name), and Tracking persists neither. Doing it here rather
// than in the update command keeps the command's job the state transition: it
// would otherwise have to handle a Users outage in the middle of a database
// write.
type UserResolver interface {
	Resolve(ctx context.Context, identifier string) (grpcusers.ResolvedUser, error)
}

// Publisher emits one transition. PublishTrackingStatusChanged NEVER returns an
// error — that is the contract, not an implementation detail.
type Publisher interface {
	PublishTrackingStatusChanged(ctx context.Context, in StatusChanged)
}

type publisher struct {
	client   SendMessageAPI
	queueURL string
	resolve  UserResolver
	log      *slog.Logger
}

// NewPublisher builds the SQS-backed publisher.
func NewPublisher(client SendMessageAPI, queueURL string, resolve UserResolver, log *slog.Logger) Publisher {
	if log == nil {
		log = slog.Default()
	}
	return &publisher{client: client, queueURL: queueURL, resolve: resolve, log: log}
}

// PublishTrackingStatusChanged emits one transition. Never fails the caller.
//
// INVARIANT: creation NEVER emits an event. Only status updates do. A TestMode
// run therefore produces 5 history rows and 4 events.
func (p *publisher) PublishTrackingStatusChanged(ctx context.Context, in StatusChanged) {
	if p.queueURL == "" {
		p.fail(ctx, "publisher_unavailable", in, "")
		return
	}

	user, err := p.resolve.Resolve(ctx, in.UserID)
	if err != nil {
		p.fail(ctx, "email_resolution_failed", in, "")
		return
	}
	if user.Email == "" {
		// ABORT BEFORE BUILDING ANYTHING: the handler rejects a payload without
		// an email as a PERMANENT error, so the mail would never be sent and the
		// record would be consumed.
		p.fail(ctx, "no_email_for_user", in, "")
		return
	}

	body, err := json.Marshal(buildEnvelope(ctx, in, user))
	if err != nil {
		p.fail(ctx, "sqs_send_failed", in, HashEmail(user.Email))
		return
	}

	ctx, span := tracing.Tracer(tracing.TracerMessaging).Start(ctx, PublishSpanName,
		oteltrace.WithSpanKind(oteltrace.SpanKindProducer),
		oteltrace.WithAttributes(
			attribute.String("app_event", "tracking_status_changed_published"),
			attribute.String("messaging.system", "aws_sqs"),
			attribute.String("event_type", EventType),
			attribute.String("event_id", DeriveEventID(in.OrderID, in.Status)),
			attribute.String("order_id", in.OrderID),
		),
	)
	defer span.End()

	_, err = p.client.SendMessage(ctx, &awssqs.SendMessageInput{
		QueueUrl:    aws.String(p.queueURL),
		MessageBody: aws.String(string(body)),
		// The trace context is injected INSIDE this span — see
		// buildMessageAttributes.
		MessageAttributes: buildMessageAttributes(ctx),
	})
	if err != nil {
		// The span going ERROR is the only place this failure is visible in a
		// waterfall: the caller sees nothing, by the policy above.
		span.SetStatus(codes.Error, "sqs_send_failed")
		p.fail(ctx, "sqs_send_failed", in, HashEmail(user.Email))
		return
	}
	span.SetStatus(codes.Ok, "")
}

// fail logs one of the four reasons and returns. Never raises.
//
// emailHash is carried ONLY on sqs_send_failed, where an address was resolved and
// the send is what broke — the other three have no resolved address to identify.
// The plaintext email never appears.
func (p *publisher) fail(ctx context.Context, reason string, in StatusChanged, emailHash string) {
	attrs := []any{
		slog.String("app_event", appEventPublishFailed),
		slog.String("reason", reason),
		slog.String("order_id", in.OrderID),
		slog.String("user_id", in.UserID),
		slog.String("status", in.Status),
	}
	if emailHash != "" {
		attrs = append(attrs, slog.String("email_hash", emailHash))
	}
	p.log.ErrorContext(ctx, appEventPublishFailed, attrs...)
}

// buildEnvelope assembles the wire shape field by field. Every omission below is
// a rule, not a style choice — see envelope.go.
func buildEnvelope(ctx context.Context, in StatusChanged, user grpcusers.ResolvedUser) envelope {
	history := make([]historyEntry, 0, len(in.History))
	for _, entry := range in.History {
		history = append(history, historyEntry{
			Status:   entry.Status,
			Datetime: entry.Datetime.UTC().Format("2006-01-02T15:04:05"),
		})
	}

	env := envelope{
		EventID: DeriveEventID(in.OrderID, in.Status),
		Type:    EventType,
		Source:  EventSource,
		UserID:  in.UserID,
		OrderID: in.OrderID,
		Author: author{
			Actor: string(in.Actor),
			// Omitted when empty; comes off the persisted row, never the request.
			CognitoSub: in.CognitoSub,
		},
		Payload: payload{
			Status:         in.Status,
			PreviousStatus: in.PreviousStatus,
			ChangedAt:      in.ChangedAt.UTC().Format("2006-01-02T15:04:05"),
			Email:          user.Email,
			// ALWAYS present, "" when unknown.
			FullName:       user.FullName,
			OrderID:        in.OrderID,
			TrackingNumber: in.TrackingNumber,
			// An EXPLICIT nil check, never truthiness: an empty string is a value
			// the row actually holds, and only NULL means "no address".
			ShippingAddress: in.ShippingAddress,
			History:         history,
		},
	}

	// Omitted when empty, never null, never "".
	for _, field := range logging.LogFields(ctx) {
		if field.Key == logging.KeyRequestID {
			env.RequestID = field.Value.String()
			break
		}
	}
	return env
}

// buildMessageAttributes returns type, source, and the W3C trace context.
//
// # type and source
//
// Duplicated out of the envelope so the queue can be inspected and filtered
// without deserializing the body — the same two keys Users and Orders set.
//
// # traceparent, and why it rides HERE and not in the envelope
//
// SQS is where the trace would otherwise end: the pipeline's Lambda is a separate
// process reached through a queue, so nothing links its spans to the PUT that
// produced the message unless the context travels with it. MessageAttributes is
// the transport SQS gives us for exactly that.
//
// It is deliberately NOT a field of the envelope. The envelope is the DOMAIN
// contract with events-pipeline and a transport concern has no business in it;
// the consumer reads record.messageAttributes.traceparent.stringValue, which needs
// no schema change at all.
//
// # It MUST be called INSIDE the publish span
//
// The propagator reads whatever span is ACTIVE at the moment it runs, so WHERE
// this is called decides which span the consumer parents itself to. Evaluated one
// line earlier it would write the enclosing WORKFLOW span's id, and the pipeline's
// spans would hang BESIDE the publish rather than under it — a trace that still
// looks complete. Orders hit exactly this and fixed it the same way.
//
// # Omitted, never empty
//
// The propagator writes NOTHING into the carrier when there is no valid active
// span, so this loop adds zero keys rather than a blank traceparent. That matters:
// the consumer would treat "" as a malformed-but-present context, which is
// strictly worse than an absent one it can link nothing to.
func buildMessageAttributes(ctx context.Context) map[string]sqstypes.MessageAttributeValue {
	attributes := map[string]sqstypes.MessageAttributeValue{
		"type":   {DataType: aws.String("String"), StringValue: aws.String(EventType)},
		"source": {DataType: aws.String("String"), StringValue: aws.String(EventSource)},
	}

	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	for key, value := range carrier {
		if value == "" {
			continue
		}
		attributes[key] = sqstypes.MessageAttributeValue{
			DataType:    aws.String("String"),
			StringValue: aws.String(value),
		}
	}
	return attributes
}

// noopPublisher discards every call.
//
// NOT dead code, and kept for the same reason Users and Orders keep theirs: a
// test (or an environment) that must not emit binds this instead, rather than the
// command growing an `if publishEnabled` branch that production would then carry
// forever.
//
// Deliberately records nothing. A test that needs to ASSERT on what was published
// uses its own recording fake — a Noop that silently swallowed the call cannot
// fail when the call stops happening.
type noopPublisher struct{}

// NewNoopPublisher returns the discarding publisher.
func NewNoopPublisher() Publisher { return noopPublisher{} }

func (noopPublisher) PublishTrackingStatusChanged(context.Context, StatusChanged) {}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/services/tracking-go && goenv local 1.25.14 && gofmt -s -w ./internal/adapter/sqs && go test ./internal/adapter/sqs/... -race -v
```

Expected: every subtest `--- PASS`, the four omission-rule subtests and the four failure-reason subtests included.

- [ ] **Step 5: Commit**

```
feat(tracking): SQS event publisher with deterministic event ids and strict omission rules
```

---

## Wave 1 equivalence map

The shared/ modules this wave ports, and the tacit rules extracted from each — the ones that live only in a Python docstring or a comment and would be silently lost in a mechanical translation.

| Source Python file | Destination Go file(s) | Tacit rules found |
|---|---|---|
| `src/shared/config/settings.py` | `internal/platform/config/config.go`, `dsn.go` | Exactly 4 required vars; every other value falls back to its default on an unparseable input, never a startup failure. `METRICS_ENABLED` defaults **true** and `E2E_TESTING_ENABLED` defaults **false** — opposite directions on purpose. Both flags are read from the raw environment, not through a validated model, because they are consulted while the app is being constructed. `AWS_ENDPOINT_URL` must be nil-able, not `""`. `EVENTS_QUEUE_URL` defaults empty so test fixtures need not supply it. `USERS_GRPC_URL` is defaulted (not required) because the generator does not yet emit it. `ENVIRONMENT` is a rejecting enum; `echo_sql` is `environment != "production"`. DSNs are SQLAlchemy-shaped and need conversion with `parseTime=true&loc=UTC` always appended. |
| `src/shared/logging/json_formatter.py` | `internal/platform/logging/handler.go`, `logger.go` | Field ORDER is part of the schema. `WARN`/`FATAL`, never `WARNING`/`CRITICAL` — both spellings at once made dashboard filters return half the matches. Severity numbers 5/9/13/17/21, fallback 0. Timestamp is UTC ISO-8601 at millisecond precision with a `Z`, not RFC3339Nano. `None` is dropped entirely; a non-serializable value is **stringified, never dropped**. `exception`/`stack` only when present. |
| `src/shared/logging/log_context.py` | `internal/platform/logging/context.go` | A FIXED set of exactly 7 keys, never a free map — a typo'd key would become a new indexed field. Both `None` and `""` are dropped. Merge REBINDS rather than mutates, so a concurrently-copied context cannot be changed underneath. |
| `src/shared/logging/context_filter.py` | `internal/platform/logging/context_handler.go` | An explicit field at the call site WINS over the ambient context — a handler logging about a different order is being specific on purpose. Enrichment lives on the HANDLER, not per-logger, so library records are enriched too. It never filters anything out. |
| `src/shared/logging/request_id.py` | `internal/platform/logging/requestid.go` | `req_` + exactly 24 nano-alphabet chars, validated with a FULL match and an exact length. A malformed inbound id is silently replaced, never a 400 — a correlation header is a convenience, not a contract. The pattern is the only thing between an untrusted header and every log line of the flow. The id is deliberately NOT a second `trace_id`: the runtimes at the ends of these flows have no OTel SDK. |
| `src/shared/logging/trace_filter.py` | `internal/adapter/otel/loghandler.go` | Lowercase hex zero-padded to 32/16 — a join is string equality, so any other rendering matches nothing. OMITTED, never zeroed, when the span context is invalid: an all-zero id reads as real and makes unrelated lines appear to share a trace. Same call-site precedence rule as the log context. |
| `src/shared/logging/config.py` | `internal/platform/logging/logger.go` | Idempotent installation (replace the handler, never stack a second). The uvicorn/SQLAlchemy handler-stripping has **no Go analogue** — Gin and `database/sql` do not install their own handlers — so that logic is deliberately not ported; what carries over is the single-stdout-handler rule. |
| `src/shared/http/log_context_middleware.py` | `internal/adapter/http/logcontext_middleware.go` | The request line is the ONE line with no `app_event`; message literally `request completed`. `http_route` is the matched TEMPLATE (cardinality). INFO for every status including 5xx — the status already encodes the outcome. Health exemption applies **only to 2xx** (353/368 lines measured). The id is seeded at the OUTERMOST layer so 401s and 404s carry one. The `X-Cache`-off-the-wire workaround is a contextvars/threadpool artifact with **no Go analogue** — a Gin handler shares the request's context — so the cache result can be merged directly. |
| `src/shared/observability/workflow_tracing.py` | `internal/adapter/otel/workflow.go`, `provider.go` | `INTERNAL` kind; status OK on success. The exception must be recorded EXACTLY ONCE — Python disables the SDK's own recorder because it runs after the except arm and overwrites the chosen description. `mark_phase` is an EVENT, not a span, and no-ops outside a recording span. Tracer names are exact. Endpoint/protocol/exporters come from env vars only. `/v1/health` is excluded from tracing. |
| `src/shared/metrics/cloudwatch_metrics.py` + `features/tracking/commands/publish_metrics.py` | `internal/adapter/cloudwatch/publisher.go`, `ticker.go` | One namespace `3MRAI` across all four services; the dimension SET is a contract because Floci does not aggregate across dimensions (a wrong query returns an empty result, not an error). One datum per call, unit always `Count`. `Publish` never raises. The ticker SLEEPS FIRST. Five data points per tick, `http_errors_total` seeded at zero. Zeros are published — a series that stops reads as "no data". `ALL` is pre-summed because the collector queries with `Maximum`. Anything not `DELIVERED` is `IN_PROGRESS`, unknown statuses included. A failed tick continues the loop, unlike TestMode. |
| `src/shared/cache/keys.py` | `internal/adapter/redis/keys.go` | Every response key carries BOTH identities. The first segment is the RAW header and may be a sub OR a `usr_` id. A builder answers "no key" without a `user_id`, and the route then skips caching entirely. The list digest is sha256 of sorted-unique ids joined by `\n`, truncated to 16 — a per-process hash would break cross-replica hits (Go: never `maphash`). `PrefixOf` keeps exactly 3 segments; everything after is identity. |
| `src/shared/cache/gateway.py` | `internal/adapter/redis/gateway.go` | Three outcomes, not two: MISS ≠ BYPASS, or an outage reads as a poor hit rate. A malformed payload is a MISS (Redis is fine, the entry is not). Never raises. TTL `-1`/`-2` both mean unknown → omit `X-Cache-TTL`. Index TTL is deliberately LONGER than any entry it tracks. Spans are hand-written because `cache.result`/`cache.ttl_remaining` are business facts. The full key never leaves the file. `invalidate_index` is SMEMBERS+DEL, never KEYS/SCAN. The null object, not a flag, expresses a disabled cache. |
| `src/shared/cache/redis_client.py` | `internal/adapter/redis/client.go` | One shared timeout budget for connect and socket. Retries DISABLED — a retry doubles the budget on exactly the path the cache exists to speed up. With the cache off, construct NO client at all. |
| `src/shared/cache/identity_cache.py` | `internal/adapter/redis/identity.go` | NEGATIVES ARE NEVER CACHED — caching one would disable the response cache for that caller for the whole hour. TTL-only invalidation is correct because a sub never resolves to a different id while the account exists. The value is a bare JSON string. One person can own several entries. |
| `src/shared/cache/invalidation.py` | `internal/adapter/redis/invalidation.go` | Skip reasons `no_owner_sub` / `no_owner_user_id`, both no-ops and both safe. The cascade sweeps BOTH identifiers in the first key position — sweeping only the canonical pair leaked deleted-account data for its full TTL, verified live in Orders. Deduplicated and order-preserving. Never raises: the deletion has already committed. Non-normalization of keys is an accepted, recorded trade-off. |
| `src/shared/http/identity.py` | `internal/adapter/http/auth.go` | The header is named `x-user-id` but holds a Cognito SUB. EMPTY IS MISSING — nginx sends `""`, and accepting it would scope a read to `cognito_sub = ''`, a silent empty result instead of a 401. 401, not 403. Per-route rather than middleware-plus-allowlist, so the carrier PUT is unauthenticated by simply not asking. |
| `src/shared/http/carrier_auth.py` + `internal_auth.py` | `internal/adapter/http/auth.go` | Two schemes, one header NAME, two secrets in two trust domains — never collapse them. Constant-time comparison; length leaks, contents do not. Missing and wrong are indistinguishable, identical body. Log `reason=invalid_api_key` and the client IP; never the key, not a prefix, not its length. Kept as separate functions so the wrong-key mistake is structurally harder. |
| `src/shared/http/e2e_source.py` | `internal/adapter/http/flags.go` | The result is the AND of header and flag, evaluated in the middleware so a handler cannot tag on the header alone. Only the exact `"true"`, case-insensitive after trimming — no `1`, no `yes`. Never an error for an unrecognized value. The tag is exactly `E2E Source`. |
| `src/shared/http/test_mode.py` | `internal/adapter/http/flags.go` | Same parsing, deliberately **not** guarded by `E2E_TESTING_ENABLED` in this service — a recorded known open item, not a bug to fix during the migration. A header, not a body field, so a test switch stays out of the public schema. |
| `src/shared/audit/audit_actor.py` | `internal/domain/audit/actor.go` | Five exact `<source>:<action>` strings, persisted in `created_by`/`updated_by`/`deleted_by`. The value records what PRODUCED the row, not who requested it — two of three write paths have no user identity at all. Never widen speculatively. |
| `src/shared/grpc/users_client.py` | `internal/adapter/grpcusers/client.go`, `target.go` | ONLY `NOT_FOUND` means "no such user"; every other status propagates, or an outage reads as a missing user. Scheme stripping so one env var serves both grpc-go and .NET. Per-call metadata for the key AND the request id; the id is omitted when empty. 2s timeout, insecure channel. Never log a `UserResponse`. Address deliberately not carried. Email `""` → treated as absent; full_name `""` kept as-is — the asymmetry is deliberate. An empty api key fails at construction. |
| `src/shared/messaging/sqs_event_publisher.py` + `event_publisher.py` | `internal/adapter/sqs/publisher.go`, `envelope.go`, `emailhash.go` | Deterministic `event_id` from `(order_id, status)` — a random one sends a duplicate email past the dedupe index. Seven omission rules, each enforcing a downstream Zod constraint whose violation loses the email silently. `author.user_id` and `author.source` must NEVER exist. `full_name` always present vs `shipping_address` omitted — different kinds of missing. `actor` threaded through, never a constant. Trace context in message ATTRIBUTES, injected INSIDE the publish span. Span named after the event, not the queue. Four failure reasons, all swallowed; only `sqs_send_failed` carries `email_hash`. `hash_email` is a cross-service contract. Creation never emits; a TestMode run is 5 history rows and 4 events. |
## Wave 2 — Endpoints

Wave 2 ports the seven HTTP routes. Waves 0 and 1 have already produced: the domain
package (`internal/domain`), the sqlc-generated MySQL queries, the Redis cache gateway,
the SQS publisher, the gRPC Users client, the OTel/slog plumbing, and the middleware
(caller identity, carrier auth, internal auth, e2e-source, log context, cache result).
Wave 2 assembles those into handlers.

**Five agents run in parallel.** The file sets are disjoint by construction — each task
owns its own `internal/app/*.go`, its own `internal/adapter/http/handler_*.go`, and its
own tests. Every agent appends its wiring to `cmd/server/main.go` in a distinct,
clearly-delimited block; if two agents touch that file simultaneously, the last one
merges by hand (the blocks do not overlap semantically).

| Agent | Tasks | Owns |
|---|---|---|
| A | 18 | `POST /v1/trackings/init-tracking` |
| B | 19 | `GET /v1/trackings/{order_id}` and `GET /v1/trackings?order_ids=` |
| C | 20 | `PUT /v1/trackings/{order_id}/status` |
| D | 21 | `DELETE /v1/trackings/by-user` and `DELETE /v1/trackings/e2e-cleanup` |
| E | 22 | `openapi.yaml` generation + comparison test |

Then **Wave 2.5** (Task 24, TestMode) runs alone — it consumes Task 19's hook and Task
20's transition function, so it cannot start until both are merged. Then **Wave 3**
(Tasks 24–26) verifies.

### Response shapes — defined once, in Task 19, referenced by name afterwards

Task 19 creates `internal/adapter/http/response.go`. Every later task imports those
types and MUST NOT redeclare them.

`TrackingResponse` is the shared read shape:

```json
{
  "id": "trk_...",
  "user_id": "usr_...",
  "order_id": "ord_...",
  "status": "PLACED",
  "datetime": "2026-08-27T14:53:01.123456Z",
  "history": [
    {"tracking_id": "trk_...", "user_id": "usr_...", "order_id": "ord_...",
     "status": "PLACED", "datetime": "2026-08-27T14:53:01.123456Z"}
  ]
}
```

All keys are snake_case. `datetime` is a STRING — Python renders `isoformat() + "Z"`, so
Go must format with `2006-01-02T15:04:05.999999` and append `"Z"` (the `.999999`
verb drops trailing zeros exactly as Python's `isoformat()` does, and omits the
fractional part entirely when it is zero). A nil timestamp renders as `""`, NEVER
`null`. Neither `shipping_address` nor `cognito_sub` appears on any response, and the
response structs are declared so they physically cannot hold them.

Three error body shapes coexist in this service. **Do not unify them** — each is
observable by a shipped client.

- **Shape A — flat, no reason:** `{"detail": "..."}`. Used by every 401, the 404 on
  `GET /{order_id}`, the 404 on the carrier PUT, and the 400 on the batch read.
- **Shape B — NESTED:** `{"detail": {"detail": "...", "reason": "..."}}`. Used ONLY by
  the 404 and the 409 on `POST /init-tracking`. The Python raises
  `HTTPException(detail={"detail":…, "reason":…})` and FastAPI wraps it. **The generated
  `services/tracking/openapi.yaml` declares these as a flat `ErrorResponse` — the SPEC IS
  WRONG and the CODE IS RIGHT.** FastAPI cannot express the wrapping in its schema. Match
  the code; Task 23 records the spec difference in its allowlist.
- **Shape C — flat WITH reason:** `{"detail": "...", "reason": "..."}`. Used ONLY by the
  400 on the carrier PUT (Python routes it through a custom exception handler precisely
  to avoid Shape B).
- **Shape D — 422 validation:**
  `{"detail": [{"loc": ["body","order_id"], "msg": "...", "type": "..."}]}`.

---

### Task 19: POST /v1/trackings/init-tracking — creation

**Files:**
- Create: `services/tracking-go/internal/app/create_tracking.go`
- Create: `services/tracking-go/internal/app/create_tracking_test.go`
- Create: `services/tracking-go/internal/adapter/http/response.go`
- Create: `services/tracking-go/internal/adapter/http/errors.go`
- Create: `services/tracking-go/internal/adapter/http/handler_init_tracking.go`
- Create: `services/tracking-go/internal/adapter/http/handler_init_tracking_test.go`
- Create: `services/tracking-go/internal/adapter/mysql/create_tracking.go`
- Create: `services/tracking-go/internal/adapter/mysql/create_tracking_test.go`
- Modify: `services/tracking-go/cmd/server/main.go`

**Interfaces:**

Consumes (ports declared IN `create_tracking.go`, narrow, not shared):

```go
// UserResolver resolves the caller's internal usr_ id from their Cognito sub.
type UserResolver interface {
	ResolveInternalUserID(ctx context.Context, cognitoSub string) (string, error)
}

// TrackingCreator persists a tracking and its first history row in ONE unit of work.
type TrackingCreator interface {
	// ExistsByOrderID reports whether a LIVE tracking already exists for orderID.
	ExistsByOrderID(ctx context.Context, orderID string) (bool, error)
	// Create writes the tracking and its opening history row atomically, both
	// stamped from `now`. It returns domain.ErrTrackingAlreadyExists when the
	// unique index rejects a racing INSERT.
	Create(ctx context.Context, in domain.NewTracking, now time.Time) (domain.TrackingWithHistory, error)
}
```

Produces:

```go
package app

type CreateTrackingInput struct {
	OrderID         string
	CognitoSub      string
	ShippingAddress map[string]any
	E2ESource       bool
}

type CreateTracking struct {
	users   UserResolver
	writer  TrackingCreator
	clock   func() time.Time
}

func NewCreateTracking(users UserResolver, writer TrackingCreator, clock func() time.Time) *CreateTracking
func (uc *CreateTracking) Execute(ctx context.Context, in CreateTrackingInput) (domain.TrackingWithHistory, error)

// Sentinel errors, declared beside the use case that produces them.
var ErrUnknownUser = errors.New("user not found")
```

```go
package http // internal/adapter/http

type HistoryEntryResponse struct {
	TrackingID string `json:"tracking_id"`
	UserID     string `json:"user_id"`
	OrderID    string `json:"order_id"`
	Status     string `json:"status"`
	Datetime   string `json:"datetime"`
}

type TrackingResponse struct {
	ID       string                 `json:"id"`
	UserID   string                 `json:"user_id"`
	OrderID  string                 `json:"order_id"`
	Status   string                 `json:"status"`
	Datetime string                 `json:"datetime"`
	History  []HistoryEntryResponse `json:"history"`
}

func NewTrackingResponse(t domain.TrackingWithHistory) TrackingResponse
func ISO(t *time.Time) string

// Error bodies. Three shapes, deliberately three types.
type FlatError struct { Detail string `json:"detail"` }                                  // Shape A
type NestedError struct { Detail NestedErrorBody `json:"detail"` }                       // Shape B
type NestedErrorBody struct { Detail string `json:"detail"`; Reason string `json:"reason"` }
type ReasonError struct { Detail string `json:"detail"`; Reason string `json:"reason"` } // Shape C
type ValidationError struct { Detail []ValidationDetail `json:"detail"` }                // Shape D
type ValidationDetail struct {
	Loc []string `json:"loc"`
	Msg string   `json:"msg"`
	Typ string   `json:"type"`
}
```

```go
type InitTrackingHandler struct { ... }
func NewInitTrackingHandler(uc *CreateTracking, hook ProgressionHook, log *slog.Logger, tracer trace.Tracer) *InitTrackingHandler
func (h *InitTrackingHandler) Handle(c *gin.Context)

// ProgressionHook is the TestMode seam. Wave 2.5 supplies the real implementation;
// Wave 2 wires a no-op.
type ProgressionHook interface {
	Start(orderID string)
}
```

**Contract this task must reproduce (extracted from `services/tracking/src/features/tracking/api/init_tracking_router.py` and `commands/create_tracking.py`):**

- Body: `order_id` (string, required, min length 1, **max length 28**) and
  `shipping_address` (object, optional, FREE-FORM — no inner schema).
  The permissiveness is deliberate: the shape is owned by Orders/Users and this service
  only stores it, so a strict model would turn an additive upstream field into a
  creation outage.
- Python declares `model_config = ConfigDict(extra="forbid")`. Go's `encoding/json`
  silently ignores unknown fields, so the handler MUST call
  `decoder.DisallowUnknownFields()` — **on this endpoint only**. Getting this wrong
  reintroduces exactly the bug Python guards: a client sending `user_id` must receive a
  422 NAMING the field, not silent acceptance.
- Identity comes from the `x-user-id` header, NEVER the body.
- Flow order: resolve the caller's internal `usr_` id via gRPC to Users → 409 guard →
  persist tracking + FIRST history row in ONE unit of work, both stamped from ONE `now`.
  Resolution happens FIRST so an unknown user costs no write at all.
- The 409 guard rejects an order that already has a tracking OR any history, so a retry
  cannot duplicate a shipment; the unique index catches a racing INSERT and must map to
  the SAME 409, never a 500.
- Status codes: **201**; **401** (missing/empty `x-user-id`, Shape A
  `{"detail":"missing x-user-id"}`); **404** (gRPC `NotFound` → Shape B, reason
  `unknown_user`); **409** (Shape B, reason `tracking_already_exists`); **422**
  (validation, Shape D); **500** for any gRPC status OTHER than `NotFound` — an outage
  must never read as "unknown user".
- The 201 body is **WRAPPED**: `{"tracking": {…TrackingResponse…}}`. The reads are not
  wrapped this way.
- **CREATION NEVER EMITS AN SQS EVENT.** Only status updates do. A TestMode run leaves 5
  history rows and sends 4 events.
- Sets the tag `E2E Source` on the row when the e2e middleware resolved true (the AND of
  the `x-e2e-source` header and `E2E_TESTING_ENABLED`).
- Exposes a hook for TestMode progression but DOES NOT implement the progression (Wave 2.5).
- **Transaction ordering:** commit BEFORE invoking the hook or scheduling any post-write
  work. Starting the progression inline races the commit and the progression always loses.

**Steps:**

- [ ] **Step 1: Write the failing test**

`internal/app/create_tracking_test.go`:

```go
package app_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

type stubResolver struct {
	userID string
	err    error
	calls  int
}

func (s *stubResolver) ResolveInternalUserID(ctx context.Context, sub string) (string, error) {
	s.calls++
	return s.userID, s.err
}

type stubWriter struct {
	exists     bool
	existsErr  error
	created    domain.NewTracking
	createNow  time.Time
	createErr  error
	createCall int
}

func (s *stubWriter) ExistsByOrderID(ctx context.Context, orderID string) (bool, error) {
	return s.exists, s.existsErr
}

func (s *stubWriter) Create(ctx context.Context, in domain.NewTracking, now time.Time) (domain.TrackingWithHistory, error) {
	s.createCall++
	s.created = in
	s.createNow = now
	if s.createErr != nil {
		return domain.TrackingWithHistory{}, s.createErr
	}
	return domain.TrackingWithHistory{
		Tracking: domain.Tracking{
			ID: "trk_1", OrderID: in.OrderID, UserID: in.UserID,
			CognitoSub: in.CognitoSub, Status: domain.StatusPlaced, Datetime: now,
		},
		History: []domain.TrackingHistory{{
			TrackingID: "trk_1", OrderID: in.OrderID, UserID: in.UserID,
			Status: domain.StatusPlaced, Datetime: now,
		}},
	}, nil
}

func fixedClock(t time.Time) func() time.Time { return func() time.Time { return t } }

func TestCreateTracking(t *testing.T) {
	now := time.Date(2026, 8, 27, 14, 53, 1, 0, time.UTC)

	t.Run("resolves the caller and persists at PLACED with one history row", func(t *testing.T) {
		// Two DIFFERENT identity values: a test using one value cannot fail on the
		// cognito_sub/user_id confusion this repo has already shipped once.
		res := &stubResolver{userID: "usr_internal"}
		w := &stubWriter{}
		uc := app.NewCreateTracking(res, w, fixedClock(now))

		got, err := uc.Execute(context.Background(), app.CreateTrackingInput{
			OrderID:    "ord_1",
			CognitoSub: "sub-abc-123",
			E2ESource:  true,
		})
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if w.created.UserID != "usr_internal" {
			t.Errorf("user_id = %q, want the RESOLVED usr_ id", w.created.UserID)
		}
		if w.created.CognitoSub != "sub-abc-123" {
			t.Errorf("cognito_sub = %q, want the header value verbatim", w.created.CognitoSub)
		}
		if got.Tracking.Status != domain.StatusPlaced {
			t.Errorf("status = %q, want PLACED", got.Tracking.Status)
		}
		if len(got.History) != 1 {
			t.Errorf("history rows = %d, want 1", len(got.History))
		}
		if !w.createNow.Equal(now) {
			t.Errorf("create stamped %v, want the single minted now %v", w.createNow, now)
		}
		if len(w.created.Tags) != 1 || w.created.Tags[0] != domain.E2ESourceTag {
			t.Errorf("tags = %v, want [%q]", w.created.Tags, domain.E2ESourceTag)
		}
	})

	t.Run("untagged when e2e source is false", func(t *testing.T) {
		w := &stubWriter{}
		uc := app.NewCreateTracking(&stubResolver{userID: "usr_1"}, w, fixedClock(now))
		if _, err := uc.Execute(context.Background(), app.CreateTrackingInput{
			OrderID: "ord_2", CognitoSub: "sub-1", E2ESource: false,
		}); err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if len(w.created.Tags) != 0 {
			t.Errorf("tags = %v, want empty", w.created.Tags)
		}
	})

	t.Run("unknown user maps to ErrUnknownUser and writes NOTHING", func(t *testing.T) {
		w := &stubWriter{}
		uc := app.NewCreateTracking(
			&stubResolver{err: domain.ErrUserNotFound}, w, fixedClock(now))

		_, err := uc.Execute(context.Background(), app.CreateTrackingInput{
			OrderID: "ord_3", CognitoSub: "sub-x",
		})
		if !errors.Is(err, app.ErrUnknownUser) {
			t.Fatalf("err = %v, want ErrUnknownUser", err)
		}
		if w.createCall != 0 {
			t.Error("resolution failed but a write was attempted")
		}
	})

	t.Run("a non-NotFound resolver error propagates, never as unknown user", func(t *testing.T) {
		boom := errors.New("users: connection refused")
		uc := app.NewCreateTracking(&stubResolver{err: boom}, &stubWriter{}, fixedClock(now))

		_, err := uc.Execute(context.Background(), app.CreateTrackingInput{
			OrderID: "ord_4", CognitoSub: "sub-y",
		})
		if errors.Is(err, app.ErrUnknownUser) {
			t.Fatal("a Users outage was reported as an unknown user")
		}
		if !errors.Is(err, boom) {
			t.Fatalf("err = %v, want the underlying transport error", err)
		}
	})

	t.Run("pre-existing tracking is rejected before any write", func(t *testing.T) {
		w := &stubWriter{exists: true}
		uc := app.NewCreateTracking(&stubResolver{userID: "usr_1"}, w, fixedClock(now))

		_, err := uc.Execute(context.Background(), app.CreateTrackingInput{
			OrderID: "ord_5", CognitoSub: "sub-1",
		})
		if !errors.Is(err, domain.ErrTrackingAlreadyExists) {
			t.Fatalf("err = %v, want ErrTrackingAlreadyExists", err)
		}
		if w.createCall != 0 {
			t.Error("pre-check found a tracking but the write still ran")
		}
	})

	t.Run("a racing INSERT losing the unique index is the SAME error, not a 500", func(t *testing.T) {
		w := &stubWriter{exists: false, createErr: domain.ErrTrackingAlreadyExists}
		uc := app.NewCreateTracking(&stubResolver{userID: "usr_1"}, w, fixedClock(now))

		_, err := uc.Execute(context.Background(), app.CreateTrackingInput{
			OrderID: "ord_6", CognitoSub: "sub-1",
		})
		if !errors.Is(err, domain.ErrTrackingAlreadyExists) {
			t.Fatalf("err = %v, want ErrTrackingAlreadyExists from the unique index", err)
		}
	})
}
```

`internal/adapter/http/handler_init_tracking_test.go`:

```go
package http_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInitTrackingHandler(t *testing.T) {
	t.Run("201 wraps the tracking under a tracking key", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/trackings/init-tracking",
			strings.NewReader(`{"order_id":"ord_1"}`))
		req.Header.Set("x-user-id", "sub-abc")
		newTestRouter(t, testDeps{}).ServeHTTP(rec, req)

		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201: %s", rec.Code, rec.Body)
		}
		var body map[string]json.RawMessage
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if _, ok := body["tracking"]; !ok {
			t.Fatalf("201 body is not wrapped under \"tracking\": %s", rec.Body)
		}
		var inner map[string]any
		_ = json.Unmarshal(body["tracking"], &inner)
		for _, forbidden := range []string{"shipping_address", "cognito_sub"} {
			if _, present := inner[forbidden]; present {
				t.Errorf("%q must never appear on a response", forbidden)
			}
		}
		if _, ok := inner["history"]; !ok {
			t.Error("the 201 body must carry the first history row")
		}
	})

	t.Run("an unknown body field is 422 NAMING the field", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/trackings/init-tracking",
			strings.NewReader(`{"order_id":"ord_1","user_id":"usr_someone_else"}`))
		req.Header.Set("x-user-id", "sub-abc")
		newTestRouter(t, testDeps{}).ServeHTTP(rec, req)

		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422 — encoding/json silently ignores unknown "+
				"fields unless DisallowUnknownFields is set", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "user_id") {
			t.Errorf("422 body must name the offending field: %s", rec.Body)
		}
	})

	t.Run("shipping_address accepts an arbitrary object", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/trackings/init-tracking",
			strings.NewReader(`{"order_id":"ord_1","shipping_address":{"street":"a","future_field":{"deep":1}}}`))
		req.Header.Set("x-user-id", "sub-abc")
		newTestRouter(t, testDeps{}).ServeHTTP(rec, req)

		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, want 201 — the address is free-form by design: %s",
				rec.Code, rec.Body)
		}
	})

	t.Run("order_id longer than 28 is 422", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/trackings/init-tracking",
			strings.NewReader(`{"order_id":"`+strings.Repeat("a", 29)+`"}`))
		req.Header.Set("x-user-id", "sub-abc")
		newTestRouter(t, testDeps{}).ServeHTTP(rec, req)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422", rec.Code)
		}
	})

	t.Run("missing and empty x-user-id are both 401 shape A", func(t *testing.T) {
		for name, header := range map[string]*string{
			"absent": nil,
			"empty":  ptr(""),
		} {
			t.Run(name, func(t *testing.T) {
				rec := httptest.NewRecorder()
				req := httptest.NewRequest(http.MethodPost, "/v1/trackings/init-tracking",
					strings.NewReader(`{"order_id":"ord_1"}`))
				if header != nil {
					req.Header.Set("x-user-id", *header)
				}
				newTestRouter(t, testDeps{}).ServeHTTP(rec, req)

				if rec.Code != http.StatusUnauthorized {
					t.Fatalf("status = %d, want 401", rec.Code)
				}
				var body map[string]any
				_ = json.Unmarshal(rec.Body.Bytes(), &body)
				if body["detail"] != "missing x-user-id" {
					t.Errorf("body = %s, want flat {\"detail\":\"missing x-user-id\"}", rec.Body)
				}
			})
		}
	})

	t.Run("404 and 409 use the NESTED body shape", func(t *testing.T) {
		cases := []struct {
			name     string
			deps     testDeps
			wantCode int
			wantRsn  string
		}{
			{"unknown user", testDeps{resolverErr: errUserNotFound}, 404, "unknown_user"},
			{"already exists", testDeps{alreadyExists: true}, 409, "tracking_already_exists"},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				rec := httptest.NewRecorder()
				req := httptest.NewRequest(http.MethodPost, "/v1/trackings/init-tracking",
					strings.NewReader(`{"order_id":"ord_1"}`))
				req.Header.Set("x-user-id", "sub-abc")
				newTestRouter(t, tc.deps).ServeHTTP(rec, req)

				if rec.Code != tc.wantCode {
					t.Fatalf("status = %d, want %d", rec.Code, tc.wantCode)
				}
				var body struct {
					Detail struct {
						Detail string `json:"detail"`
						Reason string `json:"reason"`
					} `json:"detail"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatalf("body is not the NESTED shape (the openapi.yaml is wrong "+
						"here, the Python CODE is right): %s", rec.Body)
				}
				if body.Detail.Reason != tc.wantRsn {
					t.Errorf("reason = %q, want %q (body %s)", body.Detail.Reason, tc.wantRsn, rec.Body)
				}
			})
		}
	})

	t.Run("a non-NotFound gRPC failure is 500, never 404", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/trackings/init-tracking",
			strings.NewReader(`{"order_id":"ord_1"}`))
		req.Header.Set("x-user-id", "sub-abc")
		newTestRouter(t, testDeps{resolverErr: errUsersUnavailable}).ServeHTTP(rec, req)

		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500 — an outage must not read as unknown user", rec.Code)
		}
	})

	t.Run("creation emits NO sqs event", func(t *testing.T) {
		deps := testDeps{}
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/trackings/init-tracking",
			strings.NewReader(`{"order_id":"ord_1"}`))
		req.Header.Set("x-user-id", "sub-abc")
		router := newTestRouter(t, deps)
		router.ServeHTTP(rec, req)

		if n := deps.publisher.Count(); n != 0 {
			t.Fatalf("creation published %d events, want 0 — only status updates emit", n)
		}
	})

	t.Run("the progression hook fires only for x-test-mode and only after commit", func(t *testing.T) {
		deps := testDeps{}
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/trackings/init-tracking",
			strings.NewReader(`{"order_id":"ord_1"}`))
		req.Header.Set("x-user-id", "sub-abc")
		req.Header.Set("x-test-mode", "true")
		newTestRouter(t, deps).ServeHTTP(rec, req)

		if !deps.hook.Started("ord_1") {
			t.Fatal("x-test-mode did not invoke the progression hook")
		}
		if deps.hook.StartedBeforeCommit() {
			t.Fatal("the hook ran before the transaction committed — the progression " +
				"would open a fresh session, see no tracking, and end at PLACED")
		}
	})

	t.Run("without x-test-mode the hook never fires", func(t *testing.T) {
		deps := testDeps{}
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/trackings/init-tracking",
			strings.NewReader(`{"order_id":"ord_1"}`))
		req.Header.Set("x-user-id", "sub-abc")
		newTestRouter(t, deps).ServeHTTP(rec, req)
		if deps.hook.Started("ord_1") {
			t.Fatal("the hook fired without x-test-mode")
		}
	})
}
```

`internal/adapter/mysql/create_tracking_test.go` (REAL MySQL, no mocks):

```go
package mysql_test

import (
	"context"
	"testing"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

func TestCreateWritesBothRowsFromOneNow(t *testing.T) {
	db := requireMySQL(t) // skips with a clear message when TRACKING_DATABASE_URL is unset
	repo := newRepo(db)
	ctx := context.Background()
	truncate(t, db)

	now := time.Now().UTC().Truncate(time.Second)
	got, err := repo.Create(ctx, domain.NewTracking{
		OrderID:    "ord_create_1",
		UserID:     "usr_internal",
		CognitoSub: "sub-abc-123",
		Status:     domain.StatusPlaced,
		Tags:       []string{domain.E2ESourceTag},
	}, now)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(got.History) != 1 {
		t.Fatalf("history rows = %d, want exactly 1", len(got.History))
	}
	if !got.Tracking.Datetime.Equal(now) || !got.History[0].Datetime.Equal(now) {
		t.Errorf("tracking=%v history=%v — both rows must carry the SAME minted now %v",
			got.Tracking.Datetime, got.History[0].Datetime, now)
	}
	if got.Tracking.CreatedBy != "tracking_api:create_tracking" {
		t.Errorf("created_by = %q, want tracking_api:create_tracking", got.Tracking.CreatedBy)
	}

	// The unique index adjudicates a duplicate; the repository must translate it.
	if _, err := repo.Create(ctx, domain.NewTracking{
		OrderID: "ord_create_1", UserID: "usr_internal", Status: domain.StatusPlaced,
	}, now); !errors.Is(err, domain.ErrTrackingAlreadyExists) {
		t.Fatalf("duplicate insert err = %v, want ErrTrackingAlreadyExists", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/tracking-go && goenv local 1.25.14
go test ./internal/app/... ./internal/adapter/http/... ./internal/adapter/mysql/... -run 'CreateTracking|InitTracking|Create' -v
```

Expect compile failures (`undefined: app.NewCreateTracking`, `undefined:
http.NewInitTrackingHandler`). That is the correct first failure.

- [ ] **Step 3: Write minimal implementation**

`internal/app/create_tracking.go`:

```go
package app

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// ErrUnknownUser: the caller authenticated successfully (the gateway verified the
// JWT) but Users holds no record for that sub. The HTTP layer renders it 404, not
// 401 — the same valid token will produce the same missing record forever, so
// telling the client to re-authenticate would make it loop.
var ErrUnknownUser = errors.New("users has no record for this cognito sub")

type UserResolver interface {
	ResolveInternalUserID(ctx context.Context, cognitoSub string) (string, error)
}

type TrackingCreator interface {
	ExistsByOrderID(ctx context.Context, orderID string) (bool, error)
	Create(ctx context.Context, in domain.NewTracking, now time.Time) (domain.TrackingWithHistory, error)
}

type CreateTrackingInput struct {
	OrderID         string
	CognitoSub      string
	ShippingAddress map[string]any
	E2ESource       bool
}

type CreateTracking struct {
	users  UserResolver
	writer TrackingCreator
	clock  func() time.Time
}

func NewCreateTracking(users UserResolver, writer TrackingCreator, clock func() time.Time) *CreateTracking {
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC().Truncate(time.Second) }
	}
	return &CreateTracking{users: users, writer: writer, clock: clock}
}

func (uc *CreateTracking) Execute(ctx context.Context, in CreateTrackingInput) (domain.TrackingWithHistory, error) {
	// Resolution FIRST: an unknown user must cost no write at all. Attempting the
	// INSERT first would consume the pre-check and the unique index for a request
	// that was always going to fail.
	userID, err := uc.users.ResolveInternalUserID(ctx, in.CognitoSub)
	if err != nil {
		if errors.Is(err, domain.ErrUserNotFound) {
			return domain.TrackingWithHistory{}, fmt.Errorf("%w: %s", ErrUnknownUser, in.CognitoSub)
		}
		// Every other status propagates unchanged. A Users outage rendered as
		// "unknown user" would write nothing and blame the caller.
		return domain.TrackingWithHistory{}, err
	}

	// Guard 1 — the explicit pre-check. This is what produces the ordinary,
	// entirely-expected 409 from a plain SELECT, with no failed INSERT and no
	// driver-specific error string to parse.
	exists, err := uc.writer.ExistsByOrderID(ctx, in.OrderID)
	if err != nil {
		return domain.TrackingWithHistory{}, err
	}
	if exists {
		return domain.TrackingWithHistory{}, fmt.Errorf("%w: %s", domain.ErrTrackingAlreadyExists, in.OrderID)
	}

	var tags []string
	if in.E2ESource {
		tags = []string{domain.E2ESourceTag}
	}

	// ONE now for both rows. Two time.Now() calls can straddle a second boundary,
	// and MySQL DATETIME(0) ROUNDS rather than truncates.
	now := uc.clock()

	// Guard 2 — the unique index, translated by the adapter into the SAME error.
	// The pre-check cannot be airtight: two concurrent requests can both SELECT
	// nothing before either INSERTs, and only the database can adjudicate that.
	return uc.writer.Create(ctx, domain.NewTracking{
		OrderID:         in.OrderID,
		UserID:          userID,
		CognitoSub:      in.CognitoSub,
		ShippingAddress: in.ShippingAddress,
		Tags:            tags,
		Status:          domain.StatusPlaced,
		Actor:           audit.CreateTracking,
	}, now)
}
```

`internal/adapter/http/response.go`:

```go
package http

import (
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// isoLayout renders the way Python's datetime.isoformat() does: no zone suffix of
// its own (the "Z" is appended), and a fractional part that disappears entirely
// when it is zero. RFC3339 is NOT equivalent — it emits "+00:00" or a fixed
// fractional width, and a client parsing the Python service's output would see a
// different string.
const isoLayout = "2006-01-02T15:04:05.999999"

// ISO renders a timestamp as the wire string. A nil (or zero) moment renders as
// "", never null: the field is typed as a string on the contract, and a
// string-typed field that can also be null would force every consumer to handle a
// case that never occurs in practice.
func ISO(t *time.Time) string {
	if t == nil || t.IsZero() {
		return ""
	}
	return t.UTC().Format(isoLayout) + "Z"
}

// HistoryEntryResponse is one immutable transition.
//
// It carries no shipping_address and no cognito_sub, and it is a DISTINCT type
// from domain.TrackingHistory for exactly that reason: reusing the domain type
// would make leaking those fields a one-line json tag away.
type HistoryEntryResponse struct {
	TrackingID string `json:"tracking_id"`
	UserID     string `json:"user_id"`
	OrderID    string `json:"order_id"`
	Status     string `json:"status"`
	Datetime   string `json:"datetime"`
}

// TrackingResponse is a tracking together with its ordered history. History is
// part of the payload rather than a separate endpoint because every caller of
// these reads wants both.
type TrackingResponse struct {
	ID       string                 `json:"id"`
	UserID   string                 `json:"user_id"`
	OrderID  string                 `json:"order_id"`
	Status   string                 `json:"status"`
	Datetime string                 `json:"datetime"`
	History  []HistoryEntryResponse `json:"history"`
}

func NewTrackingResponse(t domain.TrackingWithHistory) TrackingResponse {
	// Non-nil slice: an empty history must marshal as [] and never as null.
	history := make([]HistoryEntryResponse, 0, len(t.History))
	for _, e := range t.History {
		entry := e
		history = append(history, HistoryEntryResponse{
			TrackingID: entry.TrackingID,
			UserID:     entry.UserID,
			OrderID:    entry.OrderID,
			Status:     string(entry.Status),
			Datetime:   ISO(&entry.Datetime),
		})
	}
	return TrackingResponse{
		ID:       t.Tracking.ID,
		UserID:   t.Tracking.UserID,
		OrderID:  t.Tracking.OrderID,
		Status:   string(t.Tracking.Status),
		Datetime: ISO(&t.Tracking.Datetime),
		History:  history,
	}
}

// InitTrackingResponse is the 201 body — WRAPPED. The reads are not.
type InitTrackingResponse struct {
	Tracking TrackingResponse `json:"tracking"`
}

// TrackingListResponse is the batch read's body: an object, never a bare array.
type TrackingListResponse struct {
	Trackings []TrackingResponse `json:"trackings"`
}

// DeletedResponse is the body of both delete routes.
type DeletedResponse struct {
	Deleted int64 `json:"deleted"`
}
```

`internal/adapter/http/errors.go`:

```go
package http

// Three error body shapes coexist on this service's surface, and they are NOT
// unified. Each is observable by a shipped client, and collapsing them would be a
// silent breaking change for whichever caller reads the field that moved.

// FlatError — Shape A: {"detail": "..."}.
// Every 401, the single read's 404, the carrier PUT's 404, the batch read's 400.
type FlatError struct {
	Detail string `json:"detail"`
}

// NestedErrorBody is the inner object of Shape B.
type NestedErrorBody struct {
	Detail string `json:"detail"`
	Reason string `json:"reason"`
}

// NestedError — Shape B: {"detail": {"detail": "...", "reason": "..."}}.
//
// ONLY the 404 and 409 on POST /init-tracking. The Python raises
// HTTPException(detail={...}) and FastAPI wraps a structured detail this way. The
// GENERATED openapi.yaml declares these as flat, which is wrong — FastAPI cannot
// express the wrapping in its schema. The Python CODE is the contract; Task 23
// records the spec difference in its allowlist.
type NestedError struct {
	Detail NestedErrorBody `json:"detail"`
}

// ReasonError — Shape C: {"detail": "...", "reason": "..."}.
// ONLY the 400 on the carrier PUT, which Python routes through its own exception
// handler precisely so `reason` is a top-level field rather than Shape B.
type ReasonError struct {
	Detail string `json:"detail"`
	Reason string `json:"reason"`
}

// ValidationDetail / ValidationError — Shape D, FastAPI's 422.
type ValidationDetail struct {
	Loc []string `json:"loc"`
	Msg string   `json:"msg"`
	Typ string   `json:"type"`
}

type ValidationError struct {
	Detail []ValidationDetail `json:"detail"`
}

func NewValidationError(loc []string, msg, typ string) ValidationError {
	return ValidationError{Detail: []ValidationDetail{{Loc: loc, Msg: msg, Typ: typ}}}
}
```

`internal/adapter/http/handler_init_tracking.go`:

```go
package http

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

const (
	// reasonUnknownUser names the 404's cause. The same token Orders returns for
	// the identical condition on POST /v1/orders — two services facing the same
	// condition must not teach clients two different vocabularies.
	reasonUnknownUser = "unknown_user"
	// reasonAlreadyExists names the RULE, not the mechanism. A caller should not
	// have to know a unique index is involved.
	reasonAlreadyExists = "tracking_already_exists"

	maxOrderIDLength = 28
)

// ProgressionHook is the TestMode seam. Wave 2 wires a no-op; Wave 2.5 supplies
// the real implementation. It is an interface rather than a func so the no-op is
// a named type an operator can recognise in the wiring.
type ProgressionHook interface {
	Start(orderID string)
}

type NoopProgression struct{}

func (NoopProgression) Start(string) {}

type initTrackingRequest struct {
	OrderID         string         `json:"order_id"`
	ShippingAddress map[string]any `json:"shipping_address"`
}

type InitTrackingHandler struct {
	uc     *app.CreateTracking
	hook   ProgressionHook
	log    *slog.Logger
	tracer trace.Tracer
}

func NewInitTrackingHandler(uc *app.CreateTracking, hook ProgressionHook, log *slog.Logger, tracer trace.Tracer) *InitTrackingHandler {
	return &InitTrackingHandler{uc: uc, hook: hook, log: log, tracer: tracer}
}

func (h *InitTrackingHandler) Handle(c *gin.Context) {
	// The caller identity comes from the header, never the body. A user_id in the
	// body would be an unauthenticated string a client chooses.
	cognitoSub := strings.TrimSpace(c.GetHeader("x-user-id"))
	if cognitoSub == "" {
		c.JSON(http.StatusUnauthorized, FlatError{Detail: "missing x-user-id"})
		return
	}

	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity,
			NewValidationError([]string{"body"}, "could not read request body", "value_error"))
		return
	}

	// DisallowUnknownFields mirrors Pydantic's extra="forbid", and ONLY this
	// endpoint has it. encoding/json otherwise ignores unknown fields silently,
	// which would let a client send `user_id`, have it dropped, and then wonder
	// why the tracking belongs to somebody else.
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()

	var payload initTrackingRequest
	if err := dec.Decode(&payload); err != nil {
		if field, ok := unknownField(err); ok {
			c.JSON(http.StatusUnprocessableEntity, NewValidationError(
				[]string{"body", field},
				"Extra inputs are not permitted",
				"extra_forbidden",
			))
			return
		}
		c.JSON(http.StatusUnprocessableEntity,
			NewValidationError([]string{"body"}, err.Error(), "value_error"))
		return
	}

	if payload.OrderID == "" || len(payload.OrderID) > maxOrderIDLength {
		c.JSON(http.StatusUnprocessableEntity, NewValidationError(
			[]string{"body", "order_id"},
			"String should have at least 1 character and at most 28 characters",
			"string_too_long",
		))
		return
	}

	ctx, span := h.tracer.Start(c.Request.Context(), "init_tracking")
	defer span.End()
	span.SetAttributes(
		attribute.String("app_event", "init_tracking_started"),
		attribute.String("order_id", payload.OrderID),
	)

	created, err := h.uc.Execute(ctx, app.CreateTrackingInput{
		OrderID:    payload.OrderID,
		CognitoSub: cognitoSub,
		// Free-form by design; never logged (PII).
		ShippingAddress: payload.ShippingAddress,
		// Already the AND of the header and E2E_TESTING_ENABLED — the middleware
		// evaluates both, so this handler cannot tag a row on the header alone.
		E2ESource: E2ESourceFromContext(c),
	})
	switch {
	case errors.Is(err, app.ErrUnknownUser):
		span.SetAttributes(attribute.String("reason", reasonUnknownUser))
		h.logFailure(payload.OrderID, reasonUnknownUser, cognitoSub)
		c.JSON(http.StatusNotFound, NestedError{Detail: NestedErrorBody{
			Detail: err.Error(), Reason: reasonUnknownUser,
		}})
		return
	case errors.Is(err, domain.ErrTrackingAlreadyExists):
		span.SetAttributes(attribute.String("reason", reasonAlreadyExists))
		h.logFailure(payload.OrderID, reasonAlreadyExists, cognitoSub)
		c.JSON(http.StatusConflict, NestedError{Detail: NestedErrorBody{
			Detail: err.Error(), Reason: reasonAlreadyExists,
		}})
		return
	case err != nil:
		// Every remaining case, a Users outage included, is a 500. Deliberately
		// NOT folded into the 404 above.
		span.SetAttributes(attribute.String("reason", "internal_error"))
		h.log.ErrorContext(ctx, "init_tracking_failed",
			slog.String("app_event", "init_tracking_failed"),
			slog.String("reason", "internal_error"),
			slog.String("order_id", payload.OrderID))
		c.JSON(http.StatusInternalServerError, FlatError{Detail: "internal server error"})
		return
	}

	span.SetAttributes(
		attribute.String("app_event", "init_tracking_succeeded"),
		attribute.String("tracking_id", created.Tracking.ID),
		attribute.String("user_id", created.Tracking.UserID),
	)
	h.log.InfoContext(ctx, "init_tracking_succeeded",
		slog.String("app_event", "init_tracking_succeeded"),
		slog.String("order_id", payload.OrderID),
		slog.String("tracking_id", created.Tracking.ID),
		slog.String("user_id", created.Tracking.UserID),
		slog.String("cognito_sub", cognitoSub))

	// The response is written (and the transaction committed by the adapter)
	// BEFORE the hook is invoked. Starting the progression any earlier races the
	// commit: the progression opens its OWN session, which would see no tracking,
	// and the run would end immediately at PLACED. That is verified behaviour in
	// the Python service, not a theoretical concern.
	c.JSON(http.StatusCreated, InitTrackingResponse{Tracking: NewTrackingResponse(created)})

	if TestModeFromContext(c) {
		h.hook.Start(payload.OrderID)
	}
}

// unknownField extracts the field name out of encoding/json's
// `json: unknown field "x"` error, so the 422 can NAME it the way Pydantic does.
func unknownField(err error) (string, bool) {
	const prefix = `json: unknown field `
	msg := err.Error()
	i := strings.Index(msg, prefix)
	if i < 0 {
		return "", false
	}
	return strings.Trim(msg[i+len(prefix):], `"`), true
}

func (h *InitTrackingHandler) logFailure(orderID, reason, cognitoSub string) {
	// No user_id: on both failure paths it is unresolvable or irrelevant, and the
	// convention omits unknown fields rather than logging null. The shipping
	// address is never logged.
	h.log.Warn("init_tracking_failed",
		slog.String("app_event", "init_tracking_failed"),
		slog.String("reason", reason),
		slog.String("order_id", orderID),
		slog.String("cognito_sub", cognitoSub))
}
```

`internal/adapter/mysql/create_tracking.go` wraps the sqlc queries in one
transaction: `INSERT INTO tracking`, then `INSERT INTO tracking_history`, both with
the passed `now` in `datetime`, `created_at` and `updated_at`, and
`created_by`/`updated_by` = `tracking_api:create_tracking`. It mints the id
(`trk_` + nano id) and the tracking number itself — they are the row's identity, not
inputs. A MySQL error 1062 on `uq_tracking_order_id` is translated to
`domain.ErrTrackingAlreadyExists`; anything else is returned unchanged.

Finally, register in `cmd/server/main.go`:

```go
	// Registered BEFORE the reads router: /init-tracking is a literal segment
	// sitting where GET /{order_id} also matches, and Gin's tree resolves a
	// static segment ahead of a parameter — declaring the literal first keeps
	// that property explicit rather than incidental.
	initTracking := adapterhttp.NewInitTrackingHandler(
		app.NewCreateTracking(usersClient, trackingRepo, nil),
		adapterhttp.NoopProgression{}, // Wave 2.5 replaces this
		logger, tracer,
	)
	v1.POST("/v1/trackings/init-tracking", initTracking.Handle)
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/tracking-go && goenv local 1.25.14
gofmt -s -w . && go vet ./... && golangci-lint run
go test ./internal/app/... ./internal/adapter/http/... -run 'CreateTracking|InitTracking' -v
TRACKING_DATABASE_URL="$TRACKING_DATABASE_URL" go test ./internal/adapter/mysql/... -run Create -v
```

All subtests green, `golangci-lint` clean. Confirm by reading the output — do not
claim a pass you have not seen.

- [ ] **Step 5: Commit**

Leave the work in the working tree. Report to the main session:
`feat(tracking): port POST /v1/trackings/init-tracking to Go`.

---

### Task 20: the two user-scoped reads

**Files:**
- Create: `services/tracking-go/internal/app/get_my_tracking.go`
- Create: `services/tracking-go/internal/app/get_my_tracking_test.go`
- Create: `services/tracking-go/internal/app/list_my_trackings.go`
- Create: `services/tracking-go/internal/app/list_my_trackings_test.go`
- Create: `services/tracking-go/internal/adapter/http/handler_reads.go`
- Create: `services/tracking-go/internal/adapter/http/handler_reads_test.go`
- Create: `services/tracking-go/internal/adapter/http/order_ids.go`
- Create: `services/tracking-go/internal/adapter/http/order_ids_test.go`
- Create: `services/tracking-go/internal/adapter/mysql/read_scoped.go`
- Create: `services/tracking-go/internal/adapter/mysql/read_scoped_test.go`
- Modify: `services/tracking-go/cmd/server/main.go`

**Interfaces:**

Consumes (each use case declares its OWN narrow port — never one shared repository
interface):

```go
// in get_my_tracking.go
type ScopedTrackingReader interface {
	// GetByOrderIDScoped returns the tracking for orderID owned by cognitoSub.
	// It returns domain.ErrTrackingNotFound for "no such tracking" AND for
	// "belongs to someone else" — indistinguishably, by design.
	GetByOrderIDScoped(ctx context.Context, orderID, cognitoSub string) (domain.TrackingWithHistory, error)
}

// in list_my_trackings.go
type ScopedTrackingLister interface {
	ListByOrderIDsScoped(ctx context.Context, orderIDs []string, cognitoSub string) ([]domain.TrackingWithHistory, error)
}

// Both files also declare the cache port they consume.
type ReadCache interface {
	Get(ctx context.Context, key string) (raw []byte, hit bool, bypassed bool, ttl int, err error)
	Set(ctx context.Context, key string, raw []byte, ttl time.Duration, indexKey string) error
}
```

Produces:

```go
package app

type GetMyTracking struct { ... }
func NewGetMyTracking(reader ScopedTrackingReader) *GetMyTracking
func (uc *GetMyTracking) Execute(ctx context.Context, orderID, cognitoSub string) (domain.TrackingWithHistory, error)

type ListMyTrackings struct { ... }
func NewListMyTrackings(lister ScopedTrackingLister) *ListMyTrackings
func (uc *ListMyTrackings) Execute(ctx context.Context, orderIDs []string, cognitoSub string) ([]domain.TrackingWithHistory, error)
```

```go
package http

// ParseOrderIDs splits the CSV query parameter: trims each part, DROPS empties,
// de-duplicates preserving first-seen order.
func ParseOrderIDs(raw string) []string

type ReadsHandler struct { ... }
func NewReadsHandler(get *app.GetMyTracking, list *app.ListMyTrackings, cache ReadCache, cacheEnabled bool, log *slog.Logger, tracer trace.Tracer) *ReadsHandler
func (h *ReadsHandler) GetOne(c *gin.Context)
func (h *ReadsHandler) List(c *gin.Context)
```

Uses `TrackingResponse`, `TrackingListResponse` and `FlatError` from Task 19's
`response.go` / `errors.go`. **Do not redeclare them.**

**Contract this task must reproduce (from `api/trackings_router.py`, `queries/get_my_trackings.py`, `domain/repository.py`):**

- `GET /v1/trackings/{order_id}` → 200 with a **FLAT** `TrackingResponse`, not wrapped.
- `GET /v1/trackings?order_ids=<csv>` → 200 `{"trackings": [...]}` — never a bare array.
- **BOTH filter ownership by `cognito_sub`, NEVER by `user_id`.** The `x-user-id` header
  carries the JWT `sub`; `tracking.user_id` holds the internal `usr_` id resolved through
  Users. Filtering by `user_id` compares a sub against a `usr_` id, matches nothing, and
  404s every read INCLUDING the rightful owner's — while looking correctly implemented.
  This shipped once in the Python service and was invisible to 253 tests because they
  created and read with the same value.
- Use the **SEPARATE scoped port method**; do not add an optional parameter. In Go the
  zero value of `string` is `""`, not `nil`, so an optional-parameter port silently turns
  "unscoped" into "scoped to the empty string".
- The single read's **404 covers BOTH "no such tracking" AND "belongs to another user"**,
  indistinguishably — Shape A `{"detail":"tracking not found"}`. **NEVER 403**: a 403
  would confirm that a tracking exists for that order id and turn the endpoint into an
  oracle for other people's order ids.
- The batch read has **NO 404 by design**: unknown or non-owned ids are silently omitted,
  so the answer is a 200 with a shorter list.
- `order_ids` is a SINGLE required query string, comma-separated, parsed manually: split
  on `,`, trim each part, DROP empty parts, DE-DUPLICATE preserving first-seen order.
  `?order_ids=a,,b` → `[a,b]`; `?order_ids=a,b,a` → `[a,b]`.
- Cap: more than **100 DISTINCT NON-EMPTY** ids → 400 Shape A
  `{"detail":"at most 100 order_ids per request"}`. The token `too_many_order_ids` goes
  ONLY to the log and the span, never into the body.
- The query parameter being **ABSENT ENTIRELY is a 422** (FastAPI's required-param
  behaviour). Gin's `c.Query` returns `""` with no error, so check presence explicitly
  with `c.Request.URL.Query().Has("order_ids")` and emit 422, not 400.
- An empty id list must **short-circuit to an empty result WITHOUT querying** — sqlc's
  `IN (sqlc.slice())` generates invalid SQL for an empty slice.
- Both reads participate in the cache: read before querying, write after with TTL **60s**,
  and set the `X-Cache` header (`HIT` / `MISS` / `BYPASS`; add `X-Cache-TTL` on a hit).
  With the cache disabled, stamp NOTHING — the control arm of the load test must look
  like a service with no cache at all.
- Both return the tracking **TOGETHER WITH its history**, ordered by timestamp then
  progression position (a bare timestamp sort ties on same-second transitions and MySQL
  then falls back to PK order, which is alphabetical and puts DELIVERED first).

**Steps:**

- [ ] **Step 1: Write the failing test**

`internal/adapter/http/order_ids_test.go`:

```go
package http_test

import (
	"reflect"
	"testing"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
)

func TestParseOrderIDs(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want []string
	}{
		{"plain", "a,b,c", []string{"a", "b", "c"}},
		{"drops empty parts", "a,,b", []string{"a", "b"}},
		{"drops trailing comma", "a,b,", []string{"a", "b"}},
		{"trims whitespace", " a , b ", []string{"a", "b"}},
		{"dedupes preserving first-seen order", "a,b,a", []string{"a", "b"}},
		{"dedupes across whitespace", "a, a ,b", []string{"a", "b"}},
		{"all empty yields nothing", ",,,", []string{}},
		{"single", "a", []string{"a"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := adapterhttp.ParseOrderIDs(tc.raw)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("ParseOrderIDs(%q) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}
```

`internal/adapter/http/handler_reads_test.go`:

```go
package http_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSingleRead(t *testing.T) {
	t.Run("200 is a FLAT TrackingResponse, not wrapped", func(t *testing.T) {
		rec := doRead(t, testDeps{owned: map[string]string{"ord_1": "sub-owner"}},
			"/v1/trackings/ord_1", "sub-owner")

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body)
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if _, wrapped := body["tracking"]; wrapped {
			t.Fatal("the single read must NOT be wrapped under \"tracking\"")
		}
		for _, key := range []string{"id", "user_id", "order_id", "status", "datetime", "history"} {
			if _, ok := body[key]; !ok {
				t.Errorf("missing %q in %s", key, rec.Body)
			}
		}
		for _, forbidden := range []string{"shipping_address", "cognito_sub"} {
			if _, present := body[forbidden]; present {
				t.Errorf("%q must never appear on a response", forbidden)
			}
		}
	})

	t.Run("someone else's tracking is 404, never 403", func(t *testing.T) {
		// The tracking EXISTS and is owned by a different sub. Two different
		// identity values, so this test can actually fail on the ownership bug.
		deps := testDeps{owned: map[string]string{"ord_1": "sub-owner"}}
		rec := doRead(t, deps, "/v1/trackings/ord_1", "sub-intruder")

		if rec.Code == http.StatusForbidden {
			t.Fatal("403 confirms the tracking exists — this endpoint must not be " +
				"an oracle for other people's order ids")
		}
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body["detail"] != "tracking not found" {
			t.Errorf("body = %s, want flat {\"detail\":\"tracking not found\"}", rec.Body)
		}
	})

	t.Run("a missing tracking is byte-identical to a non-owned one", func(t *testing.T) {
		deps := testDeps{owned: map[string]string{"ord_1": "sub-owner"}}
		nonOwned := doRead(t, deps, "/v1/trackings/ord_1", "sub-intruder")
		missing := doRead(t, deps, "/v1/trackings/ord_nonexistent", "sub-intruder")

		if nonOwned.Code != missing.Code || nonOwned.Body.String() != missing.Body.String() {
			t.Fatalf("responses differ: non-owned %d %s vs missing %d %s",
				nonOwned.Code, nonOwned.Body, missing.Code, missing.Body)
		}
	})

	t.Run("ownership is scoped by cognito_sub, not user_id", func(t *testing.T) {
		// The row's user_id and cognito_sub are DIFFERENT strings. A handler
		// filtering by user_id would 404 the rightful owner here.
		deps := testDeps{
			owned:      map[string]string{"ord_1": "sub-owner"},
			rowUserID:  "usr_internal_abc",
		}
		rec := doRead(t, deps, "/v1/trackings/ord_1", "sub-owner")
		if rec.Code != http.StatusOK {
			t.Fatalf("the rightful owner got %d — the read is scoped by the wrong "+
				"identity", rec.Code)
		}
		rec = doRead(t, deps, "/v1/trackings/ord_1", "usr_internal_abc")
		if rec.Code != http.StatusNotFound {
			t.Fatalf("the internal usr_ id resolved a tracking (%d) — the read must "+
				"scope by cognito_sub only", rec.Code)
		}
	})

	t.Run("missing x-user-id is 401 shape A", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/v1/trackings/ord_1", nil)
		newTestRouter(t, testDeps{}).ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})

	t.Run("cache: miss then hit, X-Cache stamped, TTL 60", func(t *testing.T) {
		deps := testDeps{owned: map[string]string{"ord_1": "sub-owner"}, cacheEnabled: true}
		router := newTestRouter(t, deps)

		first := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/v1/trackings/ord_1", nil)
		req.Header.Set("x-user-id", "sub-owner")
		router.ServeHTTP(first, req)
		if got := first.Header().Get("X-Cache"); got != "MISS" {
			t.Fatalf("first X-Cache = %q, want MISS", got)
		}

		second := httptest.NewRecorder()
		req2 := httptest.NewRequest(http.MethodGet, "/v1/trackings/ord_1", nil)
		req2.Header.Set("x-user-id", "sub-owner")
		router.ServeHTTP(second, req2)
		if got := second.Header().Get("X-Cache"); got != "HIT" {
			t.Fatalf("second X-Cache = %q, want HIT", got)
		}
		if ttl := deps.cache.LastTTL(); ttl.Seconds() != 60 {
			t.Errorf("cache TTL = %v, want 60s", ttl)
		}
		if first.Body.String() != second.Body.String() {
			t.Errorf("the cached body differs from the fresh one:\n%s\n%s", first.Body, second.Body)
		}
	})

	t.Run("a 404 is never cached", func(t *testing.T) {
		deps := testDeps{cacheEnabled: true}
		doRead(t, deps, "/v1/trackings/ord_missing", "sub-owner")
		if deps.cache.Writes() != 0 {
			t.Fatal("a 404 was written to the cache")
		}
	})

	t.Run("with the cache disabled no header is stamped at all", func(t *testing.T) {
		deps := testDeps{owned: map[string]string{"ord_1": "sub-owner"}, cacheEnabled: false}
		rec := doRead(t, deps, "/v1/trackings/ord_1", "sub-owner")
		if got := rec.Header().Get("X-Cache"); got != "" {
			t.Fatalf("X-Cache = %q with the cache off, want no header — the load "+
				"test's control arm must look like a service with no cache", got)
		}
	})
}

func TestBatchRead(t *testing.T) {
	t.Run("200 is an object with a trackings key, never a bare array", func(t *testing.T) {
		deps := testDeps{owned: map[string]string{"ord_1": "sub-owner", "ord_2": "sub-owner"}}
		rec := doRead(t, deps, "/v1/trackings?order_ids=ord_1,ord_2", "sub-owner")

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body)
		}
		if strings.HasPrefix(strings.TrimSpace(rec.Body.String()), "[") {
			t.Fatal("the batch read returned a bare array")
		}
		var body struct {
			Trackings []map[string]any `json:"trackings"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if len(body.Trackings) != 2 {
			t.Fatalf("got %d trackings, want 2", len(body.Trackings))
		}
	})

	t.Run("unknown and non-owned ids are silently omitted, still 200", func(t *testing.T) {
		deps := testDeps{owned: map[string]string{"ord_mine": "sub-owner", "ord_theirs": "sub-other"}}
		rec := doRead(t, deps, "/v1/trackings?order_ids=ord_mine,ord_theirs,ord_nope", "sub-owner")

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 — the batch read has no 404 by design", rec.Code)
		}
		var body struct {
			Trackings []struct {
				OrderID string `json:"order_id"`
			} `json:"trackings"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if len(body.Trackings) != 1 || body.Trackings[0].OrderID != "ord_mine" {
			t.Fatalf("got %+v, want exactly [ord_mine]", body.Trackings)
		}
	})

	t.Run("no match is 200 with an empty list, not null", func(t *testing.T) {
		rec := doRead(t, testDeps{}, "/v1/trackings?order_ids=ord_nope", "sub-owner")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), `"trackings":[]`) {
			t.Errorf("body = %s, want an empty ARRAY, not null", rec.Body)
		}
	})

	t.Run("101 distinct ids is 400 shape A without the reason token", func(t *testing.T) {
		ids := make([]string, 101)
		for i := range ids {
			ids[i] = fmt.Sprintf("ord_%d", i)
		}
		rec := doRead(t, testDeps{}, "/v1/trackings?order_ids="+strings.Join(ids, ","), "sub-owner")

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body["detail"] != "at most 100 order_ids per request" {
			t.Errorf("detail = %v, want the exact message", body["detail"])
		}
		if _, present := body["reason"]; present {
			t.Error("too_many_order_ids belongs on the log and span, never in the body")
		}
	})

	t.Run("100 DISTINCT ids is allowed; duplicates do not count toward the cap", func(t *testing.T) {
		ids := make([]string, 100)
		for i := range ids {
			ids[i] = fmt.Sprintf("ord_%d", i)
		}
		rec := doRead(t, testDeps{}, "/v1/trackings?order_ids="+strings.Join(ids, ","), "sub-owner")
		if rec.Code != http.StatusOK {
			t.Fatalf("100 ids = %d, want 200", rec.Code)
		}
		// 101 raw parts collapsing to 100 distinct must also pass.
		rec = doRead(t, testDeps{},
			"/v1/trackings?order_ids="+strings.Join(append(ids, "ord_0"), ","), "sub-owner")
		if rec.Code != http.StatusOK {
			t.Fatalf("101 raw / 100 distinct = %d, want 200 — the cap counts DISTINCT "+
				"NON-EMPTY ids", rec.Code)
		}
	})

	t.Run("the parameter being absent entirely is 422, not 400", func(t *testing.T) {
		rec := doRead(t, testDeps{}, "/v1/trackings", "sub-owner")
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422 — c.Query returns \"\" with no error, so "+
				"presence must be checked explicitly", rec.Code)
		}
	})

	t.Run("an empty value short-circuits without touching the database", func(t *testing.T) {
		deps := testDeps{}
		rec := doRead(t, deps, "/v1/trackings?order_ids=,,", "sub-owner")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if deps.lister.Calls() != 0 {
			t.Fatal("an empty id list reached the database — sqlc's IN (sqlc.slice()) " +
				"generates invalid SQL for an empty slice")
		}
	})
}
```

`internal/adapter/mysql/read_scoped_test.go` (REAL MySQL):

```go
func TestScopedReadsFilterByCognitoSub(t *testing.T) {
	db := requireMySQL(t)
	repo := newRepo(db)
	ctx := context.Background()
	truncate(t, db)

	now := time.Now().UTC().Truncate(time.Second)
	// user_id and cognito_sub are DIFFERENT values, deliberately.
	seed(t, repo, domain.NewTracking{
		OrderID: "ord_1", UserID: "usr_internal", CognitoSub: "sub-owner",
		Status: domain.StatusPlaced,
	}, now)

	t.Run("the owner's sub resolves it", func(t *testing.T) {
		got, err := repo.GetByOrderIDScoped(ctx, "ord_1", "sub-owner")
		if err != nil {
			t.Fatalf("GetByOrderIDScoped: %v", err)
		}
		if got.Tracking.OrderID != "ord_1" {
			t.Errorf("order_id = %q", got.Tracking.OrderID)
		}
		if len(got.History) == 0 {
			t.Error("the read must return the tracking together with its history")
		}
	})

	t.Run("the internal usr_ id resolves NOTHING", func(t *testing.T) {
		_, err := repo.GetByOrderIDScoped(ctx, "ord_1", "usr_internal")
		if !errors.Is(err, domain.ErrTrackingNotFound) {
			t.Fatalf("err = %v, want ErrTrackingNotFound — scoping by user_id would "+
				"404 every read including the owner's", err)
		}
	})

	t.Run("a soft-deleted tracking is invisible", func(t *testing.T) {
		softDelete(t, db, "ord_1")
		if _, err := repo.GetByOrderIDScoped(ctx, "ord_1", "sub-owner"); !errors.Is(err, domain.ErrTrackingNotFound) {
			t.Fatalf("err = %v, want ErrTrackingNotFound", err)
		}
	})

	t.Run("history is ordered by timestamp then progression position", func(t *testing.T) {
		truncate(t, db)
		// Two transitions sharing one second: a bare datetime sort ties, and MySQL
		// falls back to PK order — alphabetical — which puts DELIVERED first.
		seedHistoryAtSameSecond(t, db, "ord_2", []domain.Status{
			domain.StatusPlaced, domain.StatusProcessing,
		}, now)
		got, err := repo.GetByOrderIDScoped(ctx, "ord_2", "sub-owner")
		if err != nil {
			t.Fatal(err)
		}
		if got.History[0].Status != domain.StatusPlaced {
			t.Errorf("history[0] = %q, want PLACED", got.History[0].Status)
		}
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/tracking-go && goenv local 1.25.14
go test ./internal/app/... ./internal/adapter/http/... -run 'MyTracking|SingleRead|BatchRead|ParseOrderIDs' -v
TRACKING_DATABASE_URL="$TRACKING_DATABASE_URL" go test ./internal/adapter/mysql/... -run ScopedReads -v
```

Expect `undefined: adapterhttp.ParseOrderIDs`, `undefined: app.NewGetMyTracking`, and a
missing `GetByOrderIDScoped` method.

- [ ] **Step 3: Write minimal implementation**

`internal/adapter/http/order_ids.go`:

```go
package http

import "strings"

// MaxBatchOrderIDs caps the batch read. Counted in DISTINCT, NON-EMPTY ids —
// duplicates and blanks are a caller being sloppy, not a request to reject.
const MaxBatchOrderIDs = 100

// ParseOrderIDs splits the CSV query parameter.
//
// Trims each part, drops empties, de-duplicates preserving first-seen order.
// `?order_ids=a,,b` -> [a b]; `?order_ids=a,b,a` -> [a b]. The endpoint's whole
// contract is "return the ones you own among these", which is well defined for
// either, so neither case is an error worth failing on.
func ParseOrderIDs(raw string) []string {
	seen := make(map[string]struct{}, 8)
	out := make([]string, 0, 8) // non-nil: an empty result must marshal as []
	for _, part := range strings.Split(raw, ",") {
		cleaned := strings.TrimSpace(part)
		if cleaned == "" {
			continue
		}
		if _, dup := seen[cleaned]; dup {
			continue
		}
		seen[cleaned] = struct{}{}
		out = append(out, cleaned)
	}
	return out
}
```

`internal/app/get_my_tracking.go`:

```go
package app

import (
	"context"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// ScopedTrackingReader is THE only read port this use case knows about, and it
// has no unscoped variant. Scoped and unscoped reads are separate METHODS on the
// adapter (see internal/app/progression.go for the unscoped one) rather than one
// method with an optional argument: Go's zero value for string is "", so an
// optional-parameter port silently converts "unscoped" into "scoped to the empty
// string", which matches rows whose cognito_sub is empty — somebody else's data.
type ScopedTrackingReader interface {
	GetByOrderIDScoped(ctx context.Context, orderID, cognitoSub string) (domain.TrackingWithHistory, error)
}

type GetMyTracking struct{ reader ScopedTrackingReader }

func NewGetMyTracking(reader ScopedTrackingReader) *GetMyTracking {
	return &GetMyTracking{reader: reader}
}

// Execute returns one of the CALLER'S trackings.
//
// domain.ErrTrackingNotFound covers both "no such tracking" and "exists but
// belongs to another user" — indistinguishable on purpose. The ownership
// predicate is inside the SQL, so a non-owned row never exists in this process to
// be leaked by a later change.
func (uc *GetMyTracking) Execute(ctx context.Context, orderID, cognitoSub string) (domain.TrackingWithHistory, error) {
	return uc.reader.GetByOrderIDScoped(ctx, orderID, cognitoSub)
}
```

`internal/app/list_my_trackings.go`:

```go
package app

type ScopedTrackingLister interface {
	ListByOrderIDsScoped(ctx context.Context, orderIDs []string, cognitoSub string) ([]domain.TrackingWithHistory, error)
}

type ListMyTrackings struct{ lister ScopedTrackingLister }

func NewListMyTrackings(lister ScopedTrackingLister) *ListMyTrackings {
	return &ListMyTrackings{lister: lister}
}

// Execute returns the caller's trackings among orderIDs. Ids that do not exist —
// or exist but belong to another user — are OMITTED, never reported as a per-id
// error entry. A caller passing ten ids and owning three gets exactly three back.
func (uc *ListMyTrackings) Execute(ctx context.Context, orderIDs []string, cognitoSub string) ([]domain.TrackingWithHistory, error) {
	// The short-circuit is load-bearing, not an optimisation: sqlc renders
	// `IN (sqlc.slice('order_ids'))` as `IN ()` for an empty slice, which is a
	// syntax error in MySQL.
	if len(orderIDs) == 0 {
		return []domain.TrackingWithHistory{}, nil
	}
	return uc.lister.ListByOrderIDsScoped(ctx, orderIDs, cognitoSub)
}
```

`internal/adapter/http/handler_reads.go` — the handler bodies:

```go
const readTTL = 60 * time.Second

const (
	// The token goes to the log and the span ONLY. The body carries the prose
	// message, matching the Python's HTTPException(detail=...).
	reasonTooManyOrderIDs = "too_many_order_ids"
	reasonNotFound        = "not_found"
)

func (h *ReadsHandler) GetOne(c *gin.Context) {
	cognitoSub := strings.TrimSpace(c.GetHeader("x-user-id"))
	if cognitoSub == "" {
		c.JSON(http.StatusUnauthorized, FlatError{Detail: "missing x-user-id"})
		return
	}
	orderID := c.Param("order_id")

	key := CacheKeyTrackingOrder(cognitoSub, ResolvedUserID(c), orderID)
	if body, served := h.serveCached(c, key); served {
		c.Data(http.StatusOK, "application/json; charset=utf-8", body)
		return
	}

	ctx, span := h.tracer.Start(c.Request.Context(), "get_tracking")
	defer span.End()

	found, err := h.get.Execute(ctx, orderID, cognitoSub)
	if errors.Is(err, domain.ErrTrackingNotFound) {
		// 404, never 403 — a 403 would confirm a tracking exists for this order
		// id and turn the endpoint into an oracle for other people's order ids.
		// "not yours" and "not there" are one answer here.
		span.SetAttributes(
			attribute.String("app_event", "get_tracking_failed"),
			attribute.String("reason", reasonNotFound))
		h.log.WarnContext(ctx, "get_tracking_failed",
			slog.String("app_event", "get_tracking_failed"),
			slog.String("reason", reasonNotFound),
			slog.String("order_id", orderID))
		c.JSON(http.StatusNotFound, FlatError{Detail: "tracking not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, FlatError{Detail: "internal server error"})
		return
	}

	// No *_succeeded line: the middleware's `request completed` already carries
	// the route, the status and duration_ms, and these are the two most frequent
	// authenticated calls this service serves. Only the failure branch logs,
	// because that is the one the request line cannot explain.
	result := NewTrackingResponse(found)
	h.storeCached(c, key, result) // only ever reached on a 200
	c.JSON(http.StatusOK, result)
}

func (h *ReadsHandler) List(c *gin.Context) {
	cognitoSub := strings.TrimSpace(c.GetHeader("x-user-id"))
	if cognitoSub == "" {
		c.JSON(http.StatusUnauthorized, FlatError{Detail: "missing x-user-id"})
		return
	}

	// Presence, not emptiness. c.Query returns "" with no error for an absent
	// parameter, and FastAPI answers 422 for a missing REQUIRED query param —
	// a different code from the 400 an over-cap request gets.
	raw, present := c.Request.URL.Query()["order_ids"]
	if !present || len(raw) == 0 {
		c.JSON(http.StatusUnprocessableEntity, NewValidationError(
			[]string{"query", "order_ids"}, "Field required", "missing"))
		return
	}
	parsed := ParseOrderIDs(raw[0])

	ctx, span := h.tracer.Start(c.Request.Context(), "list_trackings")
	defer span.End()
	span.SetAttributes(
		attribute.String("app_event", "list_trackings_started"),
		attribute.Int("requested_count", len(parsed)))

	// The cap counts DISTINCT NON-EMPTY ids, so it is applied AFTER parsing.
	if len(parsed) > MaxBatchOrderIDs {
		span.SetAttributes(
			attribute.String("app_event", "list_trackings_failed"),
			attribute.String("reason", reasonTooManyOrderIDs))
		h.log.WarnContext(ctx, "list_trackings_failed",
			slog.String("app_event", "list_trackings_failed"),
			slog.String("reason", reasonTooManyOrderIDs),
			slog.Int("requested_count", len(parsed)),
			slog.Int("max_order_ids", MaxBatchOrderIDs))
		c.JSON(http.StatusBadRequest, FlatError{
			Detail: fmt.Sprintf("at most %d order_ids per request", MaxBatchOrderIDs),
		})
		return
	}

	key := CacheKeyTrackingList(cognitoSub, ResolvedUserID(c), parsed)
	if body, served := h.serveCached(c, key); served {
		c.Data(http.StatusOK, "application/json; charset=utf-8", body)
		return
	}

	found, err := h.list.Execute(ctx, parsed, cognitoSub)
	if err != nil {
		c.JSON(http.StatusInternalServerError, FlatError{Detail: "internal server error"})
		return
	}

	// Non-nil slice so an empty result marshals as [] and never as null.
	items := make([]TrackingResponse, 0, len(found))
	for _, f := range found {
		items = append(items, NewTrackingResponse(f))
	}
	result := TrackingListResponse{Trackings: items}

	span.SetAttributes(
		attribute.String("app_event", "list_trackings_succeeded"),
		attribute.Int("found_count", len(items)))

	h.storeCached(c, key, result)
	c.JSON(http.StatusOK, result)
}
```

`serveCached` / `storeCached` mirror the Python's three-outcome contract: `HIT`
(with `X-Cache-TTL`), `MISS`, `BYPASS` (Redis unreachable — kept distinct from MISS
so an outage does not read as a poor hit rate). An unresolvable `user_id` makes the
key empty, which is a MISS with no write: a request that cannot be keyed correctly
is not cached at all. With the cache disabled both are no-ops and stamp nothing.
`storeCached` is reached only after the handler returned normally, so a 404, a 400
and a 401 can never write — structural, not a status check a later branch can forget.

`internal/adapter/mysql/read_scoped.go` wraps the sqlc queries. Both carry
`deleted_at IS NULL` and the ownership predicate `cognito_sub = ?` INSIDE the SQL,
and both load history in one additional query keyed on the parent ids (never one
query per tracking). Register in `cmd/server/main.go`, batch route BEFORE the
parameterised one:

```go
	reads := adapterhttp.NewReadsHandler(
		app.NewGetMyTracking(trackingRepo),
		app.NewListMyTrackings(trackingRepo),
		cacheGateway, cfg.CacheEnabled, logger, tracer,
	)
	v1.GET("/v1/trackings", reads.List)
	v1.GET("/v1/trackings/:order_id", reads.GetOne)
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/tracking-go && goenv local 1.25.14
gofmt -s -w . && go vet ./... && golangci-lint run
go test ./internal/app/... ./internal/adapter/http/... -run 'MyTracking|SingleRead|BatchRead|ParseOrderIDs' -v
TRACKING_DATABASE_URL="$TRACKING_DATABASE_URL" go test ./internal/adapter/mysql/... -run ScopedReads -v
```

- [ ] **Step 5: Commit**

Leave in the working tree. Report: `feat(tracking): port the two user-scoped reads to Go`.

---

### Task 21: PUT /v1/trackings/{order_id}/status — the carrier webhook

This task OWNS the reusable transition function that Wave 2.5 will consume. Write it as
a shared unit from the start; a parallel transition path for TestMode is how the two
would begin disagreeing about what a transition means.

**Files:**
- Create: `services/tracking-go/internal/app/update_status.go`
- Create: `services/tracking-go/internal/app/update_status_test.go`
- Create: `services/tracking-go/internal/adapter/http/handler_carrier.go`
- Create: `services/tracking-go/internal/adapter/http/handler_carrier_test.go`
- Create: `services/tracking-go/internal/adapter/mysql/update_status.go`
- Create: `services/tracking-go/internal/adapter/mysql/update_status_test.go`
- Modify: `services/tracking-go/cmd/server/main.go`

**Interfaces:**

Consumes (declared IN `update_status.go`):

```go
// StatusWriter is the transition's own narrow port. Note GetByOrderID here is the
// UNSCOPED read — a separate method from the reads' GetByOrderIDScoped, never the
// same method with an empty scope argument.
type StatusWriter interface {
	GetByOrderID(ctx context.Context, orderID string) (domain.Tracking, error)
	// ApplyTransition updates the parent, appends the history row, and RE-READS
	// the history — all in one transaction, all stamped from `now`.
	ApplyTransition(ctx context.Context, t domain.Tracking, to domain.Status, actor audit.Actor, now time.Time) (domain.TrackingWithHistory, error)
}

// EventPublisher is best-effort: it never returns an error that can fail a write.
type EventPublisher interface {
	PublishTrackingStatusChanged(ctx context.Context, t domain.TrackingWithHistory, previousStatus string, actor audit.Actor)
}

// CacheInvalidator clears a tracking's entries. Also never fails the request.
type CacheInvalidator interface {
	InvalidateTracking(ctx context.Context, orderID, cognitoSub, userID string)
}
```

Produces:

```go
package app

// UpdateStatus is the SINGLE write path behind BOTH the carrier PUT and TestMode
// progression. The ONLY thing that differs between its two callers is the actor.
type UpdateStatus struct { ... }

func NewUpdateStatus(writer StatusWriter, publisher EventPublisher, invalidator CacheInvalidator, clock func() time.Time) *UpdateStatus

// Execute loads, validates the transition, appends the history row, updates the
// parent and emits the event. actor defaults to audit.CarrierStatusUpdate
// when the zero value is passed.
func (uc *UpdateStatus) Execute(ctx context.Context, orderID string, requested domain.Status, actor audit.Actor) (domain.TrackingWithHistory, error)
```

Uses `TrackingResponse`, `FlatError` and `ReasonError` from Task 19. Reuses
`domain.ParseStatus`, `domain.CheckTransition` and `domain.InvalidTransitionError` from
Wave 1's domain package.

**Contract this task must reproduce (from `api/carrier_router.py`, `commands/update_status.py`, `domain/repository.py`):**

- Authenticated by `TRACKING_CARRIER_API_KEY` via the `x-api-key` header, declared at the
  **ROUTE GROUP level** — `v1.Group("/v1/trackings", CarrierAuth(key))` — so a future
  second carrier endpoint is authenticated by default rather than open by default.
- Receives **NO `x-user-id`** and must NEVER apply the reads' ownership filter: it
  identifies the tracking by `order_id` ALONE. Reusing the reads' filter here would make
  every carrier call 404 — the endpoint would look implemented and never work once.
  `TRACKING_CARRIER_API_KEY` and `GRPC_API_KEY` are different secrets in different trust
  domains; never collapse them.
- Body: `{status: string}` — a BARE STRING, deliberately not an enum type. Declaring it
  as the enum would let the framework reject an unknown value with a 422 before the
  handler ran, but the design specifies **400**, and routing all four failure reasons
  through one place keeps them answering with the same status code and shape.
- **200** → flat `TrackingResponse`.
- **400 Shape C** with reason `invalid_status` when the value is not one of the five.
  Message exactly:
  `invalid tracking status 'FOO'; expected one of: PLACED, PROCESSING, SHIPPED, OUT_FOR_DELIVERY, DELIVERED`
- **400 Shape C** with reason `already_delivered` / `backward_transition` /
  `not_strictly_forward` from the state machine guards. Guard order is load-bearing:
  terminality is checked first, so `DELIVERED → anything` reports `already_delivered`
  even when it is also backward or equal.
- **401 Shape A** `{"detail":"invalid api key"}` for both a MISSING and a WRONG key —
  identical body, so the response does not distinguish the two.
- **404 Shape A** `{"detail":"tracking not found"}`. There is no ownership dimension
  here, so a 404 genuinely means the order has no tracking.
- **After commit:** publish `TRACKING_STATUS_CHANGED` (best-effort, never fails the
  request) and invalidate the cache. Both read their identities off the **PERSISTED ROW**
  — the carrier sends no caller identity at all. Invalidating before the commit is worse
  than not invalidating: a concurrent read would miss, see the pre-update row, and write
  it back under the key just cleared, serving a superseded status for a full 60s TTL.
- **After appending history, RE-READ the history** rather than reusing a slice loaded
  before the append. The Python explicitly expires that collection so the published event
  and the 200 body contain the transition being announced, not the stale pre-update list.
- Every successful transition publishes exactly one event, `DELIVERED` included. Creation
  does not publish, so a TestMode run leaves five history rows and sends **four** events.

**Steps:**

- [ ] **Step 1: Write the failing test**

`internal/app/update_status_test.go`:

```go
package app_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

type recordingPublisher struct {
	calls []publishedEvent
}

type publishedEvent struct {
	tracking domain.TrackingWithHistory
	previous string
	actor    audit.Actor
}

func (p *recordingPublisher) PublishTrackingStatusChanged(_ context.Context, t domain.TrackingWithHistory, prev string, actor audit.Actor) {
	p.calls = append(p.calls, publishedEvent{tracking: t, previous: prev, actor: actor})
}

func TestUpdateStatus(t *testing.T) {
	now := time.Date(2026, 8, 27, 15, 0, 0, 0, time.UTC)

	t.Run("advances and publishes exactly one event", func(t *testing.T) {
		w := &stubStatusWriter{current: domain.Tracking{
			ID: "trk_1", OrderID: "ord_1", UserID: "usr_1",
			CognitoSub: "sub-1", Status: domain.StatusPlaced,
		}}
		pub := &recordingPublisher{}
		inv := &stubInvalidator{}
		uc := app.NewUpdateStatus(w, pub, inv, fixedClock(now))

		got, err := uc.Execute(context.Background(), "ord_1", domain.StatusProcessing, "")
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if got.Tracking.Status != domain.StatusProcessing {
			t.Errorf("status = %q, want PROCESSING", got.Tracking.Status)
		}
		if len(pub.calls) != 1 {
			t.Fatalf("published %d events, want exactly 1", len(pub.calls))
		}
		if pub.calls[0].previous != "PLACED" {
			t.Errorf("previous_status = %q, want PLACED", pub.calls[0].previous)
		}
		if pub.calls[0].actor != audit.CarrierStatusUpdate {
			t.Errorf("actor = %q, want the carrier default", pub.calls[0].actor)
		}
	})

	t.Run("the actor is a parameter, and only the actor differs", func(t *testing.T) {
		w := &stubStatusWriter{current: domain.Tracking{
			OrderID: "ord_1", Status: domain.StatusPlaced,
		}}
		pub := &recordingPublisher{}
		uc := app.NewUpdateStatus(w, pub, &stubInvalidator{}, fixedClock(now))

		if _, err := uc.Execute(context.Background(), "ord_1",
			domain.StatusProcessing, audit.TestModeProgression); err != nil {
			t.Fatal(err)
		}
		if w.appliedActor != audit.TestModeProgression {
			t.Errorf("history stamped %q, want the test-mode actor", w.appliedActor)
		}
		if pub.calls[0].actor != audit.TestModeProgression {
			t.Errorf("event actor = %q — the actor must travel to the envelope, "+
				"never be fixed in the publisher", pub.calls[0].actor)
		}
	})

	t.Run("the published history CONTAINS the transition being announced", func(t *testing.T) {
		w := &stubStatusWriter{current: domain.Tracking{
			OrderID: "ord_1", Status: domain.StatusPlaced,
		}}
		pub := &recordingPublisher{}
		uc := app.NewUpdateStatus(w, pub, &stubInvalidator{}, fixedClock(now))
		if _, err := uc.Execute(context.Background(), "ord_1", domain.StatusProcessing, ""); err != nil {
			t.Fatal(err)
		}
		last := pub.calls[0].tracking.History
		if len(last) == 0 || last[len(last)-1].Status != domain.StatusProcessing {
			t.Fatalf("published history = %+v — it must be RE-READ after the append, "+
				"not a slice loaded before it", last)
		}
	})

	t.Run("the state machine guards, in their load-bearing order", func(t *testing.T) {
		cases := []struct {
			name       string
			current    domain.Status
			requested  domain.Status
			wantReason string
		}{
			{"terminal beats backward", domain.StatusDelivered, domain.StatusPlaced, "already_delivered"},
			{"terminal beats equal", domain.StatusDelivered, domain.StatusDelivered, "already_delivered"},
			{"backward", domain.StatusShipped, domain.StatusPlaced, "backward_transition"},
			{"equal is not forward", domain.StatusShipped, domain.StatusShipped, "not_strictly_forward"},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				w := &stubStatusWriter{current: domain.Tracking{
					OrderID: "ord_1", Status: tc.current,
				}}
				pub := &recordingPublisher{}
				uc := app.NewUpdateStatus(w, pub, &stubInvalidator{}, fixedClock(now))

				_, err := uc.Execute(context.Background(), "ord_1", tc.requested, "")
				var invalid *domain.InvalidTransitionError
				if !errors.As(err, &invalid) {
					t.Fatalf("err = %v, want InvalidTransitionError", err)
				}
				if invalid.Reason != tc.wantReason {
					t.Errorf("reason = %q, want %q", invalid.Reason, tc.wantReason)
				}
				if w.applied {
					t.Error("a rejected transition wrote to the database")
				}
				if len(pub.calls) != 0 {
					t.Error("a rejected transition published an event")
				}
			})
		}
	})

	t.Run("a missing tracking is ErrTrackingNotFound and writes nothing", func(t *testing.T) {
		w := &stubStatusWriter{getErr: domain.ErrTrackingNotFound}
		uc := app.NewUpdateStatus(w, &recordingPublisher{}, &stubInvalidator{}, fixedClock(now))
		if _, err := uc.Execute(context.Background(), "ord_gone", domain.StatusShipped, ""); !errors.Is(err, domain.ErrTrackingNotFound) {
			t.Fatalf("err = %v, want ErrTrackingNotFound", err)
		}
	})

	t.Run("a publisher panic never fails the transition", func(t *testing.T) {
		w := &stubStatusWriter{current: domain.Tracking{
			OrderID: "ord_1", Status: domain.StatusPlaced,
		}}
		uc := app.NewUpdateStatus(w, panickingPublisher{}, &stubInvalidator{}, fixedClock(now))

		got, err := uc.Execute(context.Background(), "ord_1", domain.StatusProcessing, "")
		if err != nil {
			t.Fatalf("a notification failure broke the write: %v", err)
		}
		if got.Tracking.Status != domain.StatusProcessing {
			t.Error("the transition did not land")
		}
	})

	t.Run("invalidation reads its identities off the PERSISTED row", func(t *testing.T) {
		// The carrier request carries no identity at all, so the row is the only
		// possible source.
		w := &stubStatusWriter{current: domain.Tracking{
			OrderID: "ord_1", UserID: "usr_persisted", CognitoSub: "sub-persisted",
			Status: domain.StatusPlaced,
		}}
		inv := &stubInvalidator{}
		uc := app.NewUpdateStatus(w, &recordingPublisher{}, inv, fixedClock(now))
		if _, err := uc.Execute(context.Background(), "ord_1", domain.StatusProcessing, ""); err != nil {
			t.Fatal(err)
		}
		if inv.cognitoSub != "sub-persisted" || inv.userID != "usr_persisted" {
			t.Errorf("invalidated with sub=%q user=%q, want the persisted row's values",
				inv.cognitoSub, inv.userID)
		}
		if inv.calledBeforeCommit {
			t.Error("the cache was cleared before the commit — a concurrent read " +
				"would repopulate it with the pre-update row for a full TTL")
		}
	})
}
```

`internal/adapter/http/handler_carrier_test.go`:

```go
func TestCarrierPut(t *testing.T) {
	const key = "carrier-secret"

	put := func(t *testing.T, deps testDeps, apiKey, body string) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPut, "/v1/trackings/ord_1/status",
			strings.NewReader(body))
		if apiKey != "" {
			req.Header.Set("x-api-key", apiKey)
		}
		newTestRouter(t, deps).ServeHTTP(rec, req)
		return rec
	}

	t.Run("200 is a flat TrackingResponse", func(t *testing.T) {
		rec := put(t, testDeps{carrierKey: key, current: domain.StatusPlaced},
			key, `{"status":"PROCESSING"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body)
		}
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if _, wrapped := body["tracking"]; wrapped {
			t.Fatal("the carrier PUT must return a FLAT TrackingResponse")
		}
		if body["status"] != "PROCESSING" {
			t.Errorf("status = %v, want PROCESSING", body["status"])
		}
	})

	t.Run("missing and wrong keys are the SAME 401 body", func(t *testing.T) {
		missing := put(t, testDeps{carrierKey: key}, "", `{"status":"SHIPPED"}`)
		wrong := put(t, testDeps{carrierKey: key}, "not-the-key", `{"status":"SHIPPED"}`)

		for name, rec := range map[string]*httptest.ResponseRecorder{"missing": missing, "wrong": wrong} {
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("%s key: status = %d, want 401", name, rec.Code)
			}
		}
		if missing.Body.String() != wrong.Body.String() {
			t.Fatalf("bodies differ: %s vs %s — both must be identical", missing.Body, wrong.Body)
		}
		var body map[string]any
		_ = json.Unmarshal(missing.Body.Bytes(), &body)
		if body["detail"] != "invalid api key" {
			t.Errorf("detail = %v, want \"invalid api key\"", body["detail"])
		}
	})

	t.Run("the route group authenticates, so no x-user-id is ever required", func(t *testing.T) {
		// A carrier request carries no x-user-id at all. If the reads' identity
		// middleware leaked onto this group, this would be a 401.
		rec := put(t, testDeps{carrierKey: key, current: domain.StatusPlaced},
			key, `{"status":"PROCESSING"}`)
		if rec.Code == http.StatusUnauthorized {
			t.Fatal("the carrier PUT acquired an x-user-id requirement")
		}
	})

	t.Run("an unknown status is 400 shape C with the exact message", func(t *testing.T) {
		rec := put(t, testDeps{carrierKey: key, current: domain.StatusPlaced},
			key, `{"status":"FOO"}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400 (NOT 422 — the body is a bare string so "+
				"all four failure reasons answer alike)", rec.Code)
		}
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		want := "invalid tracking status 'FOO'; expected one of: " +
			"PLACED, PROCESSING, SHIPPED, OUT_FOR_DELIVERY, DELIVERED"
		if body["detail"] != want {
			t.Errorf("detail = %q, want %q", body["detail"], want)
		}
		if body["reason"] != "invalid_status" {
			t.Errorf("reason = %v, want invalid_status (top level, not nested)", body["reason"])
		}
	})

	t.Run("each guard surfaces its own reason at 400", func(t *testing.T) {
		cases := []struct {
			current    domain.Status
			requested  string
			wantReason string
		}{
			{domain.StatusDelivered, "PLACED", "already_delivered"},
			{domain.StatusShipped, "PLACED", "backward_transition"},
			{domain.StatusShipped, "SHIPPED", "not_strictly_forward"},
		}
		for _, tc := range cases {
			t.Run(tc.wantReason, func(t *testing.T) {
				rec := put(t, testDeps{carrierKey: key, current: tc.current},
					key, fmt.Sprintf(`{"status":%q}`, tc.requested))
				if rec.Code != http.StatusBadRequest {
					t.Fatalf("status = %d, want 400", rec.Code)
				}
				var body map[string]any
				_ = json.Unmarshal(rec.Body.Bytes(), &body)
				if body["reason"] != tc.wantReason {
					t.Errorf("reason = %v, want %q", body["reason"], tc.wantReason)
				}
				if _, nested := body["detail"].(map[string]any); nested {
					t.Error("the carrier 400 is FLAT with a top-level reason (shape C), " +
						"not the nested shape init-tracking uses")
				}
			})
		}
	})

	t.Run("an unknown order is 404 shape A", func(t *testing.T) {
		rec := put(t, testDeps{carrierKey: key, notFound: true}, key, `{"status":"SHIPPED"}`)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body["detail"] != "tracking not found" {
			t.Errorf("detail = %v", body["detail"])
		}
		if _, present := body["reason"]; present {
			t.Error("the 404 is shape A — no reason field")
		}
	})
}
```

`internal/adapter/mysql/update_status_test.go` (REAL MySQL) asserts that
`ApplyTransition` writes the parent and the history row in one transaction from one
`now`, stamps `updated_by` with the actor, and that the returned `History` slice
ends with the new status (proving the re-read).

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/tracking-go && goenv local 1.25.14
go test ./internal/app/... ./internal/adapter/http/... -run 'UpdateStatus|CarrierPut' -v
TRACKING_DATABASE_URL="$TRACKING_DATABASE_URL" go test ./internal/adapter/mysql/... -run ApplyTransition -v
```

Expect `undefined: app.NewUpdateStatus`.

- [ ] **Step 3: Write minimal implementation**

`internal/app/update_status.go`:

```go
package app

import (
	"context"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// StatusWriter is this use case's own narrow port.
//
// GetByOrderID here is the UNSCOPED read, and it is a DIFFERENT METHOD from the
// reads' GetByOrderIDScoped rather than the same method with an empty scope. This
// endpoint has no caller identity to scope by — its gateway route carries no
// Cognito authorizer, so no x-user-id reaches the service — and reusing the reads'
// filter would 404 every carrier call.
type StatusWriter interface {
	GetByOrderID(ctx context.Context, orderID string) (domain.Tracking, error)
	ApplyTransition(ctx context.Context, t domain.Tracking, to domain.Status, actor audit.Actor, now time.Time) (domain.TrackingWithHistory, error)
}

type EventPublisher interface {
	PublishTrackingStatusChanged(ctx context.Context, t domain.TrackingWithHistory, previousStatus string, actor audit.Actor)
}

type CacheInvalidator interface {
	InvalidateTracking(ctx context.Context, orderID, cognitoSub, userID string)
}

type UpdateStatus struct {
	writer      StatusWriter
	publisher   EventPublisher
	invalidator CacheInvalidator
	clock       func() time.Time
}

func NewUpdateStatus(writer StatusWriter, publisher EventPublisher, invalidator CacheInvalidator, clock func() time.Time) *UpdateStatus {
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC().Truncate(time.Second) }
	}
	return &UpdateStatus{writer: writer, publisher: publisher, invalidator: invalidator, clock: clock}
}

// Execute advances a tracking to `requested`, appending the transition to its
// history.
//
// `actor` is the ONLY thing that differs between this function's two callers: the
// carrier PUT takes the default, and TestMode progression passes
// ActorTestModeProgression so an automatic run stays identifiable from
// tracking_history.created_by after the fact. Everything else — the lookup, the
// guards, the persistence, the emission — is deliberately shared. A second
// implementation for the automatic path is how the two would start disagreeing
// about what a transition means.
//
// The order is load-bearing:
//  1. Find the tracking, UNSCOPED, by order_id alone. Missing -> ErrTrackingNotFound.
//  2. Guard the transition. A rejection carries its machine-readable reason and
//     NOTHING is written.
//  3. Persist: update the parent and append the history row in one unit of work,
//     both stamped from one `now`, then RE-READ the history.
//  4. Only after the commit: publish, then invalidate.
//
// Steps 1 and 2 are separate so a rejected transition on an existing tracking is
// never confused with a missing one — different causes, different status codes.
func (uc *UpdateStatus) Execute(ctx context.Context, orderID string, requested domain.Status, actor audit.Actor) (domain.TrackingWithHistory, error) {
	if actor == "" {
		actor = audit.CarrierStatusUpdate
	}

	tracking, err := uc.writer.GetByOrderID(ctx, orderID)
	if err != nil {
		return domain.TrackingWithHistory{}, err
	}

	current := tracking.Status
	if err := domain.AssertCanTransition(current, requested); err != nil {
		return domain.TrackingWithHistory{}, err
	}

	now := uc.clock()
	// ApplyTransition commits, and the re-read of the history happens inside it —
	// so the returned slice contains the transition being announced rather than
	// the stale pre-update list. The Python expires that collection for exactly
	// this reason: the carrier PUT once reported the NEW status alongside a
	// history that did not contain it.
	updated, err := uc.writer.ApplyTransition(ctx, tracking, requested, actor, now)
	if err != nil {
		return domain.TrackingWithHistory{}, err
	}

	// Everything below is AFTER the commit and cannot fail the request.
	//
	// Both read their identities off the PERSISTED ROW: the carrier sends no
	// caller identity at all, so the row is the only possible source. And both
	// must run after the commit — clearing the cache first opens the window where
	// a concurrent read misses, sees the pre-update row (its transaction cannot
	// see an uncommitted change), and writes that stale body back under the key
	// just cleared, serving a superseded status for a full 60s TTL. Invalidating
	// before the write lands is worse than not invalidating, because it looks
	// correct.
	uc.publish(ctx, updated, string(current), actor)
	uc.invalidator.InvalidateTracking(ctx, updated.Tracking.OrderID,
		updated.Tracking.CognitoSub, updated.Tracking.UserID)

	return updated, nil
}

// publish is best-effort and swallows everything, panics included. A notification
// must not break the write that caused it: the transition is already committed,
// and a 500 would make the carrier retry a status change we actually recorded —
// which the forward-only guard then rejects as a 400.
func (uc *UpdateStatus) publish(ctx context.Context, t domain.TrackingWithHistory, previous string, actor audit.Actor) {
	defer func() {
		if r := recover(); r != nil {
			// The publisher logs its own failures with a reason; this guard covers
			// the layer beneath that — obtaining or calling it at all.
			_ = r
		}
	}()
	uc.publisher.PublishTrackingStatusChanged(ctx, t, previous, actor)
}
```

The handler in `internal/adapter/http/handler_carrier.go` translates the three error
kinds into their bodies. Note the carrier group's auth:

```go
	// Router-level, so every endpoint added to this group is authenticated by
	// DEFAULT rather than open by default. TRACKING_CARRIER_API_KEY is an
	// external vendor's credential and is NOT GRPC_API_KEY — reusing one as the
	// other would give that vendor a credential valid against every internal
	// surface we have.
	carrier := r.Group("/v1/trackings", adapterhttp.CarrierAuth(cfg.CarrierAPIKey))
	carrier.PUT("/:order_id/status", carrierHandler.Handle)
```

```go
func (h *CarrierHandler) Handle(c *gin.Context) {
	orderID := c.Param("order_id")

	var payload struct {
		// A bare string, deliberately not domain.Status: binding it as the enum
		// would let Gin reject an unknown value with a 422 before this handler
		// ran, and the design specifies 400. Routing all four failure reasons
		// through one place keeps them answering with the same code and shape.
		Status string `json:"status"`
	}
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusUnprocessableEntity,
			NewValidationError([]string{"body", "status"}, "Field required", "missing"))
		return
	}

	ctx, span := h.tracer.Start(c.Request.Context(), "carrier_status_update")
	defer span.End()
	span.SetAttributes(
		attribute.String("app_event", "carrier_status_update_started"),
		attribute.String("order_id", orderID))

	requested, err := domain.ParseStatus(payload.Status)
	if err != nil {
		// Rejected before anything was read, so nothing was written.
		h.reject(c, span, orderID, err.Error(), reasonInvalidStatus)
		return
	}

	updated, err := h.uc.Execute(ctx, orderID, requested, "")
	switch {
	case errors.Is(err, domain.ErrTrackingNotFound):
		span.SetAttributes(attribute.String("reason", "not_found"))
		h.logFailure(orderID, "not_found")
		c.JSON(http.StatusNotFound, FlatError{Detail: "tracking not found"})
		return
	case err != nil:
		var invalid *domain.InvalidTransitionError
		if errors.As(err, &invalid) {
			h.reject(c, span, orderID, invalid.Error(), invalid.Reason)
			return
		}
		c.JSON(http.StatusInternalServerError, FlatError{Detail: "internal server error"})
		return
	}

	span.SetAttributes(
		attribute.String("app_event", "carrier_status_update_succeeded"),
		attribute.String("tracking_id", updated.Tracking.ID),
		attribute.String("status", string(updated.Tracking.Status)))
	h.log.InfoContext(ctx, "carrier_status_update_succeeded",
		slog.String("app_event", "carrier_status_update_succeeded"),
		slog.String("order_id", orderID),
		slog.String("tracking_id", updated.Tracking.ID),
		slog.String("status", string(updated.Tracking.Status)))

	c.JSON(http.StatusOK, NewTrackingResponse(updated))
}

// reject renders the 400. Shape C — flat, with `reason` as a TOP-LEVEL field, so a
// client can reach it without knowing a framework's detail-wrapping convention.
// The four reasons (invalid_status plus the three guards) share one vocabulary.
func (h *CarrierHandler) reject(c *gin.Context, span trace.Span, orderID, detail, reason string) {
	span.SetAttributes(attribute.String("reason", reason))
	h.logFailure(orderID, reason)
	c.JSON(http.StatusBadRequest, ReasonError{Detail: detail, Reason: reason})
}

// logFailure emits *_failed with the SAME token the span carries, so the two
// cannot drift. No user_id field: this request has no user identity, and the
// convention omits unknown fields rather than emitting null.
func (h *CarrierHandler) logFailure(orderID, reason string) {
	h.log.Warn("carrier_status_update_failed",
		slog.String("app_event", "carrier_status_update_failed"),
		slog.String("reason", reason),
		slog.String("order_id", orderID))
}
```

`CarrierAuth` compares with `subtle.ConstantTimeCompare` and answers the identical
`{"detail":"invalid api key"}` for a missing and a wrong key. It never logs the key,
not even a prefix or a length.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/tracking-go && goenv local 1.25.14
gofmt -s -w . && go vet ./... && golangci-lint run
go test ./internal/app/... ./internal/adapter/http/... -run 'UpdateStatus|CarrierPut' -v
TRACKING_DATABASE_URL="$TRACKING_DATABASE_URL" go test ./internal/adapter/mysql/... -run ApplyTransition -v
```

- [ ] **Step 5: Commit**

Leave in the working tree. Report:
`feat(tracking): port the carrier status PUT and the shared transition to Go`.

---

### Task 22: DELETE /v1/trackings/by-user + DELETE /v1/trackings/e2e-cleanup

Two routes with different callers and different credentials, but ONE shared soft-delete
mechanism. They are one task because that mechanism must not be written twice.

**Files:**
- Create: `services/tracking-go/internal/app/delete_by_user.go`
- Create: `services/tracking-go/internal/app/delete_by_user_test.go`
- Create: `services/tracking-go/internal/app/e2e_cleanup.go`
- Create: `services/tracking-go/internal/app/e2e_cleanup_test.go`
- Create: `services/tracking-go/internal/adapter/http/handler_internal_delete.go`
- Create: `services/tracking-go/internal/adapter/http/handler_e2e_cleanup.go`
- Create: `services/tracking-go/internal/adapter/http/handler_deletes_test.go`
- Create: `services/tracking-go/internal/adapter/mysql/soft_delete.go`
- Create: `services/tracking-go/internal/adapter/mysql/soft_delete_test.go`
- Modify: `services/tracking-go/cmd/server/main.go`

**Interfaces:**

Consumes:

```go
// in delete_by_user.go
type UserSoftDeleter interface {
	// SoftDeleteByUser stamps deleted_at/deleted_by on the user's live trackings
	// and their live history, and returns the PARENT statement's rowcount.
	SoftDeleteByUser(ctx context.Context, cognitoSub, userID string, actor audit.Actor, now time.Time) (int64, error)
}

type UserCacheInvalidator interface {
	InvalidateUser(ctx context.Context, cognitoSub, userID string)
}

// in e2e_cleanup.go
type TagSoftDeleter interface {
	SoftDeleteByTag(ctx context.Context, tag string, actor audit.Actor, now time.Time) (int64, error)
}
```

Produces:

```go
package app

type DeleteByUser struct { ... }
func NewDeleteByUser(deleter UserSoftDeleter, invalidator UserCacheInvalidator, clock func() time.Time) *DeleteByUser
func (uc *DeleteByUser) Execute(ctx context.Context, cognitoSub, userID string) (int64, error)

var ErrEmptyIdentity = errors.New("soft delete by user requires both identities to be non-empty")

type E2ECleanup struct { ... }
func NewE2ECleanup(deleter TagSoftDeleter, clock func() time.Time) *E2ECleanup
func (uc *E2ECleanup) Execute(ctx context.Context) (int64, error)
```

Uses `DeletedResponse`, `FlatError` and `ValidationError` from Task 19.

**Contract — `DELETE /v1/trackings/by-user` (internal):**

- Authenticated by `GRPC_API_KEY` via the `x-api-key` header. Not published on the API
  Gateway; the only caller is Users' `DELETE /v1/users/me` cascade.
- It is a **DELETE WITH A REQUIRED JSON BODY**: `{cognito_sub, user_id}`, both required
  with **min length 1**.
- That min-length is a **SECURITY CONTROL, not cosmetic**: the predicate is an OR, so an
  empty value on either side could widen the match to any row carrying an empty string
  in that column — someone else's data. Reject at the boundary (422) and **guard again at
  the row-selection point**, because the use case is reachable by a future caller that
  does not go through the HTTP boundary.
- **Unlike init-tracking, this endpoint does NOT forbid unknown fields.**
- **200** `{"deleted": N}`; **401** Shape A; **422**; **500** on a DB error — logged with
  `reason=db_error`, then returned untouched so the HTTP contract is unchanged. Without
  that branch the 500 carries no `*_failed`, no reason and no span attribute: the one
  outcome that most needs to be findable would be the only silent one.
- The soft-delete predicate matches `cognito_sub` **OR** `user_id` (both travel because
  rows predating the `cognito_sub` migration carry only `user_id`, and because
  `cognito_sub` is not durable — a user who deletes and re-registers gets a new one while
  their `usr_` id never changes).
- The predicate is written explicitly under `utf8mb4_bin` collation:
  `WHERE (cognito_sub COLLATE utf8mb4_bin = ? OR user_id COLLATE utf8mb4_bin = ?) AND deleted_at IS NULL`.
  This is a **safety control**, not a tuning knob: the columns are `utf8mb4_unicode_ci`
  (case-INSENSITIVE) while the ids come from a MIXED-CASE alphabet minted elsewhere and
  compared case-SENSITIVELY. Postgres can legitimately issue `usr_AbC…` and `usr_abc…` as
  two different people that MySQL cannot tell apart, and an erasure keyed on one would
  sweep the other's trackings. Verified against the live database on 2026-08-26.
- After the write, clear the user's cache footprint via the user-invalidation path,
  scheduled to run **AFTER the commit**. That invalidation must never fail the response:
  the deletion has already committed, so a Redis outage failing the request would tell
  Users the cascade did not happen when it did, and fail the whole account deletion.

**Contract — `DELETE /v1/trackings/e2e-cleanup`:**

- Registered **ONLY** when `E2E_TESTING_ENABLED`.
- Takes **NO caller identity at all**, and that is deliberate: the harness's teardown runs
  once, globally, with no user session, so a route requiring `x-user-id` would 401 its
  only real caller (it did, in the first version). What protects it instead is that it
  does not exist unless the flag is on, and that it only deletes rows tagged
  `E2E Source` — a tag applied at creation only when the request sent `x-e2e-source: true`
  **AND** that same flag was on. Both halves are required; the conjunction is what stops
  an untrusted client tagging its own rows for someone else's teardown to delete.
- **200** `{"deleted": N}` ALWAYS, including zero matches — a teardown re-run is not a
  failure, and a count is what makes a teardown diagnosable ("the suite still sees its
  fixtures" and "the cleanup matched nothing" are the same symptom from the client's side).
- With the flag **OFF**, a DELETE to that path must answer **405, not 404** — the path
  still matches the GET route. In Gin this requires `router.HandleMethodNotAllowed = true`.

**SHARED soft-delete semantics for BOTH:**

- Children (history) are updated **FIRST**, mirroring the FK direction, so an interrupted
  unit of work can never leave a live history row under a deleted tracking.
- The parent-id subquery is deliberately **NOT** filtered on `deleted_at IS NULL` (an
  already-deleted tracking may still have live history from a partial previous run),
  while each UPDATE statement **IS** guarded, keeping the stamps idempotent.
- The returned count is the rowcount of the **PARENT statement only**.
- The tag predicate is exactly `JSON_CONTAINS(tags, JSON_QUOTE(?))` — `JSON_QUOTE` in SQL,
  never string-building the JSON in Go. `JSON_CONTAINS`'s second argument must be valid
  JSON, so a bare bind fails with "Invalid JSON text"; doing the wrapping in SQL keeps the
  value a bound parameter instead of putting caller-supplied text into the statement. It
  matches `["E2E Source"]` and `["x","E2E Source"]`; it does not match `[]` or `["other"]`.
- **Hard delete is impossible by grant** — the application database user has no DELETE
  privilege. A "just DELETE the rows, it is only test data" shortcut would fail at the
  server.

**Steps:**

- [ ] **Step 1: Write the failing test**

`internal/app/delete_by_user_test.go`:

```go
func TestDeleteByUser(t *testing.T) {
	now := time.Date(2026, 8, 27, 16, 0, 0, 0, time.UTC)

	t.Run("returns the parent rowcount and invalidates after the write", func(t *testing.T) {
		d := &stubUserDeleter{count: 3}
		inv := &stubUserInvalidator{}
		uc := app.NewDeleteByUser(d, inv, fixedClock(now))

		got, err := uc.Execute(context.Background(), "sub-1", "usr_1")
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if got != 3 {
			t.Errorf("deleted = %d, want 3", got)
		}
		if d.actor != audit.DeleteByUser {
			t.Errorf("actor = %q, want tracking_api:delete_by_user", d.actor)
		}
		if !inv.called || inv.calledBeforeWrite {
			t.Error("the cache must be invalidated, and only after the write")
		}
	})

	t.Run("an empty identity is refused at the row-selection point too", func(t *testing.T) {
		// The HTTP boundary already 422s these, but this use case is public and a
		// future caller reaching it another way must not be able to widen the
		// blast radius: the predicate is an OR, so an empty value matches every
		// row carrying an empty string in that column.
		for _, tc := range []struct{ sub, user string }{
			{"", "usr_1"}, {"sub-1", ""}, {"", ""},
		} {
			d := &stubUserDeleter{}
			uc := app.NewDeleteByUser(d, &stubUserInvalidator{}, fixedClock(now))
			if _, err := uc.Execute(context.Background(), tc.sub, tc.user); !errors.Is(err, app.ErrEmptyIdentity) {
				t.Errorf("Execute(%q,%q) err = %v, want ErrEmptyIdentity", tc.sub, tc.user, err)
			}
			if d.called {
				t.Errorf("Execute(%q,%q) reached the database", tc.sub, tc.user)
			}
		}
	})

	t.Run("a db error propagates untouched", func(t *testing.T) {
		boom := errors.New("mysql: gone away")
		uc := app.NewDeleteByUser(&stubUserDeleter{err: boom}, &stubUserInvalidator{}, fixedClock(now))
		if _, err := uc.Execute(context.Background(), "sub-1", "usr_1"); !errors.Is(err, boom) {
			t.Fatalf("err = %v, want the underlying error", err)
		}
	})
}
```

`internal/adapter/mysql/soft_delete_test.go` (REAL MySQL — this is where the semantics
actually live):

```go
func TestSoftDeleteByUser(t *testing.T) {
	db := requireMySQL(t)
	repo := newRepo(db)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	t.Run("matches EITHER identity", func(t *testing.T) {
		truncate(t, db)
		// One row reachable only by cognito_sub, one only by user_id (its
		// cognito_sub is NULL, like rows predating the migration).
		seed(t, repo, domain.NewTracking{OrderID: "ord_a", UserID: "usr_other", CognitoSub: "sub-1", Status: domain.StatusPlaced}, now)
		seedNullSub(t, db, "ord_b", "usr_1", now)
		seed(t, repo, domain.NewTracking{OrderID: "ord_c", UserID: "usr_nope", CognitoSub: "sub-nope", Status: domain.StatusPlaced}, now)

		got, err := repo.SoftDeleteByUser(ctx, "sub-1", "usr_1", audit.DeleteByUser, now)
		if err != nil {
			t.Fatal(err)
		}
		if got != 2 {
			t.Fatalf("deleted = %d, want 2 (the OR must reach both rows)", got)
		}
		if liveHistoryCount(t, db, "ord_a") != 0 {
			t.Error("history was left live under a deleted tracking")
		}
		if !isLive(t, db, "ord_c") {
			t.Error("an unrelated user's tracking was swept")
		}
	})

	t.Run("comparison is CASE-SENSITIVE under utf8mb4_bin", func(t *testing.T) {
		truncate(t, db)
		// The columns are utf8mb4_unicode_ci — case-insensitive — while the ids
		// come from a mixed-case alphabet minted by Postgres, which compares
		// case-sensitively. Without the explicit COLLATE these are one person.
		seed(t, repo, domain.NewTracking{OrderID: "ord_upper", UserID: "usr_AbC", CognitoSub: "sub-AbC", Status: domain.StatusPlaced}, now)

		got, err := repo.SoftDeleteByUser(ctx, "sub-abc", "usr_abc", audit.DeleteByUser, now)
		if err != nil {
			t.Fatal(err)
		}
		if got != 0 {
			t.Fatalf("deleted = %d, want 0 — a lower-case id must NOT sweep the "+
				"mixed-case row; that is a different person", got)
		}
	})

	t.Run("children are stamped before the parent and the count is the parent's", func(t *testing.T) {
		truncate(t, db)
		seedWithHistory(t, repo, "ord_h", "usr_1", "sub-1", 5, now)

		got, err := repo.SoftDeleteByUser(ctx, "sub-1", "usr_1", audit.DeleteByUser, now)
		if err != nil {
			t.Fatal(err)
		}
		if got != 1 {
			t.Fatalf("deleted = %d, want 1 — the count is the PARENT rowcount, not "+
				"the 5 history rows", got)
		}
	})

	t.Run("live history under an ALREADY-deleted tracking is still swept", func(t *testing.T) {
		truncate(t, db)
		seedWithHistory(t, repo, "ord_partial", "usr_1", "sub-1", 3, now)
		markTrackingDeletedOnly(t, db, "ord_partial") // simulate a partial previous run

		if _, err := repo.SoftDeleteByUser(ctx, "sub-1", "usr_1", audit.DeleteByUser, now); err != nil {
			t.Fatal(err)
		}
		if n := liveHistoryCount(t, db, "ord_partial"); n != 0 {
			t.Fatalf("%d history rows left live — the parent-id subquery must NOT be "+
				"filtered on deleted_at IS NULL", n)
		}
	})

	t.Run("idempotent: a second call stamps nothing", func(t *testing.T) {
		truncate(t, db)
		seedWithHistory(t, repo, "ord_i", "usr_1", "sub-1", 2, now)
		if _, err := repo.SoftDeleteByUser(ctx, "sub-1", "usr_1", audit.DeleteByUser, now); err != nil {
			t.Fatal(err)
		}
		second, err := repo.SoftDeleteByUser(ctx, "sub-1", "usr_1", audit.DeleteByUser, now)
		if err != nil {
			t.Fatal(err)
		}
		if second != 0 {
			t.Errorf("second call deleted = %d, want 0", second)
		}
	})
}

func TestSoftDeleteByTag(t *testing.T) {
	db := requireMySQL(t)
	repo := newRepo(db)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	t.Run("JSON_CONTAINS matching, verified against the real server", func(t *testing.T) {
		cases := []struct {
			name  string
			tags  []string
			match bool
		}{
			{"exact single tag", []string{"E2E Source"}, true},
			{"among others", []string{"x", "E2E Source"}, true},
			{"empty array", []string{}, false},
			{"other tag only", []string{"other"}, false},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				truncate(t, db)
				seed(t, repo, domain.NewTracking{
					OrderID: "ord_tag", UserID: "usr_1", CognitoSub: "sub-1",
					Status: domain.StatusPlaced, Tags: tc.tags,
				}, now)

				got, err := repo.SoftDeleteByTag(ctx, domain.E2ESourceTag, audit.E2ECleanup, now)
				if err != nil {
					t.Fatal(err)
				}
				want := int64(0)
				if tc.match {
					want = 1
				}
				if got != want {
					t.Errorf("deleted = %d, want %d for tags %v", got, want, tc.tags)
				}
			})
		}
	})

	t.Run("an untagged row created by a real user is untouchable", func(t *testing.T) {
		truncate(t, db)
		seed(t, repo, domain.NewTracking{OrderID: "ord_real", UserID: "usr_1", CognitoSub: "sub-1", Status: domain.StatusPlaced}, now)
		if _, err := repo.SoftDeleteByTag(ctx, domain.E2ESourceTag, audit.E2ECleanup, now); err != nil {
			t.Fatal(err)
		}
		if !isLive(t, db, "ord_real") {
			t.Fatal("an untagged row was deleted by the e2e cleanup")
		}
	})

	t.Run("a tag containing a quote character stays a bound parameter", func(t *testing.T) {
		truncate(t, db)
		// Not an injection test so much as a proof the JSON is built in SQL:
		// string-building it in Go would put this straight into the statement.
		if _, err := repo.SoftDeleteByTag(ctx, `E2E" or "1`, audit.E2ECleanup, now); err != nil {
			t.Fatalf("a quoted tag broke the statement: %v", err)
		}
	})
}
```

`internal/adapter/http/handler_deletes_test.go`:

```go
func TestInternalDeleteByUser(t *testing.T) {
	const key = "internal-secret"

	t.Run("200 with the count", func(t *testing.T) {
		rec := doDelete(t, testDeps{internalKey: key, deletedCount: 4}, key,
			"/v1/trackings/by-user", `{"cognito_sub":"sub-1","user_id":"usr_1"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body)
		}
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body["deleted"] != float64(4) {
			t.Errorf("deleted = %v, want 4", body["deleted"])
		}
	})

	t.Run("missing or wrong key is 401 shape A", func(t *testing.T) {
		for _, k := range []string{"", "wrong"} {
			rec := doDelete(t, testDeps{internalKey: key}, k,
				"/v1/trackings/by-user", `{"cognito_sub":"sub-1","user_id":"usr_1"}`)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("key %q: status = %d, want 401", k, rec.Code)
			}
		}
	})

	t.Run("an empty identity on either side is 422", func(t *testing.T) {
		for _, body := range []string{
			`{"cognito_sub":"","user_id":"usr_1"}`,
			`{"cognito_sub":"sub-1","user_id":""}`,
			`{"cognito_sub":"sub-1"}`,
			`{"user_id":"usr_1"}`,
		} {
			rec := doDelete(t, testDeps{internalKey: key}, key, "/v1/trackings/by-user", body)
			if rec.Code != http.StatusUnprocessableEntity {
				t.Errorf("%s -> %d, want 422 (the min-length is a SECURITY control: "+
					"the predicate is an OR)", body, rec.Code)
			}
		}
	})

	t.Run("unknown body fields are ACCEPTED here", func(t *testing.T) {
		// Unlike init-tracking. Do not add DisallowUnknownFields to this route.
		rec := doDelete(t, testDeps{internalKey: key}, key, "/v1/trackings/by-user",
			`{"cognito_sub":"sub-1","user_id":"usr_1","extra":"ignored"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 — this endpoint does not forbid extras", rec.Code)
		}
	})

	t.Run("a db error is 500 and logs reason=db_error", func(t *testing.T) {
		deps := testDeps{internalKey: key, deleteErr: errors.New("mysql gone")}
		rec := doDelete(t, deps, key, "/v1/trackings/by-user",
			`{"cognito_sub":"sub-1","user_id":"usr_1"}`)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rec.Code)
		}
		if !deps.logs.Has("app_event", "internal_delete_by_user_failed") ||
			!deps.logs.Has("reason", "db_error") {
			t.Error("the 500 must carry *_failed with reason=db_error — otherwise the " +
				"one outcome that most needs to be findable is the only silent one")
		}
	})
}

func TestE2ECleanupRoute(t *testing.T) {
	t.Run("registered with the flag on, 200 with a count and no credential", func(t *testing.T) {
		rec := doDelete(t, testDeps{e2eEnabled: true, deletedCount: 7}, "", "/v1/trackings/e2e-cleanup", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 — this route takes NO caller identity", rec.Code)
		}
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body["deleted"] != float64(7) {
			t.Errorf("deleted = %v, want 7", body["deleted"])
		}
	})

	t.Run("zero matches is still 200", func(t *testing.T) {
		rec := doDelete(t, testDeps{e2eEnabled: true, deletedCount: 0}, "", "/v1/trackings/e2e-cleanup", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 — a teardown re-run is not a failure", rec.Code)
		}
	})

	t.Run("with the flag OFF a DELETE is 405, not 404", func(t *testing.T) {
		rec := doDelete(t, testDeps{e2eEnabled: false}, "", "/v1/trackings/e2e-cleanup", "")
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want 405 — the path still matches the GET route, "+
				"which requires gin's HandleMethodNotAllowed = true", rec.Code)
		}
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/tracking-go && goenv local 1.25.14
go test ./internal/app/... ./internal/adapter/http/... -run 'DeleteByUser|E2ECleanup' -v
TRACKING_DATABASE_URL="$TRACKING_DATABASE_URL" go test ./internal/adapter/mysql/... -run SoftDelete -v
```

- [ ] **Step 3: Write minimal implementation**

`internal/app/delete_by_user.go`:

```go
package app

import (
	"context"
	"errors"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// ErrEmptyIdentity guards the row-selection point. The HTTP boundary already
// rejects empties with a 422, but this use case is exported and a future caller
// reaching it another way must not be able to widen the blast radius: the
// predicate is an OR, so an empty value on either side matches every row carrying
// an empty string in that column — someone else's trackings.
var ErrEmptyIdentity = errors.New("soft delete by user requires both identities to be non-empty")

type UserSoftDeleter interface {
	SoftDeleteByUser(ctx context.Context, cognitoSub, userID string, actor audit.Actor, now time.Time) (int64, error)
}

type UserCacheInvalidator interface {
	InvalidateUser(ctx context.Context, cognitoSub, userID string)
}

type DeleteByUser struct {
	deleter     UserSoftDeleter
	invalidator UserCacheInvalidator
	clock       func() time.Time
}

func NewDeleteByUser(deleter UserSoftDeleter, invalidator UserCacheInvalidator, clock func() time.Time) *DeleteByUser {
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC().Truncate(time.Second) }
	}
	return &DeleteByUser{deleter: deleter, invalidator: invalidator, clock: clock}
}

// Execute soft-deletes every live tracking belonging to the user and, through the
// FK, their history. It returns how many `tracking` rows were stamped.
//
// The actor is the cascade, not the user: deleted_by records what PRODUCED the
// change, and "this account was deleted" is a different fact from "the carrier
// updated this" or "the test harness swept this".
func (uc *DeleteByUser) Execute(ctx context.Context, cognitoSub, userID string) (int64, error) {
	if cognitoSub == "" || userID == "" {
		return 0, ErrEmptyIdentity
	}

	deleted, err := uc.deleter.SoftDeleteByUser(ctx, cognitoSub, userID, audit.DeleteByUser, uc.clock())
	if err != nil {
		return 0, err
	}

	// After the write, never before. And it must not be able to fail the
	// response: the deletion has already committed, so a Redis outage that failed
	// here would tell Users the cascade did not happen when it did, and fail the
	// whole account deletion for the person.
	uc.invalidator.InvalidateUser(ctx, cognitoSub, userID)
	return deleted, nil
}
```

`internal/app/e2e_cleanup.go`:

```go
package app

// TagSoftDeleter is the E2E teardown's port. It is unscoped by any identity, and
// that is the design: the harness's teardown runs once, globally, with no user
// session. The safety that scoping would have provided moved to creation — a row
// is tagged only when the request sent x-e2e-source AND E2E_TESTING_ENABLED was
// on — and to registration: this route does not exist unless that flag is on.
type TagSoftDeleter interface {
	SoftDeleteByTag(ctx context.Context, tag string, actor audit.Actor, now time.Time) (int64, error)
}

type E2ECleanup struct {
	deleter TagSoftDeleter
	clock   func() time.Time
}

func NewE2ECleanup(deleter TagSoftDeleter, clock func() time.Time) *E2ECleanup {
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC().Truncate(time.Second) }
	}
	return &E2ECleanup{deleter: deleter, clock: clock}
}

// Execute soft-deletes every live tracking carrying the E2E Source tag.
//
// Idempotent: a second call stamps nothing and returns 0, which is a success. The
// count travels to the client so a teardown that quietly matched nothing is
// visible in the harness's own output rather than only in this service's logs.
func (uc *E2ECleanup) Execute(ctx context.Context) (int64, error) {
	return uc.deleter.SoftDeleteByTag(ctx, domain.E2ESourceTag, audit.E2ECleanup, uc.clock())
}
```

`internal/adapter/mysql/soft_delete.go` — the shared mechanism, written once:

```go
// softDeleteHistoryFirst stamps the children, then the parents, in ONE
// transaction, and returns the PARENT statement's rowcount.
//
// Children FIRST, mirroring the FK direction, so an interrupted unit of work can
// never leave a live history row under a deleted tracking.
//
// The parent-id subquery is deliberately NOT filtered on `deleted_at IS NULL`: an
// already-soft-deleted tracking may still have live history under it from a
// partial previous run, and those children should still be swept. The
// per-statement `deleted_at IS NULL` guards below are what keep the stamps
// idempotent.
//
// Never a SQL DELETE. The application database user is granted no DELETE
// privilege, so a hard delete would fail at the server anyway — the rows stay in
// the table and every read excludes them.
const softDeleteHistoryByUser = `
UPDATE tracking_history
   SET deleted_at = ?, deleted_by = ?
 WHERE tracking_id IN (
         SELECT id FROM (
           SELECT id FROM tracking
            WHERE cognito_sub COLLATE utf8mb4_bin = ?
               OR user_id     COLLATE utf8mb4_bin = ?
         ) AS parents
       )
   AND deleted_at IS NULL`

// The COLLATE is a SAFETY control, not a tuning knob. Both columns are
// utf8mb4_unicode_ci — case-INSENSITIVE — while the ids they hold come from a
// mixed-case alphabet (A-Za-z0-9) minted by Users' Postgres, which compares
// case-SENSITIVELY. Postgres can legitimately issue usr_AbC... and usr_abc... as
// two different people that MySQL cannot tell apart, and an erasure keyed on one
// would sweep the other's trackings. Verified against the live database on
// 2026-08-26: an id with its case inverted matched a real row.
//
// Pinned at the PREDICATE rather than fixed in the schema, which keeps the change
// scoped to the irreversible operation. The user-scoped READS share the same root
// cause and are deliberately left alone: a read returning a neighbour's row is a
// bug, but a delete removing it is not recoverable without hand-written SQL.
const softDeleteTrackingByUser = `
UPDATE tracking
   SET deleted_at = ?, deleted_by = ?
 WHERE (cognito_sub COLLATE utf8mb4_bin = ? OR user_id COLLATE utf8mb4_bin = ?)
   AND deleted_at IS NULL`

// JSON_QUOTE in SQL, never string-building the JSON in Go: JSON_CONTAINS's second
// argument must be valid JSON, so a bare bind fails with "Invalid JSON text", and
// doing the wrapping here keeps the value a BOUND PARAMETER rather than putting
// caller-supplied text into the statement. Verified on MySQL 8.0.46: matches
// ["E2E Source"] and ["x","E2E Source"], does not match [] or ["other"].
const softDeleteHistoryByTag = `
UPDATE tracking_history
   SET deleted_at = ?, deleted_by = ?
 WHERE tracking_id IN (
         SELECT id FROM (
           SELECT id FROM tracking WHERE JSON_CONTAINS(tags, JSON_QUOTE(?))
         ) AS parents
       )
   AND deleted_at IS NULL`

const softDeleteTrackingByTag = `
UPDATE tracking
   SET deleted_at = ?, deleted_by = ?
 WHERE JSON_CONTAINS(tags, JSON_QUOTE(?))
   AND deleted_at IS NULL`
```

(The derived-table wrapper `SELECT id FROM (…) AS parents` is required because MySQL
refuses a subquery over the same table an UPDATE targets — the Python's ORM emits the
equivalent. Both statements run inside one `sql.Tx`; the parent's `RowsAffected` is the
returned count.)

The two handlers are thin. `InternalAuth(cfg.GRPCAPIKey)` guards `by-user` and rejects a
missing or wrong key with the same 401 body; the e2e route takes no credential and is
registered conditionally:

```go
	// Both literal segments are registered BEFORE the parameterised read route.
	internal := r.Group("/v1/trackings", adapterhttp.InternalAuth(cfg.GRPCAPIKey))
	internal.DELETE("/by-user", internalDelete.Handle)

	// The whole ROUTE is the guard. With the flag off nothing is registered, and
	// the path still matches GET /v1/trackings/:order_id — so a DELETE answers
	// 405 rather than 404, which requires HandleMethodNotAllowed below.
	if cfg.E2ETestingEnabled {
		r.DELETE("/v1/trackings/e2e-cleanup", e2eCleanup.Handle)
	}
```

and in the router construction:

```go
	r := gin.New()
	// Without this, gin answers 404 for a path that exists under another method,
	// and the flag-off e2e-cleanup case would report the wrong code.
	r.HandleMethodNotAllowed = true
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/tracking-go && goenv local 1.25.14
gofmt -s -w . && go vet ./... && golangci-lint run
go test ./internal/app/... ./internal/adapter/http/... -run 'DeleteByUser|E2ECleanup' -v
TRACKING_DATABASE_URL="$TRACKING_DATABASE_URL" go test ./internal/adapter/mysql/... -run SoftDelete -v
```

- [ ] **Step 5: Commit**

Leave in the working tree. Report:
`feat(tracking): port the internal and e2e deletion routes to Go`.

---

### Task 23: openapi.yaml generation + comparison test

**Files:**
- Create: `services/tracking-go/internal/openapi/spec.go`
- Create: `services/tracking-go/internal/openapi/allowlist.go`
- Create: `services/tracking-go/internal/openapi/spec_test.go`
- Create: `services/tracking-go/cmd/genopenapi/main.go`
- Create: `services/tracking-go/openapi.yaml` (generated output, committed)
- Read-only reference: `services/tracking/openapi.yaml`

**Interfaces:**

```go
package openapi

// BuildSpec returns the OpenAPI 3.1 document the Go routes describe, as a
// generic tree ready to marshal. It takes no database and no environment.
func BuildSpec() map[string]any

// Diff compares two parsed documents and returns every difference that is NOT
// covered by the allowlist.
func Diff(got, want map[string]any) []Difference

type Difference struct {
	Path string // JSON-pointer-ish location, e.g. "paths./v1/trackings.get.responses.401"
	Got  any
	Want any
}

// AllowedDifferences is a CLOSED, ENUMERATED list. Every entry carries the
// justification for why the difference is irreducible.
var AllowedDifferences []AllowedDifference

type AllowedDifference struct {
	Path          string
	Justification string
}
```

**Contract:**

- Generate the OpenAPI document **from the Go routes** and compare against the committed
  Python `services/tracking/openapi.yaml`.
- The generator must **declare the failures the framework cannot infer** — the 401s that
  come from middleware, the 404/409 from handler guards, and the 400s. In Python these
  appear ONLY because each route declares them explicitly in `responses=`, and **two
  reads shipped without their 401 for exactly this reason**. Go has no framework
  inference at all, so every response is declared by hand: that is a feature here, but it
  means an omission is equally silent. Enumerate against the route table.
- The comparison test **must run WITHOUT a database** — the OpenAPI document is a
  routing-table fact, so it must run in the suite that executes when no MySQL is
  reachable, which is exactly when a wiring mistake is likeliest to go unnoticed.
- Expect irreducible serialization differences (ordering of `required`, naming of
  anonymous schemas). Each one must be recorded in a **CLOSED, ENUMERATED allowlist with
  a justification**. The criterion is "**empty diff except this list**". If the list grows
  beyond formatting details, the criterion is NOT met and the divergence is a real one.
- **Where the Python spec and the Python CODE disagree — the nested 404/409 bodies on
  init-tracking — the GO CODE must match the Python CODE, and the difference from the
  Python spec must be an entry in that allowlist**, not a change to the Go handler.

The seven routes the document must describe (the Python `CLAUDE.md` currently lists five —
that debt is settled in Wave 4):

| Method | Path | Auth | Declared failures |
|---|---|---|---|
| GET | `/v1/health` | none | — |
| POST | `/v1/trackings/init-tracking` | `x-user-id` | 401, 404, 409, 422 |
| GET | `/v1/trackings` | `x-user-id` | 400, 401, 422 |
| GET | `/v1/trackings/{order_id}` | `x-user-id` | 401, 404 |
| PUT | `/v1/trackings/{order_id}/status` | `x-api-key` (carrier) | 400, 401, 404 |
| DELETE | `/v1/trackings/by-user` | `x-api-key` (internal) | 401, 422, 500 |
| DELETE | `/v1/trackings/e2e-cleanup` | none, flag-guarded | — |

**Steps:**

- [ ] **Step 1: Write the failing test**

`internal/openapi/spec_test.go`:

```go
package openapi_test

import (
	"os"
	"path/filepath"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/openapi"
)

// pythonSpec is the committed contract the Go service must reproduce.
const pythonSpecPath = "../../../tracking/openapi.yaml"

func loadYAML(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return doc
}

func TestSpecRunsWithoutADatabase(t *testing.T) {
	// No fixture, no TRACKING_DATABASE_URL, no skip. The document is a
	// routing-table fact and this test must run in every suite.
	if got := openapi.BuildSpec(); len(got) == 0 {
		t.Fatal("BuildSpec returned an empty document")
	}
}

func TestEveryRouteIsDescribed(t *testing.T) {
	spec := openapi.BuildSpec()
	paths, _ := spec["paths"].(map[string]any)

	want := map[string][]string{
		"/v1/health":                        {"get"},
		"/v1/trackings/init-tracking":       {"post"},
		"/v1/trackings":                     {"get"},
		"/v1/trackings/{order_id}":          {"get"},
		"/v1/trackings/{order_id}/status":   {"put"},
		"/v1/trackings/by-user":             {"delete"},
		"/v1/trackings/e2e-cleanup":         {"delete"},
	}
	for path, methods := range want {
		item, ok := paths[path].(map[string]any)
		if !ok {
			t.Errorf("path %s is absent from the generated document", path)
			continue
		}
		for _, m := range methods {
			if _, ok := item[m]; !ok {
				t.Errorf("%s %s is absent", m, path)
			}
		}
	}
	if len(paths) != len(want) {
		t.Errorf("the document describes %d paths, want %d — a route added without "+
			"a spec entry is an incomplete change", len(paths), len(want))
	}
}

func TestDeclaredFailuresTheFrameworkCannotInfer(t *testing.T) {
	spec := openapi.BuildSpec()
	paths := spec["paths"].(map[string]any)

	cases := []struct {
		path, method string
		codes        []string
	}{
		{"/v1/trackings/init-tracking", "post", []string{"201", "401", "404", "409", "422"}},
		// Both reads shipped without their 401 in the Python service for exactly
		// this reason: it comes from middleware, which no framework can infer.
		{"/v1/trackings", "get", []string{"200", "400", "401", "422"}},
		{"/v1/trackings/{order_id}", "get", []string{"200", "401", "404"}},
		{"/v1/trackings/{order_id}/status", "put", []string{"200", "400", "401", "404"}},
		{"/v1/trackings/by-user", "delete", []string{"200", "401", "422", "500"}},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			op := paths[tc.path].(map[string]any)[tc.method].(map[string]any)
			responses, _ := op["responses"].(map[string]any)
			for _, code := range tc.codes {
				if _, ok := responses[code]; !ok {
					t.Errorf("%s is not declared", code)
				}
			}
		})
	}
}

func TestDiffAgainstThePythonSpecIsEmptyExceptTheAllowlist(t *testing.T) {
	got := openapi.BuildSpec()
	want := loadYAML(t, pythonSpecPath)

	diffs := openapi.Diff(got, want)
	if len(diffs) != 0 {
		for _, d := range diffs {
			t.Errorf("unallowed difference at %s:\n  go:     %v\n  python: %v", d.Path, d.Got, d.Want)
		}
		t.Fatalf("%d differences outside the allowlist — the criterion is an EMPTY "+
			"diff except the enumerated list", len(diffs))
	}
}

func TestTheAllowlistIsClosedAndJustified(t *testing.T) {
	if len(openapi.AllowedDifferences) == 0 {
		t.Skip("no differences allowed yet")
	}
	for _, a := range openapi.AllowedDifferences {
		if a.Justification == "" {
			t.Errorf("allowlist entry %q has no justification", a.Path)
		}
	}
	// A growing allowlist is the signal that the criterion is no longer met.
	// Formatting details only; anything semantic belongs in the code, not here.
	const maxEntries = 12
	if len(openapi.AllowedDifferences) > maxEntries {
		t.Fatalf("the allowlist has %d entries — beyond formatting details, which "+
			"means the criterion is NOT met", len(openapi.AllowedDifferences))
	}
}

func TestTheNestedErrorBodiesAreAnAllowlistEntry(t *testing.T) {
	// The Python CODE emits {"detail": {"detail":…, "reason":…}} for the 404 and
	// 409 on init-tracking; the generated Python SPEC declares them flat because
	// FastAPI cannot express HTTPException's wrapping. The Go code matches the
	// CODE, so the spec difference must be recorded rather than "fixed".
	wantPaths := []string{
		"paths./v1/trackings/init-tracking.post.responses.404.content.application/json.schema",
		"paths./v1/trackings/init-tracking.post.responses.409.content.application/json.schema",
	}
	for _, p := range wantPaths {
		found := false
		for _, a := range openapi.AllowedDifferences {
			if a.Path == p {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%s is not in the allowlist — the Python spec is wrong here and "+
				"the Python code is right; the difference must be RECORDED", p)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/tracking-go && goenv local 1.25.14
go test ./internal/openapi/... -v
```

Expect `undefined: openapi.BuildSpec`. Verify the suite runs with `TRACKING_DATABASE_URL`
unset and does not skip:

```bash
env -u TRACKING_DATABASE_URL go test ./internal/openapi/... -v
```

- [ ] **Step 3: Write minimal implementation**

`internal/openapi/spec.go` builds the document as literal Go data. Every operation
declares its responses by hand, including the ones no framework can infer:

```go
// BuildSpec returns the OpenAPI document the routes describe.
//
// Written by hand rather than reflected off gin's route tree, and deliberately:
// gin knows the method and the path template and NOTHING about status codes,
// bodies or auth. The failures that matter here — the 401s raised by middleware,
// the 404/409 raised inside a handler, the 400s from the state machine — are
// exactly the ones no framework can see. In the Python service they appear only
// because each route declares them in `responses=`, and BOTH user-scoped reads
// shipped without their 401 for precisely that reason.
//
// So this file IS the declaration, and spec_test.go enumerates the route table
// against it. A route added without an entry here fails that test.
func BuildSpec() map[string]any {
	return map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":   "Tracking Service",
			"version": "1.0.0",
		},
		"paths": map[string]any{
			"/v1/trackings/init-tracking": map[string]any{
				"post": map[string]any{
					"tags":    []any{"trackings"},
					"summary": "Create the tracking for one of the caller's orders",
					"responses": map[string]any{
						"201": jsonResponse("Successful Response", ref("InitTrackingResponse")),
						"401": description("Missing or empty x-user-id"),
						// NESTED body — the Python CODE's shape, not its spec's.
						"404": jsonResponse("Users has no such user", ref("NestedErrorResponse")),
						"409": jsonResponse("The order already has a tracking", ref("NestedErrorResponse")),
						"422": jsonResponse("Validation Error", ref("HTTPValidationError")),
					},
					// ... requestBody etc.
				},
			},
			// ... the other six
		},
		"components": map[string]any{"schemas": schemas()},
	}
}
```

`ref`, `jsonResponse` and `description` are small local helpers in the same file —
the document is mostly repetition, and naming the repetition is what keeps the seven
route entries readable enough to audit against the table above.

`internal/openapi/allowlist.go`:

```go
package openapi

// AllowedDifferences is CLOSED and ENUMERATED. Every entry is a serialization or
// spec-generation artifact, never a behavioural divergence. The acceptance
// criterion for this migration is "an empty diff EXCEPT this list" — so an entry
// added to make a test pass is an entry that has moved the goalposts, and the
// list growing beyond formatting details means the criterion is not met.
var AllowedDifferences = []AllowedDifference{
	{
		Path: "paths./v1/trackings/init-tracking.post.responses.404.content.application/json.schema",
		Justification: "THE PYTHON SPEC IS WRONG AND THE PYTHON CODE IS RIGHT. The " +
			"handler raises HTTPException(detail={\"detail\":…, \"reason\":…}), which " +
			"FastAPI renders as {\"detail\": {\"detail\":…, \"reason\":…}} — nested. " +
			"FastAPI's generator cannot express that wrapping and emits the flat " +
			"ErrorResponse instead. The Go code matches the observable CODE, so this " +
			"difference is recorded rather than reproduced.",
	},
	{
		Path: "paths./v1/trackings/init-tracking.post.responses.409.content.application/json.schema",
		Justification: "Same as the 404 above: the code nests, the generated spec says flat.",
	},
	{
		Path:          "components.schemas.*.required",
		Justification: "Ordering of the `required` array. Pydantic emits field-declaration order; the Go generator sorts. Set semantics, no contract difference.",
	},
	{
		Path:          "components.schemas.InitTrackingRequest.properties.shipping_address",
		Justification: "Pydantic renders `dict[str, Any] | None` as an anyOf with a named null branch; the Go generator emits `type: object, nullable: true`. Same accepted values.",
	},
	{
		Path:          "components.schemas.*.title",
		Justification: "Pydantic auto-titles every schema and property from the field name. Cosmetic; no consumer branches on a title.",
	},
}
```

`internal/openapi/spec_diff.go` walks both trees, normalises the allowlisted paths
(supporting a trailing `*` segment wildcard), and returns what remains.

`cmd/genopenapi/main.go` marshals `BuildSpec()` to `services/tracking-go/openapi.yaml`.
Like the Python's, this is a **committed build artifact**: any route, schema or status
code change must regenerate and commit it in the SAME change.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/tracking-go && goenv local 1.25.14
go run ./cmd/genopenapi
gofmt -s -w . && golangci-lint run
env -u TRACKING_DATABASE_URL go test ./internal/openapi/... -v
```

Read the diff output. A green run here means: seven routes described, every
framework-invisible failure declared, and every remaining difference from the Python spec
justified in the allowlist.

- [ ] **Step 5: Commit**

Leave in the working tree. Report:
`feat(tracking): generate the Go openapi.yaml and pin it against the Python contract`.

---

## Wave 2.5 — TestMode

Runs ALONE, after Wave 2 is merged. It consumes Task 19's `ProgressionHook` and Task 21's
`UpdateStatus`, so it cannot start until both exist.

### Task 24: TestMode automatic progression

**Files:**
- Create: `services/tracking-go/internal/app/progression.go`
- Create: `services/tracking-go/internal/app/progression_test.go`
- Create: `services/tracking-go/internal/adapter/http/progression_hook.go`
- Modify: `services/tracking-go/cmd/server/main.go`

**Interfaces:**

Consumes:

```go
// UnscopedTrackingReader is the progression's own read port. Explicitly UNSCOPED:
// there is no caller to scope by, and the order id came from a tracking this
// process just created rather than from a request. A SEPARATE METHOD from the
// reads' GetByOrderIDScoped, never the same one with an empty argument.
type UnscopedTrackingReader interface {
	GetByOrderID(ctx context.Context, orderID string) (domain.Tracking, error)
}

// Transitioner is Task 21's UpdateStatus, consumed as an interface so the
// progression cannot grow a second transition path.
type Transitioner interface {
	Execute(ctx context.Context, orderID string, requested domain.Status, actor audit.Actor) (domain.TrackingWithHistory, error)
}
```

Produces:

```go
package app

const DefaultProgressionInterval = 10 * time.Second

type Progression struct { ... }

// NewProgression takes the PROCESS lifetime context, not a request context.
func NewProgression(base context.Context, reader UnscopedTrackingReader, transitioner Transitioner, interval time.Duration, log *slog.Logger, tracer trace.Tracer) *Progression

// Start launches a run for orderID and returns immediately.
func (p *Progression) Start(orderID string)

// Run executes the whole progression synchronously. Exported so tests drive it
// without a goroutine and without sleeping.
func (p *Progression) Run(ctx context.Context, orderID string)

// Wait blocks until every in-flight run has ended or ctx is done. Used by
// graceful shutdown so the process does not exit leaving goroutines mid-flight
// without at least logging it.
func (p *Progression) Wait(ctx context.Context)
```

**Contract:**

- Sequence: created at **PLACED by creation itself** (not by the progression), then
  PROCESSING, SHIPPED, OUT_FOR_DELIVERY, DELIVERED — one step every interval. Result:
  **5 history rows, 4 events**. The event count is one less than the status count, and
  that gap is where assertions go wrong: creation never emits, so a test asserting
  one-event-per-status waits forever for a message the system never sends, and "got 4 of
  5" reads exactly like a dropped message rather than a wrong expectation.
- Interval: default **10s**, **INJECTABLE** — production 10s; tests pass ~0 so the suite
  never sleeps 40 seconds. A test that actually waited would be skipped or deleted, and
  either way the feature would stop being covered.
- Each transition **opens its OWN database session/transaction** (the creating request's
  is long gone) and **reuses the SAME transition function as the carrier PUT**, differing
  ONLY in the actor, which is `tracking_api:test_mode_progression`. **NEVER write a
  parallel transition path.**
- The read inside the progression is **UNSCOPED** (no `cognito_sub`, no `user_id`) — use
  the unscoped port method explicitly.
- **THE CENTRAL BUG THIS TASK EXISTS TO AVOID:** the goroutine **MUST NOT inherit the
  request's `context.Context`**, which Go cancels when the response is sent. It needs its
  own context derived from the PROCESS lifetime context. A faithful line-by-line port
  would produce a goroutine that dies at the first transition — and **the symptom would
  be identical to the already-accepted, already-documented restart limitation ("frozen
  after a restart"), so it would disguise itself as a known limitation and nobody would
  investigate.** Write a test that proves the goroutine survives the request's context
  being cancelled.
- Start it only **AFTER the creating transaction has committed**. Starting it inline
  races the commit; the progression's own fresh session would see no tracking and the run
  would end immediately at PLACED. (Verified in the Python service, not theoretical.)
- **Clean endings** — never retried, never propagated out of the goroutine: reaching
  DELIVERED; the tracking having been deleted; a rejected transition because a carrier PUT
  moved it first (log the guard's reason); context cancellation at shutdown. Retrying a
  rejected forward-only transition can only be rejected again, forever.
- Any other error: log `reason=unexpected_error` and end the run.
- **ONE span for the whole run, opened INSIDE the goroutine** (a span opened around the
  spawn would end before the work starts — OTel's context is a `context.Context` value
  and the spawn returns immediately). It is a **ROOT span**: the creating request's span
  is already closed by the time a background run starts, and that is correct — the
  progression is a 40-second fixture with its own lifetime, not part of the POST that
  scheduled it. Each tick adds a **span EVENT**, not a child span.
- **Graceful shutdown:** the process must not exit leaving goroutines mid-flight without
  at least logging it.
- **KNOWN LIMITATION, ACCEPTED, DO NOT "FIX":** a process restart mid-progression loses
  the goroutine and the tracking freezes at whatever status it reached, with no recovery,
  no retry and nothing logged. This is acceptable because TestMode is a 40-second E2E
  fixture: nothing downstream depends on it completing, and real carrier updates arrive
  through the persistent PUT endpoint. **Do NOT add a durable scheduler** (no
  cron table, no outbox, no poller, no queue).

**Steps:**

- [ ] **Step 1: Write the failing test**

`internal/app/progression_test.go`:

```go
package app_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// fakeTransitioner advances an in-memory status the way UpdateStatus would, and
// records the actor it was called with.
type fakeTransitioner struct {
	mu      sync.Mutex
	status  domain.Status
	actors  []audit.Actor
	calls   int
	failWith error
}

func (f *fakeTransitioner) Execute(_ context.Context, _ string, requested domain.Status, actor audit.Actor) (domain.TrackingWithHistory, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.actors = append(f.actors, actor)
	if f.failWith != nil {
		return domain.TrackingWithHistory{}, f.failWith
	}
	f.status = requested
	return domain.TrackingWithHistory{Tracking: domain.Tracking{Status: requested}}, nil
}

func (f *fakeTransitioner) Status() domain.Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.status
}

type fakeUnscopedReader struct {
	t   *fakeTransitioner
	err error
	// sawScope records whether anything ever passed an identity in. It must stay
	// false: the progression's read is unscoped by design.
	gone bool
}

func (r *fakeUnscopedReader) GetByOrderID(_ context.Context, orderID string) (domain.Tracking, error) {
	if r.gone {
		return domain.Tracking{}, domain.ErrTrackingNotFound
	}
	if r.err != nil {
		return domain.Tracking{}, r.err
	}
	return domain.Tracking{OrderID: orderID, Status: r.t.Status()}, nil
}

func TestProgression(t *testing.T) {
	// ~0 interval so the suite never sleeps 40 seconds.
	const fast = time.Millisecond

	t.Run("PLACED to DELIVERED is FOUR transitions, not five", func(t *testing.T) {
		tr := &fakeTransitioner{status: domain.StatusPlaced}
		p := app.NewProgression(context.Background(), &fakeUnscopedReader{t: tr}, tr,
			fast, testLogger(t), noopTracer())

		p.Run(context.Background(), "ord_1")

		if got := tr.Status(); got != domain.StatusDelivered {
			t.Fatalf("final status = %q, want DELIVERED", got)
		}
		if tr.calls != 4 {
			t.Fatalf("transitions = %d, want 4 — creation writes PLACED itself, so "+
				"the run leaves 5 history rows and sends 4 events", tr.calls)
		}
	})

	t.Run("every transition carries the test-mode actor", func(t *testing.T) {
		tr := &fakeTransitioner{status: domain.StatusPlaced}
		p := app.NewProgression(context.Background(), &fakeUnscopedReader{t: tr}, tr,
			fast, testLogger(t), noopTracer())
		p.Run(context.Background(), "ord_1")

		for i, a := range tr.actors {
			if a != audit.TestModeProgression {
				t.Errorf("transition %d actor = %q, want tracking_api:test_mode_progression "+
					"(the ONLY difference from the carrier path)", i, a)
			}
		}
	})

	// THE CENTRAL TEST. A faithful line-by-line port of the Python would give the
	// goroutine the request's context, which Go cancels the moment the response is
	// sent — and the run would die at the first transition. The symptom is
	// identical to the accepted restart limitation ("frozen after a restart"), so
	// the bug would disguise itself as a known limitation and nobody would look.
	t.Run("the run SURVIVES the request context being cancelled", func(t *testing.T) {
		tr := &fakeTransitioner{status: domain.StatusPlaced}
		p := app.NewProgression(context.Background(), &fakeUnscopedReader{t: tr}, tr,
			fast, testLogger(t), noopTracer())

		requestCtx, cancel := context.WithCancel(context.Background())
		p.Start("ord_1")
		// Exactly what net/http does when the handler returns.
		cancel()
		_ = requestCtx

		done := make(chan struct{})
		go func() { p.Wait(context.Background()); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("the run never finished")
		}

		if got := tr.Status(); got != domain.StatusDelivered {
			t.Fatalf("final status = %q, want DELIVERED — the goroutine inherited the "+
				"request's context and died when the response was sent", got)
		}
	})

	t.Run("a deleted tracking ends the run cleanly", func(t *testing.T) {
		tr := &fakeTransitioner{status: domain.StatusPlaced}
		reader := &fakeUnscopedReader{t: tr, gone: true}
		p := app.NewProgression(context.Background(), reader, tr, fast, testLogger(t), noopTracer())

		p.Run(context.Background(), "ord_gone") // must return, not panic, not hang
		if tr.calls != 0 {
			t.Errorf("transitions = %d, want 0", tr.calls)
		}
	})

	t.Run("a carrier PUT moving it first ends the run, logging the guard's reason", func(t *testing.T) {
		tr := &fakeTransitioner{
			status:   domain.StatusPlaced,
			failWith: &domain.InvalidTransitionError{Reason: "not_strictly_forward"},
		}
		logs := testLogger(t)
		p := app.NewProgression(context.Background(), &fakeUnscopedReader{t: tr}, tr, fast, logs, noopTracer())

		p.Run(context.Background(), "ord_1")

		if tr.calls != 1 {
			t.Fatalf("transitions = %d, want 1 — a rejected forward-only transition "+
				"must NEVER be retried; retrying can only be rejected again, forever", tr.calls)
		}
		if !logs.Has("reason", "not_strictly_forward") {
			t.Error("the guard's own reason must be logged")
		}
	})

	t.Run("an unexpected error ends the run with reason=unexpected_error", func(t *testing.T) {
		tr := &fakeTransitioner{status: domain.StatusPlaced, failWith: errors.New("boom")}
		logs := testLogger(t)
		p := app.NewProgression(context.Background(), &fakeUnscopedReader{t: tr}, tr, fast, logs, noopTracer())

		p.Run(context.Background(), "ord_1")
		if !logs.Has("reason", "unexpected_error") {
			t.Error("an unexpected error must be logged with reason=unexpected_error")
		}
	})

	t.Run("shutdown cancels the run and logs it", func(t *testing.T) {
		tr := &fakeTransitioner{status: domain.StatusPlaced}
		base, shutdown := context.WithCancel(context.Background())
		p := app.NewProgression(base, &fakeUnscopedReader{t: tr}, tr,
			500*time.Millisecond, testLogger(t), noopTracer())

		p.Start("ord_1")
		shutdown()

		done := make(chan struct{})
		go func() { p.Wait(context.Background()); close(done) }()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("Wait did not return after shutdown — the process would exit " +
				"leaving goroutines mid-flight")
		}
	})

	t.Run("ONE root span for the run, one EVENT per tick", func(t *testing.T) {
		tr := &fakeTransitioner{status: domain.StatusPlaced}
		rec := newRecordingTracer()
		p := app.NewProgression(context.Background(), &fakeUnscopedReader{t: tr}, tr, fast, testLogger(t), rec)

		p.Run(context.Background(), "ord_1")

		if n := rec.SpanCount(); n != 1 {
			t.Fatalf("spans = %d, want exactly 1 for the whole run", n)
		}
		span := rec.Span(0)
		if span.ParentSpanID().IsValid() {
			t.Error("the run's span must be a ROOT — the creating request's span is " +
				"already closed by the time a background run starts")
		}
		if n := len(span.Events()); n != 4 {
			t.Errorf("span events = %d, want 4 — each tick adds an EVENT, not a child span", n)
		}
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/tracking-go && goenv local 1.25.14
go test ./internal/app/... -run Progression -v
```

Expect `undefined: app.NewProgression`.

- [ ] **Step 3: Write minimal implementation**

`internal/app/progression.go`:

```go
package app

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// DefaultProgressionInterval is the design's cadence: t=10s PROCESSING, t=20s
// SHIPPED, t=30s OUT_FOR_DELIVERY, t=40s DELIVERED. Tests inject ~0 rather than
// patching this, so the suite runs in milliseconds while production keeps the
// real cadence — a test that actually waited 40 seconds would be skipped or
// deleted, and either way the feature would stop being covered.
const DefaultProgressionInterval = 10 * time.Second

// UnscopedTrackingReader is the progression's read port, and it is EXPLICITLY
// unscoped: there is no caller to scope by, and the order id came from a tracking
// this process just created rather than from a request. A separate METHOD from
// the reads' GetByOrderIDScoped — never the same method with an empty argument,
// because Go's zero value for string is "" and that silently means "scoped to the
// empty string".
type UnscopedTrackingReader interface {
	GetByOrderID(ctx context.Context, orderID string) (domain.Tracking, error)
}

// Transitioner is Task 21's UpdateStatus. Consumed as an interface so the
// progression physically cannot grow a second transition path: the state
// machine's guards, the history row, the datetime bump and the history re-read
// all live there, and a second copy is how the two would start disagreeing about
// what a transition means.
type Transitioner interface {
	Execute(ctx context.Context, orderID string, requested domain.Status, actor audit.Actor) (domain.TrackingWithHistory, error)
}

// Progression drives TestMode runs.
//
// !! KNOWN LIMITATION, EXPLICITLY ACCEPTED — DO NOT "FIX" !!
//
// These are in-process goroutines, chosen deliberately over a durable scheduler.
// If the process restarts mid-run — a rebuild, a redeploy, a crash, a container
// reschedule — the goroutine is LOST and the tracking stays frozen at whatever
// status it reached, forever. Nothing retries it, nothing resumes it, and no
// error is reported anywhere. A tracking stuck at PROCESSING after a rebuild is
// EXPECTED, not a bug to investigate; recover by creating a new TestMode tracking
// or by driving the remaining transitions through PUT /v1/trackings/{id}/status.
//
// This is acceptable because TestMode is a 40-second E2E fixture: nothing
// downstream depends on it completing, and real carrier updates arrive through
// the PUT endpoint, which is persistent. Paying for a durable scheduler — a new
// dependency, a new table, a poller, its own failure modes — to make a 40-second
// test fixture restart-proof is not a trade this service wants.
type Progression struct {
	// base is the PROCESS lifetime context, never a request context. See Start.
	base         context.Context
	reader       UnscopedTrackingReader
	transitioner Transitioner
	interval     time.Duration
	log          *slog.Logger
	tracer       trace.Tracer
	wg           sync.WaitGroup
}

func NewProgression(base context.Context, reader UnscopedTrackingReader, transitioner Transitioner, interval time.Duration, log *slog.Logger, tracer trace.Tracer) *Progression {
	if interval <= 0 {
		interval = DefaultProgressionInterval
	}
	return &Progression{
		base: base, reader: reader, transitioner: transitioner,
		interval: interval, log: log, tracer: tracer,
	}
}

// Start launches a run and returns immediately.
//
// THE CONTEXT IS THE WHOLE POINT OF THIS METHOD.
//
// The goroutine derives its context from p.base — the PROCESS lifetime context —
// and NEVER from the request's. net/http cancels a request's context the instant
// the response is written, so a goroutine that inherited it would die at the
// first transition. And the symptom would be indistinguishable from the accepted
// restart limitation above: "the tracking froze partway through". The bug would
// disguise itself as a known limitation, and nobody would investigate.
//
// The caller invokes this only AFTER the creating transaction has committed.
// Starting it any earlier races the commit and the progression always loses: its
// first read opens a fresh session, sees no tracking, and the run ends
// immediately at PLACED.
func (p *Progression) Start(orderID string) {
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		p.Run(p.base, orderID)
	}()
}

// Wait blocks until every in-flight run has ended, or until ctx is done. Called
// from graceful shutdown so the process does not exit leaving goroutines
// mid-flight without at least logging it.
func (p *Progression) Wait(ctx context.Context) {
	done := make(chan struct{})
	go func() { p.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		p.log.Warn("test_mode_progression_shutdown_incomplete",
			slog.String("app_event", "test_mode_progression_shutdown_incomplete"),
			slog.String("reason", "shutdown_deadline"))
	}
}

// Run executes the whole progression. Exported so tests drive it synchronously.
//
// Nothing escapes: every ending is explicit and logged. A background goroutine
// that panicked or returned an error nobody reads would surface as nothing at
// all, detached from the request that caused it.
func (p *Progression) Run(ctx context.Context, orderID string) {
	// ONE span for the whole run, not one per tick, and opened INSIDE the
	// goroutine. A span opened around the spawn would end the moment Start
	// returned — long before the first tick — recording a 40-second workflow as a
	// microsecond of scheduling.
	//
	// It is a ROOT span: the creating request's span is closed by the time a
	// background run starts. That is correct — the progression is a fixture with
	// its own lifetime, not a part of the POST that scheduled it.
	ctx, span := p.tracer.Start(ctx, "test_mode_progression", trace.WithNewRoot())
	defer span.End()
	span.SetAttributes(
		attribute.String("app_event", "test_mode_progression_started"),
		attribute.String("order_id", orderID),
		attribute.Float64("interval_seconds", p.interval.Seconds()))

	p.log.InfoContext(ctx, "test_mode_progression_started",
		slog.String("app_event", "test_mode_progression_started"),
		slog.String("order_id", orderID),
		slog.Float64("interval_seconds", p.interval.Seconds()))

	defer func() {
		if r := recover(); r != nil {
			// A TestMode fixture must not be able to take the process down.
			p.finish(span, orderID, "unexpected_error")
		}
	}()

	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			// Shutdown. The tracking simply stays where it is — see the KNOWN
			// LIMITATION on the type.
			p.finish(span, orderID, "cancelled")
			return
		case <-ticker.C:
		}

		status, done, reason := p.advanceOnce(ctx, orderID)
		if done {
			if reason != "" {
				p.finish(span, orderID, reason)
			} else {
				span.SetAttributes(attribute.String("app_event", "test_mode_progression_succeeded"))
				p.log.InfoContext(ctx, "test_mode_progression_succeeded",
					slog.String("app_event", "test_mode_progression_succeeded"),
					slog.String("order_id", orderID))
			}
			return
		}

		// A span EVENT per tick, not a child span: it marks when each transition
		// landed inside the one workflow span, which is what the *_advanced log
		// line already says.
		span.AddEvent("test_mode_progression_advanced",
			trace.WithAttributes(attribute.String("status", string(status))))
		p.log.InfoContext(ctx, "test_mode_progression_advanced",
			slog.String("app_event", "test_mode_progression_advanced"),
			slog.String("order_id", orderID),
			slog.String("status", string(status)))
	}
}

// advanceOnce moves the tracking by exactly one status.
//
// done=true means STOP, and it covers every reason a run should end. The caller
// does not need to distinguish them, which is what keeps Run simple.
func (p *Progression) advanceOnce(ctx context.Context, orderID string) (status domain.Status, done bool, reason string) {
	// Each step opens its own session through the adapter: the creating request's
	// was committed and closed long before the first tick, and holding one open
	// across 40 seconds of ticking would pin a pooled connection for the run.
	tracking, err := p.reader.GetByOrderID(ctx, orderID)
	if errors.Is(err, domain.ErrTrackingNotFound) {
		// Soft-deleted (or never there) between two ticks. Not an error: the
		// progression is a fixture and the row it animated is gone.
		return "", true, "tracking_not_found"
	}
	if err != nil {
		return "", true, "unexpected_error"
	}

	next, ok := domain.NextStatus(tracking.Status)
	if !ok {
		// Already terminal — this run finished, or a carrier PUT delivered it
		// first. Either way there is nothing left to do. The clean ending.
		return "", true, ""
	}

	// The SAME function the carrier PUT calls. Only the actor differs.
	if _, err := p.transitioner.Execute(ctx, orderID, next, audit.TestModeProgression); err != nil {
		var invalid *domain.InvalidTransitionError
		if errors.As(err, &invalid) {
			// Something else moved it while this run was sleeping. The state
			// machine is the authority; the progression yields and stops. It does
			// NOT retry: retrying a rejected forward-only transition can only be
			// rejected again, forever.
			return "", true, invalid.Reason
		}
		if errors.Is(err, domain.ErrTrackingNotFound) {
			return "", true, "tracking_not_found"
		}
		return "", true, "unexpected_error"
	}
	return next, false, ""
}

// finish records a non-success ending. Swallowed rather than propagated: the run
// ENDS, it does not fail anything.
func (p *Progression) finish(span trace.Span, orderID, reason string) {
	span.SetAttributes(
		attribute.String("app_event", "test_mode_progression_failed"),
		attribute.String("reason", reason))
	p.log.Info("test_mode_progression_failed",
		slog.String("app_event", "test_mode_progression_failed"),
		slog.String("reason", reason),
		slog.String("order_id", orderID))
}
```

`internal/adapter/http/progression_hook.go` adapts `*app.Progression` to Task 19's
`ProgressionHook` interface (a one-method wrapper), and `cmd/server/main.go` replaces
`NoopProgression{}` with it, passing the process context and calling `Wait` from the
graceful-shutdown path:

```go
	// The PROCESS context, not any request's.
	progression := app.NewProgression(rootCtx, trackingRepo, updateStatus,
		cfg.ProgressionInterval, logger, tracer)
	initTracking := adapterhttp.NewInitTrackingHandler(createTracking, progression, logger, tracer)

	// ... on shutdown, after srv.Shutdown:
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	progression.Wait(shutdownCtx)
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/tracking-go && goenv local 1.25.14
gofmt -s -w . && go vet ./... && golangci-lint run
go test ./internal/app/... -run Progression -v -race
```

`-race` is not optional here: this is the only concurrent code in the service.

Then an end-to-end check against the real stack, with the production interval:

```bash
# create a TestMode tracking and confirm 5 history rows and 4 events after ~45s
curl -s -XPOST localhost:8001/v1/trackings/init-tracking \
  -H 'x-user-id: <sub>' -H 'x-test-mode: true' -H 'content-type: application/json' \
  -d '{"order_id":"ord_testmode_1"}'
sleep 45
curl -s localhost:8001/v1/trackings/ord_testmode_1 -H 'x-user-id: <sub>' | jq '.status, (.history|length)'
# expect "DELIVERED" and 5
```

- [ ] **Step 5: Commit**

Leave in the working tree. Report:
`feat(tracking): port TestMode progression to Go with a process-lifetime context`.

---

## Wave 3 — Verification

THREE parallel tasks. None of them writes service source code: their job is to prove the
Go service is equivalent, and a test edited to accommodate Go proves nothing.

### Task 25: the three test layers

**Files:**
- Create: `services/tracking-go/internal/adapter/mysql/suite_test.go` (shared MySQL fixture)
- Modify: `docker-compose.yml` (add the `tracking-go` service)
- Modify: `infra/modules/compute/nginx/nginx.conf` (the one-line backend switch)
- Read-only, MUST NOT BE EDITED: `e2e/tests/tracking.spec.ts`,
  `e2e/tests/gateway/tracking.spec.ts`, `e2e/tests/gateway/tracking-flow.spec.ts`,
  `e2e/tests/gateway/realtime-tracking.spec.ts`
- Create: `e2e/.env.tracking-go` (or the equivalent local override naming the Go port)

**Interfaces:** none — this task produces configuration and test runs, not Go API surface.

**Contract:**

Three layers, all three required:

1. **Go unit/integration against a REAL MySQL.** Never mocks: mocked tests pass while the
   real schema or driver rejects the statement, which is a recorded lesson in this repo.
   The suite runs against the same local `tracking` database the service uses, so its
   teardown is load-bearing for everyone else's environment — drop at SETUP for a clean
   shape, and leave the schema in place at teardown. Never drop tables at teardown: the
   Python suite did, which left the local stack with no tracking tables, made
   `init-tracking` answer 500 and pointed the symptom at the feature under test.
2. **Internal E2E against the Go service URL** — `e2e/tests/tracking.spec.ts`, pointed at
   the Go port.
3. **Gateway E2E with a real Cognito JWT** — the URL the user actually hits. In-process
   and internal tests fake the authorizer and never touch the gateway, so they miss
   gateway-only bugs: a missing route, a dropped path param, a method mismatch.

**THE EXISTING GATEWAY SPECS MUST NOT BE EDITED.** If the same files that pass against
Python pass against Go unedited, the contract is equivalent. **A spec modified to
accommodate Go INVALIDATES the criterion** — it converts the test from evidence into
decoration. If a spec fails, the Go service is wrong; fix the service.

Diagnostic for a gateway 404: a body carrying the gateway's own `{"message":"Not Found"}`
rather than the service's `{"detail": …}` shape means the request never reached the
service. After a routing fix, a **401 is the good answer** — it proves the route resolves
and reached the authorizer.

**Steps:**

- [ ] **Step 1: Write the failing test**

Add the compose entry and the gateway switch, then run the untouched specs — they will
fail while nothing serves the Go port.

`docker-compose.yml`, beside the existing `tracking` service:

```yaml
  # The Go port of Tracking, running BESIDE the Python service on its own port so
  # both can be exercised against the same database and the same load, and so the
  # gateway can be switched between them with one line (see nginx.conf).
  #
  # Build context is ./services/tracking-go — not the repo root.
  tracking-go:
    build: ./services/tracking-go
    ports:
      # 8001 externally; the process listens on 8000 inside, like its Python peer.
      - "8001:8000"
    env_file:
      # The SAME generated env file as the Python service: same database, same
      # Redis, same queue, same Cognito. A separate file would let the two drift
      # and make the comparison meaningless.
      - .env.local.tracking
    networks:
      - 3mrai-network
    depends_on:
      floci:
        condition: service_healthy
    logging:
      driver: awslogs
      options:
        tag: "tracking-go"
```

`infra/modules/compute/nginx/nginx.conf` — the ONE line, inside the existing
`location /v1/trackings` block:

```nginx
    location /v1/trackings {
      # THE SWITCH. `tracking` = the Python service, `tracking-go` = the Go port.
      # Change this one word and re-apply to move every functional route between
      # implementations. TO REVERT: set it back to `tracking`, re-apply, done —
      # both containers stay up, so there is nothing to rebuild.
      set $backend tracking-go;
```

and the same one-word change in the `location = /v1/tracking/health` block, so the health
probe follows the functional routes rather than reporting on the container that is no
longer serving traffic.

Reverting is symmetric and takes one apply:

```bash
# switch to Go
sed -i '' 's/set \$backend tracking;/set $backend tracking-go;/' infra/modules/compute/nginx/nginx.conf
make apply-compute        # or the project's nginx-reload target
# revert to Python
sed -i '' 's/set \$backend tracking-go;/set $backend tracking;/' infra/modules/compute/nginx/nginx.conf
make apply-compute
```

- [ ] **Step 2: Run test to verify it fails**

```bash
# Layer 1 — Go integration, real MySQL
cd services/tracking-go && goenv local 1.25.14
TRACKING_DATABASE_URL="$TRACKING_DATABASE_URL" go test ./... -v

# Layer 2 — internal E2E against the GO port, spec UNEDITED
cd ../../e2e && nvm use
TRACKING_BASE_URL=http://localhost:8001 pnpm exec playwright test tests/tracking.spec.ts

# Layer 3 — gateway E2E with a real Cognito JWT, specs UNEDITED
pnpm exec playwright test tests/gateway/tracking.spec.ts \
  tests/gateway/tracking-flow.spec.ts tests/gateway/realtime-tracking.spec.ts
```

Before the compose entry exists, layers 2 and 3 fail with a connection error. That is the
expected first failure.

- [ ] **Step 3: Write minimal implementation**

Bring the Go service up, flip the gateway, and fix the GO SERVICE for every failure —
never the specs.

```bash
docker compose up -d --build tracking-go
docker compose logs -f tracking-go   # confirm it is serving before flipping nginx
```

Work the failures in this order, because each unblocks the next:

1. **Gateway 404 with `{"message":"Not Found"}`** — the route never reached the service.
   Check `infra/modules/api-gateway/main.tf`'s route map and the nginx `location` block.
   A new top-level path without a `location` block falls through to `location /` and
   silently reaches **Users**, not Tracking.
2. **401 where a 200 was expected** — the route resolves and reached the authorizer.
   Good news; check header propagation (`x-user-id` from `$jwt_sub`).
3. **Shape mismatches** — compare the response byte-for-byte against the Python service
   on the same fixture. `curl` both ports with the same request and `diff` the bodies.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd services/tracking-go && TRACKING_DATABASE_URL="$TRACKING_DATABASE_URL" go test ./... -race
cd ../../e2e && nvm use
TRACKING_BASE_URL=http://localhost:8001 pnpm exec playwright test tests/tracking.spec.ts
pnpm exec playwright test tests/gateway/
git diff --stat -- e2e/tests/   # MUST be empty
```

That last command is the acceptance criterion for this task: **a non-empty diff under
`e2e/tests/` means the criterion was not met**, regardless of how green the run is.

- [ ] **Step 5: Commit**

Leave in the working tree. Report: `test(tracking): run all three layers against the Go service`.

---

### Task 26: performance comparison

**Files:**
- Modify: `e2e/load-tests/src/scenarios/tracking.ts` — ONLY if a base-URL parameter is
  needed; the scenario logic itself must not change
- Read-only: `e2e/load-tests/src/fullJourney.gatling.ts`, `e2e/load-tests/src/cacheAB.gatling.ts`
- Create: the vault note (routed through `obsidian-vault`, never written directly)

**Interfaces:** none.

**Contract:**

- Run the **EXISTING** Gatling simulations against both services — **same hardware, same
  database, same load**. Anything else makes the numbers a story rather than a measurement.
- Record: **p50 / p95 / p99, throughput, memory at rest and under load, image size,
  cold-start time**.
- **Record the HONEST number.** If Go does not win on some dimension, that is written down
  too — this is a portfolio data point, not a marketing campaign. A comparison that only
  ever favours the new thing is a comparison nobody should trust, including its author.

The load tests deliberately send **neither** `x-e2e-source` **nor** `x-test-mode`, so
their data persists like real data and deliveries advance only through the carrier
webhook. Do not add those headers to make cleanup easier — that would change what is
being measured.

**Steps:**

- [ ] **Step 1: Write the failing test**

Write the comparison harness as a script that refuses to report until it has both runs:

```bash
# e2e/load-tests/compare.sh equivalent, but as a Python script per this repo's
# scripting convention (Python first for anything non-trivial).
.venv/bin/python infra/scripts/compare_tracking_runtimes.py --dry-run
```

It must fail while either arm is missing, rather than reporting one arm as a result.

- [ ] **Step 2: Run test to verify it fails**

```bash
.venv/bin/python infra/scripts/compare_tracking_runtimes.py --dry-run
# expect: "missing arm: go" (or python) — no numbers printed
```

- [ ] **Step 3: Write minimal implementation**

Run both arms back to back on the same machine, with the database restored to the same
state between them:

```bash
cd e2e/load-tests && nvm use

# Arm A — Python
TRACKING_BASE_URL=http://localhost:8000 pnpm exec gatling run --simulation fullJourney
# restore the database to the same starting state
make migrate-tracking && .venv/bin/python infra/scripts/reset_tracking_fixtures.py

# Arm B — Go
TRACKING_BASE_URL=http://localhost:8001 pnpm exec gatling run --simulation fullJourney

# The cache A/B simulation, both arms
TRACKING_BASE_URL=http://localhost:8000 pnpm exec gatling run --simulation cacheAB
TRACKING_BASE_URL=http://localhost:8001 pnpm exec gatling run --simulation cacheAB
```

Collect the resource figures alongside:

```bash
docker stats --no-stream tracking tracking-go            # memory under load
docker image ls --format '{{.Repository}} {{.Size}}' | grep tracking   # image size
# cold start: time from `docker compose up` to the first 200 on /v1/health
```

- [ ] **Step 4: Run test to verify it passes**

```bash
.venv/bin/python infra/scripts/compare_tracking_runtimes.py --report
```

Then hand the table to `obsidian-vault` for a note under
`docs/domains/tracking/` with `## Related` links to the migration spec, and ask it to link
the note from `docs/00-overview/index.md`. Do not write to `docs/` directly — the vault
has a single writer.

- [ ] **Step 5: Commit**

Leave in the working tree. Report: `docs(tracking): record the Python/Go performance comparison`.

---

### Task 27: observability parity

**Files:**
- Create: `services/tracking-go/internal/adapter/otel/propagation_test.go`
- Modify: `infra/modules/compute/nginx/nginx.conf` — only if `traceparent` is not being
  forwarded
- Create: the vault note recording the verification (routed through `obsidian-vault`)

**Interfaces:** none.

**Contract:**

- Verify in OpenObserve (`localhost:5080`) that **ONE `trace_id` crosses gateway → Go →
  gRPC Users**.
  **KNOWN TRAP:** if the W3C `traceparent` header is not propagated through nginx, the
  result is **TWO disconnected traces, not one broken one** — which looks green unless
  somebody counts. Assert the COUNT of distinct trace ids for a single request is exactly
  1, never "a trace exists".
- Verify the **log context fields**: `trace_id`, `cognito_sub`, `user_id`, `order_id`,
  `tracking_id`, `request_id`, `duration_ms`, with unknown fields OMITTED rather than null.
- Verify **END-TO-END** that a status transition against Go is consumed by the
  events-pipeline Lambda and produces the email. **Inspecting the outgoing JSON is NOT
  enough**: the Lambda validates with Zod, and a shape violation silently consumes the
  record — a `PermanentError` that loses the email AND the WebSocket push with no error
  visible from the producer's side.
- Also verify the **CloudWatch metrics** are published.
- If OpenObserve's trace waterfall returns HTTP 400 (`code 20004`,
  `gen_ai_operation_name`), run `make observability-traces-schema`. That is a known
  quirk of its LLM-tracing feature querying a field this repo never emits — not a bug in
  the Go service.

**Steps:**

- [ ] **Step 1: Write the failing test**

```go
package otel_test

// TestTraceparentSurvivesTheGateway is the counting test. A propagation failure
// produces TWO valid traces rather than one broken one, so asserting "a trace
// exists" passes while the correlation is gone.
func TestTraceparentSurvivesTheGateway(t *testing.T) {
	requireOpenObserve(t)

	// One request through the GATEWAY (not the service port — the gateway is the
	// hop where propagation actually breaks).
	orderID := seedViaGateway(t)

	traceIDs := distinctTraceIDsFor(t, orderID) // queries OpenObserve
	if len(traceIDs) != 1 {
		t.Fatalf("found %d distinct trace ids for one request (%v) — want exactly 1. "+
			"More than one means nginx dropped the W3C traceparent header and the "+
			"gateway span and the service span are two unrelated traces.", len(traceIDs), traceIDs)
	}

	spans := spansFor(t, traceIDs[0])
	wantServices := []string{"gateway", "tracking-go", "users"}
	for _, svc := range wantServices {
		if !hasSpanFrom(spans, svc) {
			t.Errorf("no span from %q in the trace — the chain gateway -> Go -> gRPC "+
				"Users is not complete", svc)
		}
	}
}

func TestLogContextFields(t *testing.T) {
	requireOpenObserve(t)
	orderID := seedViaGateway(t)

	lines := logLinesFor(t, orderID)
	if len(lines) == 0 {
		t.Fatal("no log lines reached OpenObserve")
	}
	for _, want := range []string{"trace_id", "request_id", "order_id", "user_id", "cognito_sub"} {
		if !allLinesHave(lines, want) {
			t.Errorf("%q is missing from at least one line — the context is shared, "+
				"so every line of the request must carry it", want)
		}
	}
	// Unknown fields are OMITTED, never null and never "".
	for _, line := range lines {
		for k, v := range line {
			if v == nil {
				t.Errorf("field %q is null — unknown fields must be omitted", k)
			}
		}
	}
}

// TestTransitionReachesTheInbox is the only assertion that proves the envelope is
// actually valid. Inspecting the outgoing JSON is NOT enough: the Lambda validates
// with Zod, and a shape violation consumes the record silently — the producer sees
// a successful send and the user gets nothing.
func TestTransitionReachesTheInbox(t *testing.T) {
	requireOpenObserve(t)

	orderID := seedViaGateway(t)
	carrierPut(t, orderID, "PROCESSING")

	if !awaitLambdaConsumed(t, orderID, 30*time.Second) {
		t.Fatal("the events-pipeline Lambda never reported consuming the event")
	}
	if !awaitEmailSent(t, orderID, 30*time.Second) {
		t.Fatal("no email was produced — a Zod shape violation consumes the record " +
			"and loses the notification with no error on the producer side")
	}
}

func TestCloudWatchMetricsArePublished(t *testing.T) {
	requireAWS(t)
	before := metricSampleCount(t, "TrackingStatusChanged")
	orderID := seedViaGateway(t)
	carrierPut(t, orderID, "PROCESSING")

	if after := awaitMetricIncrease(t, "TrackingStatusChanged", before, 90*time.Second); !after {
		t.Fatal("no metric sample was published")
	}
}
```

Note on the metric test's window: measure over **2–3× the export cycle**, not one cycle.
A 60s assertion window inside a 60s export cycle has produced a false PASS in this repo
before.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/tracking-go && goenv local 1.25.14
go test ./internal/adapter/otel/... -run 'Traceparent|LogContext|Inbox|CloudWatch' -v
```

Expect the trace test to report 2 distinct trace ids if nginx is not forwarding
`traceparent`.

- [ ] **Step 3: Write minimal implementation**

If the trace count is 2, add the header pass-through to the `/v1/trackings` location:

```nginx
      # W3C trace context. Without these the gateway span and the service span
      # are two unrelated traces — which looks green in OpenObserve unless
      # somebody counts the distinct trace ids for one request.
      proxy_set_header traceparent $http_traceparent;
      proxy_set_header tracestate  $http_tracestate;
```

On the Go side, confirm the propagator is the W3C one and that `otelgrpc`'s client
interceptor is installed on the Users client — the gateway → Go hop and the Go → Users hop
break independently.

- [ ] **Step 4: Run test to verify it passes**

```bash
make observability-traces-schema   # only if the waterfall 400s with code 20004
go test ./internal/adapter/otel/... -run 'Traceparent|LogContext|Inbox|CloudWatch' -v
```

Confirm in the OpenObserve UI that one waterfall shows gateway, `tracking-go` and `users`
spans under a single root.

- [ ] **Step 5: Commit**

Leave in the working tree. Report: `test(tracking): verify observability parity for the Go service`.

---

## Wave 4 — Cutover

### Task 28: delete the Python service

**Do not start this task until all four gate criteria pass.** Deleting the Python folder
is the only irreversible step in this plan, and every one of these is a thing the Go
service either does or does not do:

1. **Contract:** the generated Go `openapi.yaml` diffs empty against the Python one except
   the enumerated allowlist (Task 23).
2. **Behaviour:** all three test layers green, with `git diff --stat -- e2e/tests/` EMPTY
   (Task 25).
3. **Performance:** both arms measured and recorded, honestly (Task 26).
4. **Observability:** one trace id end to end, log fields present, the Lambda consuming
   and emailing, metrics published (Task 27).

**Files:**
- Delete: `services/tracking/` (the whole folder)
- Create: `services/tracking-go/CLAUDE.md` (content moved from `services/tracking/CLAUDE.md`, updated for Go)
- Modify or delete: `.claude/agents/tracking-impl.md`
- Modify: `docker-compose.yml` (remove the Python `tracking` service; rename `tracking-go` to `tracking` and restore port 8000)
- Modify: `infra/modules/compute/nginx/nginx.conf` (the `$backend` value follows the rename)
- Modify: the env-file generator (`make env-file` / its Terraform outputs) — remove the Python service's entry
- Modify: `Makefile` (`migrate-tracking` and any other target invoking the Python image)
- Vault: propagate through `obsidian-vault`

**Interfaces:** none.

**Contract:**

- Move `services/tracking/CLAUDE.md`'s content to `services/tracking-go/CLAUDE.md`,
  updated for Go: the stack section (Gin, sqlc, golang-migrate, `log/slog`), the commands
  section (`go test`, `golangci-lint run`, `go run ./cmd/genopenapi`, the migrate target),
  and the folder structure section (hexagonal, not screaming-architecture-with-DI).
  Everything else — §5a auth surfaces, §5b the two identities, §5c TestMode's accepted
  limitation, §5d the SQS producer rules — is service knowledge that survives the runtime
  change and must be carried over, not rewritten from memory.
- **NOTE: that CLAUDE.md currently documents FIVE routes when there are SEVEN.** It omits
  `DELETE /v1/trackings/by-user` and lists `e2e-cleanup` only in §5a. **The deletion is
  exactly the moment that debt is either paid or inherited** — the new file documents all
  seven, in one table, with each route's auth surface and declared failures.
- **Retire or repoint the `tracking-impl` agent definition** (`.claude/agents/tracking-impl.md`).
  It currently says "FastAPI, Aurora MySQL" and points at `services/tracking/CLAUDE.md`,
  which will not exist. Either delete it, or repoint it at the Go service and rewrite its
  stack line. An agent definition pointing at a deleted path fails silently by reading
  nothing and proceeding on guesses.
- **Remove the Python service from docker-compose and env-file generation.** The
  `tracking-go` entry takes the `tracking` name and port 8000, so nginx and the E2E suite
  need no further change beyond the rename. `.env.local.tracking` keeps its name.
- **Propagate to the vault** through `obsidian-vault`: the migration spec's decisions move
  into `docs/domains/tracking/` (specs, decisions, runbooks), the performance note is
  linked, and each target's `updated:` is bumped. A spec is not done when written — it is
  done when its decisions have propagated. Run `nvm use && node scripts/validate-vault.mjs`
  and confirm green; the propagation gate is a gate, not a suggestion.

**Steps:**

- [ ] **Step 1: Write the failing test**

A gate script that refuses the deletion until all four criteria are demonstrably met:

```python
# infra/scripts/tracking_cutover_gate.py — Python per this repo's scripting convention.
# Exits non-zero, printing WHICH criterion failed, until every one passes.
#
#   1. openapi diff empty except the allowlist
#   2. three test layers green AND `git diff --stat -- e2e/tests/` empty
#   3. the performance note exists in the vault with both arms
#   4. the observability checks green
```

- [ ] **Step 2: Run test to verify it fails**

```bash
.venv/bin/python infra/scripts/tracking_cutover_gate.py
# expect a non-zero exit naming the unmet criterion
```

- [ ] **Step 3: Write minimal implementation**

Only once the gate is green:

```bash
# 1. Move the service memory, updated for Go.
#    (Write the new file BEFORE deleting the old one — it is the source.)
$EDITOR services/tracking-go/CLAUDE.md      # all SEVEN routes

# 2. Retire or repoint the agent.
$EDITOR .claude/agents/tracking-impl.md      # or: git rm

# 3. Compose: drop the Python service, rename the Go one.
$EDITOR docker-compose.yml

# 4. nginx: the $backend value follows the rename.
$EDITOR infra/modules/compute/nginx/nginx.conf

# 5. Makefile + env-file generation.
$EDITOR Makefile

# 6. The irreversible step, last.
git rm -r services/tracking
```

Then route the vault propagation through `obsidian-vault` and validate:

```bash
nvm use && node scripts/validate-vault.mjs
```

- [ ] **Step 4: Run test to verify it passes**

```bash
.venv/bin/python infra/scripts/tracking_cutover_gate.py     # green
docker compose up -d --build tracking
cd e2e && nvm use && pnpm exec playwright test tests/gateway/ tests/tracking.spec.ts
git diff --stat -- e2e/tests/                                # still empty
nvm use && node scripts/validate-vault.mjs                   # green
grep -rn "services/tracking/" --include='*.md' --include='*.yml' --include='*.tf' . | grep -v tracking-go
# expect no hits: nothing may still point at the deleted folder
```

- [ ] **Step 5: Commit**

Leave in the working tree. This one warrants a breaking-change footer. Report:
`refactor(tracking)!: replace the Python service with the Go implementation`.

---

## Waves 2-3 equivalence map

Every Python module under `api/`, `commands/` and `queries/`, with its Go destination and
the tacit rules found in it — the things the code does that no spec states, and that a
line-by-line port would drop.

| Source Python file | Destination Go file(s) | Tacit rules found |
|---|---|---|
| `api/schemas.py` | `internal/adapter/http/response.go` | `datetime` is a STRING (`isoformat()+"Z"`), not a serialized time type — Pydantic would drop the `Z`; a nil moment renders `""`, never `null`; `shipping_address` is absent from EVERY schema deliberately (PII, and the narrowest surface that answers the question is the one that cannot leak it); `TrackingListResponse` is an object not a bare array (a bare array is not extensible and no `total` field is offered, because a count of what came back would start describing what the caller does NOT own); `InitTrackingResponse` reuses `TrackingResponse` so creating and reading return identical bodies; `UpdateStatusRequest.status` is a bare `str` so the 400 stays a 400. |
| `api/errors.py` | `internal/adapter/http/errors.go` | The custom exception + handler exists ONLY so the carrier 400's `reason` is a TOP-LEVEL field (Shape C); `HTTPException(detail={...})` would nest it (Shape B), which is what init-tracking deliberately keeps. The two shapes coexist and must not be unified. |
| `api/health_router.py` | `internal/adapter/http/handler_health.go` (Wave 1) | Served UNPREFIXED at `/v1/health`; the gateway publishes `/v1/tracking/health` and nginx rewrites. A bare `/v1/health` at the GATEWAY falls through nginx's `location /` catch-all to **Users** and returns Users' 200 — a Tracking probe that reports healthy while never reaching Tracking. Does not touch the database: a liveness check, not a readiness one. |
| `api/init_tracking_router.py` | `internal/app/create_tracking.go`, `internal/adapter/http/handler_init_tracking.go` | Identity from the header, NEVER the body (a body `user_id` would be an unauthenticated claim); `extra="forbid"` → `DisallowUnknownFields()` on this route ONLY; an unresolvable sub is 404 not 401/422 (the credential is verified, the lookup failed, and re-authenticating cannot help); `NOT_FOUND` alone maps to 404 — every other gRPC status is a 500, so an outage never reads as "unknown user"; the 404/409 bodies are NESTED and the generated spec disagrees with the code; the TestMode hook fires from the post-response hook, AFTER the commit, because the progression's fresh session would otherwise see no tracking; creation emits NO event. |
| `api/trackings_router.py` | `internal/app/get_my_tracking.go`, `internal/app/list_my_trackings.go`, `internal/adapter/http/handler_reads.go`, `internal/adapter/http/order_ids.go` | Ownership by `cognito_sub`, never `user_id` (the header carries the JWT `sub`); 404 not 403, so the endpoint is not an oracle for other people's order ids; the batch read has no 404 at all; `order_ids` parsing drops blanks and dedupes preserving first-seen order; the 100 cap counts DISTINCT NON-EMPTY ids; an ABSENT parameter is 422 while an over-cap one is 400; `too_many_order_ids` goes to the log and span only; an empty list short-circuits without querying; the cache's BYPASS is distinct from MISS so an outage does not read as a poor hit rate; with the cache off NO header is stamped; neither read logs a success line (the request line already carries route, status and duration, and these are the two most frequent calls the service serves). |
| `api/carrier_router.py` | `internal/adapter/http/handler_carrier.go` | Auth declared at the ROUTER level so a second carrier endpoint is authenticated by default; the router is separate from the reads so it cannot acquire an identity dependency by proximity; identifies the tracking by `order_id` ALONE — reusing the reads' filter would 404 every carrier call and the endpoint would look implemented and never work; invalidation is scheduled AFTER the commit, because clearing the key before the write lands lets a concurrent read repopulate it with the pre-update row for a full TTL; the identities come off the PERSISTED row because the request carries none; passing the entity (rather than plain strings) to post-response work would be a bet on the session still being open. |
| `api/internal_router.py` | `internal/app/delete_by_user.go`, `internal/adapter/http/handler_internal_delete.go` | Registered BEFORE the reads router because `/by-user` is a literal segment where `/{order_id}` also matches; both identities go into the ambient LOG CONTEXT (merge, not set — `set` would drop the `request_id` the whole correlation hangs on); `deleted_count` deliberately stays OFF the context because keys outside the allowlist are silently dropped; the DB-error branch exists because without it the 500 carried no `*_failed`, no reason and no span attribute — the one outcome that most needs to be findable was the only silent one; the error is re-raised untouched so the HTTP contract is unchanged. |
| `api/e2e_router.py` | `internal/app/e2e_cleanup.go`, `internal/adapter/http/handler_e2e_cleanup.go` | Its own router so the flag guard is a property of the whole router; NO caller identity, because the teardown runs globally with no session and an earlier version 401'd its only caller; 200 with a count rather than 204, because "the suite still sees its fixtures" and "the cleanup matched nothing" are the same symptom from the client's side; 200 even at zero matches; the 405-not-404 with the flag off is a consequence of the path layout, not a guard. |
| `commands/create_tracking.py` | `internal/app/create_tracking.go`, `internal/adapter/mysql/create_tracking.go` | The uniqueness rule is enforced TWICE and both are needed: the pre-check produces the ordinary 409 from a plain SELECT, and the unique index adjudicates the race the pre-check cannot see — both raise the SAME error, which is what keeps a lost race a 409 instead of a 500; the flush is what makes catching possible inside the function rather than at the caller's commit; a soft-deleted tracking still holds the `order_id` in the index, so re-creating one is also a 409; `test_mode` is returned, never persisted — it is a fact about the request, not about the shipment. |
| `commands/update_status.py` | `internal/app/update_status.go`, `internal/adapter/mysql/update_status.go` | The actor is the ONLY difference between the two callers and it must travel to the envelope, never be fixed in the publisher (hardcoding it would relabel every automatic progression as a carrier update); the lookup is unscoped; emission lives HERE and only here, so both callers are covered by one call site; the event count is one less than the status count and a test asserting one-per-status waits forever; the event is built from the PERSISTED entity because the request has no identity; `author.cognito_sub` is carried and is NOT an author claim — it is the key the pipeline routes the WebSocket push by, and the root `user_id` matches nothing there; a NULL is OMITTED, never null, or Zod rejects it and the EMAIL is lost too; obtaining the publisher is inside the try, because a `ValidationError` is a `ValueError` and would surface as "the carrier sent an invalid status" — a 400 blaming the caller for a transition already written. |
| `commands/delete_by_user.py` | `internal/app/delete_by_user.go`, `internal/adapter/mysql/soft_delete.go` | The predicate matches EITHER identity, because rows predating the migration have a NULL `cognito_sub` and because `cognito_sub` is not durable across re-registration; `utf8mb4_bin` is a SAFETY control — the columns are case-insensitive while the ids come from a mixed-case alphabet compared case-sensitively, verified against the live database; the empty-identity guard is repeated at the row-selection point because the method is public; the collation is pinned at the PREDICATE, not the schema, so the change stays scoped to the irreversible operation (the READS share the root cause and are deliberately left alone). |
| `commands/e2e_cleanup.py` | `internal/app/e2e_cleanup.go`, `internal/adapter/mysql/soft_delete.go` | Scoped by the tag, not by any identity; `JSON_QUOTE` in SQL never in the host language, because the second argument must be valid JSON and doing it in SQL keeps the value a bound parameter; idempotent — a second call returns 0, which is a success; soft delete only, and here it is not merely convention: the DB user has no DELETE privilege at all. |
| `commands/test_mode_progression.py` | `internal/app/progression.go`, `internal/adapter/http/progression_hook.go` | The run must NOT inherit the request's context (Go's specific hazard; the Python's equivalent was scheduling before the commit) and the failure mode disguises itself as the accepted restart limitation; each step opens its own session because the creating request's is long closed and holding one across the ticks would pin a pooled connection; reuses the carrier's transition function, differing ONLY in the actor; the read is unscoped; a rejected transition is never retried, because a forward-only rejection can only be rejected again; ONE root span opened INSIDE the goroutine (a span around the spawn ends before the work starts), with a span EVENT per tick; the restart limitation is ACCEPTED — no durable scheduler. |
| `queries/get_tracking.py` | folded into `internal/app/get_my_tracking.go` and the mysql adapter | The tracking-plus-history pairing is built in ONE place so the history's order cannot differ between the single and the batch read; the UNSCOPED read functions that once lived here were REMOVED with the gRPC surface, and the file carries an explicit "do not reintroduce an unscoped read here" — in Go that is enforced by the port being scoped-only. |
| `queries/get_my_trackings.py` | `internal/app/get_my_tracking.go`, `internal/app/list_my_trackings.go` | These wrappers exist precisely so a handler can never call the repository directly and omit the scope by accident — a one-argument difference between a scoped and an unscoped call. In Go the same intent is expressed as two DIFFERENT METHODS, because an optional string parameter would default to `""` rather than to "unscoped". |
| `domain/repository.py` (read paths) | `internal/adapter/mysql/read_scoped.go` | The ownership predicate goes INSIDE the query, never fetch-then-compare, so a non-owned row never exists in this process; every read carries `deleted_at IS NULL`; an empty id list short-circuits because `IN ()` is not valid SQL; history is loaded for the whole result set in ONE extra query, never per row; history ordering is timestamp THEN progression position, because a bare timestamp sort ties on same-second transitions and MySQL falls back to PK order — alphabetical — which puts DELIVERED first. |
| `domain/repository.py` (write paths) | `internal/adapter/mysql/create_tracking.go`, `update_status.go`, `soft_delete.go` | `_utcnow()` drops microseconds because MySQL DATETIME(0) ROUNDS rather than truncates, so an entity keeping them disagrees with its own row by up to a second in the wrong direction; a tracking is NEVER created without its first history row; `update_status` does not validate — the guards live in the pure domain so TestMode can reuse them; the history collection is EXPIRED after appending so the response and the event carry the transition being announced; the soft deletes stamp children first, do not filter the parent subquery on `deleted_at`, guard each statement for idempotency, and return the PARENT rowcount only. |
| `domain/status.py` | `internal/domain/status.go` (Wave 1) | Position in the ordered list IS the ordering — the enum's own comparison is alphabetical and `DELIVERED < PLACED`, so statuses must never be compared directly; the three rejection reasons are distinct because one `new > current` comparison would satisfy all three and collapse them into one indistinguishable failure; terminality is checked FIRST so `DELIVERED → anything` reports `already_delivered`; `next_status` returns "none" rather than raising, because reaching the end is how a TestMode run is meant to finish; `parse_status` is case-sensitive on purpose. |

## Related

- [[2026-08-27-tracking-go-migration-design]] — the design spec this plan implements task by task.
- [[ADR-0021-tracking-go-gin-sqlc-stack]] — the stack decision (Gin + sqlc + golang-migrate) this plan builds against.
- [[user-id-vs-cognito-sub-ownership-key]] — the ownership-key rule several tasks (creation, reads, soft-delete) preserve from the Python service.
- [[two-api-keys-two-trust-domains]] — the auth-scheme distinction Task 16 ports into the four auth schemes.
- [[testmode-in-process-asyncio-task]] — the TestMode background-progression decision Task 24 re-implements for Go, including its accepted restart limitation.
- [[logging-context]] — the shared cross-service log-context contract Tasks 9-10 implement in `log/slog`.
- [[testing]] — the three-test-layer convention Task 25 closes out for the new service.
- [[git-workflow]] — the branch/PR flow this plan is executed under.
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] — the review-against-the-brief lesson this plan's closing gate (Task 28) is designed to satisfy before the irreversible deletion step.

