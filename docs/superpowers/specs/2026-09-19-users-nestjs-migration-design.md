---
title: Users Service — NestJS Migration
type: spec
area: users
status: draft
created: 2026-09-19
updated: 2026-09-19
tags: [type/spec, area/users, status/draft]
propagates-to:
  - "[[users-service-design]]"
  - "[[cqrs]]"
  - "[[dependency-injection]]"
  - "[[testing]]"
related:
  - "[[users-service-design]]"
  - "[[cqrs]]"
  - "[[dependency-injection]]"
  - "[[testing]]"
  - "[[2026-09-18-cqrs-bus-refactor-design]]"
  - "[[ADR-0002-cqrs]]"
  - "[[ADR-0008-screaming-arch-di]]"
  - "[[screaming-architecture]]"
  - "[[logging-context]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[openapi-specs]]"
  - "[[grpc-context-activate-at-dispatch]]"
  - "[[2026-07-12-prisma-lazy-promise-als]]"
  - "[[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]"
---

# Users Service — NestJS Migration

## Context / Problem

The Users service is the repo's only Node.js service: Fastify 5 + Awilix DI (PROXY
injection) + Prisma 7 + Zod. Measured on 2026-09-19:

- `src/features/` — 4,189 lines across 31 files (commands, queries, domain, HTTP routes,
  webhooks, gRPC, messaging).
- `src/shared/` — 3,466 lines across 41 files (config, db, DI, audit, auth, cache,
  logging, messaging, metrics, observability, realtime).
- `tests/` — 10,282 lines, 663 tests (74 test files).

The user has decided Fastify is not a strong enough framework for this service's
long-term shape and wants to migrate it to **NestJS**, primarily to adopt
`@nestjs/cqrs` (`CommandBus`, `QueryBus`, `EventBus`) plus Nest's surrounding
structure — modules, DI, interceptors, guards, pipes — as the home for the
cross-cutting concerns (tracing, structured logging, validation) that today are
hand-repeated per handler.

### Why the earlier `@nestjs/cqrs` rejection is superseded, not contradicted

[[2026-09-18-cqrs-bus-refactor-design]] (in the working tree at the time of this
writing, uncommitted) designed a hand-rolled CQRS bus for all three services and
explicitly rejected `@nestjs/cqrs` for Users:

> `@nestjs/cqrs` disqualified: its `CommandBus` takes `ModuleRef` and requires
> booting a second Nest DI container beside Awilix. Its 462k downloads/week
> measure NestJS adoption, not standalone viability.

