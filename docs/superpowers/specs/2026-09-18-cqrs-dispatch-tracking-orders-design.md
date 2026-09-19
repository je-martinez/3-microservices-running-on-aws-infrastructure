---
title: CQRS Dispatch for Tracking and Orders
type: spec
area: shared
status: draft
created: 2026-09-18
updated: 2026-09-19
tags: [type/spec, area/shared, status/draft, area/tracking, area/orders]
propagates-to:
  - "[[cqrs]]"
  - "[[dependency-injection]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
related:
  - "[[2026-09-18-cqrs-dispatch-tracking-orders]]"
  - "[[cqrs-dispatch-all-services-milestone]]"
  - "[[cqrs]]"
  - "[[dependency-injection]]"
  - "[[screaming-architecture]]"
  - "[[logging-context]]"
  - "[[testing]]"
  - "[[2026-09-19-users-nestjs-migration-design]]"
  - "[[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]"
  - "[[2026-09-18-cqrs-rule-lived-only-in-the-vault-not-in-the-file-agents-read-first]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
---

# CQRS Dispatch for Tracking and Orders

## Context / Problem

The repo already follows CQRS ([[cqrs]], [[ADR-0002-cqrs]]): commands and queries have
dedicated handlers in both remaining services covered here. But dispatch is entirely
**manual** — the DI container resolves a handler class and the transport layer calls its
method directly. There is no bus, and therefore no pipeline where cross-cutting concerns
(tracing, structured logging, validation) can be applied once instead of once per handler.

Evidence measured in the codebase on 2026-09-18:

- **Tracking** (`services/tracking-go/**`): `tracing.WorkflowSpan(...)` lives in the HTTP
  handler, `internal/adapter/http/handler_reads.go`, **not** in the use case — a layer
  mismatch versus how Orders does it (Orders applies the equivalent concern inside the
  handler/service that IS the use case, not in the transport adapter in front of it).
- **Orders** (`services/orders/src/Orders.Infrastructure/**`): 7 service classes
  (`CartWriteService`, `CartReadService`, `OrderReadService`,
  `InvalidateOrderCacheService`, plus others) each repeat `_tracer.TraceWorkflowAsync(...)`
  by hand, calling into `Orders.Infrastructure/Observability/WorkflowTracer.cs` /
  `IWorkflowTracer.cs`.

### Users is out of scope here — it took a different path

This spec originally covered a three-service (Users/Orders/Tracking) refactor. The Users
service has since been superseded by a NestJS migration: the framework change lets Users
adopt `@nestjs/cqrs` directly (`CommandBus`/`QueryBus`/`EventBus` plus Nest interceptors and
pipes) rather than a hand-rolled bus over Awilix, removing the proportionality problem that
originally ruled `@nestjs/cqrs` out for Users. See
[[2026-09-19-users-nestjs-migration-design]] for the full design, including the
routine-vs-thrown span-status distinction, the specific-reason-deferral requirement, and the
other hard-won findings carried forward from the reverted hand-rolled-bus work. This spec no
longer covers Users, its bus design, its DI container, or its migration plan — those sections
were removed when this note was rescoped to Tracking and Orders only.

Also relevant: [[2026-09-18-cqrs-rule-lived-only-in-the-vault-not-in-the-file-agents-read-first]]
records an incident where an endpoint inlined domain logic and a DbContext because nothing
structurally prevented it. A bus makes that violation harder to express — an endpoint that
wants domain logic has to go through the bus dispatch instead of reaching around it.

## Research findings

Library survey performed 2026-09-18, extended 2026-09-19. Reported honestly, including
negative results.

### .NET (Orders) — Wolverine 6.39.0 is adopted

- License: MIT, free. JasperFx moved to an "open core" model (paid support + CritterWatch
  tool); the library itself did **not** change license. Sources:
  https://wolverinefx.net/ ,
  https://jeremydmiller.com/2026/08/28/the-open-core-model-for-sustainable-oss-development-in-net/
- Packages all at 6.39.0: `WolverineFx.MySql`, `WolverineFx.EntityFrameworkCore`,
  `WolverineFx.AmazonSqs`, `WolverineFx.Http` (verified on NuGet).
- Handlers are plain classes with constructor injection, discovered by convention
  (`*Handler`/`*Consumer` class + `Handle`/`Consume` method), zero runtime reflection
  (source-generated).
- `WolverineFx.Http` is opt-in **per endpoint** and coexists with existing `MapGet`/`MapPost`
  delegates — gradual migration is supported.
