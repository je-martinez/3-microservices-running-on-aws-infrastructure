---
title: Migrating the Tracking Service from Python/FastAPI to Go/Gin
type: spec
area: tracking
status: draft
created: 2026-08-27
updated: 2026-08-27
tags:
  - type/spec
  - area/tracking
  - status/draft
propagates-to:
  - "[[tracking-service-design]]"
  - "[[testmode-in-process-asyncio-task]]"
  - "[[ADR-0021-tracking-go-gin-sqlc-stack]]"
  - "[[plans/index]]"
related:
  - "[[tracking-service-design]]"
  - "[[testmode-in-process-asyncio-task]]"
  - "[[user-id-vs-cognito-sub-ownership-key]]"
  - "[[two-api-keys-two-trust-domains]]"
  - "[[ADR-0021-tracking-go-gin-sqlc-stack]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[ADR-0008-screaming-arch-di]]"
  - "[[logging-context]]"
  - "[[testing]]"
  - "[[scripting-language]]"
  - "[[package-manager]]"
  - "[[events-pipeline-design]]"
  - "[[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]"
---

# Migrating the Tracking Service from Python/FastAPI to Go/Gin

## Motivation

Three reasons, all stated by the user, and they define what "done" means:

1. **Stack diversity (portfolio).** The repo already runs Node/Fastify (Users), .NET (Orders),
   Python (Tracking). Go adds a fourth runtime and demonstrates real polyglot interop (gRPC,
   SQS, OTel) across languages.
2. **Performance and footprint.** Static binary (~15-20MB) vs a ~200MB Python image;
   millisecond startup; lower Fargate memory. Measured, not assumed.
3. **Simplicity / maintainability.** Static typing, less magic, explicit dependencies.

**An honest caveat recorded during brainstorming, and it must survive into the spec:** "it got
complex instead of staying simple" is not a language problem. Of ~9,776 lines in `src`, only
~2,400 are the tracking feature (api + commands + queries + domain). The other ~7,400 are
`shared/`: Redis cache (~900), SQS messaging (~750), logging + context (~1,100), http/identity
(~900), gRPC (~300), config, metrics, observability. That complexity is accidental to the
domain but *essential to the requirements* — cache, tracing, events, two identities, two auth
schemes. Rewriting in Go relocates it; it does not delete it. Simplicity is therefore an
explicit design goal to be pursued, not a freebie Go grants.

## Approach chosen: A — faithful port, layer by layer

Two other approaches were considered and rejected:

- **B, idiomatic redesign from the contract alone** — highest simplicity, but high risk of
  losing rules invisible in the OpenAPI contract. This repo has the exact scar: `cognito_sub`
  vs `user_id` ownership ([[user-id-vs-cognito-sub-ownership-key]]) is not in the contract and
  253 tests missed it.
- **C, hybrid (extract invariants first, then write idiomatically)** — was the recommendation,
  not chosen.

Approach A means **behavioural equivalence is faithfully ported; file layout is not.** The
original version of this spec additionally proposed mirroring the Python folder structure
1:1 ("for any Go file there is a Python counterpart in the same logical position"), on the
theory that a 1:1 mirror is what makes the port reviewable side by side. **That folder-mirror
rationale is withdrawn** — the user pushed back that it would import anti-patterns and files
that don't belong in idiomatic Go, and the objection is correct. Concretely, a literal mirror
would have produced:

- `commands/` and `queries/` as sibling directories — a Go package holding one type per file
  is a known smell. CQRS stays a design decision, but it is expressed as Command/Query
  **types within a package**, not as a directory tree.
- `errors.py` → an `errors` package. In Go, errors are values declared next to the type that
  produces them (e.g. `var ErrAlreadyExists = errors.New(...)`), not centralized.
- `schemas.py` → a `schemas` package. Go request/response DTOs live beside the handler that
  uses them, not in a shared schema module.
- One file per router — seven files holding one function each is translation, not design.
- `domain/repository.go` exporting one fat interface — Go prefers small interfaces **defined
  at the consumer**, not a single contract exported by the producer.

