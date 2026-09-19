---
title: Dependency injection
type: pattern
area: shared
status: active
created: 2026-06-26
updated: 2026-09-19
tags: [type/pattern, area/shared, status/active, area/users]
related:
  - "[[cqrs]]"
  - "[[2026-09-18-cqrs-dispatch-tracking-orders-design]]"
  - "[[2026-09-19-users-nestjs-migration-design]]"
  - "[[users-service-design]]"
  - "[[2026-09-19-esbuild-drops-decorator-metadata]]"
  - "[[audit-fields]]"
---

# Dependency injection

## Pattern

All services use dependency injection (DI) to wire their components together. Collaborators — handlers, repositories, clients — are provided to consumers rather than constructed inline.

## How we apply it

- Handlers receive their repositories and clients via DI instead of instantiating them.
- The same approach wires the [[cqrs]] command/query/event handlers across every service.
- This keeps use-cases (see [[screaming-architecture]]) decoupled from concrete infrastructure, making them easy to test and swap.

## How the Users service applies it (NestJS)

As of the 2026-09-19 NestJS migration ([[2026-09-19-users-nestjs-migration-design]]), Users
uses **Nest providers** — not Awilix. The Fastify + Awilix cradle is deleted.

- **Registration.** Feature and shared modules declare `providers` / `exports`. Infrastructure
  collaborators (`PrismaService`, Cognito `AuthProvider`, `EventPublisher`, Redis, metrics,
  cache) live in `@Global()` shared modules so feature modules need no import line to reach
  them. Command/query handlers are Nest providers registered beside their module (discovered
  by `@nestjs/cqrs` via `@CommandHandler` / `@QueryHandler`).
- **Injection style.** Prefer **type-based** constructor injection for concrete classes
  (`constructor(private readonly prisma: PrismaService)`). Use `@Inject(TOKEN)` **only** where
  the type is an interface or type alias with no runtime class — today `Db`, `AuthProvider`,
  `EventPublisher`, and Redis client tokens in `shared/tokens.ts` (or the owning module).
- **Value import required.** An injected class must be a **value** import. `import type { Foo }`
  erases the token at runtime; Nest fails at **bootstrap**, not at compile time, with an
  unresolved-dependency error.
- **Decorator metadata toolchain.** Nest type-based DI needs `design:paramtypes`. esbuild
  (tsx, default Vitest) does not emit it; `tsc` with `emitDecoratorMetadata` does. Dev and
  Vitest therefore run through SWC (`.swcrc` with `decoratorMetadata: true`) —
  `unplugin-swc` for Vitest, `@swc-node/register` for `pnpm dev` / OpenAPI generation. Canary:
  `tests/di-metadata.test.ts`. See [[2026-09-19-esbuild-drops-decorator-metadata]].
- **Config.** `@nestjs/config` validates the same Zod env schema (`src/config/env.schema.ts`)
  the old `env.ts` held; inject `AppConfigService` / `ConfigService` instead of importing a
  module-level frozen object.
- **Request identity & audit.** HTTP identity still arrives as `x-user-id`. Per-request actor
  and log-context stores are seeded by `RequestContextMiddleware` (AsyncLocalStorage). Audit
  stamping still reads a semantic `AuditActor` from ALS (`shared/audit/actor-context.ts`), not
  from the Nest request scope — the Prisma client is process-wide. See [[audit-fields]].
- **Auth.** A global `AuthGuard` (`APP_GUARD`) plus `@Public()` replaces the hand-maintained
  public-routes allowlist. A guard sees the matched handler; middleware saw only the raw URL.
- **Test pattern.** Each suite builds `Test.createTestingModule()` with the real
  `CqrsModule` and overrides providers with doubles. Dispatch through `CommandBus` /
  `QueryBus` — never `handler.execute()` directly (see [[cqrs]] / [[testing]]).

## Registration strategy per stack — auto vs. manual

How handlers get registered into their DI container/bus varies deliberately by language:

- **Node (Users / NestJS)** — `@CommandHandler` / `@QueryHandler` metadata + Nest module
  providers; `@nestjs/cqrs` resolves handlers via `ModuleRef`.
- **.NET (Orders)** — Wolverine's convention-based discovery, free and automatic, per
  [[2026-09-18-cqrs-dispatch-tracking-orders-design]] D5.
- **Go (Tracking)** — manual wiring in `cmd/server/main.go` — type-safe dynamic registration
  is not possible in Go without `map[reflect.Type]any` and the assertions that follow, so full
  type safety is bought with the accepted cost of a wiring line per handler.

## Related

- [[cqrs]] — the handlers wired through DI; Users' bus-wrapping interceptor pipeline.
- [[screaming-architecture]] — DI connects use-case folders to infrastructure at the edges.
- [[audit-fields]] — the `AuditActor`/`AsyncLocalStorage` mechanism that stamps writes.
- [[users-service-design]] — current Users stack after the Nest migration.
- [[2026-09-19-users-nestjs-migration-design]] — Awilix → Nest providers migration.
- [[2026-09-19-esbuild-drops-decorator-metadata]] — SWC required for type-based DI.
- [[2026-09-18-cqrs-dispatch-tracking-orders-design]] — the per-stack auto/manual registration
  decision (D5) for Tracking (Go) and Orders (.NET).
