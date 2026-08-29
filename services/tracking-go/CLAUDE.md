# CLAUDE.md — Tracking service (Go)

Nested project memory for the **Tracking** microservice, Go implementation.
Source of truth for this service's stack and conventions. The `tracking-impl`
agent reads this first, every time. Cross-cutting rules are **referenced**, never
duplicated.

This file is the successor to `services/tracking/CLAUDE.md` (the Python service).
Where the two disagree, this one governs the Go service.

## 1. Stack & versions

- **Go 1.26.7, via goenv.** Pinned in `.go-version`. From this directory,
  `goenv local 1.26.7` once and `go` resolves correctly for every later command.
  If `go` is not on `PATH`, use `~/.goenv/shims/go`. `make verify-toolchain`
  fails loudly when the active toolchain is anything else, and `build`/`test`
  depend on it — so a wrong toolchain is a build failure, not a subtle one.
- HTTP framework: **Gin** (`github.com/gin-gonic/gin`).
- Database: **Aurora MySQL** (separate writer + reader pools, ADR-0006), accessed
  through **sqlc**-generated code over the standard `database/sql` with the
  `go-sql-driver/mysql` driver. No ORM.
- Migrations: **golang-migrate** (`migrations/`, `schema_migrations` table).
- Cache: **go-redis** (`github.com/redis/go-redis/v9`).
- AWS: **aws-sdk-go-v2** (SQS for events, CloudWatch for custom metrics).
- gRPC: **grpc-go**, client only. Stubs generated with **buf**, committed.
- Observability: **OpenTelemetry** — `otelgin` (inbound HTTP), `otelgrpc`
  (outbound gRPC), `otelsql` (database), OTLP/HTTP trace exporter. Logging is
  stdlib `log/slog` with hand-written handlers.
- Env validation: hand-rolled in `internal/platform/config` (parity with the Zod
  and Pydantic-settings conventions in the other services).

### Why 1.26.7 and not 1.25.x — the lesson, not just the number

The pin was originally **1.25.14**, chosen on the criterion this repo already
applies to Node in `.nvmrc`: *latest patch of a mature series, stability over
novelty*. That reasoning was **wrong here**, and goenv said so at install time:
**Go 1.25 reached end-of-life on 2026-08-19**, eight days before the decision, and
receives no further security patches. Go supports only the **two most recent
minor series** at any time.

> **"Latest patch of a series" is not a sufficient criterion. The series must
> still be inside its support window.** A `.14` in an EOL series is strictly
> riskier than a `.7` in a supported one — patch count does not offset being out
> of support.

1.26.7 is the genuinely conservative pick: in active support, one series behind
the latest (1.27), with accumulated patches, and the whole chosen ecosystem
already proven against it. A fresh `.0` of a brand-new series (1.27.0) was
considered and declined. Apply the same two-part test to any future bump.

## 2. Commands

Run everything **from `services/tracking-go/`** so goenv picks up `.go-version`.

| Task | Command |
|---|---|
| Verify toolchain | `make verify-toolchain` |
| Build | `make build` → `bin/tracking-server` |
| Test (unit only — **see §6**) | `make test` (`go test -race ./...`) |
| Test **with the real database** | `make test-db` — **§6, and `make test` alone is not enough** |
| Coverage | `make test-cover` → `coverage.out` |
| Format | `make fmt` (`gofmt -s -w .`) / `make fmt-check` |
| Lint | `make lint` (`golangci-lint run`) |
| Tidy modules | `make tidy` |
| Generate sqlc data layer | `make sqlc-generate` |
| Check sqlc is not stale | `make sqlc-verify` (`sqlc diff`) |
| Generate `openapi.yaml` | `go run ./cmd/genopenapi` |
| Migrate up | `make migrate-up` (needs `TRACKING_DB_*` in the env) |
| Migrate down one | `make migrate-down` |
| Migration version | `make migrate-version` |
| Stamp an Alembic-created DB | `make migrate-stamp-baseline` — **see below** |
| Regenerate gRPC stubs | `buf generate` (config in `buf.gen.yaml`) |

**`gofmt -s -w .` and `golangci-lint run` before reporting any task done.**

**Migrations against the shared local database.** `migrations/000001_baseline`
describes the schema Alembic already created. On a database Alembic has migrated,
run `make migrate-stamp-baseline` (`migrate force 1`), which records version 1
**without running any DDL**. Running `migrate-up` there would try to `CREATE TABLE`
over existing tables. `migrate-up` is for **fresh** databases only. See
`migrations/README.md`.

**gRPC stubs are committed**, like the Python service's, and generated with buf
rather than protoc: protoc is a native binary this machine does not have, while
buf installs with `go install`. The proto is the shared `../../proto/users.proto`
— never fork it.

### GOLDEN RULE — keep `openapi.yaml` in sync

`services/tracking-go/openapi.yaml` is a **generated, committed build artifact**,
produced by `go run ./cmd/genopenapi` from `internal/openapi`. Never hand-edit it.

**Any change to a route, its schemas, its status codes or its tags requires
regenerating and committing `openapi.yaml` in the SAME change.**
`internal/openapi/spec_test.go` regenerates and compares, so a stale spec fails
the suite rather than reaching a consumer. It needs no database and no
environment — `openapi.BuildSpec()` reads nothing and dials nothing.

**The comparison reference is FROZEN, and used to be live.** The gate once read
`../../../tracking/openapi.yaml` — the Python service's own generated document.
`services/tracking/` was deleted in `b889580`, so that path now reads a file that
does not exist, and the two tests depending on it failed. The reference is
therefore committed as a snapshot at
`internal/openapi/testdata/python-contract-at-cutover.yaml` (recoverable with
`git show b889580^:services/tracking/openapi.yaml`), and the question it answers
changed with it: not *"does the Go service serve the same contract as the RUNNING
Python service?"* — that was answered once, at cutover, and passed — but *"has the
Go service drifted from the contract it was accepted as equivalent to, in any way
not enumerated in the allowlist?"* A weaker claim, deliberately: the reference
cannot move any more, so the only party that can is this one.

**Reading it from git at test time was considered and rejected.** It avoids the
682 committed lines, but makes the gate need git, a working tree and a reachable
commit — false in a shallow clone or an exported tarball. A test that can fail for
environmental reasons is a test people learn to ignore, and this one is closing-gate
criterion 2.