See [Folder structure](#folder-structure) for the replacement architecture (hexagonal / ports
and adapters) and [Review mechanism — the equivalence map](#review-mechanism--the-equivalence-map)
for what replaces the mirror as the review tool that catches tacit rules like `cognito_sub`
ownership, 409 idempotency, `DELIVERED` terminality, the E2E tag's double condition, and
`author.cognito_sub` omitted-never-null.

## Stack decisions (all user-confirmed)

- **HTTP framework: Gin.** Most ubiquitous Go framework, mature official OTel instrumentation
  (`otelgin`), struct-tag binding/validation.
- **Data access: sqlc + `database/sql`.** Hand-written SQL, generated typed Go
  structs/methods. No reflection, no ORM magic, SQL errors at compile time. Fits the
  "simplicity" goal and the fact that the schema already exists. JSON tags and
  `JSON_CONTAINS` are written as-is, which is an advantage here.
- **Migrations: golang-migrate.** Current Alembic revisions are translated into a single SQL
  baseline plus incremental `.up.sql`/`.down.sql`. The Go service becomes self-sufficient so
  Python can be deleted without leaving debt. `make migrate-tracking` changes command but not
  contract.
- **Go version manager: goenv** (github.com/go-nv/goenv). A `.go-version` file pinned in the
  repo, exactly parallel to `.nvmrc` for Node (see [[scripting-language]] and
  [[package-manager]] for the sibling conventions this mirrors). A CLAUDE.md rule mirroring the
  Node one: run `goenv local <version>` / ensure the pinned version is active before ANY Go
  command.

These decisions, and the rationale for rejecting a runtime other than Gin/sqlc/golang-migrate,
are recorded as [[ADR-0021-tracking-go-gin-sqlc-stack]].

## Cutover strategy

One branch (`feature/tracking-go-migration`), **two coexisting folders**. `services/tracking/`
(Python) stays untouched and working; `services/tracking-go/` is built alongside. The Python is
deleted ONLY when the closing gate proves behavioural equivalence — that deletion is its own
final commit.

Both services point at the SAME database during coexistence. This is what allows real A/B
comparison, and it is safe because golang-migrate starts from a baseline describing the schema
Alembic already produced. In `docker-compose.yml` the `tracking-go` service is added on a
different port with its own `.env.local.tracking-go` generated by `make env-file` (see
[[env-files]]). The nginx/gateway switch is one line, and reverting is equally fast.

## Folder structure

**Hexagonal / ports and adapters**, user-chosen after being shown three options. Plain
domain-package layout was the recommendation; the user chose hexagonal instead, and the choice
is defensible on its own terms, not merely accepted: the pure domain package cannot import
Gin, sqlc, or Redis, so **the compiler**, not a convention someone has to remember to uphold,
prevents infrastructure from leaking into business rules. That is a structural guarantee, and
it is the property a plain domain-package layout does not give you for free.

```
services/tracking-go/
├── .go-version              ← goenv, pinned 1.25.14
├── go.mod / go.sum
├── Makefile
├── .golangci.yml
├── Dockerfile               ← multi-stage: build → distroless
├── sqlc.yaml
├── openapi.yaml             ← generated
├── cmd/
│   └── server/main.go       ← composition root: ALL wiring by hand
├── internal/
│   ├── domain/              ← PURE: no external imports
│   │   ├── tracking.go      ← Tracking, TrackingHistory types
│   │   └── status.go        ← transitions, DELIVERED terminality
│   ├── app/                 ← use cases (one file each, + _test.go)
│   │   ├── create.go
│   │   ├── update_status.go
│   │   ├── get_tracking.go
│   │   ├── get_my_trackings.go
│   │   ├── delete_by_user.go
│   │   ├── e2e_cleanup.go
│   │   └── testmode.go
│   └── adapter/
│       ├── http/            ← Gin handlers, middleware, auth
│       ├── mysql/           ← sqlc-generated + store impl
│       ├── redis/           ← cache
│       ├── sqs/             ← event publisher
│       ├── grpcusers/       ← outbound Users client
│       └── otel/            ← tracing/metrics wiring
└── migrations/              ← golang-migrate
```

`internal/` follows Go convention (prevents external module imports); `cmd/server/` replaces a
root `main.py`. `internal/domain` is the layer that makes the earlier withdrawal concrete: no
`commands/`/`queries/` sibling directories (CQRS is expressed as Command/Query types inside
`internal/app`, not a directory split), no centralized `errors` or `schemas` package (errors
are values declared beside the type that produces them; request/response DTOs live beside the
handler in `internal/adapter/http`), and no one-file-per-router translation.

**Correction applied to plain hexagonal, stated explicitly:** a single `ports.go` holding
every interface reintroduces the same fat-interface problem the withdrawn mirror was
criticized for — it would just move the smell from `domain/repository.go` to `domain/ports.go`
without removing it. **Ports are defined where they are consumed**, not centrally: the
persistence port a use case needs is declared in that use case's file
(e.g. `internal/app/create.go` declares the narrow store interface `create.go` itself calls),
each one narrow — often one or two methods — rather than one interface serving every use case.
There is no central interface file in this layout.

**Dependency injection: manual constructor injection**, user-chosen over `google/wire` or
`uber-go/fx` — both were considered and declined. Everything is wired by hand in
`cmd/server/main.go`: DB pool, Redis client, SQS publisher, gRPC client → use cases →
handlers, in that order, top to bottom. No library, no code generation, no reflection. Expect
roughly 100-150 lines of explicit wiring, which is the cost of the guarantee: nothing is
assembled by a container doing something implicit at startup.

`shared/di/` (the Node/Awilix-style container this repo uses elsewhere, see
[[ADR-0008-screaming-arch-di]]) has NO equivalent here — this is a deliberate divergence from
that pattern for this one service, not an omission.

The layout also brings the `golang-project-layout` skill's baseline requirements into scope
for wave 0: `Makefile`, `.golangci.yml`, `.gitignore`, and 12-Factor conventions (config from
environment, logs to stdout, graceful shutdown).

## Surface inventory — SEVEN routes, four auth schemes

A finding from the brainstorm worth recording: **`services/tracking/CLAUDE.md` documents five
routes; `openapi.yaml` has seven.** The inventory must be taken from the generated contract,
never from the prose docs. The routes:

| Route | Auth | Caller |
|---|---|---|
| `GET /v1/health` | none | ALB / Fargate liveness |
| `POST /v1/trackings/init-tracking` | Cognito JWT at gateway → `x-user-id` | Orders, forwarding the user's header |
| `GET /v1/trackings/{order_id}` | Cognito JWT → scoped by `cognito_sub` | end user |
| `GET /v1/trackings?order_ids=` | Cognito JWT → scoped by `cognito_sub` | end user |
| `PUT /v1/trackings/{order_id}/status` | `TRACKING_CARRIER_API_KEY` | external carrier; receives NO `x-user-id` |
| `DELETE /v1/trackings/by-user` | shared internal key | Users' `DELETE /v1/users/me` |
| `DELETE /v1/trackings/e2e-cleanup` | none — route only EXISTS under `E2E_TESTING_ENABLED` | E2E harness teardown |

See [[two-api-keys-two-trust-domains]] for the carrier-key vs internal-key distinction this
inventory depends on.

## Review mechanism — the equivalence map

The folder mirror was not only a layout choice — it was what made approach A reviewable:
"for any Go file there is a Python counterpart in the same logical position" meant a reviewer
could open both files side by side and diff them by eye. Dropping the mirror for hexagonal
removes that mechanism, and with it returns the exact risk approach A exists to guard
against: losing a tacit rule that isn't written anywhere in the Python code's structure, only
in its behavior — the repo's own scar, `cognito_sub` vs `user_id` ownership, invisible in the
OpenAPI contract and missed by 253 tests (see [Approach chosen](#approach-chosen-a--faithful-port-layer-by-layer)).

**Replacement, user-chosen: an explicit equivalence map.** Review no longer follows "same file
path, different extension" — it follows a table each agent delivers alongside its code:

| Source Python file | Destination Go file(s) | Tacit rules found |
|---|---|---|
| e.g. `api/init_tracking.py` | `internal/adapter/http/handler_init_tracking.go`, `internal/app/create.go` | 409 idempotency guard; `usr_` id resolved via gRPC before persistence; ... |

This is the single mechanism for what the spec's earlier draft described as two separate
things — "each wave-2 agent records the tacit rules it finds" and the folder mirror enabling
side-by-side review. They are now one: **the map records the rules, and reviewing the map
(rather than matching file paths) is how the rules get checked.** There is one mechanism
described once, not two competing ones.

At the close of each wave, the acting agent's equivalence-map rows are consolidated into a
single vault note (propagated alongside this spec's other targets — see the
`propagates-to:` frontmatter) that serves two purposes going forward: a migration audit
(what moved where, and why) and a guide for anyone reading the Go diff without the Python
open beside it.

**What does not change, regardless of file layout:** behavioural equivalence. Same seven
routes, same status codes, same SQS envelope shape, same `openapi.yaml` contract. The
[closing gate](#closing-gate--what-must-be-true-before-the-python-folder-is-deleted) is
unaffected by the folder-structure revision — it was never a gate on file layout, only on
observable behavior, and stays exactly as specified.

## Agent team and waves

The user asked for a team of agents. A new **`tracking-go-impl`** agent is created (Go/Gin/sqlc
conventions in its definition, plus its own `services/tracking-go/CLAUDE.md`), instantiated N
times in parallel within each wave. Rationale: conventions live in the agent definition rather
than in repeated prompts, so they do not erode between waves, and a reusable agent remains for
later maintenance.

Waves are cut where real signature dependencies exist; within a wave, agents touch disjoint
files.

**Wave 0 — Foundations (sequential, 1 agent).** The only non-parallel part. `go.mod`,
`.go-version` + goenv rule (`1.25.14`), `sqlc.yaml`, the golang-migrate baseline translated
from Alembic, `sqlc generate` against the real schema, the **pure domain types and rules**
under `internal/domain` (`Tracking`, `TrackingHistory`, `Status`, transitions, `DELIVERED`
terminality, `nano_id`/`tracking_number`), the `Makefile`/`.golangci.yml`/`.gitignore`
baseline, and a `main.go` skeleton that compiles and serves `/v1/health`.

The deliverable that matters is `internal/domain` plus the sqlc-generated data layer: they are
what the next three waves build on. **Ports are NOT defined centrally in wave 0.** Each use
case in wave 2 declares the narrow port it needs, at the point it needs it — consistent with
[Folder structure](#folder-structure)'s rejection of a single `ports.go`. If the domain types
or the generated schema are wrong, the parallel waves diverge; that is why this wave runs
alone and is reviewed before the fan-out opens, not because it hands the later waves a shared
interface.

**Gin routing note to carry into wave 0:** Gin does not use Starlette's "first declared wins".
Its route tree resolves literals over params, but `/by-user`, `/init-tracking` and
`/e2e-cleanup` coexist with `/{order_id}`, and Gin **panics at startup** on a wildcard conflict
rather than failing silently. Better behaviour than today's, but it must be anticipated so it
is not discovered in wave 2.

**Wave 1 — Platform (4 parallel agents).** No inter-dependencies:

1. `logging` + request context (`context.Context` instead of ambient-context filters) + log
   middleware
2. `observability` (OTel: `otelgin`, `otelsql`, `otelgrpc`) + `metrics` (CloudWatch)
3. `cache` (Redis: gateway, keys, identity cache, invalidation)
4. `httpx` (all four auth paths: caller/JWT, carrier key, internal key, e2e source) +
   `grpcclient` to Users + `messaging` (SQS)

**Wave 2 — Endpoints (5 parallel agents).** Each ports one route with its tests, on top of
wave 0's domain types/data layer and wave 1's platform. Each use case declares its own narrow
port (persistence, in most cases) at the point it needs it, per [Folder
structure](#folder-structure) — there is no shared repository interface to implement against.
Each agent also fills in its rows of the [equivalence
map](#review-mechanism--the-equivalence-map) as it works:

1. `POST /init-tracking` — creation ONLY: validation, `usr_` id resolution via gRPC, 409
   idempotency guard, persistence. Exposes the hook for progression but does not implement it.
2. Both reads (`/{order_id}` and `?order_ids=`) — same agent, they share `cognito_sub` scoping
3. `PUT /{order_id}/status` (carrier) — including the reusable transition logic TestMode will
   consume
4. `DELETE /by-user` (internal) + `DELETE /e2e-cleanup`
5. `openapi.yaml` generator + the comparison test, plus the `/v1/health` arrangement

**Wave 2.5 — TestMode (1 agent, alone).** Split out at the user's request, and the dependency
analysis confirms it belongs here rather than in wave 2: TestMode is not an endpoint but a side
effect of `POST /init-tracking` when `test_mode: true`, and it reuses
`update_tracking_status` — the same handler behind the carrier PUT — differing only in
`AuditActor`. It therefore depends on TWO wave-2 agents, so it runs after both compile.

Scope: the `PLACED → PROCESSING → SHIPPED → OUT_FOR_DELIVERY → DELIVERED` progression, its 5
history rows, and the injectable interval (production 10s, tests ~0).

**This piece is not translated, it is redesigned.** The vault ADR's decision
([[testmode-in-process-asyncio-task]]) — in-process goroutine, no durable scheduler — stands
and is NOT revisited. But the Python implementation carries scaffolding Go does not need:

- The `run_coroutine_threadsafe` bridge was already dead in Python (its own comment says so;
  it survived from when creation ran on the gRPC thread pool). In Go it is simply `go func()`.
- Each transition opens its own write session because the request's is closed. Same in Go, but
  explicit: the goroutine **must NOT inherit the request's `context.Context`**, which is
  cancelled when the response is sent. It needs its own context derived from the process
  lifetime context.

**That last point is the bug this agent exists to avoid**, and it is invisible to
line-by-line translation: Python has no context to cancel, so the Python teaches the Go
nothing here. A faithful port would produce a goroutine that dies at the first `PROCESSING` —
and the symptom would be identical to the broken-but-accepted behaviour the ADR already
documents ("frozen after a restart"), i.e. it would disguise itself as a known limitation and
nobody would investigate. Graceful shutdown is also in scope: the process must not die leaving
goroutines mid-flight without at least logging it.

**Wave 3 — Verification (3 parallel agents).** The gate's four pieces: internal + gateway E2E
against Go (via `e2e-impl`), the Gatling Python-vs-Go comparison, and observability parity in
OpenObserve.

**Coordination.** Each agent writes source code only and leaves work in the tree; the main
session commits (A/B/C/D/E menu) at the close of each wave. Between waves there is a stop
point: compile, run tests, and review the diff **against each agent's brief and its
[equivalence map](#review-mechanism--the-equivalence-map) rows, not merely against itself** —
per [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]. An agent that "finishes"
having silently dropped the 409 idempotency guard produces self-consistent code that passes
its own review; the map is what a reviewer checks that guard against now that file position no
longer does.

## Observability and event parity

The section where a faithful port fails most quietly, because nothing that breaks here fails
an endpoint test.

**Traces.** Today Python instruments with no code: the Dockerfile wraps uvicorn in
`opentelemetry-instrument` and everything is configured via `OTEL_*` env vars. **In Go that
mechanism does not exist** — there is no equivalent auto-instrumentation agent — so wiring
necessarily moves into code: `otelgin` middleware, `otelsql` wrapping the driver, `otelgrpc` on
the Users client, and the SQS producer instrumented by hand.

This collides head-on with the global CLAUDE.md rule *"OTel config goes in environment
variables, not code"* (see [[ADR-0019-distributed-tracing-opentelemetry]]), written after
three silent failures. **The rule is not broken, it is scoped:** what still comes from the
environment is endpoint, protocol, and which exporters are disabled
(`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, the `*_EXPORTER=none`), read by
Go's SDK exactly as by Python's. What lives in code is *which surfaces are instrumented* —
which in Python was also an explicit decision, expressed as the list of
`-instrumentation-*` packages in requirements, not as environment. Record this distinction so
it is not read as a concession granted lightly.

Acceptance: a single `trace_id` crossing gateway → Go → gRPC Users, visible in OpenObserve.
**Known trap:** if the request enters through nginx and the W3C `traceparent` is not
propagated, the result is TWO disconnected traces rather than one broken one — which looks
green unless somebody counts.

**Logs.** The shared context (`trace_id`, `cognito_sub`, `user_id`, `email_hash`, `order_id`,
`duration_ms`) today travels via a logging filter reading an ambient context (see
[[logging-context]]). In Go it travels through explicit `context.Context`, with `slog` and a
handler extracting those fields. This is one place Go is genuinely simpler.

Two invariants are verified, not assumed: **unknown fields are omitted, never null** (`slog`
has no "omit if unset" equivalent — attributes must be built conditionally), and **email is
never logged in plaintext**, only `email_hash` or the masked form in auth flows. There is no
`SUCCESS` severity: success is `INFO` + `app_event=*_succeeded`.

**Events.** `TRACKING_STATUS_CHANGED` to the shared SQS queue. The consumer is the
events-pipeline Lambda, already in production (see [[events-pipeline-design]]), which
**validates the envelope with Zod** — so an extra field, a missing one, or a `null` where
omission was required produces a `PermanentError` that loses the email AND the WebSocket push.
The envelope does not tolerate "almost identical". Points the agent must respect, all already
documented and all easy to lose in a port:

- `author.actor` is the actor the command received (`CARRIER_STATUS_UPDATE` vs
  `TEST_MODE_PROGRESSION`), **not a constant chosen by the publisher** — hardcoding it
  relabels every automatic progression as a carrier update, and the two stop being
  distinguishable.
- `author.user_id` is **omitted** (neither write path has a human author); the tracking's
  `user_id` is the SUBJECT and travels at the envelope root.
- `author.cognito_sub` **does travel**, and comes off the persisted row, not the request. It
  is not an authorship claim: it is the key the pipeline routes the push by (it queries a
  DynamoDB index by sub; the `usr_` id matches nothing there and returns an empty list with NO
  error).
- Publishing is **best-effort and never raises**: a failure is logged with a machine-readable
  `reason` and swallowed. A notification must not break the write that caused it.

Verification is end-to-end: drive a transition against Go and confirm the Lambda consumes it
and emits the email — inspecting the outgoing JSON is not enough.

## Closing gate — what must be true before the Python folder is deleted

All four criteria were chosen by the user. None closes by eyeball; each leaves evidence in the
vault.

1. **All three test layers green.** Go unit/integration (against a REAL MySQL — "mocks hide
   schema bugs" applies equally), internal E2E against the Go service URL, and gateway E2E
   with a real Cognito JWT (see [[testing]]). **The gateway specs are NOT touched**: if the
   same files that pass against Python pass against Go unedited, the contract is equivalent.
   A spec modified to accommodate Go invalidates the criterion — the mirror image of
   `e2e-impl`'s rule never to edit service source to make a test pass.
2. **`openapi.yaml` with an empty diff.** Go generates its own and it is compared against
   FastAPI's. Expect irreducible serialization differences (ordering of `required`, naming of
   anonymous schemas); each one that appears is documented individually with its
   justification, and the criterion becomes "empty diff except the closed list of N justified
   differences". This must not become a dumping ground: if the list grows beyond formatting
   details, the criterion is NOT met.
3. **Measured performance comparison.** The existing Gatling simulations against both
   services — same hardware, same database, same load. Record p50/p95/p99, throughput, memory
   at rest and under load, image size, cold start time. With the honest number, whatever it
   is: **if Go does not win on some dimension, that is written down too.** It is a portfolio
   data point, not a marketing campaign.
4. **Observability parity**, per the section above, verified in OpenObserve and in the
   Lambda — not inferred from the code.
5. **(Added during design, not in the user's original four, because nothing else covers it.)**
   Deleting the Python is its own commit, after the four pass, accompanied by:
   `services/tracking/CLAUDE.md` → `services/tracking-go/CLAUDE.md`, retiring or repointing
   the `tracking-impl` agent, and vault propagation. That `CLAUDE.md` currently claims five
   routes when there are seven — the deletion is exactly the moment that debt is either paid
   or inherited.

## Prerequisites (wave 0 blockers, status as of 2026-08-27)

- **goenv is already installed** — `goenv 3.1.4` at `/opt/homebrew/bin/goenv`. The version
  manager itself is not a blocker; only the Go toolchain is missing (`goenv list` reports "no
  Go versions installed yet"). Wave 0 runs `goenv install 1.25.14`, not a goenv install step.
- **Go version pinned: 1.25.14 (user-confirmed).** Latest patch of the 1.25 series, with the
  whole chosen ecosystem (Gin, `otelgin`, sqlc, golang-migrate) proven against it — the same
  conservative criterion already applied to Node 24.18.0 in `.nvmrc`: stability over novelty.
  Wave 0 creates `services/tracking-go/.go-version` containing `1.25.14` and runs
  `goenv install 1.25.14`.
- **Go skills: resolved, 9 installed.** Sourced from `samber/cc-skills-golang` (~37K installs
  each; samber also authors the well-known `lo`/`mo` Go libraries), installed into the repo
  (`.agents/skills/` with `.claude/skills/` symlinks) and recorded in `skills-lock.json`:
  `golang-project-layout`, `golang-context`, `golang-concurrency`, `golang-database`,
  `golang-error-handling`, `golang-testing`, `golang-observability`, `golang-code-style`,
  `golang-naming`.

  These nine were chosen out of the family's nineteen because each maps to a specific risk
  this design already names, not because they were the top nine by install count:
  `golang-context` covers the TestMode goroutine cancellation trap (wave 2.5);
  `golang-concurrency` covers the progression goroutine and graceful shutdown; and
  `golang-observability` covers the manual OTel wiring the migration pushes into code (see
  Observability and event parity). `golang-code-style` and `golang-naming` exist to keep 5+
  parallel wave-2 agents writing consistently, which matters precisely because approach A puts
  several agents' output side by side for review. The other ten in the family — performance,
  security, safety, modernize, lint, data-structures, documentation, dependency-management,
  troubleshooting, design-patterns — are installable later if a wave surfaces a concrete need
  for them; loading all nineteen up front dilutes more than it helps.
- **No mature skill exists for the chosen stack — Context7 is the source of truth instead.**
  Searches for `gin`, `sqlc`, `go migrate`, and `go http` on skills.sh returned nothing
  credible: the only stack-specific hits were under ~400 installs (below the quality bar used
  above), and the `gin` query returned no Gin skill at all, only unrelated fuzzy matches. This
  is a deliberate sourcing decision, not a gap to close later: **Context7 (already configured
  in this repo) is the source of truth for Gin, sqlc, and golang-migrate APIs**, while the nine
  installed skills cover idiomatic Go generally. Recorded here so a later agent does not go
  looking for a Gin skill that was never going to exist.

## Related

- [[plans/index]] — indexes this design spec among the vault's implementation plans.
- [[tracking-service-design]]
- [[testmode-in-process-asyncio-task]]
- [[user-id-vs-cognito-sub-ownership-key]]
- [[two-api-keys-two-trust-domains]]
- [[ADR-0021-tracking-go-gin-sqlc-stack]]
- [[ADR-0019-distributed-tracing-opentelemetry]]
- [[ADR-0008-screaming-arch-di]] — the Awilix/DI container pattern this service's manual
  constructor injection deliberately diverges from; see [Folder structure](#folder-structure).
- [[logging-context]]
- [[testing]]
- [[scripting-language]]
- [[package-manager]]
- [[events-pipeline-design]]
- [[env-files]]
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]
