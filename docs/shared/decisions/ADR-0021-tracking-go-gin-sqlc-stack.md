---
title: "ADR-0021: Tracking's Go Port Uses Gin, sqlc, and golang-migrate"
type: adr
area: shared
status: accepted
id: ADR-0021
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
created: 2026-08-27
updated: 2026-08-27
tags:
  - type/adr
  - area/shared
  - status/accepted
  - area/tracking
related:
  - "[[2026-08-27-tracking-go-migration-design]]"
  - "[[tracking-service-design]]"
  - "[[scripting-language]]"
  - "[[package-manager]]"
  - "[[ADR-0003-grpc-inter-service]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[2026-08-27-go-vs-python-performance]]"
  - "[[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]]"
  - "[[2026-08-27-a-producer-side-test-proves-nothing-about-what-the-consumer-accepts]]"
---

# ADR-0021: Tracking's Go Port Uses Gin, sqlc, and golang-migrate

## Context

The Tracking service is being migrated from Python/FastAPI to Go, per
[[2026-08-27-tracking-go-migration-design]]. Three reasons drove the migration itself (stack
diversity, measured performance/footprint, simplicity), and are recorded in full in that
spec — this ADR covers only the concrete stack choices within Go, since Go itself is a given
by the time this decision is made.

Three areas needed a decision: the HTTP framework, the data-access layer, and the migration
tool. A fourth, smaller decision — how Go's toolchain version is pinned and enforced — is
included here because it mirrors an existing repo-wide convention and should be recorded
alongside the rest of the stack.

## Decision

- **HTTP framework: Gin.** Chosen as the most ubiquitous Go web framework, with mature
  official OpenTelemetry instrumentation (`otelgin`) and struct-tag based binding/validation
  that keeps handler code declarative.
- **Data access: sqlc + `database/sql`.** Hand-written SQL with sqlc generating typed Go
  structs and methods from it. No reflection, no ORM magic, and SQL errors surface at compile
  time rather than at request time. This fits the migration's "simplicity" goal directly, and
  the Tracking schema already exists (originally authored for Alembic/SQLAlchemy), so there is
  no schema design left to redo — only translation. It also means constructs already in use
  today, like JSON columns and `JSON_CONTAINS` queries, are written as literal SQL rather than
  re-expressed through an ORM's query builder.
- **Migrations: golang-migrate.** The current Alembic revision history is translated into a
  single SQL baseline plus incremental `.up.sql`/`.down.sql` pairs. This makes the Go service
  fully self-sufficient for schema management, so the Python service can eventually be deleted
  without leaving any migration tooling behind as debt. `make migrate-tracking` changes which
  command runs under the hood; its contract (target, invocation point in the Makefile) does
  not change.
- **Go version manager: goenv** (github.com/go-nv/goenv), with a `.go-version` file pinned in
  the repository — the direct Go-toolchain analogue of `.nvmrc` for Node (see
  [[scripting-language]] and [[package-manager]], the sibling conventions this mirrors for
  Python and pnpm respectively). Any Go command (`go build`, `go test`, `go run`, `sqlc
  generate`, `migrate`) must be run with the pinned version active, exactly as the repo
  already requires `nvm use` before any Node command.
- **Pinned Go version: 1.26.7** (revised from an initial 1.25.14 — see Consequences below for
  why the first choice inverted).

## Consequences

- Gin's route tree resolves literals over path parameters, and — unlike FastAPI/Starlette,
  which resolves ambiguous routes by declaration order — Gin **panics at startup** on an
  unresolvable wildcard conflict. This is safer than Python's silent-first-match behavior, but
  it means route registration order is not a free variable during the port and any conflict
  surfaces immediately rather than as a runtime 404.
- sqlc means every query used by the service must be written out as literal, reviewable SQL
  ahead of time (sqlc generates from static `.sql` files, not from ad hoc query construction).
  This is a deliberate constraint, not a limitation to work around — it is what buys the
  compile-time safety.
- golang-migrate's baseline is a point-in-time snapshot of the schema Alembic produced; it is
  not a byte-for-byte translation of every historical Alembic revision. Anyone reconstructing
  "why does this column exist" history for anything before the baseline still needs to consult
  the Python service's Alembic revisions (kept until the Python folder is deleted per the
  migration spec's closing gate).
- A missing `goenv local <version>` step (or a stale shell not picking up the pinned version)
  is the Go-toolchain equivalent of the `nvm use` failure mode already documented for Node —
  the wrong compiler on `PATH` silently building against a different Go version's stdlib.