That reasoning is correct **for a Fastify service** — `@nestjs/cqrs`'s `CommandBus`
is built against Nest's `ModuleRef`, and bolting a second DI container onto Awilix
just to get a bus was a real proportionality problem (the earlier spec's hand-rolled
Node bus was ~150 LOC against `mediatr-ts`'s 2,794 downloads/week for comparison).
**Migrating the framework itself removes the objection at its root**: once Users runs
on Nest, `ModuleRef` is already there, there is no second container to boot, and
`@nestjs/cqrs` becomes the natural, idiomatic choice for the exact three things
[[2026-09-18-cqrs-bus-refactor-design]] wanted from a Node bus — a `CommandBus`, a
`QueryBus`, and a pipeline for cross-cutting concerns — at 462k downloads/week
versus `mediatr-ts`'s 2,794. This spec does not reopen that decision; it changes the
premise it was made under.

### Hard-won findings that must carry forward

The `feature/cqrs-bus-refactor` branch (commit `82d21a7`, now archived; its "6a/6b"
work sits in a git stash) explored a hand-rolled bus for Users and was reverted, but
five findings from that work were discovered **by measurement**, not theory, and
will recur under Nest's own interceptor pipeline exactly as they would have under a
hand-rolled one. They are binding constraints on this migration's interceptor
design, not historical trivia:

1. **The routine-vs-thrown distinction.** A "not found" is a ROUTINE outcome: it
   logs `app_event: <flow>_failed` + `reason`, but the span status stays `OK`. Only
   a thrown error sets `ERROR`. Flattening these — e.g. an interceptor that treats
   every non-happy-path the same way — is a real observability regression that
   passes review unnoticed. See `get-me.ts` (`doGetMe`, lines 40–45: a missing user
   sets `app_event: get_profile_failed` + `reason: user_not_found` on the active
   span **without** touching span status, because the return value `null` never
   reaches `withWorkflowSpan`'s catch) and the equivalent shape in
   `list-notifications.ts`.
2. **Granular failure reasons must not be clobbered.** Auth commands record specific
   reasons (`passwordless_user`, `invalid_credentials`, `cognito_error`,
   `invalid_otp`, `unknown_user`) on the span. A generic interceptor that stamps
   `reason: "unhandled_error"` in its own catch **overwrites** them, because
   `span.setAttributes` is last-write-wins per key. This was proven empirically.
   Existing tests assert these exact values: `login.test.ts` asserts
   `invalid_credentials` (line 107) and `passwordless_user` (lines 56, 120);
   `change-password.test.ts` (lines 148–151) asserts `reason: "cognito_error"` on a
   span whose status is `ERROR` after `command.execute(...)` rejects. A generic
   interceptor **must defer to an already-recorded specific reason** and fall back
   to `"unhandled_error"` only when none was recorded. This applies to **both** the
   thrown branch (`change-password.ts`'s Cognito-rejection path) and the
   non-throwing routine branch (`change-password.ts`'s unresolved-caller path,
   which stamps its span then returns `null` — see `change-password.test.ts` lines
   152+).
3. **One failure = one `*_failed` log line.** When a handler already logged its own
   specific line, the generic interceptor must suppress its own — a double log line
   per failure is a real regression a "just wrap everything" interceptor produces by
   default.
4. **Tests that exercise a handler directly do NOT prove pipeline behavior.** 709
   tests passed green while the production path emitted the wrong reason, because
   every test called the command directly instead of going through the bus. Any
   test for interceptor behavior must go through the real pipeline (Nest's
   `Test.createTestingModule()` with the actual `CommandBus`/interceptor wired in,
   not a direct handler call).
5. **A green suite is not evidence.** Three separate vacuous-test traps were found
   by mutation testing during that work: a test-local OTel provider that was a
   silent no-op (the global OTel API only accepts the first registration per
   process), a db stub returning `null` unconditionally that forced 6 tests down a
   branch where they asserted nothing, and the reason-clobber in finding #2.
   Mutation-testing the critical assertions (span status, `reason`, `app_event`) is
   recommended for this migration's interceptor tests specifically, because this is
   exactly the class of bug a green suite hid before.

## Approved decisions

Every decision below came out of the brainstorming session that produced this spec
and is **already approved** — it is documented here, not proposed.

### D1 — Scope: the Users service only

Orders (.NET) and Tracking (Go) are untouched by this migration — different
languages, already running their own frameworks (ASP.NET Core Minimal APIs +
Wolverine per [[2026-09-18-cqrs-bus-refactor-design]]; Gin per
[[ADR-0021-tracking-go-gin-sqlc-stack]]). The events-pipeline Lambda (TypeScript) is
**explicitly out of scope**: Nest adds cold-start weight to a Lambda invocation, and
that tradeoff was not taken — the Lambda keeps its current per-record dispatch
model.

### D2 — Transition: build Nest in parallel; delete Fastify only when Nest passes the E2E suite

The service stays on Fastify and deployable throughout the migration. There is no
half-migrated window shipped to any environment. The Nest implementation is built
alongside the Fastify one inside the same repository, and the cut-over — deleting
the Fastify code — is a **single decision point** gated on evidence (D3), not a
gradual strangler-fig replacement of individual routes.

### D3 — The E2E suite is the contract and the definition of done

84 E2E tests cover Users today and are framework-agnostic — they hit the service
over real HTTP/WebSocket/gateway, never importing Fastify or Nest internals.
Counted on 2026-09-19:

| Spec | Tests |
|---|---|
| `e2e/tests/users.spec.ts` | 11 |
| `e2e/tests/cache.spec.ts` | 21 |
| `e2e/tests/notifications.spec.ts` | 13 |
| `e2e/tests/account-deletion.spec.ts` | 10 |
| `e2e/tests/password-reset.spec.ts` | 9 |
| `e2e/tests/otp.spec.ts` | 5 |
| `e2e/tests/gateway/users.spec.ts` | 10 |
| `e2e/tests/gateway/notifications.spec.ts` | 5 |
| **Total** | **84** |

The gateway specs go through JWT authorizer → njs → nginx → service with a real
Cognito JWT, so they prove the external contract end-to-end — the same contract a
real client depends on, independent of which framework serves it.

**These specs are not modified by this migration.** All 84 passing against the Nest
implementation is the gate for deleting the Fastify implementation. If a spec
cannot pass unmodified against Nest, that is a migration defect to fix in the Nest
code, not a reason to touch the spec.

### D4 — The 663 unit/integration tests are rewritten, not ported

They are coupled to `buildApp(container)` + `app.inject()` and an Awilix test
container — constructs that do not exist in Nest. They become Nest tests via
`Test.createTestingModule()`. **Their assertions are the specification of behavior**
and must be preserved in substance — this is a rewrite of the test *harness*, not a
relaxation of what is verified.

Explicitly: assertion strength must not be weakened in translation. No `toEqual` →
`toMatchObject`, no dropped assertions, no assertion quietly turned into a `.not
.toThrow()`-only check. This matters because the rewrite is exactly the place where
that erosion is invisible — a rewritten test that still passes gives no signal that
it verifies less than the original did. Reviewers of the rewritten suite must diff
assertions against the original test, not just confirm the new one is green.

### D5 — Stack kept from the current service

- **Prisma 7**, unchanged. The single client composing the cross-cutting extension
  (nano-id + audit + soft-delete + computed `isDeleted`, see
  `shared/db/prisma-extensions.ts`) and `@prisma/extension-read-replicas` stay as
  they are. Only **how the client is injected** changes: a Nest provider (e.g. a
  `PrismaModule` exporting the client via `useValue`/`useFactory`) instead of an
  Awilix `asValue` registration in `awilix-container.ts`.
- **Fastify adapter** (`@nestjs/platform-fastify`), **not** Express. Verified:
  `@nestjs/platform-fastify@12.0.3` depends on `fastify@5.12.4` — the same Fastify
  major version already in use (`package.json` pins `"fastify": "^5.0.0"`). Nest
  keeps talking to a Fastify HTTP server underneath; what changes is that Nest, not
  hand-written route registration, owns the routing/DI/lifecycle layer on top of it.
- **Zod** for validation, not `class-validator`/`class-transformer` — via a
  hand-rolled pipe, not a Zod↔Nest bridge library. See D8.
- **The existing OTel wiring**, unchanged in mechanism:
  - The SDK is loaded via `node --import` (`package.json`'s `start`/`dev` scripts
    already do this against `src/shared/observability/tracing.ts`), not imported in
    application code — this repo is ESM, where static imports are hoisted and
    resolved before any module body runs, so importing the SDK "first" in code still
    leaves instrumented libraries already loaded. Nest's bootstrap file
    (`main.ts`) is a normal ESM module and inherits this constraint exactly as
    `server.ts` does today.
  - The **manual gRPC server span** (`shared/observability/grpc-tracing.ts`) stays
    manual: the `x-api-key` interceptor's `ServerInterceptingCall` consumes the
    metadata before auto-instrumentation would see it, so the parent W3C context
    must be extracted in the interceptor and **activated in `onReceiveHalfClose`,
    not `onReceiveMetadata`** — the metadata callback returns synchronously, long
    before grpc-js dispatches the async handler, so activating there unwinds before
    the handler runs and produces a disjoint ROOT span (the JE-77 bug; see
    [[grpc-context-activate-at-dispatch]] and `services/users/CLAUDE.md` §"Logging
    & tracing in this service"). Nest's own gRPC transport (`@nestjs/microservices`)
    is **not** adopted for this reason — see the gRPC surface below and Risks.

### D6 — `@nestjs/cqrs` in full: CommandBus, QueryBus, and EventBus

Handlers are `@CommandHandler`/`@QueryHandler`-decorated classes, auto-registered
per Nest module (Nest's own module-scoped provider discovery, not a hand-rolled
registration map). This is the change that motivated the migration, and it resolves
three goals from [[2026-09-18-cqrs-bus-refactor-design]] at once: a uniform pipeline
for cross-cutting concerns, transport-decoupled handlers (an HTTP controller, the
SQS consumer, and the gRPC service can all dispatch the same command/query through
one bus), and registration without touching a Cradle-shaped file per handler.

### D7 — Cross-cutting concerns become Nest interceptors and pipes, not per-handler calls

- **Tracing / `app_event` / structured logging** as one or more `NestInterceptor`s
  wrapping command/query dispatch, replacing the current
  `public method -> withWorkflowSpan -> private doMethod` shape repeated by hand in
  all 15 handler files.
- **Zod validation** as a `PipeTransform`, replacing route-level Fastify/Zod schema
  wiring for request validation (response-schema generation is a separate concern —
  see D8, which resolves both).
- **The interceptor design must incorporate finding #2 from day one**: it defers to
  an already-recorded specific `reason` attribute and only stamps
  `"unhandled_error"` when none is present, on **both** the thrown and the routine
  (non-throwing) failure paths. This is not an optimization to add later — building
  the generic interceptor first and adding reason-deferral as a follow-up is exactly
  the sequence that produced the original clobber bug.

### D8 — Validation and OpenAPI generation both build on Zod directly, with no Zod↔Nest bridge library

Two related decisions, made together because the same measurement drove both: the
Zod↔Nest bridge ecosystem has not caught up to Nest 12, and the user chose to
eliminate that dependency risk entirely rather than accept a peer-mismatched
library at the validation layer.

**Validation — a hand-rolled `PipeTransform`, not `nestjs-zod` or
`@anatine/zod-nestjs`.** Verified on 2026-09-19: `nestjs-zod@5.5.0` declares peers
`@nestjs/common: ^10 || ^11` (not `^12`), and `@anatine/zod-nestjs@2.0.12` declares
peers `@nestjs/common: ^7...^11` (also not `^12`). Both stop at Nest 11 — not a
coincidence; Nest 12 is recent enough that the bridge ecosystem has not released
against it yet. Taking either package today would mean `--legacy-peer-deps` (or
pnpm's equivalent override) to force-install a library outside its own declared
support range, at the layer of the service responsible for rejecting malformed
input — precisely the risk the user chose to eliminate. `class-validator@0.15.1`
was the honest alternative (10.5M downloads/week, **zero** peer dependencies), but
adopting it means abandoning Zod and rewriting every schema as decorated DTOs,
losing Zod as the single source of types across validation and (per below)
OpenAPI generation. The user chose to keep Zod.

The pipe itself is small and owns no dependency risk:

```typescript
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}
  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (!result.success) throw new BadRequestException(/* map to the CURRENT error contract */);
    return result.data;
  }
}
```

Two requirements, stated explicitly because they are easy to lose in translation:

1. **The pipe must map validation failures to the same error response shape the
   service returns today.** The E2E specs (D3) assert on those response bodies —
   a differently-shaped validation error breaks the contract even though
   validation itself "works."
2. **The existing Zod schemas in `src/features/users/http/schemas.ts` and
   `src/features/notifications/http/schemas.ts` are reused unchanged.** This is a
   pipe-wiring change, not a schema rewrite.

**OpenAPI generation — `zod-to-json-schema` feeding `@nestjs/swagger`, not a
Fastify-specific generator.** Verified on 2026-09-19 against this repo's
`pnpm-lock.yaml`: `zod-to-json-schema@3.25.2` declares only
`peerDependencies: { zod: "^3.25.28 || ^4" }` — no Nest peer at all, so the Nest-12
mismatch above does not apply to it. The service's resolved Zod version is
**3.25.76** (`package.json` specifies `^3.23.0`; `pnpm-lock.yaml` resolves it to
3.25.76), which satisfies `^3.25.28` — compatibility is verified against the
version actually installed, not assumed from the `^3.23.0` specifier alone.
(`zod-openapi@6.0.2` was also considered and is a worse fit today: it requires
`zod: ^4.0.0`, which this service is not on.) `zod-to-json-schema` is already
present in this repo's lockfile, used elsewhere in the workspace.

The resulting path: the Zod schemas stay the single source of truth for both
validation (above) and OpenAPI shape; `zod-to-json-schema` converts each schema to
a JSON Schema fragment, fed into `@nestjs/swagger`'s document builder in place of
`@fastify/swagger` + `fastify-type-provider-zod`. **The exact wiring into
`@nestjs/swagger`'s document builder is the one piece not yet proven** — it belongs
in Phase 1 of the migration plan below, not the last phase, because
`services/users/openapi.yaml` is a committed artifact under a GOLDEN RULE
(`services/users/CLAUDE.md` §2a) imported into Apidog, and the migration should not
reach Phase 5's cut-over gate having deferred verification of its generation
mechanism to the end.

**Acceptance criterion for the regenerated `openapi.yaml` — a hard requirement, not
a nice-to-have**: the document generated under Nest must be *equivalent* to the
current one — every route's body/params/response resolving to a **named** `$ref`
(never an inline anonymous schema), **no orphan components**, and the same
component names where the current generator produces them (e.g. `Register` →
`RegisterInput`, per the existing `fastify-type-provider-zod` suffix convention
this service already registers around in `http/schemas.ts`). Verification is a
diff of the newly generated document against the current committed
`openapi.yaml`, performed as an explicit acceptance step — not "it builds without
errors." The current generator prunes components nothing `$ref`s
(`pruneOrphanComponents` in `routes.ts`); whatever replaces it must reproduce that
behavior, or the Apidog import degrades with unreferenced schema noise.
## Architecture

### Module layout

A first-pass module boundary, mapped from the current `screaming-architecture`
feature split ([[screaming-architecture]], [[ADR-0008-screaming-arch-di]]):

```
src/
├── main.ts                      — Nest bootstrap (NestFactory + FastifyAdapter)
├── app.module.ts                — root module, imports feature + shared modules
├── users/
│   ├── users.module.ts          — commands, queries, HTTP controller, gRPC service
│   ├── commands/                — @CommandHandler classes (register, login, refresh,
│   │                               sign-out, update-profile, forgot/confirm/change
│   │                               password, delete-account, register-passwordless,
│   │                               start/verify-otp-challenge)
│   ├── queries/                 — @QueryHandler classes (get-me, get-user-by-id)
│   ├── domain/                  — unchanged: User entity/mapping, no framework coupling
│   ├── http/                    — Nest controller(s) + Zod pipe wiring
│   ├── webhooks/                — Cognito identity-capture controller
│   └── grpc/                    — GetUserById gRPC service (see Surfaces below)
├── notifications/
│   ├── notifications.module.ts
│   ├── commands/                — create-notification, mark-notifications-read
│   ├── queries/                 — list-notifications
│   ├── domain/
│   ├── http/                    — notifications controller
│   └── messaging/                — SQS consumer (see Surfaces below)
├── shared/
│   ├── prisma/                  — PrismaModule (D5)
│   ├── auth/                    — AuthModule (Cognito provider, auth errors)
│   ├── cache/                   — CacheModule (ioredis, reset-code store)
│   ├── audit/                   — AsyncLocalStorage actor context (unchanged mechanism)
│   ├── logging/                 — structured logging, log-context ALS
│   ├── observability/           — tracing helpers, gRPC manual span, interceptors (D7)
│   ├── messaging/                — SNS event publisher
│   ├── metrics/                 — CloudWatch publisher + business-metrics poller
│   └── realtime/                — WebSocket publisher
└── config/                      — Zod-validated env, as a Nest ConfigModule-shaped provider
```

This layout is a **starting point for the parallel build**, not a frozen contract —
the exact module boundaries (e.g. whether `notifications` is its own top-level
module or nested under `users`) are an implementation-time decision, same status as
today's `src/features/<feature>/` split.

### How CQRS handlers and interceptors compose

```
HTTP controller / gRPC service / SQS consumer
        │  bus.execute(new SomeCommand(...))  /  bus.execute(new SomeQuery(...))
        ▼
   @nestjs/cqrs CommandBus / QueryBus
        │  (Nest's own interceptor chain wraps the bus call site, OR a
        │   `ExecutionContext`-based interceptor wraps controller methods that
        │   invoke the bus — see Risks: this needs a spike, not an assumption)
        ▼
   tracing/app_event/logging interceptor(s)  →  Zod validation pipe  →  handler
        │
        ▼
   @CommandHandler / @QueryHandler
```

The pipeline order mirrors [[2026-09-18-cqrs-bus-refactor-design]]'s D4 for the
other two services (`tracing -> app_event -> logging -> validation -> handler`),
kept here for cross-service consistency in the *shape* of the pipeline even though
the *mechanism* (`@nestjs/cqrs` interceptors vs. a hand-rolled behavior chain) is
Nest-specific to Users.

### How the seven surfaces map onto Nest

1. **HTTP** — 20 routes in `src/features/users/http/routes.ts` today (verified by
   counting registration calls on 2026-09-19: `r.get`/`r.post`/`r.patch`/`r.delete`
   invocations), covering auth, profile, passwordless OTP, password reset,
   notifications, the Cognito webhook, and E2E-only endpoints. Maps to Nest
   `@Controller()` classes with `@Get`/`@Post`/`@Patch`/`@Delete` handler methods,
   each dispatching a command/query through the bus. Response typing/OpenAPI
   generation moves to `@nestjs/swagger` fed by `zod-to-json-schema` — see D8.
2. **gRPC server** — `GetUserById` on `:50051` (`src/shared/grpc/`), guarded by a
   constant-time `x-api-key` interceptor, with the manual server span described in
   D5. **Nest's own gRPC transport (`@nestjs/microservices` `Transport.GRPC`) is not
   the obvious fit here** because that transport owns its own interceptor chain and
   context propagation, and the manual-span requirement (activate in
   `onReceiveHalfClose`, not `onReceiveMetadata`) was discovered by needing to
   reach into `@grpc/grpc-js`'s `ServerInterceptingCall` directly. Two options, to
   be resolved at implementation time: (a) keep the current hand-built `@grpc/grpc-js`
   server as a Nest-external process that calls into the Nest application context
   (`NestFactory.createApplicationContext`) to dispatch commands/queries through the
   same bus, or (b) adopt `@nestjs/microservices`' gRPC transport and re-verify the
   JE-77 fix still holds under its interceptor model. Flagged as an open question
   below — **do not assume either option without verification**.
3. **SQS consumer** — `src/features/notifications/messaging/notification-consumer.ts`
   (`sqs-consumer` library, wrapping `@aws-sdk/client-sqs`). No Nest-native SQS
   transport is in the current dependency set (`@nestjs/microservices` supports
   SQS via a community transport, not verified here). The straightforward mapping
   is to keep `sqs-consumer` as a plain injectable service (e.g. `NotificationConsumerService`
   started from `main.ts` or a Nest `OnApplicationBootstrap` lifecycle hook,
   mirroring how `server.ts` starts it today — see the "started outside `buildApp`"
   note in Surface 6 below, which the DI hazard section calls out for the poller
   and applies identically here) that resolves a command handler via the bus and
   calls `bus.execute(...)` per message, rather than adopting a new transport
   layer. This should be treated as a decision to make explicitly during
   implementation, not an assumption baked into this spec.
4. **SNS publisher** — `src/shared/messaging/event-publisher.ts`
   (`SnsEventPublisher`/`NoopEventPublisher` behind the `EventPublisher` interface).
   Maps directly to a Nest provider bound to that interface (`useClass` per
   environment), with no transport-layer change — this is an outbound AWS SDK call,
   not something Nest's messaging module needs to own.
5. **WebSocket/realtime** — `src/shared/realtime/` (live toasts via API Gateway
   Management API, `PostToConnectionCommand`). This is **not** a WebSocket server
   Nest hosts (`@nestjs/websockets` gateways assume Nest owns the socket
   lifecycle) — it is an outbound client publishing to AWS's own WebSocket API
   Gateway, and the connections table lives in DynamoDB
   (`shared/realtime/connections-reader.ts`), not in this service's Postgres. Maps
   to a plain Nest provider wrapping `ApiGatewayManagementApiClient`, same as
   today's `websocket-publisher.ts` — no Nest WebSocket module applies here.
6. **Metrics** — `src/shared/metrics/` (`MetricsPublisher` over
   `@aws-sdk/client-cloudwatch`, and `BusinessMetricsPoller`, which owns a single
   `setInterval` timer). Today, `BusinessMetricsPoller` is registered in the Awilix
   container but **started only in `server.ts`**, never in `buildApp` — so the test
   suite's `buildApp()` never spins up a live timer against the database. This
   split must be preserved under Nest: the poller is a Nest provider
   (`SINGLETON`-equivalent, i.e. the default Nest provider scope), but its
   `start()` call happens from `main.ts`'s bootstrap, not from a module's
   constructor or `onModuleInit` — an `onModuleInit` lifecycle hook would fire in
   every `Test.createTestingModule()` compile, silently reintroducing a live timer
   into the test suite that today does not have one. This is a design constraint
   worth stating as its own line item during implementation review, not an
   incidental detail.
7. **Cache** — `src/shared/cache/` (`ioredis`, singleton client; `ResetCodeStore`
   for password-reset codes with native `SET … EX 600` expiry; `CacheGateway` for
   the shared HTTP response cache, see [[x-cache-response-header]]). Maps to a
   `CacheModule` exporting the `ioredis` client as a singleton-scope provider and
   `ResetCodeStore`/`CacheGateway` as providers over it — no interceptor
   involvement beyond what already exists (`CacheGateway`'s HTTP-layer cache is
   itself a candidate to become a Nest interceptor, since Nest interceptors are the
   idiomatic place for response-wrapping concerns, but that re-implementation is
   not required by this spec and can be deferred; keeping it as a plain service
   called from route handlers, as today, is an acceptable Nest-native shape too).

No surface has been found with **no** Nest analogue — every one maps to either a
built-in Nest concept (`@Controller`, provider, pipe, interceptor) or a plain
injectable service that keeps using the same AWS SDK client it uses today. The gRPC
surface (#2) is the one surface where the "obvious" Nest-native option
(`@nestjs/microservices`) is flagged as **not** obviously correct, given the
manual-span requirement — see Risks.

## Migration plan

**Phase 0 — Spike the remaining unresolved question before committing to the full
build.** Verify whether `@nestjs/microservices`' gRPC transport can carry the
JE-77 manual-span fix (`onReceiveHalfClose` activation) or whether the gRPC server
stays hand-built alongside the Nest app — see Risks. This is the one surface
mapping (Architecture, Surface 2) not resolved by this spec; validation and
OpenAPI generation were resolved during drafting (D8) and need no further spike.

**Phase 1 — Scaffold the Nest application alongside Fastify.** New `main.ts` +
`app.module.ts` + module skeletons (Architecture, above), Prisma/Auth/Cache/Logging
shared modules wired as Nest providers, OTel bootstrap verified to still initialize
before any instrumented module loads under Nest's own module-resolution order (D5).
No handlers migrated yet; the goal is a Nest app that boots, serves `/v1/health`,
and passes through the existing OTel/logging wiring unchanged.

**Phase 2 — Migrate handlers to `@CommandHandler`/`@QueryHandler` behind the bus
(D6), building the D7 interceptors alongside the first few handlers so the
routine-vs-thrown and reason-deferral rules (findings #1–#3) are validated against
real handlers early, not retrofitted after all 15 are ported.** Recommended order:
start with a read (`GetMeQuery`) to prove the pipeline with no side effects, then
the auth commands that carry the specific-reason requirement (`login`,
`change-password`) since those are where a clobber bug would surface first and are
already covered by the exact tests cited in finding #2 — treat those two as an
explicit checkpoint before porting the rest.

**Phase 3 — Migrate the remaining six surfaces** (gRPC, SQS consumer, SNS
publisher, WebSocket, metrics, cache — Architecture, above), each wired to
dispatch through the same bus where applicable.

**Phase 4 — Rewrite the 663 unit/integration tests (D4)** against
`Test.createTestingModule()`, in parallel with or immediately after each handler's
Phase 2/3 migration — not as a separate pass at the end, so a handler and its tests
move together and a reviewer can compare old/new assertions while the original
handler is still fresh context.

**Phase 5 — Cut-over gate (D2, D3).** Run all 84 E2E specs unmodified against the
Nest implementation. Only once **all 84 pass** does the Fastify implementation get
deleted — `src/server.ts`, the Awilix container, and any Fastify-specific route
files. This is a single commit/PR, not a gradual removal, so there is one clear
point where the service is Nest-only.

This plan intentionally does not assign calendar time or issue numbers — those are
milestone-planning concerns for whichever plan/issue set implements this spec, not
part of the design.

## Testing

All three layers from [[testing]] apply, unchanged in kind:

- **Unit/integration** — rewritten per D4, against `Test.createTestingModule()`.
- **Internal E2E** — the 84 specs from D3, unmodified, run against the service URL
  directly.
- **Gateway E2E** — the 15 gateway specs within that 84 (`gateway/users.spec.ts` +
  `gateway/notifications.spec.ts`), unmodified, through a real Cognito JWT.

**The no-weakening rule (D4) is the testing-specific risk this migration carries**:
a test suite rewrite is the one place assertion strength erodes invisibly, because
"the new test passes" and "the new test verifies as much as the old one" are
different claims and only the first is checked by a green run. Concretely for this
migration:

- Every `expect(...).toEqual(...)` in the current suite must have an equally strict
  counterpart in the rewritten suite — not a `toMatchObject` unless the original
  test itself used one.
- Every span-attribute assertion (`app_event`, `reason`, `SpanStatusCode.ERROR`/`OK`)
  must survive the rewrite verbatim in intent, since these are exactly the
  assertions findings #1–#2 depend on.
- **A rewritten test for interceptor/pipeline behavior must go through the real
  `CommandBus`/`QueryBus`**, not call a handler's method directly — finding #4
  exists because 709 direct-call tests missed a production-path bug. A test file
  that imports a handler class and calls `.execute()` on it directly, bypassing the
  bus, does not prove pipeline behavior no matter how many assertions it makes.
- Recommend mutation-testing the reason/status/app_event assertions specifically
  (finding #5), since that is the exact technique that caught the three vacuous-test
  traps in the reverted work.

## Observability

The D7 interceptors must reproduce current semantics **exactly**, not
approximately — this is a direct carry-forward of
[[2026-09-18-cqrs-bus-refactor-design]]'s Observability section, restated for
Nest's interceptor model specifically:

- `app_event: <flow>_started` at pipeline entry; `<flow>_succeeded` or
  `<flow>_failed` at pipeline exit, matching the flow-naming already in use across
  the 15 current handlers (see [[logging-context]]).
- `reason` present on `*_failed`, absent — **never null** — otherwise.
- **No SUCCESS severity** — success is `INFO` + `app_event=*_succeeded` (per
  [[logging-context]], SUCCESS is not a real OTel severity level).
- **Routine-vs-thrown (finding #1)**: a domain "not found" that a controller later
  turns into a 404 is a normal return value, not a thrown error, and must produce
  `*_failed` + `reason` in logs **without** marking span status `ERROR`. An
  interceptor that only distinguishes "did the handler throw" from "did it not"
  would flatten this — it must inspect the handler's **result** (or a typed
  "routine failure" signal the handler returns), matching what `get-me.ts`'s
  `doGetMe` already does by hand today.
- **Specific-reason deferral (finding #2)**: the generic interceptor's own catch
  block must check whether the span already carries a `reason` attribute before
  setting `"unhandled_error"` — `span.setAttributes` is last-write-wins per key, so
  setting it unconditionally silently destroys `passwordless_user`,
  `invalid_credentials`, `cognito_error`, `invalid_otp`, and `unknown_user` wherever
  a handler already recorded one. This applies on both the thrown branch and the
  non-throwing routine branch.
- **One failure, one log line (finding #3)**: if a handler already emitted its own
  `*_failed` log line, the generic interceptor suppresses its own rather than
  double-logging.
- The full shared-context field set (`trace_id`, `cognito_sub`, `user_id`,
  `email_hash`, `duration_ms`, etc., per [[logging-context]]) continues to attach
  exactly as it does today — the migration changes *where* the logging/tracing call
  is made (an interceptor instead of a hand-written
  `public -> withWorkflowSpan -> private` wrapper), not *what* it logs.
- The manual gRPC server span (D5, Surface 2) keeps its `onReceiveHalfClose`
  activation point regardless of which gRPC-hosting option (Risks, open question)
  is chosen — that timing requirement is independent of the transport mechanism
  wrapping it.

## Risks and open questions

Two risks originally identified here — the `nestjs-zod` peer-dependency gap and
`openapi.yaml` generation — were **resolved during this spec's drafting** and are
now decisions, not open questions: see D8. Both are kept out of this section
because they no longer carry open uncertainty; D8 records the measurements that
closed them (verified `nestjs-zod`/`@anatine/zod-nestjs` peer ranges, the
`zod-to-json-schema` compatibility check against this service's resolved Zod
version, and the equivalence acceptance criterion for the regenerated
`openapi.yaml`). The remaining items below are still open.

- **Awilix → Nest DI is not a mechanical swap.** Awilix's PROXY injection mode
  injects a single destructured object per constructor (`constructor({ db, logger
  })`); Nest injects positionally by token/type
  (`constructor(private readonly db: PrismaClient)` with a provider token). **Every
  constructor in the 15 handler files, plus every shared-module class, changes
  shape** — this is not a search-and-replace. Also carry forward the specific
  failure mode `awilix-container.ts` already documents: its
  `// CONTRACT: asFunction, NOT asClass` comment (lines 154–159) records that
  `MetricsPublisher`'s constructor destructures `{ client }` but the cradle key is
  `cloudwatchClient` — a resolution failure that surfaces at **startup**, not in
  any unit test, because Awilix only resolves the mismatch when something actually
  asks for that provider. **The Nest-equivalent risk is a provider missing from a
  module's `providers`/`imports`**, which Nest also only discovers at
  **application bootstrap**, not at compile time or in an isolated unit test that
  mocks the dependency away. This argues for at least one boot-the-whole-app smoke
  test (not just `Test.createTestingModule()` per feature module) as part of
  Phase 1/2, specifically to catch this class of failure before it reaches a real
  environment.
- **AsyncLocalStorage-based audit actor likely survives unchanged, and that is a
  deliberate risk to flag rather than resolve here.** `shared/audit/actor-context.ts`
  plus the Prisma extension read the current actor from an `AsyncLocalStorage`
  store because the **singleton** Prisma client has no way to reach a per-request
  scope. Nest has request-scoped providers (`Scope.REQUEST`), but a
  request-scoped provider still cannot reach a *singleton* Prisma client any more
  than Awilix's per-request scope could — the mismatch that motivated ALS in the
  first place is a property of "one shared client, many concurrent requests," not
  of Awilix specifically. The likely outcome is that the ALS mechanism in
  `actor-context.ts` and `log-context.ts` carries over into Nest largely as-is,
  wrapped by whichever code populates the store at request entry (today
  `routes.ts`'s hooks; under Nest, most plausibly a global interceptor or guard).
  Carry forward the existing pitfall verbatim: **Prisma promises are lazy, so any
  `await` on a Prisma call must happen *inside* the ALS callback**, or the context
  is lost at the await site (see [[2026-07-12-prisma-lazy-promise-als]] and
  `runAsActor`'s comment in `actor-context.ts`) — this is a property of Prisma's
  lazy promises and Node's ALS semantics, not of the web framework, so it applies
  identically under Nest.
- **gRPC hosting mechanism is genuinely unresolved (see Architecture, Surface 2).**
  Whether the gRPC server stays a hand-built `@grpc/grpc-js` server dispatching
  into a Nest application context, or adopts `@nestjs/microservices`' gRPC
  transport, is not decided by this spec — it needs a spike (Phase 0) that
  specifically re-verifies the JE-77 `onReceiveHalfClose` activation point still
  holds under whichever option is chosen, since that fix was discovered by direct
  experimentation with `ServerInterceptingCall`, not derived from documentation.
- **Test rewrite volume is the largest single cost of this migration and should be
  planned as such.** 10,282 lines of tests across 74 files. This is not incidental
  work riding alongside the "real" migration — for a service this size, it is
  comparable in volume to the migration of the handlers themselves, and the
  no-weakening rule (D4, Testing) makes it slower per-line than a mechanical port
  would be, by design.
- **No rollback window after cut-over.** Once the Fastify implementation is deleted
  (Phase 5), reverting means reverting that commit/PR wholesale — there is no
  gradual fallback to a partially-Fastify state, because D2 explicitly rejected a
  half-migrated window. This is mitigated, not eliminated, by D3: the deletion only
  happens after all 84 E2E tests pass, which is real evidence the replacement
  serves the same external contract, but it is still a single irreversible-without-
  a-revert step.

## Out of scope

- Orders (.NET/Wolverine) and Tracking (Go/Gin) — untouched, different languages
  and frameworks (D1).
- The events-pipeline Lambda — explicitly excluded; Nest's cold-start weight was
  judged not worth taking on for a Lambda (D1).
- Any change to the 84 E2E specs themselves (D3) — they are the fixed contract this
  migration is measured against, not a surface to modify.
- Any change to a handler's externally visible behavior — like
  [[2026-09-18-cqrs-bus-refactor-design]], this is a dispatch/framework/plumbing
  migration; a handler test that must change to keep passing is a signal of an
  unintended behavior change, out of scope here.
- Deciding Users' exact module boundaries beyond the first-pass layout in
  Architecture, and resolving the gRPC hosting mechanism — both are implementation-
  time findings flagged in Risks, not decisions made by this spec.
- Re-implementing `CacheGateway`'s HTTP response cache as a Nest interceptor — the
  Architecture section notes this as a plausible future shape, not a requirement of
  this migration.

## Related

- [[users-service-design]]
- [[cqrs]]
- [[dependency-injection]]
- [[testing]]
- [[2026-09-18-cqrs-bus-refactor-design]]
- [[ADR-0002-cqrs]]
- [[ADR-0008-screaming-arch-di]]
- [[screaming-architecture]]
- [[logging-context]]
- [[ADR-0019-distributed-tracing-opentelemetry]]
- [[openapi-specs]]
- [[grpc-context-activate-at-dispatch]]
- [[2026-07-12-prisma-lazy-promise-als]]
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]