- **MySQL durability is real and CI-tested, not vendor-uncertain.** An earlier pass of this
  research quoted the published guide's line "we've tested Wolverine with EF Core using both
  SQL Server and PostgreSQL persistence" as a MySQL risk. That line is stale. Verified by
  cloning the Wolverine repo: `CIMySql` is a first-class CI job in
  `.github/workflows/tests.yml`, with `mysql:8.0` in their docker-compose — MySQL is tested on
  every run. 27 commits touched `src/Persistence/MySql` since January 2026, including a
  failover named-lock fix (#4284), a tenant-store schema fix, and PR #4472 (merged days before
  this research). There is a dedicated `docs/guide/durability/mysql.md`; config is
  `opts.PersistMessagesWithMySql(connectionString)`. Requires MySQL 8.0+/MariaDB 10.5+ — Aurora
  MySQL 3 is 8.0-compatible. Issue #4316 (a durability recovery-poll full-table-scan problem)
  states verbatim that "MySQL and Oracle already carry a plain (unfiltered) owner_id index
  that an owner_id = 0 equality can use, so they are unaffected" — MySQL was already correct
  on that issue; Postgres and SQL Server were the broken ones. Sources:
  https://wolverinefx.net/guide/durability/mysql.html ,
  https://github.com/JasperFx/wolverine/issues/4316
- **The EF Core + MySQL transaction sharing is a decisive technical fact, not an assumption.**
  `Wolverine.MySql` depends on MySqlConnector 2.4.0, and `Pomelo.EntityFrameworkCore.MySql
  9.0.0` also depends on MySqlConnector 2.4.0. Pomelo is built on MySqlConnector, so the
  `DbConnection`/`DbTransaction` instances are the same concrete types. Wolverine's EF Core
  bridge borrows the `DbContext`'s connection and transaction and enlists in Pomelo's
  transaction with no adapter layer — the outbox write and the domain write genuinely share
  one transaction.
- **Honest counterweight to keep**: MySQL support sits at roughly 27k downloads versus 4.2M
  for Postgres — real, CI-tested, and actively maintained, but lightly travelled. This repo
  could be an early reporter on a novel edge case. One known issue is not MySQL-specific:
  #1735, messages occasionally stuck in the outbox via a `RaiseSideEffects` double-flush,
  affects all providers. Source: https://github.com/JasperFx/wolverine/issues/1735

Alternatives considered and rejected:
- **MediatR** 14.2.0 is dual-licensed RPL-1.5 or commercial; its free Community tier covers
  organizations under $5M USD annual gross revenue and under $10M outside capital, with
  unlimited developers and unlimited deployment — this project qualifies. Paid tiers are
  $799/$1,499/$6,399 per year; v12 and earlier stay Apache-2.0/MIT. **The defensible reason to
  reject it is scope, not license**: it is a mediator only — no outbox, no messaging, no
  transport — covering roughly one of the four goals this refactor needs (bus, behaviors,
  outbox, transport). RPL-1.5 copyleft would only matter if this repo ever went closed-source,
  which it is not expected to. Source: https://luckypennysoftware.com/faq
- **Paramore.Brighter** 10.7.0 is MIT, has a dedicated `Paramore.Brighter.Outbox.MySql`
  package, and documented EF Core outbox support — it has *more* real-world MySQL mileage than
  Wolverine. It is recorded here as the serious runner-up. The honest reason Wolverine was
  chosen over Brighter is **integration breadth** — mediator + outbox + transport + Minimal
  API in one MIT library with native net10.0 support — not MySQL superiority; on MySQL
  maturity alone, Brighter is arguably the stronger claim.