- **The pinned version was revised from 1.25.14 to 1.26.7 eight days after Go 1.25 reached
  end-of-life.** The original pin argued "latest patch of a mature series, stability over
  novelty," explicitly mirroring the Node 24.18.0 criterion in `.nvmrc`. That argument inverted
  once it surfaced that Go's support policy maintains only the two most recent major (i.e.
  minor-numbered) release series at a time, and Go 1.25 fell out of that window on 2026-08-19 —
  no further security patches, regardless of how many patch releases it had accumulated. 1.26.7
  is the version that actually satisfies the original criterion: in active support, one series
  behind the latest (1.27), with accumulated patches, and the chosen ecosystem (Gin, `otelgin`,
  sqlc, golang-migrate) already proven against it. 1.27.0 was considered and declined as
  unnecessary novelty-risk for wave 0. Lesson for future toolchain pins in this repo: "latest
  patch of a series" is not sufficient by itself — the series itself must still be inside its
  vendor's support window at pin time, not just at some earlier point during evaluation.

### Outcome (2026-08-27) — the migration shipped; the stack decision is closed, not merely accepted in the abstract

The migration described in [[2026-08-27-tracking-go-migration-design]] completed and the
cutover was executed: `services/tracking-go/` is now THE Tracking service and
`services/tracking/` (Python) is being removed. The closing gate was **three of four criteria
met** (all three test layers, the `openapi.yaml` diff, and observability parity all PASS;
measured performance PARTIALLY met — resource/startup metrics measured and Go wins all four,
load-test latency/throughput not measurable on this stack — see
[[2026-08-27-go-vs-python-performance]]), and the cutover proceeded on that basis by explicit
user decision rather than waiting on a fully-controlled latency re-run.

This stack combination (Gin + sqlc + golang-migrate + manual constructor injection over a
hexagonal layout) is not merely a decision recorded — it is now the decision the running
Tracking service is built on. Two additional consequences surfaced only once real production
wiring was exercised, worth recording here because they are downstream effects of choosing this
specific stack shape, not of "Go" in the abstract:

- **Hexagonal architecture's isolation-by-construction, combined with manual DI (no container
  to complain about an unwired dependency), produced five instances of correct, fully
  unit-tested code that was never reached from `main()`** — unregistered routes, an inert
  response cache, zero log lines carrying a `trace_id`, discarded cache metrics, and a dropped
  gateway `traceparent`. All five passed `golangci-lint`'s `unused` check, which is structurally
  blind to a dead **exported** symbol — exactly what every hexagonal seam is. The guard now in
  place is a static call-graph reachability test from `main()`, not a linter change; full
  write-up: [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]].
- **sqlc's compile-time SQL safety and Go's strict typing do not extend across a wire boundary
  this service doesn't share types over.** The SQS producer emitted `shipping_address` as a
  string where the consumer's Zod schema required an object; the producer's own unit test had
  encoded the wrong shape as its expectation, so nothing in this service's test suite could have
  caught it. Full write-up:
  [[2026-08-27-a-producer-side-test-proves-nothing-about-what-the-consumer-accepts]].

Neither finding invalidates the stack decision above — both are properties of hexagonal
architecture and cross-language SQS messaging generally, not defects specific to Gin, sqlc, or
golang-migrate — but both are direct consequences of the architectural choices this ADR
accepted, and are recorded here for that reason.

## Related

- [[2026-08-27-tracking-go-migration-design]] — the full migration design this stack decision
  is extracted from: motivation, approach, wave plan, observability/event parity, and the
  closing gate.
- [[tracking-service-design]] — the service design the Go port must remain behaviourally
  equivalent to.
- [[scripting-language]] — the sibling Python-first scripting convention and its own
  `.venv`/absolute-interpreter-path rule, which this ADR's goenv pinning parallels.
- [[package-manager]] — the sibling pnpm convention (`.nvmrc` precedent this ADR's
  `.go-version` mirrors).
- [[ADR-0003-grpc-inter-service]] — the gRPC-to-Users identity resolution the Go service must
  keep calling exactly as the Python service does.
- [[ADR-0019-distributed-tracing-opentelemetry]] — the OTel backend and env-var-vs-code
  scoping the Go port's observability wiring must respect (see the migration design's
  Observability and event parity section).
- [[2026-08-27-go-vs-python-performance]] — the measured performance comparison behind the
  Outcome section's "three of four criteria met" status.
- [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]] — the
  wiring-hazard consequence of this stack's hexagonal-plus-manual-DI shape, discovered during
  the migration's observability parity check.
- [[2026-08-27-a-producer-side-test-proves-nothing-about-what-the-consumer-accepts]] — the
  wire-contract consequence of this stack's cross-language SQS messaging, discovered during
  the migration's event-parity verification.