**Never edit the fixture.** Its value is entirely that it is unedited evidence, and
the cheapest way to silence a failing equivalence gate is to edit the thing it is
compared against — an edit that looks like a small YAML fix in review.
`TestTheFrozenReferenceHasNotBeenEdited` checksums the payload below the header to
make that impossible; the header's prose stays editable. The old arrangement got
this property for free, because the reference lived in another service's tree.

`cmd/genopenapi` deliberately takes **no `--output` flag**: being able to write
the document somewhere the test does not look is the one way a committed artifact
silently goes stale.

Full convention: [../../docs/shared/conventions/openapi-specs.md](../../docs/shared/conventions/openapi-specs.md)

## 3. Architecture — hexagonal, and why

```
services/tracking-go/
├── cmd/
│   ├── server/          — the composition root (main.go) + its wiring tests
│   └── genopenapi/      — writes openapi.yaml from the Go routes
├── internal/
│   ├── domain/          — PURE business rules. stdlib ONLY.
│   │   └── audit/       — AuditActor
│   ├── app/             — use cases; each declares its OWN ports
│   ├── adapter/         — http, mysql, redis, sqs, cloudwatch, grpcusers,
│   │                      notify, otel
│   ├── platform/        — config, logging
│   └── openapi/         — the spec builder + the equivalence gate
└── migrations/          — golang-migrate SQL
```

### `internal/domain` is PURE

It may import **only the Go standard library**. No gin, no sqlc-generated
package, no redis, no aws-sdk, no grpc, no otel, **not even `net/http`**. A domain
file importing any of those is a defect even if the tests pass.

**This is enforced by a test**, not by review: `internal/domain/purity_test.go` walks
the full transitive closure and fails naming the offending import and the shortest
path to it. Run it like any other test.

Do NOT verify this by grepping for a dot in the package path. That heuristic is
wrong on Go 1.26.7: the closure contains `crypto/internal/entropy/v1.0.0`, which is
standard library and does contain dots, so the grep reports a violation against a
domain that is perfectly pure. The test asks the toolchain instead, via the
`Standard` field of `go list -deps -json`.

Nor is an AST-based check sufficient: it sees only DIRECT imports, so a domain file
importing a local helper that itself imports gin would pass. The test covers the
transitive case, and that mutation was used to prove it.

Business rules that compile without a framework are business rules that can be
tested without one. The rule is stated in `internal/domain/doc.go`; the test is what
makes it true rather than aspirational.

### Ports are declared by their CONSUMERS

Each use case declares the narrow interface it needs (usually one or two methods)
**in its own file**. There is **no central `ports.go`** and **no shared repository
interface**. `internal/app/progression.go` declaring `UnscopedTrackingReader`, and
`internal/adapter/http/handler_carrier.go` declaring `StatusTransitioner`, are the
pattern — copy it.

The payoff is not tidiness. A one-method port cannot grow a second implementation
of the same concept: `Transitioner` has exactly one method, so the carrier webhook
and the TestMode progression physically cannot drift apart about what a transition
means.

### Errors are values, declared beside the type that produces them

`domain.ErrTrackingNotFound` lives with the tracking. There is **no shared
`errors` package**. Compare with `errors.Is`/`errors.As`, never `==` — `errorlint`
is enabled and will catch you.

### Manual constructor injection — a deliberate divergence from ADR-0008

Everything is wired **by hand** in `cmd/server/main.go`: no DI container, no code
generation for wiring, no reflection. This **diverges deliberately** from the
repo's Awilix/DI-container convention recorded in
[ADR-0008](../../docs/shared/decisions/ADR-0008-screaming-arch-di.md); the stack
decision is [ADR-0021](../../docs/shared/decisions/ADR-0021-tracking-go-gin-sqlc-stack.md).
Go's static typing and zero-cost interfaces make a container pure overhead, and a
wiring you can read top to bottom is the whole point.

**The split between `main.go` and `NewAppRouter` is load-bearing.** `main.go` owns
only what cannot be tested in-process — reading the environment, opening sockets,
starting the ticker, shutting down. The **route table and the middleware chain**
live in `internal/adapter/http.NewAppRouter`, which a test **can** import. That is
why a dropped `Register*` call fails a unit test at the commit that dropped it
rather than a gateway E2E hours later. Never move composition back into `main.go`.

**Flags are decided in the composition root and nowhere else.** `CACHE_ENABLED`,
`METRICS_ENABLED` and `EVENTS_QUEUE_URL` are each read exactly once, in `main.go`,
and turned into a **dependency**: a null gateway, a nil publisher, a noop
publisher. No use case and no middleware branches on a flag.

Conventions referenced, never duplicated:
- Screaming architecture + DI: [../../docs/shared/patterns/screaming-architecture.md](../../docs/shared/patterns/screaming-architecture.md), [../../docs/shared/patterns/dependency-injection.md](../../docs/shared/patterns/dependency-injection.md)
- CQRS: [../../docs/shared/patterns/cqrs.md](../../docs/shared/patterns/cqrs.md)
- Soft delete only: [../../docs/shared/conventions/soft-delete.md](../../docs/shared/conventions/soft-delete.md)
- Prefixed nano IDs: [../../docs/shared/conventions/nano-id.md](../../docs/shared/conventions/nano-id.md)
- Audit fields: [../../docs/shared/conventions/audit-fields.md](../../docs/shared/conventions/audit-fields.md)
- API versioning: [../../docs/shared/conventions/versioning.md](../../docs/shared/conventions/versioning.md)
- DB naming: [../../docs/shared/conventions/db-naming.md](../../docs/shared/conventions/db-naming.md)
- Logging context & tracing: [../../docs/shared/conventions/logging-context.md](../../docs/shared/conventions/logging-context.md)
- Testing layers: [../../docs/shared/conventions/testing.md](../../docs/shared/conventions/testing.md)

## 4. The SEVEN routes