- **MassTransit** v9.2.2 is confirmed commercial (its nuspec `licenseUrl` points to
  https://massient.com/license); v8 stays Apache-2.0 with security patches through 2026.
- **Rebus** 8.9.4 is MIT but has no in-process mediator, so it fails the "single bus for
  commands and queries" goal outright.

### Go (Tracking) — no library adopted; a hand-rolled generic bus is used

- Watermill 1.5.3 (9,897 stars, actively maintained) has **no** `QueryBus`/`Query`/
  `QueryHandler` in `components/cqrs`; `CommandBus.Send` returns only `error`. There **is** a
  generic blocking `components/requestreply.SendWithReply[Result any]`, so "async-only" would
  be imprecise — but it is still wrong for synchronous HTTP reads: every call generates a UUID
  `OperationID`, subscribes to a reply topic, publishes, and correlates, adding a timeout
  failure mode and a documented subscriber-leak risk, to serve a `SELECT`. Right library,
  wrong job.
- `go-kit` has the ideal composition model (`Endpoint`/`Middleware`/`Chain`) but is
  `interface{}`-based, predates generics, last release Aug 2023, last push Jul 2024.
- `Go-MediatR` v1.4.0 — re-verified at the source level on 2026-09-19; both grounds from the
  first pass were confirmed, but the deeper reading found a stronger primary reason and
  corrected one piece of prior reasoning:

  1. **Primary reason: `buildPipeline` (`mediatr.go:309-330`) wraps every registered behavior
     around every `Send`, with no per-type filtering.** This repo's pipeline needs the request
     type — tracing, `app_event` and validation all do (D4) — so under Go-MediatR every
     behavior must carry its own hand-maintained type switch, run on every request regardless
     of type:
     ```go
     switch r := request.(type) {
     case *GetMyTracking:   flow = "get_my_tracking"
     case *AdvanceTracking: flow = "advance_tracking"
     default:               flow = reflect.TypeOf(request).String()  // silent fallback
     }
     ```
     Every new use case means editing that central switch, and a forgotten case degrades
     silently into `default` rather than failing to compile. That refunds, as an ongoing
     maintenance tax, the exact "apply cross-cutting concerns once instead of per handler"
     benefit the library would be adopted for. This is open issue **#26** ("Allow Registration
     of Pipeline Behaviors for Specific Request Types", opened 2025-07-06), unanswered.
  2. **A live panic path.** `Send` ends at `mediatr.go:179` with `return result.(TResponse),
     nil` — an unchecked type assertion. A behavior that returns a wrong-typed response panics
     in the caller's goroutine, with no typed error path.
  3. **Global registry — confirmed, with the original reasoning corrected.**
     `mediatr.go:54-61`:
     ```go
     var (
         requestHandlersRegistrations      sync.Map // map[reflect.Type]interface{}
         notificationHandlersRegistrations sync.Map // map[reflect.Type][]interface{}
         pipelineBehaviors                 []PipelineBehavior
         notificationHandlerMutex sync.Mutex
         pipelineMutex            sync.RWMutex
     )
     ```
     There is no `Mediator` type, no constructor, no method with a receiver — every entry
     point is a package-level function over these vars. **Correcting the record:** an earlier
     pass of this evaluation claimed parallel tests would leak state across packages. That is
     wrong — `go test ./...` compiles each package into a separate binary in a separate
     process, so cross-package leakage is impossible. The real, verified costs are
     intra-package: registration is one-shot per process (`LoadOrStore` errors with "handler
     already exists for type"), so tests must serialize and clear state between cases;
     `t.Parallel()` becomes unusable in any test that registers handlers (the library's own
     suite has **zero** `t.Parallel()` calls and serializes everything through its own
     `testMutex`); and `ClearRequestRegistrations()` is itself racy — it does an
     unsynchronized `requestHandlersRegistrations = sync.Map{}` while `Send` may concurrently
     `.Load()` from it.
  4. **Non-generic middleware — confirmed, with the asymmetry made explicit.**
     `mediatr.go:20-26`:
     ```go
     type RequestHandlerFunc func(ctx context.Context) (interface{}, error)
     type PipelineBehavior interface {
         Handle(ctx context.Context, request interface{}, next RequestHandlerFunc) (interface{}, error)
     }
     ```
     `RegisterRequestPipelineBehaviors(behaviours ...PipelineBehavior) error`
     (`mediatr.go:85`) takes no type parameter, while `Send[TRequest any, TResponse any]`
     (`mediatr.go:156`) IS generic. Types exist at the call site and are erased through the
     pipeline — the one place this design needs them.
  5. **Freshness — the library is stale, not the evaluation.** Latest release v1.4.0,
     2025-05-08T22:12:49Z. Last commit `259e2610`, 2025-05-09, tagged v1.4.0. Zero commits
     since — sixteen months. GitHub: 279 stars, 19 forks, 5 watchers, 3 open issues, MIT, not
     archived. The final two commits (`2c80ee6f` "feat: add thread-safe handlers registration
     (#24)" and `259e2610` "refactor: optimization concurrent-safety and adding api docs
     (#25)", four hours apart) introduced the global `sync.Map` block itself; neither touched
     generics or injectability. The decisive signal: issue **#27 "Pipeline behaviors to be
     generic"** (2026-02-12) was closed 16 minutes later as `not_planned` **by the requester
     himself** — "seems like this is impossible to implement =(" — with no maintainer reply.
     Issue **#21** asks for automatic handler registration via uber/fx and has been open and
     ignored for 20 months. No PR has ever proposed generic behaviors or a non-global
     registry.
  6. **Competitive sweep — a verified null result.** Swept pkg.go.dev (`mediator`,
     `mediatr`, `cqrs`, `command bus`) plus GitHub metadata on every plausible hit:

     | Library | Generic req/resp | Generic middleware | Injectable registry | Last push | Stars |
     |---|---|---|---|---|---|
     | Go-MediatR | yes | **no** | **no** | 2025-05-08 | 279 |
     | The127/mediatr | yes | **yes** | **yes** | 2026-08-24 | **0** |
     | ssengalanto/midt | no (`any`) | no | yes | 2026-08-01 | 6 |
     | Oleexo/mediator-go | yes | no (`BaseRequest`) | yes | 2025-01-11 | 0, GPL-3.0 |
     | adzeitor/mediatr | — | — | — | 2020 | 13 |

     `The127/mediatr` is the only library meeting all three criteria and is valuable as an
     **existence proof**, not as a dependency: zero stars, zero tags, zero releases, absent
     from the module proxy, single author, everything since 2026-04-29 is Dependabot, and
     `NewMediator()` returns an **unexported** type that cannot be named in a consumer's own
     signatures. `Oleexo/mediator-go` is GPL-3.0, disqualifying for this repo regardless of
     merit. No mature, maintained Go library offers all three properties.
  7. **Auto-registration — a decision-relevant correction, stated prominently because it
     sharpens D5.** D5 records that Tracking accepts manual wiring because type-safe dynamic
     registration is impossible in Go. This re-verification sharpens that: **Go-MediatR does
     not offer auto-registration either.** Per `mediatr.go:248-256`, a consumer still
     hand-writes one `RegisterRequestHandler[*GetMyTracking, *TrackingResult](h)` per handler.
     What is "automatic" is only that *dispatch* later finds the handler by `reflect.Type` key
     instead of the call site naming it. So the hand-rolled bus surrenders a **map lookup**,
     not a registration step — the same number of hand-written lines in `main.go`, spelled
     `Wrap(...)` instead of `RegisterRequestHandler[...]`. The registry's one genuine benefit
     is late binding (calling `Send` without holding a reference to the handler), which in a
     service whose `main.go` already wires every dependency explicitly is not a benefit but
     the mechanism by which the handler becomes invisible to the compiler.

  **Why the three properties cannot coexist, fundamental to the language:** Go has no runtime
  discovery of generic instantiations — `reflect` sees a concrete `*GetMyTracking` but cannot
  enumerate "everything implementing `Handler[Q,R]`" — no assembly scanning like .NET's
  `AddMediatR(Assembly)`, and no decorators like TypeScript's. The linker also deliberately
  drops unreferenced symbols, so a handler nothing references is not in the binary to be
  discovered. The nearest approximation, `init()` self-registration with blank imports, is
  still one hand-written line per handler package (merely relocated somewhere harder to
  trace) and can only write into a **package-level global**, because `init()` takes no
  arguments and runs before `main()` builds anything. That is the root of the collision:
  registration without an explicit call from wiring code must write to global state, and a
  heterogeneous global registry must be `interface{}`-valued, which erases the types
  middleware needs. Go-MediatR is not badly designed here — it occupies the only shape the
  language allows.

  **The escape hatch worth recording:** `go:generate` codegen that walks the use-case package
  and emits the `Wrap(...)` calls into `main.go` DOES yield all three properties, because
  discovery happens at build time against source (where types are still visible) and the
  output is ordinary typed code the compiler checks. It is the Go-idiomatic answer if the
  per-handler wiring lines ever become tiresome, and it **composes with** the hand-rolled bus
  rather than replacing it. Recorded here as a future option, not as work in this spec's
  scope.

  **Verdict: the rejection stands**, now on stronger evidence than when first made. The
  re-verification was explicitly willing to overturn it, and the source did not support that.
- The absence of a maintained, generic, injectable mediator in a language Go's size is itself
  the finding. Note the codebase's own CONTRACT in `create_tracking.go` about narrow
  per-use-case ports — a central bus applies that same widening pressure one layer up, and the
  hand-rolled design below (D1, D5) is deliberately narrow for the same reason.

#### go-mink — evaluated 2026-09-19, rejected for Tracking

The user asked about `go-mink` (https://go-mink.dev/ ,
https://github.com/AshkanYarmoradi/go-mink), Apache-2.0, self-described "Production-ready
event sourcing & CQRS toolkit" positioned as "MartenDB for Go". Verified via the GitHub API
on 2026-09-19: **29 stars, 1 fork, 1 watcher, 4 open issues**, created 2025-12-27, last push
2026-09-10, 595 commits, not archived.

Rejected for Tracking on three independent grounds:

1. **It is an event-sourcing toolkit, and its read side is not a bus.** A first pass of this
   evaluation claimed the command bus returned only an error; that was wrong, and the source
   corrects it: `CommandBus.Dispatch(ctx, cmd) (CommandResult, error)` does return a value
   synchronously, where `CommandResult` carries `AggregateID`, `Version` and a
   `Data interface{}`. What actually disqualifies it is different and sharper:
   - **There is no query bus.** The repository has `bus.go`, `command.go`, `handler.go`,
     `projection.go` and `repository.go`, but no `query.go`/`query_bus.go`, and the tutorial
     lists "Projections & Queries" as *future* content. Reads go through
     `ReadModelRepository[T any]` (`Get`/`Find`/`FindOne`/`Count` over a fluent `Query`
     builder) — a repository over projected read models, not a handler dispatched through a
     pipeline. Tracking's `GET /v1/trackings/{order_id}` would therefore bypass the pipeline
     entirely, leaving the per-handler `WorkflowSpan` repetition (the actual problem) untouched.
   - **The result and the middleware are untyped.** `CommandResult.Data` is `interface{}`, so
     every read of it needs a type assertion, and middleware is
     `func(next mink.MiddlewareFunc) mink.MiddlewareFunc` with no generics — the same defect
     that disqualifies Go-MediatR above, losing type safety exactly in the pipeline.
   - **`CommandResult` returning `AggregateID`/`Version` is the tell**: the model assumes
     event-sourced aggregates. Tracking has ordinary MySQL tables via sqlc. Adopting go-mink
     means adopting event sourcing, projections and read models — a far larger architectural
     change than the observability pipeline this spec is about.
2. **PostgreSQL only.** Its production adapter is Postgres plus an in-memory adapter for
   tests. Tracking is on Aurora **MySQL**. This alone disqualifies it.
3. **Adoption is near-zero.** 1 fork and 1 watcher means essentially no production use,
   despite the "v1.0.0 Production Ready" label. 595 commits in ~9 months shows genuine effort
   and the license is clean, but for a service's dispatch layer the abandonment risk is not
   justifiable.

The contrast with Wolverine, stated fairly: Wolverine earns its place in Orders because of
evidence of real use — a first-class `CIMySql` job, 27 commits to its MySQL persistence
module since Jan 2026, and sharing MySqlConnector 2.4.0 with Pomelo so the outbox enlists in
EF Core's transaction with no adapter. go-mink has no equivalent evidence yet.

Honest counterweight: go-mink is a more serious project than its star count suggests —
`ReadModelRepository[T any]` is well shaped and uses generics correctly, and 595 commits in
~9 months is real work. It would be worth revisiting for a **new** service that genuinely
wants event sourcing on PostgreSQL. It is not wrong — it is wrong *here*: adopting it in
Tracking would mean restructuring the service around aggregates, events and projections,
which is a different decision from the one this spec makes.

## Approved decisions

### D1 — Align on the contract, not on a shared library

One shape, two native implementations:

- **Orders** (.NET): Wolverine 6.39.0.
- **Tracking** (Go): hand-rolled generic `Handler[Q,R]` / `Middleware[Q,R]` / `Wrap`, ~60 LOC,
  in `internal/bus/`.

### D2 — The bus lives per service; only the contract is shared

No shared package. These are two different languages; the shared artifact is the documented
convention in the vault ([[cqrs]]), not code.

### D3 — Uniform call shape across services

```
Orders (C#)     bus.InvokeAsync(new GetOrder(id))
Tracking (Go)   bus.Send(ctx, GetMyTracking{...})
```

### D4 — Uniform behavior pipeline, same order in both

```
tracing -> app_event -> logging -> validation -> handler
```

This absorbs the per-handler rituals catalogued above. The behaviors must reproduce the
**existing** semantics exactly — `app_event: <flow>_started|_succeeded|_failed` plus `reason`
on failure, no SUCCESS severity, unknown fields omitted never null (see
[[logging-context]]). The pipeline must preserve the distinction between a routine non-happy
path and a genuine error rather than flattening every non-happy path into an error — see the
test-validity traps below, which document exactly this class of bug in practice.

### D5 — Handler auto-registration: per-stack, per what's actually safe

- **.NET**: yes — Wolverine's convention-based discovery, free.
- **Go**: no — type-safe dynamic registration is not possible without
  `map[reflect.Type]any` and the assertions that follow (precisely why Go-MediatR's middleware
  is untyped, and precisely the shape of mismatch that ruled out go-mink above for a different
  reason). Manual wiring in `main.go` is the accepted cost of full type safety. The user
  explicitly accepted manual registration where auto-registration isn't clean, provided it is
  documented as a rule for future sessions. The 2026-09-19 re-verification of Go-MediatR
  sharpens this further (see Research findings, point 7): even a library offering a global
  registry does not buy auto-registration — a handler still has to be registered by hand, one
  call per handler, in exchange for a `reflect.Type` lookup instead of a direct reference. The
  hand-rolled bus in D1 gives up nothing over that trade.

### D6 — Transactional outbox in both services, in this same refactor

User's explicit choice over the recommended split (deferring the outbox). Each service gets
**its own outbox table in its own database** — there is no shared outbox store (see
"Considered and rejected" below).

- **Orders**: Wolverine's durable outbox (`WolverineFx.MySql` +
  `WolverineFx.EntityFrameworkCore`). Must **begin with a validation spike** for EF Core +
  MySQL + Pomelo — the combination is CI-tested and the transaction-sharing is sound by
  construction (see Research findings), but MySQL is a lightly-travelled path for Wolverine
  (~27k downloads vs. 4.2M for Postgres) and this repo could be an early reporter on an edge
  case. The spike de-risks that exposure; it is not chasing an uncertified integration.
- **Tracking**: `oagudo/outbox` v1.0.1 — explicit MySQL support, broker-agnostic (works with
  the existing SNS publisher), and its "unmanaged" mode accepts a transaction the caller
  already owns, which fits sqlc's `database/sql` usage.

#### Blast radius — only publishing handlers are touched

Phase 2 only affects handlers that publish an event today. Every query handler and every
non-publishing command is untouched by Phase 2 — it only ever sees the Phase 1 bus change.
Measured in the codebase on 2026-09-18, that is **2 handlers total**:

- **Orders (1)** — `src/Orders.Infrastructure/Orders/CreateOrderService.cs`.
- **Tracking (1)** — `internal/app/update_status.go`, publishing via
  `internal/adapter/notify/status_changed.go`.

This bounds the risk of Phase 2: it is a targeted change to 2 write paths across two
services, not a rewrite of every handler that Phase 1 already touched.

#### Per-service migration mechanism and the poller as a component

Each service's outbox table is created through that service's **existing** migration
mechanism, in its **own** database — database-per-service is preserved, nothing is shared:

| Service | Engine | Migration mechanism | Who creates the table |
|---|---|---|---|
| Orders | Aurora **MySQL** | EF Core (`src/Orders.Infrastructure/Migrations/`) | Wolverine (can auto-create its schema) |
| Tracking | Aurora **MySQL** | golang-migrate (`migrations/*.sql`) | us (schema documented by `oagudo/outbox`) |

The **poller is a distinct component per service**, not just a table. Orders gets Wolverine's
built-in durability agent for free. Tracking needs a poller **process** written and operated
as part of this refactor — `SELECT ... FOR UPDATE SKIP LOCKED` so that running multiple
instances of the service doesn't double-publish the same outbox row. That poller is real,
separately-planned work, not an implicit side effect of adding a table.

#### Considered and rejected — a single shared outbox database

Orders and Tracking run on Aurora **MySQL**, but on two separate clusters conceptually
addressed per-service in `infra/environments/local/main.tf` — a shared outbox store was
considered and rejected because it would put the business write and the outbox write in
**two different transactions against two different databases**, reintroducing exactly the
loss window the outbox exists to close (closing that gap without a shared database would
require distributed transactions — 2PC/XA — which this repo does not run anywhere and is not
taking on here). The database-per-service outbox in D6 is what keeps the business write and
its outbox row atomic.

#### Shape change in the affected handlers

Today, each of the 2 handlers above does two independent operations — write to its database,
then publish to SNS — with a failure window between them where an event can be lost if the
process dies after the write but before the publish. Under the outbox, the handler writes the
business row and the outbox row in **one transaction**; a separate poller (or, for Orders,
Wolverine's durability agent) publishes afterward by reading the outbox table. Concretely:

- **Orders**: sound by construction, per the MySqlConnector-sharing fact in Research findings
  — `Wolverine.MySql` and Pomelo both depend on MySqlConnector 2.4.0, so the outbox write
  enlists in EF Core's existing transaction with no adapter layer.
- **Tracking**: `oagudo/outbox`'s unmanaged mode takes the `database/sql` transaction the
  caller already owns, so the outbox write joins the transaction `update_status.go` already
  has open.

### D7 — Sequence the work in two phases inside one milestone

A review stop point sits between them:

- **Phase 1** delivers the bus + behaviors + registration in both services. **Phase 1 touches
  no database at all** — the bus is pure in-memory dispatch. No schema changes, no
  migrations, and no new persistence in either service. Every handler keeps writing to the
  same tables it writes to today; only *how it is invoked* changes.
- **Phase 2** delivers the outbox in both services. This is the only phase that touches a
  database — new tables, new migrations, and a new poller component per service (see D6).

This keeps a large refactor reviewable without reducing the approved scope, and it means a
Phase 1 rollback is a code-only revert with no data migration to unwind.

## Architecture

### The contract, expressed abstractly

Four concepts, present in both implementations under different names:

- **Message** — a command or query: a plain data-carrying type, no behavior.
- **Handler** — one function/method per message type: `(Message) -> Result`.
- **Behavior** (a.k.a. middleware/pipeline-step) — wraps a handler invocation:
  `(Message, next) -> Result`, where `next` is either the next behavior or the handler itself.
  Behaviors compose into a fixed pipeline (D4).
- **Bus** — the single entry point transport code calls: resolves the handler for a message's
  type, wraps it in the behavior pipeline, and invokes it.

The bus itself is **pure in-memory dispatch** — it holds no state and touches no database. It
is a routing and composition mechanism, not a persistence layer. Persistence only enters the
picture in Phase 2 (D6, D7), and only for the 2 handlers that publish events.

### Per stack

**Orders (.NET / Wolverine)**

```csharp
public record GetOrder(string OrderId) : IQuery<OrderDto>;

public class GetOrderHandler
{
    public GetOrderHandler(IOrderReadService reads) { ... }

    public Task<OrderDto> Handle(GetOrder query, CancellationToken ct) { ... }
}

// call site
var order = await bus.InvokeAsync(new GetOrder(id));
```

Behaviors are Wolverine middleware classes registered once in the pipeline configuration, not
per handler.

**Tracking (Go / hand-rolled, generic)**

```go
type Handler[Q any, R any] func(ctx context.Context, q Q) (R, error)
type Middleware[Q any, R any] func(Handler[Q, R]) Handler[Q, R]

func Wrap[Q any, R any](h Handler[Q, R], mws ...Middleware[Q, R]) Handler[Q, R] {
    for i := len(mws) - 1; i >= 0; i-- {
        h = mws[i](h)
    }
    return h
}

// call site (wiring is manual per D5/Go)
getMyTracking := bus.Wrap(getMyTrackingHandler, tracingMW, appEventMW, loggingMW, validationMW)
result, err := getMyTracking(ctx, GetMyTracking{...})
```

There is no runtime registry: each handler's wrapped instance is built once in `main.go` and
passed to the HTTP layer directly. `bus.Send` in D3 refers to invoking one of these
pre-wrapped functions, not a lookup by type.

## Per-service migration plan

**Orders** — migrates **endpoint by endpoint**, since `WolverineFx.Http` is opt-in per
endpoint and coexists with the existing `MapGet`/`MapPost` delegates. The app runs in a mixed
state (some endpoints on Wolverine, some still on the direct-call path) for the duration of
the migration, and that is expected, not a regression.

The code is already shaped for this: `CreateOrderEndpoint` already calls
`service.CreateAsync(new CreateOrderCommand(...))`, which is a Wolverine handler with a
different method name — the migration is largely renaming `CreateAsync` -> `Handle` and
keeping the constructor dependencies as-is, not restructuring the call shape.

Recommended order, and the reasoning behind it:

1. **Start with a read-only endpoint** (`OrderReadService`) to prove handler discovery,
   middleware wiring, and the `IWorkflowTracer` -> tracing-behavior mapping with zero
   transactional risk — `[NonTransactional]`, no `BeginTransactionAsync` involved.
2. **Then a write path**, once the read path has validated the pipeline.
3. **`CartWriteService.cs:165` (the concurrent-PUT retry) gets its own explicit task and its
   own review step, separate from the rest of the write-path migration.** It is the same class
   of concurrency requirement CLAUDE.md flags as the highest-risk case for review, and
   structurally not exercised by ordinary tests — see
   [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]. Do not fold it into a
   larger "migrate CartWriteService" task where it can pass review unnoticed.
4. **Keep `SnsEventPublisher` behind `IEventPublisher` initially** and let the outbox call it
   through that interface, rather than adopting Wolverine's SNS transport. This buys
   transactional guarantees (the outbox write) without also taking on SNS as a Wolverine
   transport, which is publish-only in this repo's usage (no listening, no request/reply) and
   would be a second migration bundled into this one.

See Risks and open questions for the transactional-middleware conflict this ordering is
designed around.

**Tracking** — handlers currently invoked directly from
`internal/adapter/http/handler_reads.go` (and sibling handler files) move behind
`bus.Wrap(...)`-built functions; the `tracing.WorkflowSpan(...)` call moves from the HTTP
handler into the tracing behavior, correcting the layer mismatch noted in Context/Problem.

Phase 2 (D6, outbox) applies after Phase 1 lands and is reviewed, per D7.

## Testing

All three layers apply per [[testing]] — unit/integration, internal E2E, and gateway E2E with
a real Cognito JWT — and this refactor adds one category on top: **bus behaviors need their
own unit tests**, independent of any single handler, covering the pipeline order (D4) and the
routine-not-found-is-not-ERROR distinction (D4).

The refactor is **behavior-preserving**: existing handler tests must keep passing unchanged.
A handler test that has to change to keep passing is a signal the refactor altered externally
visible behavior, which is out of scope here — this spec only changes how handlers are
invoked and where cross-cutting concerns are applied, not what any handler does.

### Test-validity traps found during the (now-reverted) Users work

The Users hand-rolled-bus branch was reverted (superseded by
[[2026-09-19-users-nestjs-migration-design]]), but before that it surfaced three test-validity
traps that are framework-independent and will recur in Go and .NET exactly as they did in
Node. Each was caught by **mutation testing**, never by a green suite:

1. A test-local OTel tracer provider was a silent no-op — the global OTel API accepts only the
   **first** registration per process, so the spans asserted on were never actually exported.
2. A db stub returning `null` unconditionally silently forced 6 of 18 tests down a "not found"
   branch where they asserted nothing, while all 18 stayed green.
3. A generic pipeline catch stamped `reason: "unhandled_error"` over a handler's specific
   reason (`span.setAttributes` is last-write-wins per key), destroying it — and 709 tests
   stayed green because every test exercised the handler directly rather than through the bus.

The lesson to carry forward: **a green suite is not evidence of the property you care about;
mutate the code and confirm the test fails.** This applies especially to the Wolverine
middleware mapping (Orders) and the hand-rolled middleware work (Tracking) in this refactor —
both are new pipeline layers whose entire job is cross-cutting correctness (tracing, `reason`,
`app_event`), which is exactly the class of property a suite built by calling handlers
directly cannot verify. Any test asserting on a behavior's output should go through the real
bus, not call the handler underneath it, and the critical span/log assertions in both
services' behavior tests are good mutation-testing candidates.

## Observability

The behavior pipeline (D4) must reproduce current semantics exactly, not approximately:

- `app_event: <flow>_started` at pipeline entry, `<flow>_succeeded` or `<flow>_failed` at
  pipeline exit, matching the flow-naming already in use (see [[logging-context]]).
- `reason` present on `*_failed`, absent (never null) otherwise.
- No SUCCESS severity — success is `INFO` + `app_event=*_succeeded`.
- The routine-not-found nuance: a domain "not found" that a route later turns into a 404 is a
  normal return value, not a thrown error. It must produce `*_failed` + `reason` in logs
  **without** marking the span status ERROR. A pipeline that catches exceptions to log
  failures and treats every non-happy-path return the same way would flatten this distinction
  — the behavior must inspect the handler's result (or a typed "routine failure" signal), not
  just catch/no-catch. This is the same distinction the test-validity traps above exist to
  guard.
- The full shared-context field set (`trace_id`, `order_id`, `tracking_id`, `duration_ms`,
  etc.) continues to attach exactly as [[logging-context]] defines — the bus changes where the
  logging call is made, not what it logs.

## Risks and open questions

- **Headline risk — Wolverine's default transactional middleware conflicts with Orders'
  explicit transaction management.** Wolverine's transactional middleware in default Eager
  mode opens its own transaction and calls `SaveChangesAsync()` for the handler. Orders has
  three explicit `BeginTransactionAsync` calls that would conflict with that: `CreateOrderAsync`
  in `src/Orders.Infrastructure/Orders/CreateOrderService.cs:128`, and two call sites in
  `src/Orders.Infrastructure/Carts/CartWriteService.cs:113` and `:165` (the latter is the
  concurrent-PUT retry). There is also a `ForUpdateInterceptor` that rewrites SQL to append
  `FOR UPDATE` on tagged queries, which has to keep working inside whichever transaction ends
  up owning the connection. Wolverine's open issue #1735 covers exactly this friction
  (https://github.com/JasperFx/wolverine/issues/1735). Two mitigations, to be decided per
  handler during migration: mark the handler `[NonTransactional]` and flush the outbox
  manually, or restructure so Wolverine owns the transaction and the `FOR UPDATE` queries run
  inside it. This risk outranks the MySQL-durability one below, because it is a correctness
  hazard on the write path (including the concurrency-sensitive cart retry) rather than an
  infrastructure-maturity question — see the migration-plan ordering above, which exists
  specifically to surface and review this before it reaches the highest-risk handler.
- **Separate read/write DbContexts reduce risk here, and fail loudly if misconfigured.** A
  Wolverine handler chain may have only one transactional `DbContext`; if a handler exposes
  two `DbContext`-shaped dependencies, Wolverine fails at **startup**, not silently at
  runtime. Disambiguate with `[Transactional(typeof(OrdersWriteDbContext))]` /
  `[Storage(typeof(OrdersWriteDbContext))]` on write handlers, and `[NonTransactional]` on read
  handlers. This is a lower-severity item than the paragraph above precisely because the
  failure mode is a startup error, not a latent bug.
- **Secondary risk — Wolverine's MySQL durability path is lightly travelled.** Now confirmed
  CI-tested and, by the MySqlConnector-sharing argument in Research findings, sound by
  construction — this is no longer an "uncertified combination" risk. It remains a
  download-count risk: ~27k downloads for MySQL support vs. 4.2M for Postgres, so this repo
  could be an early reporter on an edge case. The Phase 2 Orders spike (D6) exists to surface
  that before the rest of Phase 2 Orders work proceeds; if it fails, the fallback is the same
  hand-rolled outbox design as Tracking.
- **Scope/size risk of doing bus + outbox together.** D7's two-phase sequencing inside one
  milestone is the mitigation, not an elimination — this remains a substantial refactor
  touching every command/query handler in two services plus a durability mechanism in two
  storage engines. The review stop point between Phase 1 and Phase 2 is load-bearing, not
  optional.
- **Orders endpoint migration order** is left open (see Per-service migration plan) —
  reads-before-writes is the stated intent, not a committed sequence.
- **Tracking's manual wiring in `main.go`** will grow linearly with handler count (D5/Go, no
  registry). Whether that becomes unwieldy enough to revisit is an open question for a later
  session, not this one — flagged here so it isn't rediscovered from scratch.

## Out of scope

- Users (Node): superseded entirely by [[2026-09-19-users-nestjs-migration-design]] — its
  hand-rolled bus, DI wiring, and migration plan are no longer part of this refactor.
- Extracting any shared bus code across languages (rejected explicitly in D2).
- Changing any handler's externally visible behavior — this is a dispatch-and-plumbing
  refactor (see Testing).
- events-pipeline: not part of this refactor; it already runs a different dispatch model
  (per-record processing) not addressed here.
- Choosing Orders' exact endpoint migration order — an implementation-time finding (see Risks
  and open questions).
- Any broker/topology change for Tracking's SNS publisher beyond what `oagudo/outbox`'s
  unmanaged mode requires to accept an existing transaction.
- Adopting go-mink for Tracking (rejected above) — flagged as a candidate for a **future new
  service** that wants event sourcing on PostgreSQL, not for this refactor.

## Related

- [[2026-09-18-cqrs-dispatch-tracking-orders]] — the task-by-task implementation plan executing this spec.
- [[cqrs-dispatch-all-services-milestone]] — the milestone-level map this spec's two workstreams sit in.
- [[cqrs]]
- [[ADR-0002-cqrs]]
- [[dependency-injection]]
- [[screaming-architecture]]
- [[logging-context]]
- [[testing]]
- [[2026-09-19-users-nestjs-migration-design]]
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]
- [[2026-09-18-cqrs-rule-lived-only-in-the-vault-not-in-the-file-agents-read-first]]
- [[orders-service-design]]
- [[tracking-service-design]]
</content>