The Python `CLAUDE.md` documented **five**. The service has **seven**. The two it
omitted are `DELETE /v1/trackings/by-user` (the account-deletion cascade's leg)
and — depending on how you count — the batch read. Do not inherit that debt: if
you add or change a route, add it to this table in the same change.

| # | Method + path | Auth scheme | Caller | Declared failure modes |
|---|---|---|---|---|
| 1 | `GET /v1/health` | **none** | ALB / Fargate liveness probe | — (200 only) |
| 2 | `POST /v1/trackings/init-tracking` | Cognito JWT at the gateway → `x-user-id` (the **sub**) | Orders, forwarding the user's own header | 401, 404, 409, 422 |
| 3 | `GET /v1/trackings/{order_id}` | Cognito JWT → `x-user-id`, scoped by `cognito_sub` | the end user | 401, 404, 422 |
| 4 | `GET /v1/trackings?order_ids=<csv>` | Cognito JWT → `x-user-id`, scoped by `cognito_sub` | the end user | 400, 401, 422 — **no 404 by design** |
| 5 | `PUT /v1/trackings/{order_id}/status` | `TRACKING_CARRIER_API_KEY` in `x-api-key`, validated by this service | an external shipping carrier | 400, 401, 404, 422 |
| 6 | `DELETE /v1/trackings/by-user` | `GRPC_API_KEY` in `x-api-key`, validated by this service | Users' account-deletion cascade | 401, 422, 500 |
| 7 | `DELETE /v1/trackings/e2e-cleanup` | **none** — the route only EXISTS under `E2E_TESTING_ENABLED` | the E2E harness's global teardown | — (200 only) |

Plus one **outbound** surface: `users.v1.Users/GetUserById` over gRPC, presenting
`GRPC_API_KEY`. Tracking **serves no gRPC** — the only gRPC here is this client.

Route-by-route notes that are not visible in the table:

- **1 — health** is served **unprefixed** at `/v1/health`; the gateway publishes it
  as `/v1/tracking/health` and nginx rewrites. The prefix is not cosmetic: nginx's
  default `location /` proxies anything unmatched to `users:3000`, so a bare
  `/v1/health` **at the gateway** would return **Users'** 200 — a Tracking probe
  reporting healthy while never reaching this service. It also does **not** touch
  the database; folding a `SELECT 1` in would let a transient DB blip cycle
  healthy tasks.
- **2 — init-tracking** takes `order_id` and `shipping_address` in the body; the
  caller's identity comes from the header, never the body. Idempotency-guarded: an
  order that already has a tracking **or any history** is rejected `409`, so a
  retry cannot duplicate a shipment. `404` when Users has no record of the caller.
  Accepts `test_mode` (§10). It is deliberately **not** in the identity-stamp group
  (§9).
- **3 / 4 — the reads** are the only routes that use the **reader** pool and the
  only ones carrying the identity stamp. Both return the tracking **with its
  history**. `404` on the single read is `404` and never `403`: a `403` would
  confirm a tracking exists for that order id and turn the endpoint into an oracle
  for other people's order ids. The batch read has **no 404 at all** — unknown and
  non-owned ids are silently omitted, so a partly-owned request is a `200` with a
  shorter list. Its body is `{"trackings": [...]}`, an object and never a bare
  array, with no `total` (a count would start describing what the caller does not
  own).
- **5 — the carrier PUT** receives **no caller identity and must never acquire
  one**: its gateway route declares no Cognito authorizer, so no `x-user-id`
  arrives. It identifies the tracking by `order_id` alone, through the **unscoped**
  read. Applying the reads' ownership filter here would 404 every carrier call.
  Guards: terminal `DELIVERED` rejects any update; backward and same-status
  transitions are rejected. Its `status` field binds as `*string`, not the enum —
  `nil` (absent or `null`) is a `422`, an unknown string is a `400`, matching the
  Python exactly. Collapsing them would be a silent contract change on the one
  endpoint whose caller is a third party we cannot redeploy.
- **6 — by-user** is a `DELETE` **with a required body**, which is unusual and
  deliberate: this is the one route where the identities arrive in the body rather
  than a header, because the caller is a cascade and not a user session. **Both**
  `user_id` and `cognito_sub` travel and the predicate matches **either** — rows
  predating the `cognito_sub` migration carry only `user_id`, and `cognito_sub` is
  not durable (a user who deletes and re-registers gets a new one; their `usr_` id
  never changes). Its `500` is **declared here and not in the Python spec** — see §8.
- **7 — e2e-cleanup** has no credential at all, and that is not an oversight: the
  harness's teardown runs once, globally, with no user session, so a route
  requiring `x-user-id` would `401` its only real caller (it did, in the first
  version). What protects it is a **conjunction**: the route does not exist unless
  `E2E_TESTING_ENABLED`, **and** it only deletes rows tagged `"E2E Source"` — a tag
  applied at creation only when the request sent `x-e2e-source: true` **and** that
  same flag was on. Both halves are required; the conjunction is what stops an
  untrusted client tagging its own rows for someone else's teardown to delete. It
  answers `200 {"deleted": N}` **always**, including zero matches — `{"deleted": 0}`
  is a success, and the count is what makes a teardown diagnosable.

### Gin panics at startup on a route conflict — a Python-free failure mode

Gin builds one radix route tree **per HTTP method** and **panics the process at
boot** when a wildcard and a literal collide inside one method's tree. Starlette
matched by declaration order and simply never reached a shadowed route, so this
failure mode did not exist in the Python service.

Today's literals — `POST /init-tracking`, `DELETE /by-user`, `DELETE /e2e-cleanup`
— coexist with `GET /v1/trackings/:order_id` **only because the methods differ**.
Adding **any GET literal** under `/v1/trackings/` (e.g. `GET /v1/trackings/summary`)
lands in the wildcard's tree and panics on boot. Whoever adds such a route must
restructure the prefix, not merely register one more handler.

`router.HandleMethodNotAllowed = true` is set explicitly. Gin defaults it to
`false`, which answers `404` for a path that exists under another method; the
Python answers `405` — notably for the unmounted e2e route, whose path
`GET /v1/trackings/:order_id` still matches — so the default would be a silent
behavioural drift on a surface the equivalence gate compares.

### A new route is not done when the service serves it

Gateway route map (`infra/modules/api-gateway/main.tf`) **and** the nginx
`location` block (`infra/modules/compute/nginx/nginx.conf`), **all three test
layers**, load-test scenarios where relevant, and observability. See the root
`CLAUDE.md` and [../../docs/shared/conventions/testing.md](../../docs/shared/conventions/testing.md).

## 5. The four auth schemes — and why two share a header name

| Scheme | Header | Secret | Trust domain | Routes |
|---|---|---|---|---|
| Cognito JWT (verified at the gateway) | `x-user-id` (the JWT **sub**) | — | end user | 2, 3, 4 |
| Carrier API key | `x-api-key` | `TRACKING_CARRIER_API_KEY` | **external** vendor | 5 |
| Internal API key | `x-api-key` | `GRPC_API_KEY` | **internal** services | 6 |
| None | — | — | — | 1, 7 |

> **The two `x-api-key` schemes are DIFFERENT SECRETS in DIFFERENT TRUST DOMAINS.
> They share a header name and nothing else. Never collapse them.**
>
> `GRPC_API_KEY` is internal, shared only with Users and Orders. The carrier key is
> handed to an **outside vendor**. Reusing one as the other would give that vendor a
> credential that authenticates as an internal service against **every internal
> surface we have** — including route 6, a mass soft-delete, which is the widest
> blast radius this service has. An external carrier could erase a user's entire
> delivery history.

This is why `RequireCarrierKey` and `RequireInternalKey` are **two functions**
living side by side in `internal/adapter/http/auth.go` rather than one helper with
a key argument: one function per trust domain makes the wrong-key mistake
structurally harder. They share only `apiKeyGuard`, the **rejection path** — the
secrets are unreachable from it except through its argument.

Other rules that live in that file:

- **Comparison is constant-time** (`subtle.ConstantTimeCompare`), never `==`. Go's
  string comparison short-circuits at the first differing byte, leaking how long a
  prefix the attacker guessed. Length still leaks (as it does with Node's
  `timingSafeEqual` guard); contents do not. Same trade Users makes.
- **401, never 403**, for both key schemes and for a missing sub. A bad key
  identifies nobody, so there is no principal to forbid — and a caller cannot
  distinguish a wrong key from an absent one, so the endpoint reveals nothing about
  whether a key it was given is *nearly* right.
- **Guards are applied at the route GROUP**, in the same call that mounts the
  route. Every endpoint added to a group is then authenticated **by default**. A
  per-route guard makes the safe thing the thing you must remember, and the next
  carrier endpoint ships unprotected the first time somebody forgets.
- **Never log the key** — provided or expected, not a prefix, not a length. Failed
  attempts are logged (`app_event`, `reason=invalid_api_key`, `client`) because an
  unauthenticated state-mutating endpoint is the widest attack surface here and
  failed-attempt visibility is the cheapest mitigation available.

## 6. THE TESTING TRAP — read this before you trust a green run

> ### `make test` alone SKIPS the FOURTEEN tests that guard the most expensive bugs in this service. It used to still print `ok`; a gate now makes it fail instead.

Without `TRACKING_DATABASE_URL` set, `internal/adapter/mysql`'s real-MySQL tests
call `t.Skip` and the package reports **`ok`**. Verified, not assumed — this is the
measured list:

```
--- SKIP: TestCreateWritesBothRowsFromOneNow
--- SKIP: TestCreateRollsBackWhenTheHistoryRowFails
--- SKIP: TestExistsByOrderID
--- SKIP: TestExistsByOrderIDSeesOrphanHistory
--- SKIP: TestScopedReadsFilterByCognitoSub
--- SKIP: TestScopedReadOrdersDeliveredLastOnATie
--- SKIP: TestScopedListFiltersByCognitoSub
--- SKIP: TestScopedReadsCannotReachANullCognitoSubRow
--- SKIP: TestGetByOrderIDIsUnscoped
--- SKIP: TestGetByOrderIDMissingIsErrTrackingNotFound
--- SKIP: TestApplyTransition
```

That is: **ownership scoping by `cognito_sub`** (§7 — the bug that answered 404 to
every rightful owner), **soft delete by user and by tag** (routes 6 and 7),
**transactional rollback** of the two-row create, the **1062 duplicate-key**
translation, and the **scoped-vs-unscoped** distinction. Skipping them leaves the
whole of §7 unguarded while the suite is green.

**The count is FOURTEEN, not eleven, and there are TWO variables.** The list above
is the eleven guarded by `TRACKING_DATABASE_URL`. Three more —
`TestCountByStatus`, and the two soft-delete suites — read
`TRACKING_TEST_MYSQL_DSN` instead. Setting only one variable leaves the other
group skipping in silence, which is the same trap one level in.

**Use the make target, which sets both:**

```
cd services/tracking-go
make test-db
```

It derives the DSN from the generated `.env.local.tracking` rather than hardcoding
a port, because Floci reassigns RDS proxy ports on every apply — any port in this
file is an example, never a constant.

**The bare `go test ./...` now FAILS rather than skipping**, and that is
deliberate: `internal/adapter/mysql`'s `TestMain` refuses to report success on a
run that verified nothing. To skip on purpose, set `TRACKING_SKIP_DB_TESTS=1` —
a deliberate act that leaves a trace on the command line, rather than the default
a tired reader mistakes for a pass.

The gate cannot print that warning on a PASSING run: `go test` discards a passing
package's stdout unless `-v` is given, and the one channel Go leaves open without
it is a failure. That is why the always-visible banner comes from `make`, whose
output is never buffered, and the detailed inventory from the test under `-v`.

### Real MySQL, never mocks

This is a documented repo-wide lesson, and the reason it is enforced here: the
1062 unique-index translation, the `NULL` scan into `[]byte`, the `JSON_CONTAINS`
tag predicate and the fsp-0 rounding are all things **only the server can
produce**. A mocked repository test passes while the real schema rejects the write.

### Every ownership test uses TWO DIFFERENT VALUES

> **Any test asserting ownership must use different values for `user_id` and
> `cognito_sub`, or it structurally cannot fail on the bug in §7.**

The Python shipped that bug invisibly past **253 tests** because they created and
read with the same value. A test that uses one value for both is not a weak test —
it is a test that cannot detect the defect it exists to detect.

### TDD, as the plan writes it

Failing test first → **run it and watch it fail** → minimal implementation → run it
and watch it pass. Do not skip the red step: a test that never failed has proven
nothing.

### The other layers

Unit/integration here is layer 1 of three. Internal E2E (direct service URL) and
gateway E2E with a real Cognito JWT live in `e2e/` and are owned by `e2e-impl`.
Internal E2E is the one quietly skipped because the gateway spec feels like it
covers the same ground — it does not.

## 7. Two identities per tracking — `user_id` vs `cognito_sub`

A tracking stores **both**, and they are **not interchangeable**:

- **`user_id`** — the internal `usr_` id. Tracking resolves it itself, from the
  sub, through its outbound gRPC client to Users, while handling the request. Used
  for reporting, cross-service joins, and cache keys.
- **`cognito_sub`** — the Cognito `sub`, and **the ownership key every user-scoped
  read filters by**.

> **The gateway injects the caller's identity as `x-user-id`, but that header
> carries the JWT's `sub`, NOT the `usr_` id** (`proxy_set_header x-user-id
> $jwt_sub` in `infra/modules/compute/nginx/nginx.conf`). Scoping a read by
> `user_id` therefore compares a sub against a `usr_` id, **matches nothing, and
> answers 404 for every caller including the rightful owner — while looking
> correctly implemented.**

Rules:

- **User-scoped reads scope by `cognito_sub`.** Every read here is REST; there is
  no served gRPC surface to exempt.
- The HTTP accessor is `RequireCallerSub` / `CallerSub`, named so a handler cannot
  read it as "the user id". `UserIDHeader` is the misleading name; the doc comment
  on it says so.
- **EMPTY IS MISSING.** nginx sets `x-user-id` to the **empty string** when the
  token is absent or malformed rather than omitting the header. Accepting `""`
  would scope the read to `cognito_sub = ""`, which matches no row — a silent empty
  result instead of the `401` the caller deserves. Always `strings.TrimSpace` and
  reject empty.
- `cognito_sub` is **optional on the wire** and nullable in the schema, so a caller
  predating the field still creates successfully. `""` normalizes to `NULL`, which
  matches nobody — a row is unreachable rather than mis-attributed.
- Route 6 matches **either** identity (see §4). Route 7 scopes by **neither** — it
  selects by tag, because the teardown has no session at all.

Orders solves the identical problem the same way.

### Scoped and unscoped reads are SEPARATE METHODS — a Go-specific trap

> **Never one method with an optional identity parameter.** Go's zero value for
> `string` is `""`, **not `nil`**. An unset optional-scope parameter therefore
> silently means *"scoped to the empty string"* rather than *"unscoped"* — and the
> caller reads nothing, every time, while looking correctly implemented. The
> inverse mistake is just as easy.

So: `GetByOrderIDScoped(ctx, orderID, cognitoSub)` for the reads, and
`GetByOrderID(ctx, orderID)` — taking **no identity parameter at all** — for the
carrier webhook and the TestMode progression. The mistake then has nowhere to
happen. `internal/app/progression.go`'s `UnscopedTrackingReader` documents this at
the port.

## 8. The three error body shapes — and `openapi.yaml` is wrong about two

Three error shapes coexist on this surface **deliberately**, plus FastAPI's
validation shape. They are **not unified**: each is observable by a shipped
client, and collapsing them would silently break whichever caller reads the field
that moved. All four are declared in `internal/adapter/http/errors.go`.

| Shape | Body | Where |
|---|---|---|
| **A** `FlatError` | `{"detail": "..."}` | every 401; the single read's 404; the carrier PUT's 404; the batch read's 400 |
| **B** `NestedError` | `{"detail": {"detail": "...", "reason": "..."}}` | **only** the 404 and 409 on `POST /init-tracking` |
| **C** `ReasonError` | `{"detail": "...", "reason": "..."}` | **only** the 400 on the carrier PUT |
| **D** `ValidationError` | `{"detail": [{"loc": [...], "msg": ..., "type": ...}]}` | every 422 — a **list**, even for one problem |

> ### `openapi.yaml` declares shapes B as FLAT, and the SPEC is wrong — the CODE is right.
>
> The Python raises `HTTPException(detail={"detail": …, "reason": …})`, which
> FastAPI renders **nested**. FastAPI's generator **cannot express that wrapping**
> and emits the flat `ErrorResponse` instead. The nested body is what every
> deployed client has actually received. The Go therefore follows the **code**, not
> the spec.

Do not "fix" the Go handler to match the spec. `internal/openapi/allowlist.go`
records the difference with its justification, and `spec_test.go`:

- asserts a **cap on the allowlist's length**, so growing it is a test failure and
  not a judgement call somebody has to remember to make; and
- asserts the **two nested-error entries are present**, so a future change cannot
  quietly serve the flat body "to match the spec" and then delete the entry that
  documented why it must not.

The allowlist is **closed and enumerated**. Every entry is a spec-generation
artifact or a place where the *Python spec* disagrees with the *Python code* —
**never** a behavioural divergence between the two services. The acceptance
criterion is "an empty diff **except** this list", so an entry added to make a test
pass has moved the goalposts.

> **This is why the frozen reference is still kept rather than retired.** The
> tempting move after the Python tree was deleted was to drop the diff and keep only
> the tests asserting the CURRENT contract (the seven routes, the declared codes,
> `datetime`-as-string, no PII, the nested 404/409). But `TestEveryAllowlistEntryIsActuallyUsed`
> is not asking about Python at all — it asks whether these five exceptions still
> **correspond to anything**. With no reference to diff against, the allowlist becomes
> **unfalsifiable**: five standing permissions to differ, capped at twelve, with
> nothing able to prove one has gone stale. The cap without the used-check is exactly
> the rot the cap exists to prevent. Verified by mutation: a planted entry naming a
> nonexistent schema fails that test, and reverting the Python reference is what makes
> it able to.
>
> The frozen diff also covers what the hand-written lists structurally cannot. Those
> assert facts somebody remembered to write down; the diff asserts **everything else**
> in a 682-line document. Measured, not assumed: rewording one response `description`
> is caught **only** by the diff — every enumerated test stays green. There are five entries: the two nested responses, the
two schemas they name, and route 6's `500` — a failure the Python **serves** but
never declared (its generator cannot see a status nothing declares — the same blind
spot that shipped both reads without their `401`).

## 9. The wiring hazard — "correct code, absent wiring, no failing test"

This migration hit **seven** instances of the same shape. In each, a component was
written, unit-tested, reviewed, merged — and **never called from the running
process**:

1. The route handlers existed; `main.go` registered **none of them**.
2. `SetResolvedUserID` existed; nothing called it, so the **response cache never
   engaged** — not for a TTL, *always*.
3. `NewContextHandler` and `NewTraceHandler` existed and were used **only by their
   own tests**, so **no log line in the running process carried any correlation
   field** — 0 of 348 lines had a `trace_id`.
4. The cache gateway's metrics port was bound to the noop **unconditionally**, so
   `cache_requests_total` was computed on every request and discarded even with
   `METRICS_ENABLED=true`.
5. `otelgin` was **not in `go.mod` at all**, so there was no server span and the
   gateway's inbound `traceparent` was discarded — every workflow span started its
   own trace. Two valid traces instead of one broken one, which looks green unless
   somebody **counts**.
6. `go-sql-driver/mysql` carries its own package-level logger that `slog.SetDefault`
   does not reach, so one line in 493 escaped as non-JSON with no `service_name`
   and no `trace_id` — a record the collector cannot classify.
7. **`wire_app.go` passed `nil` as the `trace.Tracer`** to all four handler
   constructors, each guarded by `if h.tracer != nil` — so **none of the four
   workflow spans existed in production**: `init_tracking`,
   `carrier_status_update`, `internal_delete_by_user`, `e2e_cleanup`.

**Number 7 is a different shape from the first six, and it matters.** The seam was
CALLED — `NewInitTrackingHandler` runs on every boot. What arrived empty was an
**ARGUMENT**. The reachability gate below cannot see that, and neither could the
observability verification: `otelgin`'s server spans arrive, so there was a trace
and exactly one trace id, which is what that check counted. What was missing was
the inner span naming *which operation ran*. Only an E2E spec found it.

Its fix is the generalisable part: the constructors now **default** a nil tracer,
matching how they already defaulted `log` and `hook`. **A constructor that defaults
some collaborators makes an un-defaulted one an outlier waiting to be forgotten.**

**Every unit test passed in all seven cases, and that is not bad luck.** Hexagonal
architecture buys isolation by making every component constructible in isolation —
which is exactly what lets a component be fully exercised by tests and reached by
nothing. **An ordinary test cannot catch this even in principle**, because the test
constructs its own subject: its own call satisfies its own assertion. And
`golangci-lint`'s `unused` is structurally blind to it — verified, not assumed: an
**exported** dead function is not flagged, nor is one referenced only from a
`_test.go`. In a hexagonal design every seam crosses a package boundary and is
therefore exported.

### The guard: `cmd/server/wiring_reachability_test.go`

It walks the **static call graph from `main()`** over the production package set
(`go list -deps ./cmd/server` — exactly the set linked into the binary) and asserts
every seam in `requiredSeams` is reached. Each seam carries a `reason` stating
**what silently stops working in production** when it is not wired — that is the
part a bare "X is not reachable" leaves the next person to rediscover.

**When you add a middleware, an exporter, a background loop, or any other
install-once component, add it to `requiredSeams` in the same commit.** A seam
belongs there if it is *inert unless wired* and its absence is *silent*. A pure
function whose absence breaks compilation does **not** belong — the compiler
already guards it.

**Know its limit, which was measured by mutation rather than reasoned about.** The
walk asks "is this symbol **mentioned** anywhere reachable from `main`", not "is
its return value actually installed". Replacing the `otelgin.Middleware(...)` call
with a no-op closure that still *mentions* `tracing.GinFilter` leaves the gate
**green**; the four behavioural tests in
`internal/adapter/http/tracing_middleware_test.go` fail loudly on the same
mutation. The two layers divide the work:

- **The gate** catches **total absence** — the shape six of the seven historical
  bugs took. One line per seam, scales to everything.
- **It does NOT catch an empty ARGUMENT to a seam that is called.** That was bug 7,
  and no amount of walking the call graph reaches it: `NewInitTrackingHandler(…,
  nil)` is a call. The defence there is the constructor defaulting its own
  collaborators, plus a behavioural test that asserts the SPAN is exported rather
  than that a field is non-nil.
- **A behavioural test** catches partial or subtly-wrong installation. Expensive,
  so reserve it for seams where "wired but wrong" is realistic — the middleware
  chain above all.

### The middleware order is load-bearing, in both directions

`gin.Recovery()` → `otelgin.Middleware` → `LogContextMiddleware` → the two flag
middlewares. Registered first = outermost.

- **Recovery must stay outermost.** `LogContextMiddleware` observes a panic, counts
  it as a 500 and **re-raises**; producing the response is still Recovery's job.
  Inverted, the re-raise escapes to `net/http` and the connection is dropped with
  **no response** rather than a 500.
- **`otelgin` must sit ABOVE `LogContextMiddleware`.** otelgin installs the span on
  the request context only for the duration of its `c.Next()` and **restores the
  pre-span context on the way out**. `LogContextMiddleware` writes its one
  `request completed` line after **its own** `c.Next()` — which is still *inside*
  otelgin's, so the span is present and `trace_id`/`span_id` are stamped. Inverted,
  that line is written after otelgin's deferred restore has stripped the span, and
  it is emitted with `trace_id` and `span_id` **omitted**: valid JSON, correct
  fields, silently unjoinable to its trace. That is bug #3 reappearing in a new
  place.
- `LogContextMiddleware` stays **outside routing**, so a `401` from a key guard and
  a `404` from the router still get a request id and a log line. Users shipped the
  opposite ordering and its 401s had no id.

`otelgin` takes **no explicit provider or propagator** — it falls back to the
globals `SetupTracing` installed. Passing them explicitly would reintroduce the
option-versus-autodetection trap that already cost this repo three silent failures.
OTel config belongs in **environment variables, not code**.

### The identity stamp is on a GROUP, not global

`StampResolvedUserID` is applied to the two reads' group, never with `router.Use`.
Three surfaces have no caller identity at all (the carrier PUT and both deletes),
and a global middleware would fire on a stray header sent to the carrier PUT and
silently start resolving on the next route somebody adds. Per-route inverts the
default. Health is exempt by the same structure — the ALB probes it continuously,
and resolving there would turn a liveness check into a dependency on Users being
up. Creation is deliberately outside the group: it resolves the id itself and
answers 404 when Users has no record.

**Without that line the response cache is entirely inert** (bug #2): both read
handlers build their cache key from `ResolvedUserID(c)`, and the key builders
decline to build one without a `usr_` id.

## 10. TestMode — an accepted limitation, and one Go-specific trap

`POST /v1/trackings/init-tracking` with `x-test-mode: true` advances the tracking
one status every 10s (`PLACED → PROCESSING → SHIPPED → OUT_FOR_DELIVERY →
DELIVERED`, 5 history rows) using **in-process goroutines**.

> ### KNOWN LIMITATION, EXPLICITLY ACCEPTED — DO NOT "FIX" IT
>
> **If the process restarts mid-progression — a docker-watch rebuild, a redeploy, a
> crash, a container reschedule — the goroutine is LOST and the tracking stays
> frozen at whatever status it reached, forever.** Nothing retries it, nothing
> resumes it, and no error is reported anywhere. A TestMode tracking stuck at
> `PROCESSING` after a rebuild is **expected**, not a bug to investigate. Recover by
> creating a new TestMode tracking, or by driving the remaining transitions through
> `PUT /v1/trackings/{orderId}/status`.
>
> **Do not add a durable scheduler.** TestMode is a 40-second E2E fixture: nothing
> downstream depends on it completing, and real carrier updates arrive through the
> persistent PUT endpoint. A new dependency, a new table, a poller and its own
> failure modes are not a trade this service wants.

### The Go trap: the goroutine must NOT inherit the request context

> **A goroutine that outlives its request must not derive from that request's
> `context.Context`** — `net/http` cancels it the instant the response is written.
> The progression would then die on its first `ctx`-aware call, **every time**.

And this is the reason it is called out separately: **that failure is
indistinguishable from the accepted limitation above.** A tracking frozen at
`PROCESSING` looks identical whether the process restarted or the context was
cancelled at t=0 — so the bug hides inside a documented non-bug and nobody
investigates it. The structural defences:

- `app.Progression` holds a **`base` context** which **must** be the process
  lifetime context (the one derived from `signal.NotifyContext` in the composition
  root). The `//nolint:containedctx` on that field is deliberate and documented.
- **`Start(orderID string)` takes NO context**, and neither does the
  `ProgressionStarter` port the HTTP layer declares. A handler only *has* the
  request's context, so a signature that accepted one would invite exactly this
  bug. Removing the parameter makes it unrepresentable.

Other implementation rules:

- Each transition reuses **`UpdateStatus`** — the same use case behind the carrier
  PUT — differing only in `audit.Actor` (`TEST_MODE_PROGRESSION` vs
  `CARRIER_STATUS_UPDATE`). **Never write a parallel transition path**; that is how
  the two would start disagreeing about what a transition means, visible only in
  production data.
- The hook is called **after the response is written**, and therefore after the
  creating transaction has committed. Starting earlier races the commit: the
  progression's own fresh read would see no tracking and end immediately at
  `PLACED`.
- A rejected transition (a carrier delivered it first) or a deleted tracking **ends
  the run cleanly** — never retried, never panicking out of the goroutine.
- The interval is **injectable**; production default 10s, tests pass ~0 so the
  suite never sleeps for 40 seconds. A test that actually waited would be skipped
  or deleted, and either way the feature would stop being covered.
- Timestamps are **`time.Now().UTC().Truncate(time.Second)`**. MySQL `DATETIME`
  here has **fsp 0** and **rounds** fractional seconds rather than truncating them,
  so an untruncated `now` can persist a second *later* than the value in memory and
  invert an ordering.

## 11. Events, metrics and PII

### `TRACKING_STATUS_CHANGED` — the third producer

Tracking publishes to the shared SQS events queue (`EVENTS_QUEUE_URL`) on **every**
status transition, consumed by the events-pipeline Lambda, which emails the user
and pushes over WebSocket. See `internal/adapter/sqs/` and
`internal/adapter/notify/`.

- **Best-effort, never fails the write.** A publish failure is logged with a
  machine-readable `reason` and swallowed — a notification must not break the write
  that caused it. A nil publisher is a legal, documented, degraded wiring.
- **`author.actor` is the actor the use case already received**, never a constant
  the publisher picks. `UpdateStatus` takes `actor audit.Actor` and threads it
  through. Hardcoding it would relabel every automatic progression as a carrier
  update — the two are only distinguishable because that parameter travels.
- **Neither write path has a human author**, so `author.user_id` is **OMITTED**: the
  carrier webhook carries no caller identity at all and TestMode runs on a timer.
  The tracking's own `user_id` is the event's **subject** and travels as the
  envelope's root `user_id` — do not duplicate it into `author`.
- **`author.cognito_sub` IS carried, and it is not an author claim.** It is the key
  the events-pipeline routes the WebSocket push by (a DynamoDB index keyed on the
  sub; the root `user_id` is a `usr_` id, which matches nothing there and returns an
  empty list with **no error**). Like `user_id` it comes off the **persisted row**,
  never the request.

> ### OMITTED, NEVER NULL
>
> The envelope's `AuthorSchema` declares the field `.optional()` with `.min(1)`, so
> both an explicit `null` and `""` **fail Zod** — a `PermanentError` that consumes
> the record and loses the **email** as well as the WebSocket push, **silently**.
> A `NULL` column must be **omitted from the JSON entirely**. In Go that means a
> pointer field with `omitempty`, or building the map conditionally — never
> serializing a zero value into the slot.

The same rule governs logs: **unknown context fields are omitted, never null**.

### PII — what must never be logged

**Never log** passwords, tokens, API keys (not even a prefix or a length), full
request bodies, plaintext email, or **`shipping_address`**. Emails travel as
`email_hash`; auth flows elsewhere use a masked form.

> ### `otelsql`'s defaults are tuned for a generic service, and two of them are wrong for this one
>
> Both were found the same way: not by reading the library's docs and guessing, but by
> instrumenting a real call and reading what it actually emitted. Two hostile defaults
> from the *same* library is the signal to check deliberately for a pattern rather than
> patch each in isolation and move on — see
> [[2026-08-27-a-librarys-defaults-encode-assumptions-about-a-generic-service]] for the
> generalised version of this lesson (it is not Tracking-specific).
>
> **1 — `otelsql` records `db.query.text` BY DEFAULT — verified, not assumed.** An
> instrumented `UPDATE` emitted
> `db.query.text = "UPDATE trackings SET shipping_address='221B Baker Street' ..."`
> with no options set. This service's write paths carry exactly that column, and a
> **span attribute fans out to the collector and to OpenObserve just as a log line
> does**, so the same prohibition applies. **`otelsql.DisableQuery` is therefore ON**
> in `cmd/server/main.go`'s `poolTracingOptions`, and that option is one of the
> seams the reachability gate pins. Nothing needed is lost: the span name and the
> SQL method still identify the query.
>
> **2 — `otelsql` records `driver.ErrSkip` as an ERROR by default, on both spans AND
> metrics.** `driver.ErrSkip` is a `database/sql` sentinel meaning "this optional fast
> path is not implemented, use the generic one" — internal control flow, not a
> failure. It is not rare here: `go-sql-driver/mysql` returns it from
> `connection.go:439` and `:498` for **every** parameterized statement while
> `InterpolateParams` is off, which is the default — so before the fix, essentially
> every query this service made carried a false exception on its span, and the error
> status rendered successful spans as failed. Beyond noise, a false error on a
> database span **trains whoever reads the waterfall to ignore errors there**, which
> is exactly the habit that lets a real one go unnoticed. `otelsql` also stamps
> `error.type` on the `db.client.operation.duration` **metric** for the same
> non-event, independently of the span setting — so **both**
> `SpanOptions.DisableErrSkip` **and** `WithDisableSkipErrMeasurement(true)` are ON
> together in `poolTracingOptions`. Suppressing only the span half would leave a
> dashboard and a trace disagreeing about the same non-event. Fixed in commit
> `81c8ffe`.
>
> **Diagnostic worth keeping.** While writing the regression test for #2, a fake
> driver whose `Prepare` call failed produced `error.type = *errors.errorString` on
> the span — the exact string originally reported from the waterfall. That was the
> fake failing in the prepare-then-exec fallback, not a reproduction of the product
> bug. **After this fix, a stray `*errors.errorString` (or any non-`ErrSkip` type) on
> a database span is no longer `ErrSkip` and DOES deserve investigation** — the
> suppression is scoped to the one sentinel, not to "errors on database spans" in
> general.

Related: sqlc is configured with `emit_json_tags: false`. The generated models are
persistence structs; the HTTP response types are separate and hand-written,
**precisely so a response can never accidentally carry `shipping_address` or
`cognito_sub`**.

Full convention: [../../docs/shared/conventions/logging-context.md](../../docs/shared/conventions/logging-context.md).
Backend decision: [ADR-0019](../../docs/shared/decisions/ADR-0019-distributed-tracing-opentelemetry.md)
— logs **and** traces both go to OpenObserve.

### Flow logs

`app_event` (`<flow>_started|_succeeded|_failed`) plus `reason` on failures. There
is **no SUCCESS severity** — success is `INFO` + `app_event=*_succeeded`. The two
reads deliberately emit **no `*_succeeded` line**: the middleware's
`request completed` already carries route, status and `duration_ms`, and these are
the most frequent authenticated calls the service serves. Only their failure
branches log, because those are what the request line cannot explain.

## 12. Data-layer notes worth knowing before you touch sqlc

- **The schema comes from `migrations/` itself** (`sqlc.yaml`), so generated models
  cannot drift from the DDL the database runs. There is no second schema to keep in
  sync.
- **`tracking.tags` overrides to `tagtype.Tags`**, a hand-written
  `sql.Scanner`/`driver.Valuer` over `[]string`. It lives in **its own package**
  because sqlc's `go_type` override can only name a type by import path, and
  pointing that at the package being generated into emits a **self-import**
  (`import cycle not allowed`). A bare `go_type: "Tags"` is rejected too. A separate
  package is the only arrangement sqlc supports here.
- **`tracking.shipping_address` overrides to `[]byte`, NOT `json.RawMessage`**, and
  the difference is not cosmetic: `json.RawMessage` does **not** implement
  `sql.Scanner`, so scanning a `NULL` fails **at runtime** (`unsupported Scan,
  storing driver.Value type <nil> into type *json.RawMessage`). The column is
  nullable and most rows have no address, so that is the **common** path.
  `models_test.go` pins the generated type so a future override cannot silently undo
  it. It stays raw JSON deliberately: the shape is owned by Orders/Users, and a
  strict model would turn an additive upstream field into a creation outage.
- `tracking.tags` is a JSON array (MySQL has no array type), `NOT NULL DEFAULT
  (JSON_ARRAY())`, queried with `JSON_CONTAINS`. `tracking_history` deliberately
  carries **no** `tags` — its rows are reached through the parent's FK, so the tag
  stays single-sourced.
- **Writer and reader pools are separate fields even locally** (ADR-0006). Honouring
  the split in code is what makes local and deployed behave identically, instead of
  the reader-only path being exercised for the first time in production.
- `otelsql.Open` does **not** dial — like `sql.Open` it only validates the DSN — so
  a database still starting does not stop this process serving its liveness probe.

## 13. Agent rules

- Converse with the user in **Spanish**; write code, comments and commit-ready work
  in **English**.
- `tracking-impl` writes **only source code** — it **never runs git** and
  **never touches Linear**.
- Leave finished work in the **working tree** for the **main session** to commit
  (`github-ops` is an optional helper for complex git batches — see
  [../../docs/shared/conventions/git-workflow.md](../../docs/shared/conventions/git-workflow.md)).
- Stay within the single task handed to you (**YAGNI**). If the task turns out to be
  wrong or blocked, **stop and report that** — do not widen scope to fix it.
- Record **equivalence map rows** for your task: which Python source file each Go
  file came from, and any tacit rule found in the Python that is not visible in the
  OpenAPI contract. Report them with your result.

## 14. Design reference

- Migration design spec: [../../docs/superpowers/specs/2026-08-27-tracking-go-migration-design.md](../../docs/superpowers/specs/2026-08-27-tracking-go-migration-design.md)
- Migration plan: [../../docs/superpowers/plans/2026-08-27-tracking-go-migration.md](../../docs/superpowers/plans/2026-08-27-tracking-go-migration.md)
- Service spec (vault): [../../docs/domains/tracking/specs/tracking-service-design.md](../../docs/domains/tracking/specs/tracking-service-design.md)
- Stack decision: [ADR-0021](../../docs/shared/decisions/ADR-0021-tracking-go-gin-sqlc-stack.md)
- Entities: `Tracking`, `Tracking_History`.
- **Tracking is REST-only.** It serves no gRPC; the single gRPC here is an
  **outbound** client to `users.v1.Users/GetUserById`, resolving the caller's `usr_`
  id from the Cognito sub. `NOT_FOUND` means the user does not exist; **every other
  status propagates**, so a Users outage is never mistaken for an unknown caller.
