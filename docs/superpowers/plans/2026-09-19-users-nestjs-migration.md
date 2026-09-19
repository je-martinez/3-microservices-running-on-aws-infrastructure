---
title: Users Service — NestJS Migration Implementation Plan
type: plan
area: users
status: draft
created: 2026-09-19
updated: 2026-09-19
tags:
  - type/plan
  - area/users
  - status/draft
propagates-to:
  - "[[users-service-design]]"
  - "[[cqrs]]"
  - "[[dependency-injection]]"
  - "[[testing]]"
  - "[[openapi-specs]]"
related:
  - "[[2026-09-19-users-nestjs-migration-design]]"
  - "[[users-service-design]]"
  - "[[cqrs]]"
  - "[[dependency-injection]]"
  - "[[testing]]"
  - "[[openapi-specs]]"
  - "[[screaming-architecture]]"
  - "[[ADR-0002-cqrs]]"
  - "[[ADR-0008-screaming-arch-di]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[logging-context]]"
  - "[[audit-fields]]"
  - "[[grpc-context-activate-at-dispatch]]"
  - "[[2026-07-12-prisma-lazy-promise-als]]"
  - "[[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]"
  - "[[health-check-logging]]"
  - "[[auth-error-mapping]]"
  - "[[soft-delete]]"
  - "[[x-cache-response-header]]"
  - "[[package-manager]]"
  - "[[git-workflow]]"
---

# Users Service — NestJS Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Users service's Fastify + Awilix application layer with NestJS (Fastify adapter) and `@nestjs/cqrs`, moving tracing/logging/validation from hand-repeated per-handler calls into a uniform interceptor pipeline, with no change to the service's external contract.

**Architecture:** The Nest application is built alongside the Fastify one in the same package (`src/nest/`), so the service stays deployable throughout. Handlers become `@CommandHandler`/`@QueryHandler` classes dispatched through `CommandBus`/`QueryBus`; every transport (HTTP controller, gRPC service, SQS consumer) dispatches the same command objects. Cross-cutting tracing/`app_event`/logging moves into one `NestInterceptor` that wraps bus dispatch. The Fastify implementation is deleted in a single commit, only once all 84 E2E specs pass unmodified against Nest.

**Tech Stack:** NestJS 12 (`@nestjs/core`, `@nestjs/common`, `@nestjs/platform-fastify`, `@nestjs/cqrs`, `@nestjs/microservices`, `@nestjs/swagger`, `@nestjs/testing`), Fastify 5 (under the adapter), Prisma 7, Zod 3, `zod-to-json-schema`, `reflect-metadata`, `unplugin-swc` + `@swc/core` (test/dev decorator metadata), Vitest 2, `@grpc/grpc-js`, `sqs-consumer`, OpenTelemetry.

**Spec:** `docs/superpowers/specs/2026-09-19-users-nestjs-migration-design.md` → [[2026-09-19-users-nestjs-migration-design]]

## Global Constraints

Every task's requirements implicitly include this section.

- **Package manager is pnpm**, never `npm`/`yarn`. Install with `pnpm --filter @3mrai/users add <pkg>`. See [[package-manager]].
- **Run `nvm use` before any Node command.** The repo pins Node **24.18.0** in `.nvmrc`.
- **No dispatched agent runs git writes.** Implementers leave work in the working tree; the main session commits via the A/B/C/D/E menu. See [[git-workflow]].
- **Exact dependency versions** (verified on 2026-09-19 against the npm registry): `@nestjs/core@12.0.3`, `@nestjs/common@12.0.3`, `@nestjs/platform-fastify@12.0.3` (depends on `fastify@5.12.4`), `@nestjs/cqrs@12.0.0`, `@nestjs/microservices@12.0.3`, `@nestjs/swagger@12.0.1`, `@nestjs/testing@12.0.3`, `reflect-metadata@0.2.2`, `rxjs@7.8.2`, `zod-to-json-schema@3.25.2`.
- **No Zod↔Nest bridge library.** `nestjs-zod@5.5.0` and `@anatine/zod-nestjs@2.0.12` both stop at `@nestjs/common: ^11` and would need a forced peer install. Validation is a hand-rolled `ZodValidationPipe` (spec D8).
- **No `class-validator` / `class-transformer`.** Zod stays the single source of types for validation AND OpenAPI (spec D8).
- **The 84 E2E specs in `e2e/tests/` are NEVER modified.** They are the contract. A spec that cannot pass against Nest is a migration defect in the Nest code. See spec D3.
- **Assertion strength must not weaken in the test rewrite.** No `toEqual` → `toMatchObject`, no dropped assertions, no assertion turned into a `.not.toThrow()`-only check. Reviewers diff assertions against the original test, not just confirm green. See spec D4.
- **`reason` is present on `*_failed`, absent — never null — otherwise.** There is no SUCCESS severity: success is `INFO` + `app_event=*_succeeded`. See [[logging-context]].
- **OTel config lives in environment variables, not code.** The SDK loads via `node --import`, never a static import from application code.
- **Comments follow [[code-comments]]:** the five tags (`CONTRACT:`, `WORKAROUND(<scope>):`, `WHY:`, `WARNING:`, `TODO(JE-<id>):`), present tense describing the final state, vault refs as `See [[vault-id]]`, blocks ≤12 lines.

## Decisions this plan locks in (resolved with the user on 2026-09-19)

Three questions the spec left open or did not anticipate. Each was measured, not assumed.

### DI-1 — Decorator metadata: `unplugin-swc` in Vitest, not `@Inject` everywhere

**The spec did not anticipate this, and it would have failed in Phase 2.** Nest's type-based DI (`constructor(private readonly db: PrismaService)`) reads the `design:paramtypes` metadata that TypeScript emits under `emitDecoratorMetadata`. Measured on 2026-09-19 in a scratch ESM project on Node 24.18.0:

| Toolchain | `Reflect.getMetadata("design:paramtypes", B)` | Nest type-based DI |
|---|---|---|
| `tsx` (esbuild) | `undefined` | **`this.db` is `undefined` at runtime** |
| `vitest` (esbuild) | `undefined` | **same failure** |
| `tsc --emitDecoratorMetadata` | `[ [class A] ]` | works |

The failure is silent and asymmetric: `pnpm build` (tsc) produces a working service while `pnpm dev` and all 663 tests break. Adding `unplugin-swc` + `@swc/core` with a `.swcrc` carrying `decoratorMetadata: true` restores it — verified: a `CommandBus.execute` through a type-injected handler passes under Vitest. Handlers therefore use **idiomatic positional constructors**, and `@Inject(TOKEN)` appears only where the token is an interface or a non-class value (`AuthProvider`, `EventPublisher`, `Db`, `Env`), which have no runtime class to inject by.

### DI-2 — gRPC adopts `@nestjs/microservices`, gated by two tests

The spec left this open and called for a Phase 0 spike. **The spike was run on 2026-09-19** against the real `proto/users.proto` with a real gRPC client and server on Node 24.18.0, and it settled two things.

**The JE-77 fix survives.** Extracting the caller's W3C context in the api-key interceptor and activating it in `onReceiveHalfClose` produces a server span that **joins** the caller's trace under Nest's transport — the measured `traceId` matched the inbound `traceparent`. Mutating the activation back to `onReceiveMetadata` turned the test red; removing the interceptor turned both tests red. The result is not vacuous.

**But `GrpcOptions` exposes no `interceptors` key, and the intuitive spelling fails silently.** `@nestjs/microservices/server/server-grpc.js:432` builds the server as `new grpcPackage.Server(options)`, where `options` is the merged **`channelOptions`**. Passing `server: { interceptors: [...] }` — the shape that reads as correct — is dropped with no warning: the service starts, every test runs, and a call bearing a **wrong** `x-api-key` returns the user's data. An open authentication bypass that emits nothing. The interceptors go in `channelOptions`, which grpc-js reads, carrying a `WORKAROUND(nestjs-microservices):` comment naming that symptom so nobody "tidies" it back.

Because each failure mode is independent, Task 22 carries **two** gates: trace continuity, and an UNAUTHENTICATED rejection for a wrong key. `api-key-interceptor.ts` and `grpc-tracing.ts` carry over **unchanged**. See [[grpc-context-activate-at-dispatch]].

### DI-3 — Tests are rewritten in the same task as their handler

Each handler task migrates the handler AND rewrites its tests, diffing assertions against the original while it is still fresh context. A separate end-phase test pass is rejected: spec D4's no-weakening rule is only enforceable while a reviewer can see both versions, and [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] is this repo's own record of a requirement lost exactly that way.

## File Structure

The Nest application is built under `src/nest/` so both implementations coexist without name collisions. Task 22 deletes the Fastify tree and flattens `src/nest/` up to `src/`.

```
services/users/
├── .swcrc                                  NEW  — SWC decorator metadata (DI-1)
├── vitest.config.ts                        MOD  — unplugin-swc plugin
├── tsconfig.json                           MOD  — experimentalDecorators + emitDecoratorMetadata
├── package.json                            MOD  — Nest deps, dev/start/test scripts
└── src/
    ├── server.ts                           KEEP until Task 22 (Fastify entrypoint)
    ├── nest/
    │   ├── main.ts                         Nest bootstrap: FastifyAdapter, gRPC, pollers
    │   ├── app.module.ts                   root module
    │   ├── users/
    │   │   ├── users.module.ts
    │   │   ├── commands/                   12 @CommandHandler classes + their command objects
    │   │   ├── queries/                    2 @QueryHandler classes + their query objects
    │   │   ├── http/users.controller.ts    13 user routes
    │   │   ├── http/e2e.controller.ts      2 E2E-only routes
    │   │   ├── webhooks/cognito.controller.ts
    │   │   └── grpc/                       @GrpcMethod controller + transport options
    │   ├── notifications/
    │   │   ├── notifications.module.ts
    │   │   ├── commands/                   create-notification, mark-notifications-read
    │   │   ├── queries/                    list-notifications
    │   │   ├── http/notifications.controller.ts   3 notification routes
    │   │   └── messaging/notification-consumer.service.ts
    │   └── shared/
    │       ├── tokens.ts                   DI tokens for interface-typed providers
    │       ├── prisma/prisma.module.ts
    │       ├── config/config.module.ts
    │       ├── auth/auth.module.ts
    │       ├── cache/cache.module.ts
    │       ├── messaging/messaging.module.ts
    │       ├── metrics/metrics.module.ts
    │       ├── realtime/realtime.module.ts
    │       ├── observability/
    │       │   ├── workflow.interceptor.ts   the D7 tracing/app_event interceptor
    │       │   └── workflow-metadata.ts      @Workflow() decorator + flow-name metadata
    │       ├── http/
    │       │   ├── zod-validation.pipe.ts
    │       │   ├── domain-exception.filter.ts
    │       │   ├── request-context.middleware.ts   ALS seeding (actor + log context)
    │       │   └── response-log.interceptor.ts     the onResponse log line + error metric
    │       └── openapi/build-document.ts     zod-to-json-schema → @nestjs/swagger
    └── shared/                             UNCHANGED, imported by both implementations
        ├── db/, auth/, cache/, logging/, messaging/, metrics/, realtime/,
        ├── audit/, observability/, grpc/, http/, id/, config/
```

**Reused unchanged** (imported by the Nest code, not rewritten): every module under `src/shared/` except the DI container, plus `src/features/*/domain/`, `src/features/*/http/schemas.ts`, and `src/features/users/webhooks/{cognito-payload,verify-secret,message-id}.ts`. The migration replaces the *application layer*, not the domain or the infrastructure adapters.

**Deleted in Task 26:** `src/server.ts`, `src/shared/di/awilix-container.ts`, `src/features/users/http/routes.ts`, `src/features/users/http/cache-hooks.ts`, `src/features/users/http/generate-openapi.ts`, `src/shared/grpc/server.ts`, and the `@fastify/awilix` / `awilix` / `fastify-type-provider-zod` / `@fastify/swagger` dependencies. **`src/shared/grpc/api-key-interceptor.ts` and `address.ts` stay** — Task 22 uses both.

---
## Phase 1 — Toolchain and foundation (Tasks 1–6)

### Task 1: Install NestJS and make decorator metadata survive the test toolchain

This task exists because of DI-1: without it, every later task's handlers resolve their dependencies as `undefined` under Vitest while passing `pnpm build`. It is first for that reason.

**Files:**
- Modify: `services/users/package.json` (dependencies, devDependencies, scripts)
- Modify: `services/users/tsconfig.json`
- Modify: `services/users/vitest.config.ts`
- Create: `services/users/.swcrc`
- Test: `services/users/tests/nest/di-metadata.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working Nest DI toolchain. Every later task relies on `constructor(private readonly x: SomeClass)` resolving correctly under `pnpm test`.

- [ ] **Step 1: Install the dependencies**

```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use
pnpm --filter @3mrai/users add @nestjs/core@12.0.3 @nestjs/common@12.0.3 \
  @nestjs/platform-fastify@12.0.3 @nestjs/cqrs@12.0.0 @nestjs/swagger@12.0.1 \
  reflect-metadata@0.2.2 rxjs@7.8.2 zod-to-json-schema@3.25.2
pnpm --filter @3mrai/users add -D @nestjs/testing@12.0.3 unplugin-swc @swc/core
```

- [ ] **Step 2: Write the failing test**

Create `services/users/tests/nest/di-metadata.test.ts`:

```typescript
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { Injectable, Module } from "@nestjs/common";
import { CommandBus, CommandHandler, CqrsModule, type ICommandHandler } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";

// CONTRACT: This test is the toolchain's canary, not a feature test. esbuild (tsx
// and vitest) does NOT emit `design:paramtypes`, so type-based Nest DI silently
// injects `undefined` while `pnpm build` (tsc) works. It fails the moment the SWC
// plugin or .swcrc stops emitting decorator metadata. See [[dependency-injection]]
@Injectable()
class Probe {
  value(): string {
    return "resolved";
  }
}

class ProbeCommand {}

@CommandHandler(ProbeCommand)
class ProbeHandler implements ICommandHandler<ProbeCommand> {
  constructor(private readonly probe: Probe) {}
  async execute(): Promise<string> {
    return this.probe.value();
  }
}

@Module({ imports: [CqrsModule], providers: [Probe, ProbeHandler] })
class ProbeModule {}

describe("decorator metadata under the test toolchain", () => {
  it("emits design:paramtypes so Nest injects by type", () => {
    expect(Reflect.getMetadata("design:paramtypes", ProbeHandler)).toEqual([Probe]);
  });

  it("resolves a type-injected dependency through the CommandBus", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    await moduleRef.init();

    expect(await moduleRef.get(CommandBus).execute(new ProbeCommand())).toBe("resolved");

    await moduleRef.close();
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/di-metadata.test.ts
```

Expected: FAIL. The first test reports `undefined` instead of `[Probe]`; the second throws `TypeError: Cannot read properties of undefined (reading 'value')`.

- [ ] **Step 4: Add the SWC config**

Create `services/users/.swcrc`:

```json
{
  "$schema": "https://swc.rs/schema.json",
  "jsc": {
    "target": "es2023",
    "parser": { "syntax": "typescript", "decorators": true },
    "transform": { "legacyDecorator": true, "decoratorMetadata": true }
  },
  "module": { "type": "es6" }
}
```

- [ ] **Step 5: Wire the SWC plugin into Vitest**

In `services/users/vitest.config.ts`, add the import and the `plugins` entry. Keep the existing `resolve.alias` and the whole `test` block exactly as they are:

```typescript
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

export default defineConfig({
  // CONTRACT: Keep this plugin. esbuild (Vitest's default transform) drops
  // `design:paramtypes`, so Nest's type-based DI injects `undefined` in tests
  // while `pnpm build` (tsc) works — a failure that only ever shows up here.
  // Options come from .swcrc. See [[dependency-injection]]
  plugins: [swc.vite()],
  resolve: {
    alias: {
      "#shared/": fileURLToPath(new URL("./src/shared/", import.meta.url)),
      "#features/": fileURLToPath(new URL("./src/features/", import.meta.url)),
    },
  },
  // ... the existing `test` block is unchanged ...
});
```

- [ ] **Step 6: Enable decorators in tsconfig**

In `services/users/tsconfig.json`, add two compiler options to the existing block (leave every other option untouched):

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

- [ ] **Step 7: Add `reflect-metadata` to the setup file**

At the very top of `services/users/tests/setup-tracing.ts`, before every other import:

```typescript
// CONTRACT: First import in the suite. Nest's decorators write to the metadata
// registry this polyfill installs; a later import leaves earlier-evaluated
// decorators writing nowhere. See [[dependency-injection]]
import "reflect-metadata";
```

- [ ] **Step 8: Run the test to verify it passes**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/di-metadata.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 9: Run the whole existing suite to prove SWC broke nothing**

```bash
cd services/users && nvm use && pnpm test
```

Expected: the full suite passes with the same test count as before this task. If any test now fails, the SWC transform changed behaviour for existing code — fix that before continuing; do not proceed on a red suite.

- [ ] **Step 10: Leave the work in the working tree**

Report the changed files to the main session. Do not run git.

---

### Task 2: Nest bootstrap serving `/v1/health`

**Files:**
- Create: `services/users/src/nest/main.ts`
- Create: `services/users/src/nest/app.module.ts`
- Create: `services/users/src/nest/shared/config/config.module.ts`
- Create: `services/users/src/nest/shared/tokens.ts`
- Create: `services/users/src/nest/health/health.controller.ts`
- Test: `services/users/tests/nest/health.test.ts`

**Interfaces:**
- Consumes: Task 1's toolchain.
- Produces:
  - `ENV` — injection token for the validated `Env` object.
  - `createNestApp(): Promise<NestFastifyApplication>` from `main.ts`, used by later tasks' boot smoke test.
  - `AppModule` — the root module every later module registers into.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/nest/health.test.ts`:

```typescript
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "#nest/app.module";

describe("GET /v1/health", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("answers 200 with the same body the Fastify implementation returns", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 2: Confirm the shape of the current health response**

```bash
cd services/users && sed -n '337,344p' src/features/users/http/routes.ts
```

Expected: the handler returns `{ status: "ok" }`. **If it returns anything else, use that exact body in the test above** — the E2E specs assert on it and this plan must not change the contract.

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/health.test.ts
```

Expected: FAIL — `Cannot find module '#nest/app.module'`.

- [ ] **Step 4: Add the `#nest/*` subpath import**

In `services/users/package.json`, add a third entry to the existing `imports` block, matching the `#shared`/`#features` shape exactly (see [[users-path-aliases-hash]] — these are Node subpath imports, resolved without a bundler):

```json
"#nest/*": {
  "development": "./src/nest/*.ts",
  "default": "./dist/nest/*.js"
}
```

Add the matching alias to `vitest.config.ts`'s `resolve.alias`:

```typescript
"#nest/": fileURLToPath(new URL("./src/nest/", import.meta.url)),
```

- [ ] **Step 5: Write the DI tokens**

Create `services/users/src/nest/shared/tokens.ts`:

```typescript
// CONTRACT: A token per dependency whose type is an interface or a non-class
// value. Those have no runtime class for Nest to inject by, so they need an
// explicit @Inject(TOKEN) at every call site; class-typed dependencies are
// injected by type and must NOT be listed here. See [[dependency-injection]]
export const ENV = Symbol.for("users:env");
export const DB = Symbol.for("users:db");
export const AUTH_PROVIDER = Symbol.for("users:authProvider");
export const EVENT_PUBLISHER = Symbol.for("users:eventPublisher");
export const REDIS = Symbol.for("users:redis");
```

- [ ] **Step 6: Write the config module**

Create `services/users/src/nest/shared/config/config.module.ts`:

```typescript
import { Global, Module } from "@nestjs/common";
import { env } from "#shared/config/env";
import { ENV } from "../tokens.ts";

// The already-validated env object as a provider. Zod validation stays in
// `shared/config/env.ts` — this module only makes the result injectable.
@Global()
@Module({
  providers: [{ provide: ENV, useValue: env }],
  exports: [ENV],
})
export class ConfigModule {}
```

- [ ] **Step 7: Write the health controller**

Create `services/users/src/nest/health/health.controller.ts`:

```typescript
import { Controller, Get } from "@nestjs/common";

@Controller("v1/health")
export class HealthController {
  @Get()
  check(): { status: string } {
    return { status: "ok" };
  }
}
```

- [ ] **Step 8: Write the root module**

Create `services/users/src/nest/app.module.ts`:

```typescript
import { Module } from "@nestjs/common";
import { ConfigModule } from "./shared/config/config.module.ts";
import { HealthController } from "./health/health.controller.ts";

@Module({
  imports: [ConfigModule],
  controllers: [HealthController],
})
export class AppModule {}
```

- [ ] **Step 9: Write the bootstrap**

Create `services/users/src/nest/main.ts`:

```typescript
// CONTRACT: Do NOT import the OTel SDK here. It loads via `node --import`
// (Dockerfile CMD and the start/dev scripts) — the only thing that works under
// ESM, where static imports are hoisted before any module body runs, so
// importing the SDK "first" still leaves @grpc/grpc-js loaded before
// sdk.start() can patch it. See [[logging-context]]
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { env } from "#shared/config/env";
import { AppModule } from "./app.module.ts";

export async function createNestApp(): Promise<NestFastifyApplication> {
  return NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
}

export async function bootstrap(): Promise<void> {
  const app = await createNestApp();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}
```

Append the entrypoint guard at the bottom, so importing this module from a test does not start a listener:

```typescript
// Only the process entrypoint listens; a test importing `createNestApp` must not.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await bootstrap();
}
```

- [ ] **Step 10: Run the test to verify it passes**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/health.test.ts
```

Expected: PASS.

- [ ] **Step 11: Boot the real app against the Fastify one**

```bash
cd services/users && nvm use && pnpm exec tsx --conditions=development src/nest/main.ts &
sleep 3 && curl -s localhost:3000/v1/health && kill %1
```

Expected: `{"status":"ok"}`. If the port is taken by the running Fastify service, set `PORT=3100` for this check.

- [ ] **Step 12: Leave the work in the working tree**

---

### Task 3: Shared infrastructure modules (Prisma, auth, cache, messaging, metrics, realtime)

Every later handler injects from these. They wrap the **existing** `src/shared/` classes — no infrastructure code is rewritten, only its registration.

**Files:**
- Create: `services/users/src/nest/shared/prisma/prisma.module.ts`
- Create: `services/users/src/nest/shared/auth/auth.module.ts`
- Create: `services/users/src/nest/shared/cache/cache.module.ts`
- Create: `services/users/src/nest/shared/messaging/messaging.module.ts`
- Create: `services/users/src/nest/shared/metrics/metrics.module.ts`
- Create: `services/users/src/nest/shared/realtime/realtime.module.ts`
- Modify: `services/users/src/nest/app.module.ts`
- Test: `services/users/tests/nest/shared-modules.test.ts`

**Interfaces:**
- Consumes: `ENV`, `DB`, `AUTH_PROVIDER`, `EVENT_PUBLISHER`, `REDIS` from Task 2's `tokens.ts`.
- Produces, all exported and injectable by later tasks:
  - `DB` → `Db` (the extended Prisma client from `#shared/db/prisma`)
  - `AUTH_PROVIDER` → `AuthProvider`
  - `EVENT_PUBLISHER` → `EventPublisher`
  - `REDIS` → `RedisClient`
  - `ResetCodeStore`, `CacheGateway`, `MetricsPublisher`, `BusinessMetricsPoller`, `CascadeClient`, `WebsocketPublisher` — injected **by type**, no token.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/nest/shared-modules.test.ts`:

```typescript
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { AppModule } from "#nest/app.module";
import { AUTH_PROVIDER, DB, EVENT_PUBLISHER, REDIS } from "#nest/shared/tokens";
import { CacheGateway } from "#shared/cache/cache-gateway";
import { ResetCodeStore } from "#shared/cache/reset-code-store";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";
import { BusinessMetricsPoller } from "#shared/metrics/business-metrics";
import { CascadeClient } from "#shared/http/cascade-client";

describe("shared infrastructure modules", () => {
  it("resolves every shared provider from the compiled root module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();

    expect(moduleRef.get(DB)).toBeDefined();
    expect(moduleRef.get(AUTH_PROVIDER)).toBeDefined();
    expect(moduleRef.get(EVENT_PUBLISHER)).toBeDefined();
    expect(moduleRef.get(REDIS)).toBeDefined();
    expect(moduleRef.get(CacheGateway)).toBeInstanceOf(CacheGateway);
    expect(moduleRef.get(ResetCodeStore)).toBeInstanceOf(ResetCodeStore);
    expect(moduleRef.get(MetricsPublisher)).toBeInstanceOf(MetricsPublisher);
    expect(moduleRef.get(BusinessMetricsPoller)).toBeInstanceOf(BusinessMetricsPoller);
    expect(moduleRef.get(CascadeClient)).toBeInstanceOf(CascadeClient);

    await moduleRef.close();
  });

  it("does NOT start the business-metrics poller when the module compiles", async () => {
    // CONTRACT: The poller owns a live interval timer against the database.
    // `server.ts` starts it today and `main.ts` must too — an onModuleInit hook
    // would start one in every Test.createTestingModule() compile instead.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();

    const poller = moduleRef.get(BusinessMetricsPoller) as unknown as { timer?: unknown };
    expect(poller.timer).toBeUndefined();

    await moduleRef.close();
  });
});
```

- [ ] **Step 2: Confirm the poller's idle-state field name**

```bash
cd services/users && grep -n "private\|start()\|setInterval" src/shared/metrics/business-metrics.ts | head -20
```

Use the field the class actually assigns its `setInterval` handle to. **If it is not named `timer`, change the second test's property to the real name** — asserting on a field that does not exist passes vacuously, which is exactly the trap finding #5 in the spec warns about.

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/shared-modules.test.ts
```

Expected: FAIL — `Nest could not find DB element`.

- [ ] **Step 4: Write the Prisma module**

Create `services/users/src/nest/shared/prisma/prisma.module.ts`:

```typescript
import { Global, Module } from "@nestjs/common";
import { db } from "#shared/db/prisma";
import { DB } from "../tokens.ts";

// CONTRACT: One shared client, as a value provider. The composed extensions
// (nano-id + audit + soft-delete + read-replica routing) are built once in
// `shared/db/prisma.ts`; rebuilding a client per module or per request would
// open a second pool and lose read-your-writes routing. See [[soft-delete]]
@Global()
@Module({
  providers: [{ provide: DB, useValue: db }],
  exports: [DB],
})
export class PrismaModule {}
```

- [ ] **Step 5: Write the auth module**

Create `services/users/src/nest/shared/auth/auth.module.ts`:

```typescript
import { Global, Module } from "@nestjs/common";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { CognitoAuthProvider } from "#shared/auth/cognito-auth-provider";
import { CascadeClient } from "#shared/http/cascade-client";
import type { Env } from "#shared/config/env";
import { AUTH_PROVIDER, ENV } from "../tokens.ts";

const COGNITO_CLIENT = Symbol.for("users:cognitoClient");

@Global()
@Module({
  providers: [
    {
      provide: COGNITO_CLIENT,
      inject: [ENV],
      useFactory: (env: Env) =>
        new CognitoIdentityProviderClient({
          region: env.AWS_REGION,
          endpoint: env.AWS_ENDPOINT_URL,
        }),
    },
    {
      provide: AUTH_PROVIDER,
      inject: [COGNITO_CLIENT, ENV],
      useFactory: (client: CognitoIdentityProviderClient, env: Env) =>
        new CognitoAuthProvider(client, env.COGNITO_USER_POOL_ID, env.COGNITO_CLIENT_ID),
    },
    {
      // Holds only configuration and a stateless fetch, so one instance is right.
      provide: CascadeClient,
      inject: [ENV],
      useFactory: (env: Env) =>
        new CascadeClient({
          ordersBaseUrl: env.ORDERS_BASE_URL,
          trackingBaseUrl: env.TRACKING_BASE_URL,
          apiKey: env.INTERNAL_API_KEY,
        }),
    },
  ],
  exports: [AUTH_PROVIDER, CascadeClient],
})
export class AuthModule {}
```

- [ ] **Step 6: Write the cache module**

Create `services/users/src/nest/shared/cache/cache.module.ts`:

```typescript
import { Global, Module } from "@nestjs/common";
import { createRedisClient, type RedisClient } from "#shared/cache/redis";
import { ResetCodeStore } from "#shared/cache/reset-code-store";
import { CacheGateway } from "#shared/cache/cache-gateway";
import type { Env } from "#shared/config/env";
import { ENV, REDIS } from "../tokens.ts";

// CONTRACT: One ioredis client for the process. It owns a real TCP socket and
// its own reconnect state machine, so a second instance leaks a connection and
// a second reconnect loop.
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env) => createRedisClient({ host: env.REDIS_HOST, port: env.REDIS_PORT }),
    },
    {
      provide: ResetCodeStore,
      inject: [REDIS],
      useFactory: (redis: RedisClient) => new ResetCodeStore({ redis }),
    },
    {
      provide: CacheGateway,
      inject: [REDIS],
      useFactory: (redis: RedisClient) => new CacheGateway({ redis }),
    },
  ],
  exports: [REDIS, ResetCodeStore, CacheGateway],
})
export class CacheModule {}
```

**Before writing this, check the two constructors' actual parameter shapes:**

```bash
cd services/users && grep -n "constructor" src/shared/cache/reset-code-store.ts src/shared/cache/cache-gateway.ts
```

They destructure from the Awilix cradle (`constructor({ redis })`). The `useFactory` above passes `{ redis }` to match. **If a constructor destructures more names, pass each one** — Awilix resolved them by cradle key and Nest will not.

- [ ] **Step 7: Write the messaging module**

Create `services/users/src/nest/shared/messaging/messaging.module.ts`:

```typescript
import { Global, Module } from "@nestjs/common";
import { SNSClient } from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SnsEventPublisher } from "#shared/messaging/event-publisher";
import type { Env } from "#shared/config/env";
import { ENV, EVENT_PUBLISHER } from "../tokens.ts";

export const SQS_CLIENT = Symbol.for("users:sqsClient");
const SNS_CLIENT = Symbol.for("users:snsClient");

@Global()
@Module({
  providers: [
    {
      provide: SNS_CLIENT,
      inject: [ENV],
      useFactory: (env: Env) =>
        new SNSClient({ region: env.AWS_REGION, endpoint: env.AWS_ENDPOINT_URL }),
    },
    {
      // Publishing goes to the topic; this client stays because the
      // notifications consumer receives from a queue.
      provide: SQS_CLIENT,
      inject: [ENV],
      useFactory: (env: Env) =>
        new SQSClient({ region: env.AWS_REGION, endpoint: env.AWS_ENDPOINT_URL }),
    },
    {
      provide: EVENT_PUBLISHER,
      inject: [SNS_CLIENT, ENV],
      useFactory: (sns: SNSClient, env: Env) => new SnsEventPublisher(sns, env.EVENTS_TOPIC_ARN),
    },
  ],
  exports: [EVENT_PUBLISHER, SQS_CLIENT],
})
export class MessagingModule {}
```

- [ ] **Step 8: Write the metrics module**

Create `services/users/src/nest/shared/metrics/metrics.module.ts`:

```typescript
import { Global, Module } from "@nestjs/common";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";
import { BusinessMetricsPoller } from "#shared/metrics/business-metrics";
import type { Db } from "#shared/db/prisma";
import type { Env } from "#shared/config/env";
import { DB, ENV } from "../tokens.ts";

const CLOUDWATCH_CLIENT = Symbol.for("users:cloudwatchClient");

@Global()
@Module({
  providers: [
    {
      provide: CLOUDWATCH_CLIENT,
      inject: [ENV],
      useFactory: (env: Env) =>
        new CloudWatchClient({ region: env.AWS_REGION, endpoint: env.AWS_ENDPOINT_URL }),
    },
    {
      // WHY: A factory, not useClass. The constructor takes `{ client }` while the
      // provider it comes from is the CloudWatch client token — the same name
      // mismatch that made this an asFunction under Awilix. A useClass here would
      // fail at bootstrap, not in any unit test. See [[dependency-injection]]
      provide: MetricsPublisher,
      inject: [CLOUDWATCH_CLIENT],
      useFactory: (client: CloudWatchClient) => new MetricsPublisher({ client }),
    },
    {
      // CONTRACT: Constructed here, STARTED in main.ts — never in a constructor
      // or onModuleInit. It owns one interval timer against the database, and a
      // lifecycle hook would start one in every test module compile.
      provide: BusinessMetricsPoller,
      inject: [DB, MetricsPublisher, ENV],
      useFactory: (db: Db, metricsPublisher: MetricsPublisher, env: Env) =>
        new BusinessMetricsPoller({ db, metricsPublisher, env }),
    },
  ],
  exports: [MetricsPublisher, BusinessMetricsPoller],
})
export class MetricsModule {}
```

**Verify the poller's constructor names before writing it:**

```bash
cd services/users && sed -n '1,40p' src/shared/metrics/business-metrics.ts
```

Pass exactly the names it destructures.

- [ ] **Step 9: Write the realtime module**

Create `services/users/src/nest/shared/realtime/realtime.module.ts`. Read the two classes first:

```bash
cd services/users && grep -n "constructor\|export class" src/shared/realtime/websocket-publisher.ts src/shared/realtime/connections-reader.ts
```

```typescript
import { Global, Module } from "@nestjs/common";
import { WebsocketPublisher } from "#shared/realtime/websocket-publisher";
import { ConnectionsReader } from "#shared/realtime/connections-reader";
import type { Env } from "#shared/config/env";
import { ENV } from "../tokens.ts";

// An outbound client to AWS's own WebSocket API Gateway, not a socket server
// this process hosts — so no @nestjs/websockets gateway applies here.
@Global()
@Module({
  providers: [
    { provide: ConnectionsReader, inject: [ENV], useFactory: (env: Env) => new ConnectionsReader({ env }) },
    {
      provide: WebsocketPublisher,
      inject: [ENV, ConnectionsReader],
      useFactory: (env: Env, connections: ConnectionsReader) =>
        new WebsocketPublisher({ env, connections }),
    },
  ],
  exports: [WebsocketPublisher, ConnectionsReader],
})
export class RealtimeModule {}
```

Adjust both factories to the real constructor parameter names found above.

- [ ] **Step 10: Register the modules in the root module**

`services/users/src/nest/app.module.ts`:

```typescript
import { Module } from "@nestjs/common";
import { ConfigModule } from "./shared/config/config.module.ts";
import { PrismaModule } from "./shared/prisma/prisma.module.ts";
import { AuthModule } from "./shared/auth/auth.module.ts";
import { CacheModule } from "./shared/cache/cache.module.ts";
import { MessagingModule } from "./shared/messaging/messaging.module.ts";
import { MetricsModule } from "./shared/metrics/metrics.module.ts";
import { RealtimeModule } from "./shared/realtime/realtime.module.ts";
import { HealthController } from "./health/health.controller.ts";

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuthModule,
    CacheModule,
    MessagingModule,
    MetricsModule,
    RealtimeModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
```

- [ ] **Step 11: Run the test to verify it passes**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/shared-modules.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 12: Leave the work in the working tree**

---

### Task 4: Request-context middleware (ALS actor + log context + auth guard)

This carries over the single most trap-laden piece of `routes.ts`: the `onRequest` hook. Its three contracts (call the continuation INSIDE the ALS callback, attach the request id BEFORE the auth guard, 401 on a missing `x-user-id` for non-public routes) are preserved verbatim.

**Files:**
- Create: `services/users/src/nest/shared/http/request-context.middleware.ts`
- Modify: `services/users/src/nest/app.module.ts`
- Test: `services/users/tests/nest/request-context.test.ts`

**Interfaces:**
- Consumes: `isPublicRoute` from `#shared/http/public-routes`, `actorContext` from `#shared/audit/actor-context`, `logContext`/`resolveRequestId`/`resolveRunId` from `#shared/logging/*`.
- Produces: `RequestContextMiddleware`, applied to every route. Downstream handlers read the actor via `actorContext` and the correlation fields via `logContext` — no controller passes them explicitly.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/nest/request-context.test.ts`:

```typescript
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Controller, Get, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { getLogContext } from "#shared/logging/log-context";
import { actorContext } from "#shared/audit/actor-context";
import { AppModule } from "#nest/app.module";

@Controller("v1/probe")
class ProbeController {
  @Get()
  read(): { actor: string | undefined; request_id: string | undefined } {
    // Reads the two AsyncLocalStorage stores the middleware must have entered.
    return {
      actor: actorContext.getStore()?.actor,
      request_id: getLogContext().request_id,
    };
  }
}

@Module({ imports: [AppModule], controllers: [ProbeController] })
class ProbeModule {}

describe("request context middleware", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("carries the actor into the handler's AsyncLocalStorage store", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/probe",
      headers: { "x-user-id": "cognito-sub-1" },
    });

    expect(response.json().actor).toBe("cognito-sub-1");
  });

  it("seeds a request_id that reaches the handler", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/probe",
      headers: { "x-user-id": "cognito-sub-1" },
    });

    expect(response.json().request_id).toMatch(/^req_/);
  });

  it("answers 401 unauthenticated when x-user-id is absent on a non-public route", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/probe" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthenticated" });
  });

  it("lets a public route through with no x-user-id", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/health" });

    expect(response.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/request-context.test.ts
```

Expected: FAIL — the actor is `undefined` and the 401 test gets a 200.

- [ ] **Step 3: Write the middleware**

Create `services/users/src/nest/shared/http/request-context.middleware.ts`:

```typescript
import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { actorContext } from "#shared/audit/actor-context";
import { logContext } from "#shared/logging/log-context";
import { REQUEST_ID_HEADER, resolveRequestId } from "#shared/logging/request-id";
import { RUN_ID_HEADER, resolveRunId } from "#shared/logging/run-id";
import { isPublicRoute } from "#shared/http/public-routes";
import { env } from "#shared/config/env";

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  // CONTRACT: Call `next()` from INSIDE the actorContext.run callback. The rest of
  // the request continues off that call, so a `next()` outside it leaves every
  // later frame without the store and the Prisma audit extension writes a null
  // actor. See [[audit-fields]]
  use(req: FastifyRequest["raw"], res: FastifyReply["raw"], next: () => void): void {
    const actor = req.headers["x-user-id"] as string | undefined;
    const routePath = req.url ?? "";

    // CONTRACT: Attach the request id BEFORE the auth guard below, which returns
    // instead of calling next(). That branch never reaches the logContext.run
    // wrapper, so without enterWith here every 401 ships with no correlation id.
    // See [[2026-08-15-request-id-correlation-design]]
    const request_id = resolveRequestId(req.headers[REQUEST_ID_HEADER] as string | undefined);
    // CONTRACT: `run_id` is E2E-only and caller-controlled — without
    // E2E_TESTING_ENABLED the header must behave as if never sent. Omit it when
    // absent, never blank. See [[logging-context]]
    const run_id = resolveRunId(
      req.headers[RUN_ID_HEADER] as string | undefined,
      env.E2E_TESTING_ENABLED,
    );
    logContext.enterWith({ request_id, ...(run_id ? { run_id } : {}) });

    if (actor === undefined && !isPublicRoute(req.method ?? "GET", routePath)) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "unauthenticated" }));
      return; // do NOT call next() — the request is already finished
    }

    actorContext.run({ actor }, () => {
      logContext.run(
        {
          request_id,
          ...(actor === undefined ? {} : { cognito_sub: actor }),
          ...(run_id ? { run_id } : {}),
        },
        next,
      );
    });
  }
}
```

- [ ] **Step 4: Check how `isPublicRoute` matches, then reconcile the path**

```bash
cd services/users && cat src/shared/http/public-routes.ts
```

Fastify's hook passed `req.routeOptions.url` (the route **pattern**, e.g. `/v1/users/:id`); middleware sees the raw URL with query string. **If `isPublicRoute` matches on patterns, strip the query string and confirm each public route still matches**; if any public route is parameterised, move this guard to a Nest `APP_GUARD` instead, where `ExecutionContext` exposes the matched route. Add a test for every entry the file lists before moving on.

- [ ] **Step 5: Apply the middleware to all routes**

In `services/users/src/nest/app.module.ts`, implement `NestModule`:

```typescript
import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { RequestContextMiddleware } from "./shared/http/request-context.middleware.ts";

// ... the @Module decorator is unchanged ...
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes("*");
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/request-context.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Prove the ALS store survives an awaited Prisma call**

Add this test to the same file. It guards [[2026-07-12-prisma-lazy-promise-als]]: Prisma promises are lazy, so an `await` outside the ALS callback loses the context.

```typescript
it("keeps the actor store across an awaited async boundary", async () => {
  // A plain await is the same hazard shape as an awaited Prisma call: the
  // context must still be there on the far side of the microtask.
  const seen: Array<string | undefined> = [];
  await actorContext.run({ actor: "cognito-sub-1" }, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    seen.push(actorContext.getStore()?.actor);
  });

  expect(seen).toEqual(["cognito-sub-1"]);
});
```

- [ ] **Step 8: Leave the work in the working tree**

---
### Task 5: The workflow interceptor — tracing, `app_event`, and reason-deferral

**This is the task the whole migration exists for, and the one most likely to ship a silent observability regression.** Findings #1–#3 from the spec are built in from the first line, not retrofitted: the spec is explicit that building a generic interceptor first and adding reason-deferral later is the exact sequence that produced the original clobber bug.

The three rules, restated as this task's acceptance criteria:

1. **Routine ≠ thrown.** A handler that *returns* a routine failure (a `null` meaning "not found") logs `*_failed` + `reason` but leaves span status **OK**. Only a *thrown* error sets `ERROR`.
2. **Never clobber a specific reason.** `span.setAttributes` is last-write-wins per key. The interceptor stamps `reason: "unhandled_error"` **only** when the handler recorded none — on both the thrown and the routine branch.
3. **One failure, one log line.** If the handler already logged its own `*_failed`, the interceptor does not log its own.

**Files:**
- Create: `services/users/src/nest/shared/observability/workflow-metadata.ts`
- Create: `services/users/src/nest/shared/observability/workflow.interceptor.ts`
- Test: `services/users/tests/nest/workflow-interceptor.test.ts`

**Interfaces:**
- Consumes: `withWorkflowSpan` from `#shared/observability/workflow-tracing` (unchanged), `appLogger`, `trace` from `@opentelemetry/api`.
- Produces:
  - `@Workflow(flow: string)` — class decorator on a handler, naming its flow (`"login"`, `"get_profile"`, …). Every later handler task applies it.
  - `WorkflowInterceptor` — registered globally in Task 6.
  - `RoutineFailure` — a marker a handler returns to signal "routine failure, do not mark the span ERROR":
    ```typescript
    export class RoutineFailure<T = null> {
      constructor(public readonly reason: string, public readonly value: T = null as T) {}
    }
    ```

- [ ] **Step 1: Write the failing tests**

Create `services/users/tests/nest/workflow-interceptor.test.ts`. **These tests go through the real `CommandBus`, never a direct handler call** — spec finding #4 exists because 709 direct-call tests missed a production-path bug.

```typescript
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CommandHandler, CqrsModule, type ICommandHandler } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { trace } from "@opentelemetry/api";
import { testSpanExporter } from "../setup-tracing.ts";
import { appLogger } from "#shared/logging/app-logger";
import { RoutineFailure, Workflow } from "#nest/shared/observability/workflow-metadata";
import { WorkflowInterceptor } from "#nest/shared/observability/workflow.interceptor";

class HappyCommand {}
class ThrowingWithReasonCommand {}
class ThrowingBareCommand {}
class RoutineCommand {}

@Workflow("happy_flow")
@CommandHandler(HappyCommand)
class HappyHandler implements ICommandHandler<HappyCommand> {
  async execute(): Promise<string> {
    return "ok";
  }
}

@Workflow("reasoned_flow")
@CommandHandler(ThrowingWithReasonCommand)
class ThrowingWithReasonHandler implements ICommandHandler<ThrowingWithReasonCommand> {
  async execute(): Promise<never> {
    // The handler records its own specific reason and logs its own line, exactly
    // as login.ts and change-password.ts do today.
    trace.getActiveSpan()?.setAttributes({
      app_event: "reasoned_flow_failed",
      reason: "invalid_credentials",
    });
    appLogger.error(
      { app_event: "reasoned_flow_failed", reason: "invalid_credentials" },
      "handler logged its own failure",
    );
    throw new Error("rejected");
  }
}

@Workflow("bare_flow")
@CommandHandler(ThrowingBareCommand)
class ThrowingBareHandler implements ICommandHandler<ThrowingBareCommand> {
  async execute(): Promise<never> {
    throw new Error("boom");
  }
}

@Workflow("routine_flow")
@CommandHandler(RoutineCommand)
class RoutineHandler implements ICommandHandler<RoutineCommand> {
  async execute(): Promise<RoutineFailure> {
    return new RoutineFailure("user_not_found");
  }
}

@Module({
  imports: [CqrsModule],
  providers: [
    HappyHandler,
    ThrowingWithReasonHandler,
    ThrowingBareHandler,
    RoutineHandler,
    { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
  ],
})
class WorkflowTestModule {}

async function bus() {
  const moduleRef = await Test.createTestingModule({ imports: [WorkflowTestModule] }).compile();
  await moduleRef.init();
  return { bus: moduleRef.get(CommandBus), close: () => moduleRef.close() };
}

function spanNamed(name: string) {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === name);
}

describe("WorkflowInterceptor", () => {
  beforeEach(() => testSpanExporter.reset());

  it("emits a span with app_event=<flow>_succeeded and OK status on success", async () => {
    const { bus: b, close } = await bus();

    expect(await b.execute(new HappyCommand())).toBe("ok");

    const span = spanNamed("happy_flow");
    expect(span!.attributes.app_event).toBe("happy_flow_succeeded");
    expect(span!.status.code).toBe(SpanStatusCode.OK);
    expect(span!.attributes.reason).toBeUndefined();
    await close();
  });

  it("does NOT clobber a reason the handler already recorded", async () => {
    const { bus: b, close } = await bus();

    await expect(b.execute(new ThrowingWithReasonCommand())).rejects.toThrow("rejected");

    const span = spanNamed("reasoned_flow");
    expect(span!.attributes.reason).toBe("invalid_credentials");
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("stamps reason=unhandled_error only when the handler recorded none", async () => {
    const { bus: b, close } = await bus();

    await expect(b.execute(new ThrowingBareCommand())).rejects.toThrow("boom");

    const span = spanNamed("bare_flow");
    expect(span!.attributes.reason).toBe("unhandled_error");
    expect(span!.attributes.app_event).toBe("bare_flow_failed");
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("leaves span status OK for a routine (non-throwing) failure", async () => {
    const { bus: b, close } = await bus();

    await b.execute(new RoutineCommand());

    const span = spanNamed("routine_flow");
    expect(span!.attributes.app_event).toBe("routine_flow_failed");
    expect(span!.attributes.reason).toBe("user_not_found");
    expect(span!.status.code).not.toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("logs exactly ONE *_failed line when the handler logged its own", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(appLogger, "error").mockImplementation(((fields: Record<string, unknown>) => {
      lines.push(fields);
    }) as never);
    const { bus: b, close } = await bus();

    await expect(b.execute(new ThrowingWithReasonCommand())).rejects.toThrow("rejected");

    spy.mockRestore();
    expect(lines.filter((l) => l.app_event === "reasoned_flow_failed")).toHaveLength(1);
    await close();
  });

  it("logs its own *_failed line when the handler logged none", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(appLogger, "error").mockImplementation(((fields: Record<string, unknown>) => {
      lines.push(fields);
    }) as never);
    const { bus: b, close } = await bus();

    await expect(b.execute(new ThrowingBareCommand())).rejects.toThrow("boom");

    spy.mockRestore();
    expect(lines.filter((l) => l.app_event === "bare_flow_failed")).toHaveLength(1);
    await close();
  });
});
```

- [ ] **Step 2: Confirm the test exporter's export name**

```bash
cd services/users && grep -n "export" tests/setup-tracing.ts
```

Use whatever `setup-tracing.ts` actually exports; if the existing tests import it differently (check `tests/features/users/commands/login.test.ts`'s imports), match that import exactly.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/workflow-interceptor.test.ts
```

Expected: FAIL — `Cannot find module '#nest/shared/observability/workflow-metadata'`.

- [ ] **Step 4: Write the metadata decorator and the routine marker**

Create `services/users/src/nest/shared/observability/workflow-metadata.ts`:

```typescript
export const WORKFLOW_FLOW = Symbol.for("users:workflowFlow");

/**
 * Names the business flow a handler implements, so the interceptor can derive
 * `<flow>_started` / `_succeeded` / `_failed` without each handler repeating them.
 */
export function Workflow(flow: string): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(WORKFLOW_FLOW, flow, target);
  };
}

/**
 * A failure that is a normal outcome of the flow, not an error.
 *
 * CONTRACT: Returning this logs `<flow>_failed` + `reason` and leaves span status
 * OK — a "not found" the controller turns into a 404 is not a fault. Throwing is
 * what sets ERROR. Flattening the two is an observability regression that passes
 * review unnoticed. See [[logging-context]]
 */
export class RoutineFailure<T = null> {
  constructor(
    public readonly reason: string,
    public readonly value: T = null as T,
  ) {}
}
```

- [ ] **Step 5: Write the interceptor**

Create `services/users/src/nest/shared/observability/workflow.interceptor.ts`:

```typescript
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common";
import { SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { Observable, from, switchMap } from "rxjs";
import { appLogger } from "#shared/logging/app-logger";
import { RoutineFailure, WORKFLOW_FLOW } from "./workflow-metadata.ts";

const tracer = trace.getTracer("users-workflow");

// Reads the reason a handler stamped on its own span. `setAttributes` is
// last-write-wins per key, so this is what stands between a generic catch and a
// destroyed `invalid_credentials`/`passwordless_user`/`cognito_error`.
function recordedReason(span: Span): string | undefined {
  const attributes = (span as unknown as { attributes?: Record<string, unknown> }).attributes;
  const reason = attributes?.reason;
  return typeof reason === "string" ? reason : undefined;
}

function recordedAppEvent(span: Span): string | undefined {
  const attributes = (span as unknown as { attributes?: Record<string, unknown> }).attributes;
  const appEvent = attributes?.app_event;
  return typeof appEvent === "string" ? appEvent : undefined;
}

@Injectable()
export class WorkflowInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const flow = Reflect.getMetadata(WORKFLOW_FLOW, context.getClass()) as string | undefined;
    // Untagged handlers pass straight through: a flow name is opt-in, and a
    // guessed one would invent `app_event` values no dashboard filters on.
    if (!flow) return next.handle();

    return from(this.run(flow, next));
  }

  private async run(flow: string, next: CallHandler): Promise<unknown> {
    return tracer.startActiveSpan(
      flow,
      { kind: SpanKind.INTERNAL, attributes: { app_event: `${flow}_started` } },
      async (span) => {
        try {
          const result = await firstValue(next.handle());

          // CONTRACT: A routine failure is a RETURNED value, not a throw — it
          // logs `_failed` + reason with span status left OK. See the class
          // comment on RoutineFailure.
          if (result instanceof RoutineFailure) {
            span.setAttributes({ app_event: `${flow}_failed`, reason: result.reason });
            this.logFailureOnce(span, flow, result.reason);
            return result.value;
          }

          span.setAttributes({ app_event: `${flow}_succeeded` });
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          // CONTRACT: Defer to a reason the handler already recorded. Stamping
          // unconditionally overwrites `invalid_credentials`, `passwordless_user`,
          // `cognito_error`, `invalid_otp` and `unknown_user` — proven
          // empirically, and asserted by login.test.ts and
          // change-password.test.ts. See [[logging-context]]
          const reason = recordedReason(span) ?? "unhandled_error";
          span.setAttributes({ app_event: `${flow}_failed`, reason });
          this.logFailureOnce(span, flow, reason, err);
          throw err;
        } finally {
          // CONTRACT: end() in a finally — a span left open on the exception path
          // is never exported and vanishes from the cascade without erroring.
          span.end();
        }
      },
    );
  }

  // CONTRACT: One failure, one `*_failed` line. A handler that already logged its
  // own specific line has said everything this one would; logging anyway doubles
  // every failure in the stream.
  private logFailureOnce(span: Span, flow: string, reason: string, err?: unknown): void {
    if (recordedAppEvent(span) === `${flow}_failed` && this.handlerLogged) return;
    appLogger.error({ ...(err ? { err } : {}), app_event: `${flow}_failed`, reason }, `${flow} failed`);
  }
}
```

- [ ] **Step 6: Replace the log-suppression placeholder with a real signal**

`this.handlerLogged` in Step 5 does not exist — it stands in for the decision the interceptor cannot make by reading the span alone. Implement it by having `appLogger` record the last `app_event` it emitted within the active span, and read that:

In `services/users/src/shared/logging/app-logger.ts`, export a small accessor alongside the logger:

```typescript
// The last `app_event` logged inside the active span, so a wrapping interceptor
// can tell whether a handler already reported this failure and avoid a second
// line for one event. Keyed by span id — a process-wide "last" value would leak
// across concurrent requests.
const loggedEvents = new WeakMap<object, Set<string>>();

export function noteLoggedEvent(spanKey: object, appEvent: string): void {
  const events = loggedEvents.get(spanKey) ?? new Set<string>();
  events.add(appEvent);
  loggedEvents.set(spanKey, events);
}

export function hasLoggedEvent(spanKey: object, appEvent: string): boolean {
  return loggedEvents.get(spanKey)?.has(appEvent) ?? false;
}
```

Call `noteLoggedEvent(span, fields.app_event)` from the logger's own error/warn path when a span is active, then in the interceptor replace the placeholder condition with:

```typescript
if (hasLoggedEvent(span, `${flow}_failed`)) return;
```

**Run the "exactly ONE line" and "logs its own line" tests after this step specifically** — they are the only two that distinguish a working suppression from a no-op.

- [ ] **Step 7: Add the `firstValue` helper**

At the bottom of `workflow.interceptor.ts`:

```typescript
import { firstValueFrom, type Observable as Obs } from "rxjs";

// CommandBus handlers return promises; Nest hands the interceptor an Observable.
// Unwrapping to the first value keeps the `await` semantics the handlers expect.
function firstValue(source: Obs<unknown>): Promise<unknown> {
  return firstValueFrom(source);
}
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/workflow-interceptor.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 9: Mutation-test the three critical assertions**

Spec finding #5: a green suite is not evidence, and this exact file is where three vacuous-test traps were found before. Break each rule by hand, confirm the matching test goes red, then revert:

| Mutation | Test that must fail |
|---|---|
| Change `recordedReason(span) ?? "unhandled_error"` to `"unhandled_error"` | "does NOT clobber a reason the handler already recorded" |
| Add `span.setStatus({ code: SpanStatusCode.ERROR })` to the `RoutineFailure` branch | "leaves span status OK for a routine failure" |
| Delete the `hasLoggedEvent` early return | "logs exactly ONE *_failed line" |

**If any mutation leaves the suite green, that test is vacuous — fix it before continuing.** Record the outcome in the handoff summary.

- [ ] **Step 10: Leave the work in the working tree**

---

### Task 6: Zod validation pipe, domain exception filter, response-log interceptor

The three remaining cross-cutting pieces, grouped because they share one acceptance criterion: the HTTP error and log contracts must come out byte-identical to Fastify's.

**Files:**
- Create: `services/users/src/nest/shared/http/zod-validation.pipe.ts`
- Create: `services/users/src/nest/shared/http/domain-exception.filter.ts`
- Create: `services/users/src/nest/shared/http/response-log.interceptor.ts`
- Modify: `services/users/src/nest/main.ts`
- Modify: `services/users/src/nest/app.module.ts`
- Test: `services/users/tests/nest/http-cross-cutting.test.ts`

**Interfaces:**
- Consumes: `AuthError`, `RecordNotFoundError`, `CascadeError`, `MetricsPublisher`, `withHttpServerSpan`.
- Produces:
  - `ZodValidationPipe` — `new ZodValidationPipe(SomeSchema)`, used per-parameter by every controller task: `@Body(new ZodValidationPipe(RegisterInputSchema)) body: RegisterInput`.
  - `DomainExceptionFilter` — registered globally.
  - `ResponseLogInterceptor` — registered globally.

- [ ] **Step 1: Determine the current validation-error body**

The E2E specs assert on this shape, so it must be reproduced exactly, not approximated.

```bash
cd services/users && grep -rn "setErrorHandler\|statusCode.*400\|validation" src/features/users/http/routes.ts | head -20
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure && grep -rn "400" e2e/tests/users.spec.ts | head -20
```

Record the exact body the service returns for a Zod rejection today. **Use that shape verbatim in Step 3's test and in the pipe.** Fastify's default for a failed `validatorCompiler` is `{ statusCode: 400, code, error: "Bad Request", message }` — confirm before assuming it.

- [ ] **Step 2: Write the failing tests**

Create `services/users/tests/nest/http-cross-cutting.test.ts`:

```typescript
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Body, Controller, Get, Module, Post } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { z } from "zod/v4";
import { AppModule } from "#nest/app.module";
import { ZodValidationPipe } from "#nest/shared/http/zod-validation.pipe";
import { DomainExceptionFilter } from "#nest/shared/http/domain-exception.filter";
import { InvalidCredentialsError } from "#shared/auth/auth-errors";
import { RecordNotFoundError } from "#shared/db/db-errors";
import { CascadeError } from "#shared/http/cascade-client";

const BodySchema = z.object({ email: z.string().email() });

@Controller("v1/probe")
class ProbeController {
  @Post("validate")
  validate(@Body(new ZodValidationPipe(BodySchema)) body: { email: string }): { email: string } {
    return body;
  }

  @Get("auth-error")
  authError(): never {
    throw new InvalidCredentialsError();
  }

  @Get("not-found")
  notFound(): never {
    throw new RecordNotFoundError();
  }

  @Get("cascade-error")
  cascadeError(): never {
    throw new CascadeError("orders leg did not confirm");
  }
}

@Module({
  imports: [AppModule],
  controllers: [ProbeController],
  providers: [{ provide: APP_FILTER, useClass: DomainExceptionFilter }],
})
class ProbeModule {}

describe("HTTP cross-cutting behaviour", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const authed = { "x-user-id": "cognito-sub-1" };

  it("accepts a body that satisfies the schema", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/probe/validate",
      headers: authed,
      payload: { email: "ada@example.com" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ email: "ada@example.com" });
  });

  it("rejects an invalid body with the service's existing 400 contract", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/probe/validate",
      headers: authed,
      payload: { email: "not-an-email" },
    });

    expect(response.statusCode).toBe(400);
    // Replace with the EXACT body recorded in Step 1.
    expect(response.json()).toMatchObject({ statusCode: 400, error: "Bad Request" });
  });

  it("maps an AuthError to its own status and code", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/probe/auth-error", headers: authed });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_credentials" });
  });

  it("maps a RecordNotFoundError to 404 not_found", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/probe/not-found", headers: authed });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });

  it("maps a CascadeError to 502 cascade_failed", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/probe/cascade-error",
      headers: authed,
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "cascade_failed" });
  });
});
```

**Check `InvalidCredentialsError`'s real `statusCode`/`code` and `RecordNotFoundError`'s before running:**

```bash
cd services/users && grep -n "statusCode\|code" src/shared/auth/auth-errors.ts src/shared/db/db-errors.ts | head -20
```

Use the real values; a guessed 401/`invalid_credentials` that happens to be wrong makes this test assert the wrong contract.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/http-cross-cutting.test.ts
```

Expected: FAIL — the pipe and filter modules do not exist.

- [ ] **Step 4: Write the Zod pipe**

Create `services/users/src/nest/shared/http/zod-validation.pipe.ts`:

```typescript
import { BadRequestException, Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod/v4";

/**
 * Validates one parameter against a Zod schema.
 *
 * CONTRACT: The rejection body must match the shape the service already returns —
 * the E2E specs assert on it, so a differently-shaped 400 breaks the contract even
 * though validation itself works. See [[openapi-specs]]
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    // WARNING: Field PATHS only. A raw Zod message echoes the rejected values,
    // and those include passwords and emails. See [[logging-context]]
    throw new BadRequestException({
      statusCode: 400,
      error: "Bad Request",
      message: result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", "),
    });
  }
}
```

Adjust the thrown object to the exact shape recorded in Step 1.

- [ ] **Step 5: Write the exception filter**

Create `services/users/src/nest/shared/http/domain-exception.filter.ts`:

```typescript
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { AuthError } from "#shared/auth/auth-errors";
import { RecordNotFoundError } from "#shared/db/db-errors";
import { CascadeError } from "#shared/http/cascade-client";

// Maps this service's domain errors onto the HTTP contract the routes already
// serve. Everything else falls through to Nest's own handling, which keeps
// producing the default body.
@Catch(AuthError, RecordNotFoundError, CascadeError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    if (error instanceof AuthError) {
      void reply.code(error.statusCode).send({ error: error.code });
      return;
    }
    if (error instanceof RecordNotFoundError) {
      void reply.code(error.statusCode).send({ error: error.code });
      return;
    }
    // A cascade leg did not confirm, so the account was deliberately NOT deleted.
    // 502 rather than 500: the failure is DOWNSTREAM and both internal routes are
    // idempotent, so the correct client action is to retry.
    void reply.code(502).send({ error: "cascade_failed" });
  }
}
```

- [ ] **Step 6: Write the response-log interceptor**

Create `services/users/src/nest/shared/http/response-log.interceptor.ts`, carrying over the three contracts from `routes.ts`'s `onResponse` hook verbatim:

```typescript
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Observable, tap } from "rxjs";
import { withHttpServerSpan } from "#shared/observability/request-span";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";

const HEALTH_ROUTE = "/v1/health";

@Injectable()
export class ResponseLogInterceptor implements NestInterceptor {
  constructor(private readonly metricsPublisher: MetricsPublisher) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const startedAt = process.hrtime.bigint();

    return next.handle().pipe(
      tap({
        next: () => this.emit(req, reply, startedAt),
        error: () => this.emit(req, reply, startedAt),
      }),
    );
  }

  private emit(req: FastifyRequest, reply: FastifyReply, startedAt: bigint): void {
    const route = req.routeOptions?.url ?? req.url;
    const status = reply.statusCode;

    // CONTRACT: Exempt the liveness probe by STATUS, never by route. A succeeding
    // probe logs nothing; a FAILING one must still log. Suppressing the route
    // instead hides the failures. See [[health-check-logging]]
    const isHealthySoak = route === HEALTH_ROUTE && status >= 200 && status < 300;

    if (!isHealthySoak) {
      // CONTRACT: Log with the HTTP SERVER span active, not the ambient hook span,
      // or the line is stamped with the wrong span_id and OpenObserve's "View
      // logs" on the request span returns NOTHING. See [[logging-context]]
      withHttpServerSpan(req, () => {
        req.log.info(
          {
            http_request_method: req.method,
            http_route: route,
            http_response_status_code: status,
            duration_ms: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
            // CONTRACT: Do NOT add `trace_id: req.id`. The real OTel ids come from
            // logger.ts's formatter, and an explicit field beats the ambient one —
            // Fastify's local counter would break the logs↔traces join.
            // See [[logging-context]]
          },
          "request completed",
        );
      });
    }

    // ONLY 4xx/5xx. A metric per 2xx would be a request-rate metric, which the
    // log line above already provides.
    if (status >= 400) {
      // CONTRACT: Keep this guarded and unawaited. Awaiting would hold the
      // connection open for a PutMetricData round trip; publish() never rejects.
      try {
        void this.metricsPublisher.publish("http_errors_total", 1, {
          Service: "users",
          StatusClass: status >= 500 ? "5xx" : "4xx",
        });
      } catch {
        // Intentionally silent — see above.
      }
    }
  }
}
```

- [ ] **Step 7: Disable Nest's own request logging**

In `main.ts`, build the adapter with the service's Pino options and Fastify's own request logging off — the interceptor above replaces it:

```typescript
import { buildLoggerOptions } from "#shared/logging/logger";

const adapter = new FastifyAdapter({
  logger: buildLoggerOptions({ serviceName: "users", environment: env.DEPLOYMENT_ENVIRONMENT }),
  // CONTRACT: Keep this true — ResponseLogInterceptor replaces Fastify's own
  // request log rather than adding to it. Re-enabling it emits TWO "request
  // completed" lines per request, doubling every request-rate figure.
  // See [[logging-context]]
  disableRequestLogging: true,
});
```

- [ ] **Step 8: Register all three globally**

In `app.module.ts`'s `providers`:

```typescript
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { DomainExceptionFilter } from "./shared/http/domain-exception.filter.ts";
import { ResponseLogInterceptor } from "./shared/http/response-log.interceptor.ts";
import { WorkflowInterceptor } from "./shared/observability/workflow.interceptor.ts";

// providers: [
//   { provide: APP_FILTER, useClass: DomainExceptionFilter },
//   { provide: APP_INTERCEPTOR, useClass: ResponseLogInterceptor },
//   { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
// ]
```

The pipe is **not** global — it takes a schema per parameter, so controllers construct it inline.

- [ ] **Step 9: Run the tests to verify they pass**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/http-cross-cutting.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 10: Run every Nest test written so far**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/
```

Expected: all green. This is the foundation every handler task builds on; do not proceed on a red suite.

- [ ] **Step 11: Leave the work in the working tree**

---
## Phase 2 — Handlers behind the bus (Tasks 7–17)

Every task in this phase follows the same five-move shape, and each one migrates a handler **and** rewrites its tests (DI-3):

1. Write the command/query object and the `@CommandHandler`/`@QueryHandler` class.
2. Rewrite the handler's existing test file against `Test.createTestingModule()`, **diffing assertions against the original** — same count, same strictness.
3. Delete the hand-rolled `execute → withWorkflowSpan → doExecute` wrapper; the `@Workflow()` decorator and the interceptor replace it.
4. Keep every handler-specific `trace.getActiveSpan()?.setAttributes(...)` call **exactly as it is** — those are the specific reasons the interceptor defers to.
5. Run both the new test and the original, then leave the work in the working tree.

**The order is deliberate**: a read with no side effects first, then the two commands that carry the specific-reason requirement, since those are where a clobber bug surfaces first and are already covered by the tests spec finding #2 cites.

### Task 7: `GetMeQuery` — the pipeline proof with no side effects

**Files:**
- Create: `services/users/src/nest/users/queries/get-me.query.ts`
- Create: `services/users/src/nest/users/queries/get-user-by-id.query.ts`
- Create: `services/users/src/nest/users/users.module.ts`
- Modify: `services/users/src/nest/app.module.ts`
- Test: `services/users/tests/nest/users/get-me.test.ts`, `services/users/tests/nest/users/get-user-by-id.test.ts`
- Reference (do not modify yet): `services/users/src/features/users/queries/get-me.ts`, `services/users/tests/features/users/queries/get-me.test.ts`, `services/users/tests/features/users/grpc/get-user-by-id.test.ts`

**Interfaces:**
- Consumes: `DB` token (Task 3), `@Workflow`/`RoutineFailure` (Task 5), `CurrentUser` from `#shared/auth/current-user`.
- Produces:
  - `class GetMeQuery { constructor(public readonly currentUser: CurrentUser) {} }`
  - `GetMeHandler.execute(query: GetMeQuery): Promise<User | RoutineFailure>` — returns `RoutineFailure("user_not_found")` when the caller resolves to nothing, so the controller answers 404 and the span stays OK.
  - `class GetUserByIdQuery { constructor(public readonly id: string) {} }`
  - `GetUserByIdHandler.execute(query: GetUserByIdQuery): Promise<User | null>` — **consumed by Task 22's gRPC controller.** Split out of today's `UserQueryService`, which groups both reads behind one class.
  - `UsersModule` — later user tasks add their handlers to its `providers`.

- [ ] **Step 1: Read the original handler and its test side by side**

```bash
cd services/users && cat src/features/users/queries/get-me.ts
cat tests/features/users/queries/get-me.test.ts
```

Count the assertions in the original test file and write the number down. The rewritten file must carry at least as many, each at least as strict.

- [ ] **Step 2: Write the failing test**

Create `services/users/tests/nest/users/get-me.test.ts`:

```typescript
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CqrsModule, QueryBus } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { testSpanExporter } from "../../setup-tracing.ts";
import { DB } from "#nest/shared/tokens";
import { GetMeHandler, GetMeQuery } from "#nest/users/queries/get-me.query";
import { WorkflowInterceptor } from "#nest/shared/observability/workflow.interceptor";
import { RoutineFailure } from "#nest/shared/observability/workflow-metadata";

const ROW = {
  id: "usr_1",
  email: "ada@example.com",
  fullName: "Ada Lovelace",
  cognitoSub: "cognito-sub-1",
  address: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  deletedAt: null,
};

async function buildBus(resolved: unknown) {
  @Module({
    imports: [CqrsModule],
    providers: [
      { provide: DB, useValue: {} },
      GetMeHandler,
      { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  const currentUser = { resolve: vi.fn(async () => resolved) };
  return { bus: moduleRef.get(QueryBus), currentUser, close: () => moduleRef.close() };
}

describe("GetMeQuery through the QueryBus", () => {
  beforeEach(() => testSpanExporter.reset());

  it("returns the domain user for a resolved caller", async () => {
    const { bus, currentUser, close } = await buildBus(ROW);

    const result = await bus.execute(new GetMeQuery(currentUser as never));

    expect(result).toMatchObject({ id: "usr_1", email: "ada@example.com" });
    await close();
  });

  it("emits app_event=get_profile_succeeded with the resolved user_id", async () => {
    const { bus, currentUser, close } = await buildBus(ROW);

    await bus.execute(new GetMeQuery(currentUser as never));

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "get_profile");
    expect(span!.attributes.app_event).toBe("get_profile_succeeded");
    expect(span!.attributes.user_id).toBe("usr_1");
    expect(span!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });

  it("reports a missing user as a ROUTINE failure — reason set, span status NOT error", async () => {
    // CONTRACT: The route turns this into a 404. It is a normal outcome, so the
    // span keeps OK status and records the reason instead.
    const { bus, currentUser, close } = await buildBus(null);

    const result = await bus.execute(new GetMeQuery(currentUser as never));

    expect(result).toBeNull();
    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "get_profile");
    expect(span!.attributes.app_event).toBe("get_profile_failed");
    expect(span!.attributes.reason).toBe("user_not_found");
    expect(span!.status.code).not.toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("resolves the caller exactly once per query", async () => {
    const { bus, currentUser, close } = await buildBus(ROW);

    await bus.execute(new GetMeQuery(currentUser as never));

    expect(currentUser.resolve).toHaveBeenCalledOnce();
    await close();
  });

  it("puts no identity guess on the span before the user resolves", async () => {
    // The x-user-id header is either a `usr_` id or a Cognito sub, so labelling
    // it as either would be a guess. Only the RESOLVED user_id is recorded.
    const { bus, currentUser, close } = await buildBus(null);

    await bus.execute(new GetMeQuery(currentUser as never));

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "get_profile");
    expect(span!.attributes.user_id).toBeUndefined();
    await close();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/users/get-me.test.ts
```

Expected: FAIL — `Cannot find module '#nest/users/queries/get-me.query'`.

- [ ] **Step 4: Write the query handler**

Create `services/users/src/nest/users/queries/get-me.query.ts`:

```typescript
import { Inject } from "@nestjs/common";
import { type IQueryHandler, QueryHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { CurrentUser } from "#shared/auth/current-user";
import type { Db } from "#shared/db/prisma";
import { toDomain, type User } from "#features/users/domain/user";
import { DB } from "../../shared/tokens.ts";
import { RoutineFailure, Workflow } from "../../shared/observability/workflow-metadata.ts";

export class GetMeQuery {
  constructor(public readonly currentUser: CurrentUser) {}
}

@Workflow("get_profile")
@QueryHandler(GetMeQuery)
export class GetMeHandler implements IQueryHandler<GetMeQuery> {
  constructor(@Inject(DB) private readonly db: Db) {}

  async execute(query: GetMeQuery): Promise<User | RoutineFailure> {
    // Soft-deleted rows are excluded by the query extension and reads are routed
    // to the replica; the id-or-cognitoSub resolution is delegated to the
    // request-scoped CurrentUser, which caches it once per request.
    // See [[soft-delete]]
    const row = await query.currentUser.resolve();

    if (!row) {
      // A missing user is a routine outcome — the controller turns it into a
      // 404, so the span keeps OK status and the reason carries the meaning.
      return new RoutineFailure("user_not_found");
    }

    trace.getActiveSpan()?.setAttributes({ user_id: row.id });
    return toDomain(row as never);
  }
}
```

- [ ] **Step 5: Split out the second read and cover it**

`UserQueryService` groups `getMe` and `getUserById` because both share the same reader-backed, soft-delete-aware shape. Nest discovers handlers one command/query at a time, so the pair becomes two handlers.

Create `services/users/src/nest/users/queries/get-user-by-id.query.ts`:

```typescript
import { Inject } from "@nestjs/common";
import { type IQueryHandler, QueryHandler } from "@nestjs/cqrs";
import type { Db } from "#shared/db/prisma";
import { toDomain, type User } from "#features/users/domain/user";
import { DB } from "../../shared/tokens.ts";

export class GetUserByIdQuery {
  constructor(public readonly id: string) {}
}

// The gRPC surface's read (Task 22). No @Workflow decorator: the gRPC handler
// opens its own SERVER span via withGrpcServerSpan, and a second workflow span
// around the same call would nest one INTERNAL span inside it for no signal.
@QueryHandler(GetUserByIdQuery)
export class GetUserByIdHandler implements IQueryHandler<GetUserByIdQuery> {
  constructor(@Inject(DB) private readonly db: Db) {}

  // Accepts a `usr_` id OR a Cognito sub — the caller may hold either.
  async execute({ id }: GetUserByIdQuery): Promise<User | null> {
    const row = await this.db.user.findByIdOrCognitoSub(id);
    return row ? toDomain(row as never) : null;
  }
}
```

Create `services/users/tests/nest/users/get-user-by-id.test.ts` covering both branches through the `QueryBus`:

```typescript
import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Module } from "@nestjs/common";
import { CqrsModule, QueryBus } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { DB } from "#nest/shared/tokens";
import { GetUserByIdHandler, GetUserByIdQuery } from "#nest/users/queries/get-user-by-id.query";

async function buildBus(row: unknown) {
  const db = { user: { findByIdOrCognitoSub: vi.fn(async () => row) } };

  @Module({ imports: [CqrsModule], providers: [{ provide: DB, useValue: db }, GetUserByIdHandler] })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return { bus: moduleRef.get(QueryBus), db, close: () => moduleRef.close() };
}

describe("GetUserByIdQuery through the QueryBus", () => {
  it("returns the domain user when a row exists", async () => {
    const { bus, close } = await buildBus({
      id: "usr_1",
      email: "ada@example.com",
      fullName: "Ada",
      cognitoSub: "cognito-sub-1",
      address: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      deletedAt: null,
    });

    expect(await bus.execute(new GetUserByIdQuery("usr_1"))).toMatchObject({ id: "usr_1" });
    await close();
  });

  it("returns null when no row matches, so gRPC can map NOT_FOUND", async () => {
    const { bus, close } = await buildBus(null);

    expect(await bus.execute(new GetUserByIdQuery("usr_missing"))).toBeNull();
    await close();
  });

  it("resolves a Cognito sub through the same lookup as a usr_ id", async () => {
    const { bus, db, close } = await buildBus(null);

    await bus.execute(new GetUserByIdQuery("cognito-sub-1"));

    expect(db.user.findByIdOrCognitoSub).toHaveBeenCalledWith("cognito-sub-1");
    await close();
  });
});
```

- [ ] **Step 6: Write the users module**

Create `services/users/src/nest/users/users.module.ts`:

```typescript
import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { GetMeHandler } from "./queries/get-me.query.ts";
import { GetUserByIdHandler } from "./queries/get-user-by-id.query.ts";

// Handlers are discovered per module by @nestjs/cqrs; later tasks add theirs to
// `providers` and nothing else needs touching.
@Module({
  imports: [CqrsModule],
  providers: [GetMeHandler, GetUserByIdHandler],
})
export class UsersModule {}
```

Add `UsersModule` to `app.module.ts`'s `imports`.

- [ ] **Step 7: Run both tests to verify they pass**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/users/
```

Expected: PASS — 5 tests for `get-me`, 3 for `get-user-by-id`.

- [ ] **Step 8: Diff the assertions against the original**

Open `tests/features/users/queries/get-me.test.ts` beside the new file and confirm, assertion by assertion, that nothing verified before is unverified now. **Write the comparison into the handoff summary** — "5 assertions before, 5 after, none weakened" is the reviewable claim; "tests pass" is not.

- [ ] **Step 9: Leave the work in the working tree**

---

### Task 8: `LoginCommand` — the first specific-reason checkpoint

Spec finding #2's primary evidence lives here: `login.test.ts` asserts `invalid_credentials` and `passwordless_user` on the span. If the interceptor clobbers a reason, this task fails and the bug is caught before 14 more handlers are ported on top of it.

**Files:**
- Create: `services/users/src/nest/users/commands/login.command.ts`
- Modify: `services/users/src/nest/users/users.module.ts`
- Test: `services/users/tests/nest/users/login.test.ts`
- Reference: `services/users/src/features/users/commands/login.ts`, `services/users/tests/features/users/commands/login.test.ts`

**Interfaces:**
- Consumes: `DB`, `AUTH_PROVIDER`, `@Workflow`.
- Produces:
  - `class LoginCommand { constructor(public readonly input: LoginInput) {} }` where `LoginInput = { email: string; password: string }`
  - `LoginHandler.execute(command: LoginCommand): Promise<AuthTokens>` — throws `InvalidCredentialsError`; the HTTP contract is unchanged.

- [ ] **Step 1: Read the original handler and test**

```bash
cd services/users && cat src/features/users/commands/login.ts
cat tests/features/users/commands/login.test.ts
```

- [ ] **Step 2: Write the failing test**

Create `services/users/tests/nest/users/login.test.ts`. It mirrors the original's assertions and adds one the original could not make — that the reason survives the **bus pipeline**, not just a direct call:

```typescript
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CqrsModule } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { testSpanExporter } from "../../setup-tracing.ts";
import { appLogger } from "#shared/logging/app-logger";
import { AUTH_PROVIDER, DB } from "#nest/shared/tokens";
import { LoginCommand, LoginHandler } from "#nest/users/commands/login.command";
import { WorkflowInterceptor } from "#nest/shared/observability/workflow.interceptor";
import { InvalidCredentialsError } from "#shared/auth/auth-errors";

const TOKENS = { accessToken: "a", refreshToken: "r", idToken: "i", expiresIn: 3600 };

async function buildBus(overrides: { findUnique?: unknown; login?: unknown } = {}) {
  const db = { user: { findUnique: overrides.findUnique ?? vi.fn(async () => null) } };
  const auth = { login: overrides.login ?? vi.fn(async () => TOKENS) };

  @Module({
    imports: [CqrsModule],
    providers: [
      { provide: DB, useValue: db },
      { provide: AUTH_PROVIDER, useValue: auth },
      LoginHandler,
      { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return { bus: moduleRef.get(CommandBus), db, auth, close: () => moduleRef.close() };
}

function loginSpan() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "login");
}

describe("LoginCommand through the CommandBus", () => {
  beforeEach(() => testSpanExporter.reset());

  it("returns the tokens Cognito issued", async () => {
    const { bus, close } = await buildBus();

    expect(await bus.execute(new LoginCommand({ email: "a@b.co", password: "x" }))).toEqual(TOKENS);
    await close();
  });

  it("emits app_event=login_succeeded with OK status", async () => {
    const { bus, close } = await buildBus();

    await bus.execute(new LoginCommand({ email: "a@b.co", password: "x" }));

    expect(loginSpan()!.attributes.app_event).toBe("login_succeeded");
    expect(loginSpan()!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });

  it("keeps reason=invalid_credentials on the span THROUGH the bus pipeline", async () => {
    // CONTRACT: This is the clobber guard. A generic interceptor catch that
    // stamps `unhandled_error` unconditionally destroys this value, and
    // `setAttributes` is last-write-wins per key. See [[logging-context]]
    const { bus, close } = await buildBus({
      login: vi.fn(async () => {
        throw new InvalidCredentialsError();
      }),
    });

    await expect(
      bus.execute(new LoginCommand({ email: "a@b.co", password: "wrong" })),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(loginSpan()!.attributes.reason).toBe("invalid_credentials");
    expect(loginSpan()!.attributes.app_event).toBe("login_failed");
    expect(loginSpan()!.status.code).toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("keeps reason=passwordless_user for the guard rejection", async () => {
    const { bus, close } = await buildBus({
      findUnique: vi.fn(async () => ({ authType: "PASSWORDLESS" })),
    });

    await bus
      .execute(new LoginCommand({ email: "a@b.co", password: "x" }))
      .catch(() => undefined);

    expect(loginSpan()!.attributes.reason).toBe("passwordless_user");
    expect(loginSpan()!.status.code).toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("rejects a passwordless account BEFORE any Cognito call", async () => {
    const { bus, auth, close } = await buildBus({
      findUnique: vi.fn(async () => ({ authType: "PASSWORDLESS" })),
    });

    await bus
      .execute(new LoginCommand({ email: "a@b.co", password: "x" }))
      .catch(() => undefined);

    expect(auth.login).not.toHaveBeenCalled();
    await close();
  });

  it("reports reason=cognito_error when the provider fails for another reason", async () => {
    const { bus, close } = await buildBus({
      login: vi.fn(async () => {
        throw new Error("cognito down");
      }),
    });

    await expect(bus.execute(new LoginCommand({ email: "a@b.co", password: "x" }))).rejects.toThrow(
      "cognito down",
    );

    expect(loginSpan()!.attributes.reason).toBe("cognito_error");
    await close();
  });

  it("still asks Cognito when no local row exists for the email", async () => {
    const { bus, auth, close } = await buildBus({
      findUnique: vi.fn(async () => null),
      login: vi.fn(async () => {
        throw new InvalidCredentialsError();
      }),
    });

    await expect(
      bus.execute(new LoginCommand({ email: "nouser@b.co", password: "x" })),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(auth.login).toHaveBeenCalledOnce();
    await close();
  });

  it("looks the user up by email exactly once per login", async () => {
    const { bus, db, close } = await buildBus();

    await bus.execute(new LoginCommand({ email: "a@b.co", password: "x" }));

    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { email: "a@b.co" } });
    await close();
  });

  it("never puts the plaintext email or the password on the span", async () => {
    const { bus, close } = await buildBus();

    await bus.execute(new LoginCommand({ email: "ada@example.com", password: "Sup3rS3cret!" }));

    const serialized = JSON.stringify(loginSpan()!.attributes);
    expect(serialized).not.toContain("ada@example.com");
    expect(serialized).not.toContain("Sup3rS3cret!");
    expect(loginSpan()!.attributes.email_hash).toBeDefined();
    await close();
  });

  it("never writes the password to a log line on the guard path", async () => {
    const calls: unknown[] = [];
    const spy = vi.spyOn(appLogger, "error").mockImplementation(((...args: unknown[]) => {
      calls.push(args);
    }) as never);
    const { bus, close } = await buildBus({
      findUnique: vi.fn(async () => ({ authType: "PASSWORDLESS" })),
    });

    await bus.execute(new LoginCommand({ email: "a@b.co", password: "x" })).catch(() => undefined);

    spy.mockRestore();
    const [fields] = calls[0] as [Record<string, unknown>];
    expect(fields.app_event).toBe("login_failed");
    expect(fields.reason).toBe("passwordless_user");
    expect(JSON.stringify(calls)).not.toContain('"x"');
    await close();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/users/login.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 4: Write the command handler**

Create `services/users/src/nest/users/commands/login.command.ts`. The body is the original `doExecute` verbatim; only the wrapper and the constructor change:

```typescript
import { Inject } from "@nestjs/common";
import { type ICommandHandler, CommandHandler } from "@nestjs/cqrs";
import { trace } from "@opentelemetry/api";
import type { AuthProvider, AuthTokens } from "#shared/auth/auth-provider";
import type { Db } from "#shared/db/prisma";
import { InvalidCredentialsError } from "#shared/auth/auth-errors";
import { appLogger } from "#shared/logging/app-logger";
import { setLogContext } from "#shared/logging/log-context";
import { hashEmail } from "#shared/logging/email-hash";
import { maskEmail } from "#shared/logging/email-mask";
import { AUTH_PROVIDER, DB } from "../../shared/tokens.ts";
import { Workflow } from "../../shared/observability/workflow-metadata.ts";

export interface LoginInput {
  email: string;
  password: string;
}

export class LoginCommand {
  constructor(public readonly input: LoginInput) {}
}

@Workflow("login")
@CommandHandler(LoginCommand)
export class LoginHandler implements ICommandHandler<LoginCommand> {
  constructor(
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    @Inject(DB) private readonly db: Db,
  ) {}

  async execute({ input }: LoginCommand): Promise<AuthTokens> {
    // Only email_hash goes in the CONTEXT — context fields stick to every later
    // line of the request. The plaintext email is passed per-call-site instead,
    // so it appears on the auth-flow lines and nowhere else.
    setLogContext({ email_hash: hashEmail(input.email) });
    trace.getActiveSpan()?.setAttributes({ email_hash: hashEmail(input.email) });
    appLogger.info(
      { app_event: "login_started", email: maskEmail(input.email) },
      "Starting user login",
    );

    // CONTRACT: Do NOT turn this into a 403 — it answers the SAME generic 401
    // invalid_credentials a wrong password gets, or a caller learns both that the
    // account exists and that it is passwordless. Rejecting BEFORE any Cognito
    // call makes the property structural. See [[auth-error-mapping]]
    const existing = await this.db.user.findUnique({ where: { email: input.email } });
    if (existing?.authType === "PASSWORDLESS") {
      appLogger.error(
        { app_event: "login_failed", email: maskEmail(input.email), reason: "passwordless_user" },
        "User login failed: account is passwordless",
      );
      trace
        .getActiveSpan()
        ?.setAttributes({ app_event: "login_failed", reason: "passwordless_user" });
      throw new InvalidCredentialsError();
    }

    try {
      const tokens = await this.auth.login(input.email, input.password);
      // WARNING: Never log `tokens` — access and refresh tokens are credentials,
      // exactly like the password.
      appLogger.info(
        { app_event: "login_succeeded", email: maskEmail(input.email) },
        "User login completed",
      );
      return tokens;
    } catch (err) {
      // Distinguished here rather than in the exception filter, which sees only a
      // typed error with no memory of the step that produced it. Wrong credentials
      // and a broken identity provider are different operational problems.
      const invalid = err instanceof InvalidCredentialsError;
      appLogger.error(
        {
          err,
          app_event: "login_failed",
          email: maskEmail(input.email),
          reason: invalid ? "invalid_credentials" : "cognito_error",
        },
        invalid
          ? "User login failed: invalid credentials"
          : "User login failed: the identity provider rejected the request",
      );
      trace.getActiveSpan()?.setAttributes({
        app_event: "login_failed",
        reason: invalid ? "invalid_credentials" : "cognito_error",
      });
      throw err; // rethrown untouched — the HTTP contract is unchanged
    }
  }
}
```

Note what moved and what did not: the `login_succeeded` span attribute is now the interceptor's job, but **every `*_failed` reason stays in the handler** — that is what the interceptor defers to.

- [ ] **Step 5: Register the handler**

Add `LoginHandler` to `users.module.ts`'s `providers`.

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/users/login.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 7: Mutation-check the clobber guard one more time**

In `workflow.interceptor.ts`, temporarily change `recordedReason(span) ?? "unhandled_error"` to `"unhandled_error"` and run this file.

Expected: the `invalid_credentials`, `passwordless_user` and `cognito_error` tests all go RED. **Revert the mutation.** If they stayed green, the interceptor is not on the pipeline for this handler and every later task would inherit the defect.

- [ ] **Step 8: Diff the assertions against the original and leave the work in the working tree**

---

### Task 9: `ChangePasswordCommand` — the routine-failure checkpoint

The second half of spec finding #2: this handler has **both** a thrown branch (`cognito_error`) and a routine non-throwing branch (`unknown_user`, which returns `null`). It is the only handler that exercises both rules at once.

**Files:**
- Create: `services/users/src/nest/users/commands/change-password.command.ts`
- Modify: `services/users/src/nest/users/users.module.ts`
- Test: `services/users/tests/nest/users/change-password.test.ts`
- Reference: `services/users/src/features/users/commands/change-password.ts`, `services/users/tests/features/users/commands/change-password.test.ts`

**Interfaces:**
- Consumes: `DB`, `AUTH_PROVIDER`, `@Workflow`, `RoutineFailure`.
- Produces:
  - `class ChangePasswordCommand { constructor(public readonly currentUser: CurrentUser, public readonly input: ChangePasswordInput) {} }` where `ChangePasswordInput = { newPassword: string }`
  - `ChangePasswordHandler.execute(...): Promise<User | RoutineFailure>`

- [ ] **Step 1: Read the original handler and test in full**

```bash
cd services/users && cat src/features/users/commands/change-password.ts
cat tests/features/users/commands/change-password.test.ts
```

- [ ] **Step 2: Write the failing test**

Create `services/users/tests/nest/users/change-password.test.ts`, carrying over all four span assertions the original makes plus the audit-actor one:

```typescript
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CqrsModule } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { testSpanExporter } from "../../setup-tracing.ts";
import { AUTH_PROVIDER, DB } from "#nest/shared/tokens";
import {
  ChangePasswordCommand,
  ChangePasswordHandler,
} from "#nest/users/commands/change-password.command";
import { WorkflowInterceptor } from "#nest/shared/observability/workflow.interceptor";

const NEW_PASSWORD = "N3wS3cret!";
const TARGET = {
  id: "usr_1",
  email: "jose@example.com",
  fullName: "Jose",
  cognitoSub: "cognito-sub-1",
  address: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  deletedAt: null,
};

async function buildBus(opts: { resolved?: unknown; cognitoRejects?: boolean } = {}) {
  const resolved = "resolved" in opts ? opts.resolved : TARGET;
  const db = { user: { update: vi.fn(async () => ({ ...TARGET, mustChangePassword: false })) } };
  const auth = {
    setPassword: opts.cognitoRejects
      ? vi.fn(async () => {
          throw new Error("cognito down");
        })
      : vi.fn(async () => undefined),
  };

  @Module({
    imports: [CqrsModule],
    providers: [
      { provide: DB, useValue: db },
      { provide: AUTH_PROVIDER, useValue: auth },
      ChangePasswordHandler,
      { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return {
    bus: moduleRef.get(CommandBus),
    db,
    auth,
    currentUser: { resolve: vi.fn(async () => resolved) },
    close: () => moduleRef.close(),
  };
}

function span() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "change_password");
}

describe("ChangePasswordCommand through the CommandBus", () => {
  beforeEach(() => testSpanExporter.reset());

  it("emits app_event=change_password_succeeded with the user_id and OK status", async () => {
    const { bus, currentUser, close } = await buildBus();

    await bus.execute(new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }));

    expect(span()!.attributes.app_event).toBe("change_password_succeeded");
    expect(span()!.attributes.user_id).toBe("usr_1");
    expect(span()!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });

  it("sets ERROR status and reason=cognito_error when Cognito rejects", async () => {
    const { bus, currentUser, close } = await buildBus({ cognitoRejects: true });

    await expect(
      bus.execute(new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD })),
    ).rejects.toThrow("cognito down");

    expect(span()!.ended).toBe(true);
    expect(span()!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span()!.attributes.app_event).toBe("change_password_failed");
    expect(span()!.attributes.reason).toBe("cognito_error");
    await close();
  });

  it("marks the unresolved caller with reason=unknown_user and does NOT mark the span ERROR", async () => {
    // Returning null is a real outcome of this workflow — the route answers the
    // same 404 the other /me routes do, so this is routine, not a fault.
    const { bus, currentUser, close } = await buildBus({ resolved: null });

    const result = await bus.execute(
      new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }),
    );

    expect(result).toBeNull();
    expect(span()!.attributes.reason).toBe("unknown_user");
    expect(span()!.status.code).not.toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("leaves the password unset in Cognito when the caller does not resolve", async () => {
    const { bus, auth, currentUser, close } = await buildBus({ resolved: null });

    await bus.execute(new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }));

    expect(auth.setPassword).not.toHaveBeenCalled();
    await close();
  });

  it("calls Cognito BEFORE the database write", async () => {
    // If Cognito fails, nothing has changed anywhere and a retry is clean.
    // Clearing the flag before a failed password set would tell the frontend to
    // stop asking for a change that never happened.
    const { bus, db, currentUser, close } = await buildBus({ cognitoRejects: true });

    await bus
      .execute(new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }))
      .catch(() => undefined);

    expect(db.user.update).not.toHaveBeenCalled();
    await close();
  });

  it("never puts the new password or the plaintext email on the span", async () => {
    const { bus, currentUser, close } = await buildBus();

    await bus.execute(new ChangePasswordCommand(currentUser as never, { newPassword: NEW_PASSWORD }));

    const serialized = JSON.stringify(span()!.attributes);
    expect(serialized).not.toContain(NEW_PASSWORD);
    expect(serialized).not.toContain("jose@example.com");
    expect(span()!.attributes.email_hash).toBeDefined();
    await close();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/users/change-password.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write the handler**

Create `services/users/src/nest/users/commands/change-password.command.ts`. Port the original's body, replacing the `return null` with `return new RoutineFailure("unknown_user")` and keeping both the log line and the span attributes on that branch:

```typescript
if (!target) {
  // CONTRACT: Log this branch. No `change_password_started` line exists yet (it
  // needs the email this resolve could not find), so without it a 404 leaves the
  // stream with nothing but the generic `request completed`. No email_hash — the
  // email is what failed to resolve. See [[logging-context]]
  appLogger.warn(
    { app_event: "change_password_failed", reason: "unknown_user" },
    "Password change failed: the caller resolved to no user",
  );
  return new RoutineFailure("unknown_user");
}
```

The `runAsActor` wrapper around the database write carries over unchanged. **Keep the `await` INSIDE the `runAsActor` callback** — Prisma promises are lazy, so an `await` outside it loses the actor and the audit extension writes null. See [[2026-07-12-prisma-lazy-promise-als]].

- [ ] **Step 5: Register the handler, run the test, verify it passes**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/users/change-password.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Checkpoint — stop and report before porting the remaining handlers**

This is the explicit checkpoint the spec calls for. Confirm all three rules hold against real handlers before 12 more are built on the same pipeline:

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/
```

Report in the handoff: the mutation-test outcomes from Task 5 Step 9 and Task 8 Step 7, and the assertion diff for all three handlers. **If any rule does not hold, fix the interceptor now** — retrofitting it after 15 handlers is the sequence the spec explicitly warns produced the original bug.

- [ ] **Step 7: Leave the work in the working tree**

---

### Tasks 10–17: The remaining twelve handlers

Each follows Task 8's shape exactly. They are listed with the details that differ — the flow name the `@Workflow()` decorator takes, the dependencies to inject, the specific reasons that must survive, and whether the handler has a routine (non-throwing) branch.

**For every task below:**
- Command/query object: `class <Name>Command { constructor(public readonly input: <Name>Input) {} }`, plus `currentUser: CurrentUser` as a first constructor parameter where the original handler takes one.
- Rewrite the matching test file from `tests/features/users/commands/` (or `queries/`) into `tests/nest/users/`, through the bus, diffing assertions.
- Register the handler in `users.module.ts`.
- Keep every `trace.getActiveSpan()?.setAttributes({ ..., reason })` call in the handler.
- Run `pnpm exec vitest run tests/nest/users/<name>.test.ts`, then leave the work in the working tree.

| Task | Handler | Flow name | Injects | Reasons that must survive | Routine branch |
|---|---|---|---|---|---|
| 10 | `RegisterHandler` | `register` | `DB`, `AUTH_PROVIDER`, `EVENT_PUBLISHER` | `email_taken`, `cognito_error` | no |
| 11 | `RegisterPasswordlessHandler` | `register_passwordless` | `DB`, `AUTH_PROVIDER`, `EVENT_PUBLISHER` | `email_taken`, `cognito_error` | no |
| 12 | `StartOtpChallengeHandler` | `otp_challenge` | `DB`, `AUTH_PROVIDER` | `unknown_user`, `cognito_error` | check the original |
| 13 | `VerifyOtpChallengeHandler` | `otp_verify` | `DB`, `AUTH_PROVIDER` | `invalid_otp`, `cognito_error` | check the original |
| 14 | `RefreshTokenHandler` + `SignOutHandler` | `refresh`, `sign_out` | `AUTH_PROVIDER` | `invalid_refresh_token`, `cognito_error` | no |
| 15 | `ForgotPasswordHandler` + `ConfirmPasswordResetHandler` | `password_reset_requested`, `password_reset_confirm` | `DB`, `AUTH_PROVIDER`, `ResetCodeStore`, `EVENT_PUBLISHER` | `unknown_user`, `invalid_code`, `cognito_error` | check both |
| 16 | `UpdateProfileHandler` | `update_profile` | `DB`, `CacheGateway` | `unknown_user` | yes — returns null |
| 17 | `DeleteAccountHandler` | `delete_account` | `DB`, `AUTH_PROVIDER`, `CascadeClient`, `EVENT_PUBLISHER` | `unknown_user`, `cascade_failed` | yes — returns null |

- [ ] **Before writing each task's handler, read its original and enumerate its reasons:**

```bash
cd services/users && grep -n "reason:" src/features/users/commands/<name>.ts
```

**Every `reason` string that appears there must appear in the ported handler and be asserted in the rewritten test.** A reason dropped in translation leaves no trace — the shipped code is self-consistent and the new test covers what was built rather than what was specified. See [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]].

- [ ] **After Task 17, run the whole Nest suite:**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/
```

Expected: green, with one test file per migrated handler.

---

### Task 18: The three notifications handlers

**Files:**
- Create: `services/users/src/nest/notifications/commands/create-notification.command.ts`
- Create: `services/users/src/nest/notifications/commands/mark-notifications-read.command.ts`
- Create: `services/users/src/nest/notifications/queries/list-notifications.query.ts`
- Create: `services/users/src/nest/notifications/notifications.module.ts`
- Modify: `services/users/src/nest/app.module.ts`
- Test: `services/users/tests/nest/notifications/{create-notification,mark-notifications-read,list-notifications}.test.ts`
- Reference: the three files under `src/features/notifications/` and their tests

**Interfaces:**
- Consumes: `DB`, `WebsocketPublisher`, `@Workflow`, `RoutineFailure`.
- Produces:
  - `class CreateNotificationCommand { constructor(public readonly envelope: NotificationEnvelope) {} }` — dispatched by the SQS consumer in Task 20.
  - `class MarkNotificationsReadCommand { constructor(public readonly currentUser: CurrentUser, public readonly input: MarkReadInput) {} }`
  - `class ListNotificationsQuery { constructor(public readonly currentUser: CurrentUser, public readonly filter: NotificationFilter) {} }`
  - `NotificationsModule`.

- [ ] **Step 1: Read the three originals and their tests**

```bash
cd services/users && cat src/features/notifications/commands/create-notification.ts \
  src/features/notifications/commands/mark-notifications-read.ts \
  src/features/notifications/queries/list-notifications.ts
```

- [ ] **Step 2: Note the one routine branch `list-notifications` carries**

The spec names `list-notifications.ts` alongside `get-me.ts` as carrying the routine-vs-thrown shape. Find it and port it as a `RoutineFailure`:

```bash
cd services/users && grep -n "app_event\|reason" src/features/notifications/queries/list-notifications.ts
```

- [ ] **Step 3: Write the three test files, run them red, write the three handlers, run them green**

Follow Task 8's shape for each. Each handler gets `@Workflow("<flow>")` with the flow name its original uses, and keeps its own `reason` attributes.

- [ ] **Step 4: Write the notifications module and register it**

```typescript
import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { CreateNotificationHandler } from "./commands/create-notification.command.ts";
import { MarkNotificationsReadHandler } from "./commands/mark-notifications-read.command.ts";
import { ListNotificationsHandler } from "./queries/list-notifications.query.ts";

@Module({
  imports: [CqrsModule],
  providers: [CreateNotificationHandler, MarkNotificationsReadHandler, ListNotificationsHandler],
})
export class NotificationsModule {}
```

Add `NotificationsModule` to `app.module.ts`'s `imports`.

- [ ] **Step 5: Run the notifications tests and leave the work in the working tree**

---
## Phase 3 — The HTTP surface and the remaining transports (Tasks 19–24)

### Task 19: The users HTTP controller — 16 routes (13 user + 1 webhook + 2 E2E-only)

**Files:**
- Create: `services/users/src/nest/users/http/users.controller.ts`
- Create: `services/users/src/nest/users/http/serializers.ts`
- Create: `services/users/src/nest/users/http/e2e.controller.ts`
- Create: `services/users/src/nest/users/webhooks/cognito.controller.ts`
- Modify: `services/users/src/nest/users/users.module.ts`
- Test: `services/users/tests/nest/users/users-routes.test.ts`
- Reference: `services/users/src/features/users/http/routes.ts` lines 337–720

**Interfaces:**
- Consumes: every handler from Tasks 7–17, `ZodValidationPipe`, the schemas in `#features/users/http/schemas`.
- Produces: `UsersController` (13 routes), `CognitoWebhookController` (1), `E2eController` (2, behind `E2E_TESTING_ENABLED`). `serializeUser` moves to `serializers.ts` unchanged.

- [ ] **Step 1: Enumerate the routes to port**

```bash
cd services/users && grep -n 'r\.\(get\|post\|patch\|delete\)("' src/features/users/http/routes.ts
```

Expected: 20 registrations — 13 user routes, 3 notification routes (Task 20), 1 webhook, 2 E2E-only, 1 health (already done in Task 2). **Every one must have a counterpart when this task and Task 20 are done; a missing route 404s at the gateway while the service looks healthy.**

- [ ] **Step 2: Copy the serializers unchanged**

Create `services/users/src/nest/users/http/serializers.ts` with `serializeUser` and `bearerToken` copied verbatim from `routes.ts` (lines ~82–115). They are pure functions with no Fastify coupling. Keep their comments — the `WARNING:` on `bearerToken`'s return value is load-bearing.

- [ ] **Step 3: Write the failing test**

Create `services/users/tests/nest/users/users-routes.test.ts`. Cover, at minimum, one route per HTTP verb plus the three that carry non-obvious wiring:

```typescript
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "#nest/app.module";

describe("users HTTP routes", () => {
  let app: NestFastifyApplication;
  const commandBus = { execute: vi.fn() };
  const queryBus = { execute: vi.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CommandBus)
      .useValue(commandBus)
      .overrideProvider(QueryBus)
      .useValue(queryBus)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const authed = { "x-user-id": "cognito-sub-1" };

  it("POST /v1/users/login dispatches a LoginCommand and returns the tokens", async () => {
    commandBus.execute.mockResolvedValueOnce({
      accessToken: "a",
      refreshToken: "r",
      idToken: "i",
      expiresIn: 3600,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/users/login",
      payload: { email: "ada@example.com", password: "Sup3rS3cret!" },
    });

    expect(response.statusCode).toBe(200);
    expect(commandBus.execute).toHaveBeenCalledOnce();
  });

  it("GET /v1/users/me returns 404 not_found when the query resolves to null", async () => {
    // CONTRACT: The handler returns null for a routine miss; the controller —
    // not the handler — is what turns it into the 404 the E2E specs assert.
    queryBus.execute.mockResolvedValueOnce(null);

    const response = await app.inject({ method: "GET", url: "/v1/users/me", headers: authed });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });

  it("GET /v1/users/me serializes Date fields as ISO strings", async () => {
    queryBus.execute.mockResolvedValueOnce({
      id: "usr_1",
      email: "ada@example.com",
      fullName: "Ada",
      cognitoSub: "cognito-sub-1",
      address: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      deletedAt: null,
    });

    const response = await app.inject({ method: "GET", url: "/v1/users/me", headers: authed });

    expect(response.json().createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects an invalid login body with 400 before dispatching anything", async () => {
    commandBus.execute.mockClear();

    const response = await app.inject({
      method: "POST",
      url: "/v1/users/login",
      payload: { email: "not-an-email", password: "x" },
    });

    expect(response.statusCode).toBe(400);
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it("answers 401 unauthenticated on /v1/users/me with no x-user-id", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/users/me" });

    expect(response.statusCode).toBe(401);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/users/users-routes.test.ts
```

- [ ] **Step 5: Write the controller**

Create `services/users/src/nest/users/http/users.controller.ts`. Every route follows this shape — dispatch through the bus, map a routine `null` to 404, serialize at the boundary:

```typescript
import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Patch, Post } from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { CurrentUser } from "#shared/auth/current-user";
import { LoginCommand } from "../commands/login.command.ts";
import { GetMeQuery } from "../queries/get-me.query.ts";
import { LoginInputSchema } from "#features/users/http/schemas";
import { ZodValidationPipe } from "../../shared/http/zod-validation.pipe.ts";
import { serializeUser } from "./serializers.ts";

@Controller("v1/users")
export class UsersController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Post("login")
  @HttpCode(200)
  async login(@Body(new ZodValidationPipe(LoginInputSchema)) body: { email: string; password: string }) {
    return this.commandBus.execute(new LoginCommand(body));
  }

  @Get("me")
  async me(@CurrentUserParam() currentUser: CurrentUser) {
    const user = await this.queryBus.execute(new GetMeQuery(currentUser));
    // The routine miss becomes the 404 the /me routes already return; the
    // handler stays transport-agnostic and the span keeps OK status.
    if (!user) throw new NotFoundException({ error: "not_found" });
    return serializeUser(user);
  }
}
```

- [ ] **Step 6: Build the `@CurrentUserParam()` decorator**

`CurrentUser` was a per-request Awilix registration; Nest needs a param decorator. Create it in `services/users/src/nest/shared/auth/current-user.decorator.ts`:

```typescript
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { CurrentUser } from "#shared/auth/current-user";
import { db } from "#shared/db/prisma";

// CONTRACT: One instance per request. CurrentUser caches its identity lookup
// internally, so a second instance re-queries the database on every handler
// that asks for it. See [[user-id-vs-cognito-sub-ownership-key]]
export const CurrentUserParam = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest & { currentUser?: CurrentUser }>();
  req.currentUser ??= new CurrentUser({
    db,
    identity: req.headers["x-user-id"] as string,
  });
  return req.currentUser;
});
```

- [ ] **Step 7: Port the remaining 12 user routes**

Work through the list from Step 1. For each: same path, same method, same status code, same request and response schema, same 404/401 behaviour. **The status codes matter** — `@HttpCode(200)` is needed on every `@Post` that does not return 201 today, and Nest defaults POST to 201.

```bash
cd services/users && sed -n '344,600p' src/features/users/http/routes.ts
```

- [ ] **Step 8: Port the webhook and E2E controllers**

The Cognito webhook keeps its shared-secret guard (`verifyWebhookSecret`) and its `NoMatchingUserError` handling. The two E2E routes stay behind `E2E_TESTING_ENABLED` — register the controller conditionally in the module, exactly as `routes.ts` wraps them in an `if` today.

- [ ] **Step 9: Run the test, then the whole Nest suite**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/
```

- [ ] **Step 10: Leave the work in the working tree**

---

### Task 20: The notifications controller and the response cache

**Files:**
- Create: `services/users/src/nest/notifications/http/notifications.controller.ts`
- Create: `services/users/src/nest/shared/cache/me-cache.interceptor.ts`
- Modify: `services/users/src/nest/notifications/notifications.module.ts`
- Test: `services/users/tests/nest/notifications/notifications-routes.test.ts`, `services/users/tests/nest/cache/me-cache.test.ts`
- Reference: `routes.ts` lines 586–656, `src/features/users/http/cache-hooks.ts`

**Interfaces:**
- Consumes: the three notification handlers (Task 18), `CacheGateway`.
- Produces: `NotificationsController` (3 routes), `MeCacheInterceptor`.

- [ ] **Step 1: Port the three notification routes**

`GET /v1/notifications`, `GET /v1/notifications/unread-count`, `PATCH /v1/notifications/read`. Same shape as Task 19; the list route takes `NotificationFilterQuerySchema` on the query string via `@Query(new ZodValidationPipe(...))`.

- [ ] **Step 2: Read the cache hooks and their two traps**

```bash
cd services/users && cat src/features/users/http/cache-hooks.ts
```

The file documents two: the cache key needs `CurrentUser.resolve()`, and `@fastify/otel` nulls the span inside `onSend`. Both carry over — the interceptor runs in the same positions the `preHandler`/`onSend` pair did.

- [ ] **Step 3: Write the cache interceptor**

A Nest interceptor is the idiomatic home for a response-wrapping concern, and `GET /v1/users/me` is the only cached route. Preserve the `x-cache` response header and the `cache_result` log-context field exactly — the E2E `cache.spec.ts` has 21 tests asserting on them. See [[x-cache-response-header]].

- [ ] **Step 4: Verify against the cache E2E spec's expectations**

```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure && grep -n "x-cache\|hit\|miss\|bypass" e2e/tests/cache.spec.ts | head -25
```

Every header value and transition those 21 tests assert must be reproduced. They are not modified by this migration.

- [ ] **Step 5: Run the tests and leave the work in the working tree**

---

### Task 21: OpenAPI generation — `zod-to-json-schema` → `@nestjs/swagger`

The spec flags this as the one piece not yet proven and insists it lands early rather than at the cut-over gate. The mechanism is verified: a scratch spike on 2026-09-19 produced a document whose route response resolves to `{ $ref: "#/components/schemas/User" }` against a `zod-to-json-schema`-derived component.

**Files:**
- Create: `services/users/src/nest/shared/openapi/build-document.ts`
- Create: `services/users/src/nest/shared/openapi/generate-openapi.ts`
- Modify: `services/users/package.json` (the `generate:openapi` script)
- Test: `services/users/tests/nest/openapi.test.ts`
- Reference: `routes.ts` lines 32–52 (`pruneOrphanComponents`), `src/features/users/http/generate-openapi.ts`

**Interfaces:**
- Consumes: the Zod schemas in `#features/users/http/schemas` and `#features/notifications/http/schemas`.
- Produces: `buildOpenApiDocument(app): OpenAPIObject` — used by both the served `/docs` route and the committed-artifact generator.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/nest/openapi.test.ts`. **The acceptance criterion is equivalence with the committed document, not "it builds":**

```typescript
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "#nest/app.module";
import { buildOpenApiDocument } from "#nest/shared/openapi/build-document";

describe("generated OpenAPI document", () => {
  async function document() {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    const doc = buildOpenApiDocument(app);
    await app.close();
    return doc;
  }

  it("resolves every request and response schema to a NAMED $ref", async () => {
    const doc = await document();
    const inlined: string[] = [];

    for (const [path, methods] of Object.entries(doc.paths ?? {})) {
      for (const [method, operation] of Object.entries(methods as Record<string, never>)) {
        const schemas = [
          (operation as never as { requestBody?: never })?.requestBody,
          ...Object.values((operation as never as { responses?: Record<string, never> })?.responses ?? {}),
        ];
        for (const entry of schemas) {
          const schema = (entry as never as {
            content?: { "application/json"?: { schema?: Record<string, unknown> } };
          })?.content?.["application/json"]?.schema;
          // An inline anonymous object is the failure: Apidog shows it as an
          // unnamed blob instead of a reusable component.
          if (schema && !("$ref" in schema)) inlined.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect(inlined).toEqual([]);
  });

  it("emits no orphan components", async () => {
    const doc = await document();
    const serialized = JSON.stringify(doc);
    const orphans = Object.keys(doc.components?.schemas ?? {}).filter(
      (name) => serialized.split(`"#/components/schemas/${name}"`).length - 1 < 1,
    );

    // The current generator prunes components nothing $refs; whatever replaces
    // it must too, or the Apidog import degrades with unreferenced noise.
    expect(orphans).toEqual([]);
  });

  it("keeps the component names the committed document already uses", async () => {
    const doc = await document();

    expect(Object.keys(doc.components?.schemas ?? {})).toEqual(
      expect.arrayContaining(["User", "AuthTokens", "Error"]),
    );
  });

  it("documents every route the service serves", async () => {
    const doc = await document();

    // 20 registrations today: 13 user + 3 notification + 1 webhook + 1 health +
    // 2 E2E-only (absent unless E2E_TESTING_ENABLED).
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThanOrEqual(16);
  });
});
```

- [ ] **Step 2: Read the committed document to get the real component names**

```bash
cd services/users && grep -n "^    [A-Z]" openapi.yaml | head -40
```

**Use these exact names in the third test.** The current generator's `fastify-type-provider-zod` suffix convention produces `RegisterInput` from `Register`; whatever the committed file says is the target.

- [ ] **Step 3: Write the document builder**

Create `services/users/src/nest/shared/openapi/build-document.ts`:

```typescript
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import type { INestApplication } from "@nestjs/common";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodType } from "zod/v4";
import {
  UserSchema, AuthTokensSchema, ErrorSchema, HealthResponseSchema,
  RefreshedTokensSchema, OtpStartResponseSchema,
  PasswordResetAcceptedSchema, PasswordResetConfirmedSchema, E2ECleanupResponseSchema,
} from "#features/users/http/schemas";
import {
  NotificationsPageSchema, UnreadCountSchema, MarkReadResultSchema,
} from "#features/notifications/http/schemas";

// CONTRACT: The Zod schemas stay the single source of truth for BOTH validation
// and the OpenAPI shape. Each is registered as a NAMED component so every route
// resolves to a $ref — an inline anonymous schema imports into Apidog as an
// unnamed blob. See [[openapi-specs]]
const COMPONENTS: Record<string, ZodType> = {
  User: UserSchema,
  AuthTokens: AuthTokensSchema,
  Error: ErrorSchema,
  HealthResponse: HealthResponseSchema,
  RefreshedTokens: RefreshedTokensSchema,
  OtpStartResponse: OtpStartResponseSchema,
  PasswordResetAccepted: PasswordResetAcceptedSchema,
  PasswordResetConfirmed: PasswordResetConfirmedSchema,
  E2ECleanupResponse: E2ECleanupResponseSchema,
  NotificationsPage: NotificationsPageSchema,
  UnreadCount: UnreadCountSchema,
  MarkReadResult: MarkReadResultSchema,
};

// Drops components nothing references, matching pruneOrphanComponents in the
// generator this replaces — an unreferenced schema is noise in the Apidog import.
function pruneOrphans(document: OpenAPIObject): OpenAPIObject {
  const schemas = document.components?.schemas;
  if (!schemas) return document;
  const serialized = JSON.stringify(document);
  for (const name of Object.keys(schemas)) {
    if (serialized.split(`"#/components/schemas/${name}"`).length - 1 < 1) delete schemas[name];
  }
  return document;
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle("Users Service API")
    .setVersion("1.0.0")
    .setDescription(
      "HTTP API for the 3MRAI Users microservice (NestJS + Aurora Postgres). " +
        "Identity is enforced at the API Gateway authorizer, which forwards the " +
        "Cognito subject as the x-user-id header.",
    )
    .addServer("http://localhost:3000", "Local (docker compose / Floci)")
    .addTag("health", "Liveness")
    .addTag("users", "Registration, auth and profile")
    .addTag("webhooks", "Inbound Cognito trigger (shared-secret guarded)")
    .addTag("notifications", "In-app notification inbox")
    .addTag("e2e", "Test-only routes (E2E_TESTING_ENABLED)")
    .build();

  const document = SwaggerModule.createDocument(app, config);
  document.components = document.components ?? {};
  document.components.schemas = {
    ...(document.components.schemas ?? {}),
    ...Object.fromEntries(
      Object.entries(COMPONENTS).map(([name, schema]) => [
        name,
        zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" }) as never,
      ]),
    ),
  };

  return pruneOrphans(document);
}
```

- [ ] **Step 4: Reference the components from the controllers**

Each route declares its response as a `$ref` with `@ApiResponse`:

```typescript
@ApiResponse({ status: 200, schema: { $ref: "#/components/schemas/User" } })
```

Spike-verified: the generated path resolves to exactly `{ $ref: "#/components/schemas/User" }`.

- [ ] **Step 5: Rewrite the artifact generator**

Create `services/users/src/nest/shared/openapi/generate-openapi.ts` mirroring the current one — boot the app, build the document, write `openapi.yaml`. Point `package.json`'s `generate:openapi` script at it.

- [ ] **Step 6: Generate and diff against the committed artifact**

```bash
cd services/users && nvm use && cp openapi.yaml /tmp/openapi.fastify.yaml
pnpm run generate:openapi && diff /tmp/openapi.fastify.yaml openapi.yaml
```

**This diff is the acceptance step, not "it ran without errors."** `openapi.yaml` is a committed artifact under a GOLDEN RULE (`services/users/CLAUDE.md` §2a) imported into Apidog. Expected differences: the description's "Fastify" → "NestJS". **Any route, component, or `$ref` that differs is a defect to fix here.** Restore the committed file if the diff is not clean, and report the differences.

- [ ] **Step 7: Run the test and leave the work in the working tree**

---

### Task 22: gRPC on `@nestjs/microservices` — with the JE-77 fix carried through `channelOptions`

**Read this before writing any code.** A spike on 2026-09-19 (real `proto/users.proto`, real gRPC client and server, Node 24.18.0) established two things:

**The JE-77 fix survives.** Activating the extracted W3C context in `onReceiveHalfClose` inside a `ServerInterceptingCall` produces a server span that **joins** the caller's trace under Nest's transport — measured `traceId` matched the inbound `traceparent`. Mutating the activation back to `onReceiveMetadata` turned the test red; removing the interceptor turned both tests red. The result is not vacuous.

**But `GrpcOptions` has no `interceptors` key, and the intuitive spelling fails SILENTLY.** `@nestjs/microservices/server/server-grpc.js:432` constructs the server as `new grpcPackage.Server(options)` where `options` is the merged **`channelOptions`**. Passing `server: { interceptors: [...] }` — the shape that reads as correct — is **dropped without a warning**: the service starts, every test runs, and a call bearing a *wrong* `x-api-key` **returns the user's data**. That is an open authentication bypass with no error anywhere. The interceptors must go in `channelOptions`, which grpc-js reads.

**Files:**
- Create: `services/users/src/nest/users/grpc/users-grpc.controller.ts`
- Create: `services/users/src/nest/users/grpc/grpc-options.ts`
- Modify: `services/users/src/nest/main.ts`
- Modify: `services/users/src/nest/users/users.module.ts`
- Test: `services/users/tests/nest/grpc/users-grpc.test.ts`
- Reference: `src/shared/grpc/server.ts`, `src/shared/grpc/api-key-interceptor.ts`, `src/features/users/grpc/get-user-by-id.ts`

**Interfaces:**
- Consumes: `GetUserByIdQuery` (Task 7's read pair), `makeApiKeyInterceptor` and `extractParentContext` from `#shared/grpc/api-key-interceptor` (**unchanged — do not rewrite them**), `withGrpcServerSpan` from `#shared/observability/grpc-tracing` (unchanged).
- Produces: `UsersGrpcController` with `@GrpcMethod("Users", "GetUserById")`, and `grpcMicroserviceOptions(env)` returning the `MicroserviceOptions` object `main.ts` passes to `connectMicroservice`.

- [ ] **Step 1: Write the failing test — BOTH gates**

Create `services/users/tests/nest/grpc/users-grpc.test.ts`. Two assertions, because the spike proved each fails independently:

```typescript
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { NestFactory } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { type MicroserviceOptions } from "@nestjs/microservices";
import { QueryBus } from "@nestjs/cqrs";
import { testSpanExporter } from "../../setup-tracing.ts";
import { AppModule } from "#nest/app.module";
import { grpcMicroserviceOptions } from "#nest/users/grpc/grpc-options";

const PROTO = resolve(import.meta.dirname, "../../../../../proto/users.proto");
const INBOUND_TRACE_ID = "1234567890abcdef1234567890abcdef";
const TRACEPARENT = `00-${INBOUND_TRACE_ID}-3250e3c0f6fbb7ab-01`;
const API_KEY = "test-grpc-key"; // matches vitest.config.ts's INTERNAL_API_KEY
const URL = "127.0.0.1:50099";

describe("Users gRPC surface on @nestjs/microservices", () => {
  let app: Awaited<ReturnType<typeof NestFactory.createMicroservice>>;
  let client: Record<string, Function>;
  const queryBus = { execute: vi.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(QueryBus)
      .useValue(queryBus)
      .compile();

    app = moduleRef.createNestMicroservice<MicroserviceOptions>(
      grpcMicroserviceOptions({ GRPC_PORT: 50099, INTERNAL_API_KEY: API_KEY } as never),
    );
    await app.listen();

    const pkg = grpc.loadPackageDefinition(
      protoLoader.loadSync(PROTO, { keepCase: true, longs: String, defaults: true, oneofs: true }),
    ) as never as { users: { v1: { Users: new (...a: never[]) => Record<string, Function> } } };
    client = new pkg.users.v1.Users(URL, grpc.credentials.createInsecure());
  });

  afterAll(async () => {
    await app.close();
  });

  function call(metadata: grpc.Metadata): Promise<Record<string, unknown>> {
    return new Promise((res, rej) =>
      client.GetUserById({ id: "usr_1" }, metadata, (err: unknown, reply: never) =>
        err ? rej(err) : res(reply),
      ),
    );
  }

  it("joins the caller's trace — the server span is NOT a root", async () => {
    // CONTRACT: The JE-77 gate. The context is extracted in the api-key
    // interceptor and activated in onReceiveHalfClose, the continuation that
    // dispatches the async handler. Activating in onReceiveMetadata unwinds
    // first and yields two disjoint traces.
    // See [[grpc-context-activate-at-dispatch]]
    testSpanExporter.reset();
    queryBus.execute.mockResolvedValueOnce({
      id: "usr_1",
      email: "ada@example.com",
      fullName: "Ada",
      cognitoSub: "sub",
      address: null,
    });
    const md = new grpc.Metadata();
    md.set("x-api-key", API_KEY);
    md.set("traceparent", TRACEPARENT);

    await call(md);

    const span = testSpanExporter
      .getFinishedSpans()
      .find((s) => s.name === "users.v1.Users/GetUserById");
    expect(span).toBeDefined();
    expect(span!.spanContext().traceId).toBe(INBOUND_TRACE_ID);
  });

  it("rejects a wrong x-api-key with UNAUTHENTICATED", async () => {
    // CONTRACT: The interceptor-reached gate. GrpcOptions has no `interceptors`
    // key — passing them under `server:` is dropped SILENTLY and this call
    // returns the user's data instead of failing. This test is what catches it.
    const md = new grpc.Metadata();
    md.set("x-api-key", "wrong-key");

    await expect(call(md)).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
  });

  it("maps a missing user to NOT_FOUND", async () => {
    queryBus.execute.mockResolvedValueOnce(null);
    const md = new grpc.Metadata();
    md.set("x-api-key", API_KEY);

    await expect(call(md)).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/grpc/users-grpc.test.ts
```

Expected: FAIL — `grpc-options` does not exist.

- [ ] **Step 3: Write the transport options, with the interceptors in `channelOptions`**

Create `services/users/src/nest/users/grpc/grpc-options.ts`:

```typescript
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Transport, type MicroserviceOptions } from "@nestjs/microservices";
import type { Env } from "#shared/config/env";
import { makeApiKeyInterceptor } from "#shared/grpc/api-key-interceptor";

// This module lives three levels under services/users/ in both src and dist, so
// five `../` reach the repo root where proto/users.proto lives.
const PROTO_PATH = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../../proto/users.proto",
);

export function grpcMicroserviceOptions(env: Env): MicroserviceOptions {
  return {
    transport: Transport.GRPC,
    options: {
      package: "users.v1",
      protoPath: PROTO_PATH,
      url: `0.0.0.0:${env.GRPC_PORT}`,
      loader: { keepCase: true, longs: String, defaults: true, oneofs: true },
      // WORKAROUND(nestjs-microservices): Interceptors go in `channelOptions`,
      // NOT in a `server` key. GrpcOptions declares no `interceptors` field, and
      // server-grpc.js builds the server as `new grpc.Server(channelOptions)` —
      // so any other spelling is DROPPED SILENTLY and a call bearing a wrong
      // x-api-key returns the user's data with no error anywhere. The
      // UNAUTHENTICATED test in tests/nest/grpc/users-grpc.test.ts is what
      // catches that. See [[grpc-context-activate-at-dispatch]]
      channelOptions: {
        interceptors: [makeApiKeyInterceptor(env.INTERNAL_API_KEY)],
      } as never,
    },
  };
}
```

- [ ] **Step 4: Write the gRPC controller**

Create `services/users/src/nest/users/grpc/users-grpc.controller.ts`:

```typescript
import { Controller } from "@nestjs/common";
import { GrpcMethod, RpcException } from "@nestjs/microservices";
import { status } from "@grpc/grpc-js";
import { QueryBus } from "@nestjs/cqrs";
import { appLogger } from "#shared/logging/app-logger";
import { withGrpcServerSpan } from "#shared/observability/grpc-tracing";
import { toGrpcAddress } from "#shared/grpc/address";
import { GetUserByIdQuery } from "../queries/get-user-by-id.query.ts";

@Controller()
export class UsersGrpcController {
  constructor(private readonly queryBus: QueryBus) {}

  // CONTRACT: The SERVER span stays MANUAL. The api-key interceptor's
  // ServerInterceptingCall consumes the metadata, so auto-instrumentation has an
  // empty map to read and creates no server span; the caller's context is
  // extracted there and is already active here. See [[ADR-0003-grpc-inter-service]]
  @GrpcMethod("Users", "GetUserById")
  async getUserById(data: { id: string }): Promise<Record<string, unknown>> {
    return withGrpcServerSpan("users.v1.Users/GetUserById", async () => {
      // The request id is a `usr_` id OR a Cognito sub — neither is PII, so it
      // is logged as given.
      const user = await this.queryBus.execute(new GetUserByIdQuery(data.id));

      if (!user) {
        // A miss is a routine outcome, not a thrown error, so the span status
        // stays OK and the outcomes are told apart by app_event/reason.
        appLogger.info(
          { app_event: "get_user_by_id_failed", reason: "user_not_found" },
          "gRPC GetUserById found no user",
        );
        throw new RpcException({ code: status.NOT_FOUND, message: "user not found" });
      }

      appLogger.info(
        { app_event: "get_user_by_id_succeeded", user_id: user.id },
        "gRPC GetUserById resolved",
      );
      // WARNING: `address` is PII — never log this response. See [[logging-context]]
      return {
        id: user.id,
        email: user.email,
        full_name: user.fullName,
        cognito_sub: user.cognitoSub ?? "",
        address: toGrpcAddress(user.address),
      };
    });
  }
}
```

- [ ] **Step 5: Connect the microservice in `main.ts`**

```typescript
const app = await createNestApp();
// The gRPC surface shares this process, its DI container and its bus.
app.connectMicroservice<MicroserviceOptions>(grpcMicroserviceOptions(env));
await app.startAllMicroservices();
await app.listen({ port: env.PORT, host: "0.0.0.0" });
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd services/users && nvm use && pnpm exec vitest run tests/nest/grpc/users-grpc.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 7: Mutation-test both gates**

| Mutation | Test that must fail |
|---|---|
| In `api-key-interceptor.ts`, move the activation from `onReceiveHalfClose` to `onReceiveMetadata` | "joins the caller's trace" |
| In `grpc-options.ts`, rename `channelOptions` to `server` | "rejects a wrong x-api-key" |

Both were confirmed red in the 2026-09-19 spike. **Revert both mutations.** If either stayed green, the corresponding gate is not wired and the defect ships.

- [ ] **Step 8: Verify the .NET client still works end to end**

Orders calls this surface. Bring the stack up and exercise the real path rather than trusting the in-process test:

```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure && make up
grpcurl -plaintext -H "x-api-key: $INTERNAL_API_KEY" -d '{"id":"usr_1"}' localhost:50051 users.v1.Users/GetUserById
```

Expected: the user payload. Then check the trace in OpenObserve (`localhost:5080`) shows **one** trace spanning caller and server, not two.

- [ ] **Step 9: Leave the work in the working tree**

---

### Task 23: The SQS consumer and the metrics poller

**Files:**
- Create: `services/users/src/nest/notifications/messaging/notification-consumer.service.ts`
- Modify: `services/users/src/nest/main.ts`
- Modify: `services/users/src/nest/notifications/notifications.module.ts`
- Test: `services/users/tests/nest/notifications/notification-consumer.test.ts`
- Reference: `src/features/notifications/messaging/notification-consumer.ts`

**Interfaces:**
- Consumes: `SQS_CLIENT`, `ENV`, `CommandBus`.
- Produces: `NotificationConsumerService` with `start()`/`stop()` and a `handleMessage(message)` that dispatches `CreateNotificationCommand` through the bus.

- [ ] **Step 1: Port the consumer as a plain injectable service**

`sqs-consumer` stays; no Nest transport is adopted. The class body carries over **unchanged** except that `createNotificationCommand.execute(parsed)` becomes `this.commandBus.execute(new CreateNotificationCommand(parsed))`. Keep every contract comment: the `messageAttributeNames: ["All"]` requirement, the RETURN-the-message delete semantics, the throw-only-on-transient rule, and both `emit`-not-throw error listeners.

- [ ] **Step 2: Preserve the never-started-in-tests split**

```typescript
// CONTRACT: Constructed by the module, STARTED from main.ts — never in a
// constructor or onModuleInit. Test.createTestingModule() compiles this module
// in many tests, and a lifecycle hook would open a live long-poll in each one,
// receiving and DELETING real messages outside any test's control. The metrics
// poller has the same rule and the same reason.
// See [[2026-09-10-in-app-notifications-design]]
```

- [ ] **Step 3: Write the test that proves the split holds**

```typescript
it("does NOT start polling when the module compiles", async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await moduleRef.init();

  const consumer = moduleRef.get(NotificationConsumerService) as unknown as {
    consumer: { isRunning: boolean };
  };
  expect(consumer.consumer.isRunning).toBe(false);

  await moduleRef.close();
});
```

Check `sqs-consumer`'s real property for a stopped consumer before relying on `isRunning`:

```bash
cd services/users && grep -n "isRunning\|status\|stopped" node_modules/sqs-consumer/dist/esm/consumer.d.ts | head
```

- [ ] **Step 4: Port the trace-continuity and envelope-validation tests**

The original test file covers `lastTraceId`, the four permanent-failure branches (`empty_body`, `body_not_json`, `invalid_envelope`, each resolving rather than throwing) and the "never log the body" rule. **All carry over** — they are behaviour, not harness.

- [ ] **Step 5: Start both in `main.ts`**

```typescript
// CONTRACT: Start the poller and the consumer HERE, not in a module lifecycle
// hook — the test suite compiles those modules and a live timer or long-poll in
// every run would hit the database and DELETE real messages.
const poller = app.get(BusinessMetricsPoller);
poller.start();
const consumer = app.get(NotificationConsumerService);
consumer.start();

process.on("SIGTERM", () => {
  poller.stop();
  consumer.stop();
});
```

- [ ] **Step 6: Run the tests and leave the work in the working tree**

---

### Task 24: Boot smoke test — catch the provider Nest only misses at bootstrap

The spec names this explicitly: Awilix's `asFunction, NOT asClass` trap surfaced at **startup**, not in any unit test, and Nest's equivalent — a provider missing from a module's `providers`/`imports` — has the same timing. A per-feature `Test.createTestingModule()` does not catch it, because the test mocks the dependency away.

**Files:**
- Test: `services/users/tests/nest/boot-smoke.test.ts`

- [ ] **Step 1: Write the smoke test**

```typescript
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "#nest/app.module";
import { BusinessMetricsPoller } from "#shared/metrics/business-metrics";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";

describe("application bootstrap", () => {
  it("resolves the ENTIRE provider graph the way the real process does", async () => {
    // CONTRACT: Boot the whole app, not a per-feature testing module. A provider
    // missing from a module's providers/imports is only discovered at bootstrap —
    // an isolated unit test mocks the dependency away and stays green while the
    // service dies on boot. See [[dependency-injection]]
    const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
      logger: false,
    });
    await app.init();

    // Eagerly resolve the two providers whose construction is indirect enough to
    // hide a wiring mistake — the factory-built publisher and its poller.
    expect(app.get(MetricsPublisher)).toBeInstanceOf(MetricsPublisher);
    expect(app.get(BusinessMetricsPoller)).toBeInstanceOf(BusinessMetricsPoller);

    await app.close();
  });

  it("registers every route the E2E specs call", async () => {
    const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // A route absent here 404s at the gateway while the service looks healthy —
    // the failure mode the cart milestone hit. The gateway answers with its own
    // {"message":"Not Found"} rather than the service's {error: ...} shape.
    const routes = app.getHttpAdapter().getInstance().printRoutes();
    for (const path of [
      "/v1/health",
      "/v1/users/register",
      "/v1/users/login",
      "/v1/users/refresh",
      "/v1/users/logout",
      "/v1/users/me",
      "/v1/users/me/password",
      "/v1/users/otp/start",
      "/v1/users/otp/verify",
      "/v1/users/password/forgot",
      "/v1/users/password/confirm",
      "/v1/notifications",
      "/v1/notifications/unread-count",
      "/v1/notifications/read",
      "/v1/webhooks/cognito",
    ]) {
      expect(routes).toContain(path.split("/").filter(Boolean)[1]);
    }

    await app.close();
  });
});
```

- [ ] **Step 2: Replace the route assertion with a real one**

`printRoutes()` returns a formatted tree, which makes the `toContain` above weak. Enumerate the router's real table instead:

```bash
cd services/users && nvm use && pnpm exec tsx --conditions=development -e "
import('#nest/app.module').then(async (m) => {
  const { NestFactory } = await import('@nestjs/core');
  const { FastifyAdapter } = await import('@nestjs/platform-fastify');
  const app = await NestFactory.create(m.AppModule, new FastifyAdapter(), { logger: false });
  await app.init();
  console.log(app.getHttpAdapter().getInstance().printRoutes());
  await app.close();
});"
```

Use whatever structure that prints to assert the **full set** of 18 paths, so a dropped route fails this test rather than reaching the gateway.

- [ ] **Step 3: Run it and leave the work in the working tree**

---
## Phase 4 — Cut-over (Tasks 25–27)

### Task 25: The E2E gate — all 84 specs, unmodified, against Nest

This is the gate the whole migration is measured against (spec D2/D3). **Nothing in `e2e/` is modified.** A spec that cannot pass is a defect in the Nest code.

**Files:**
- Modify: `services/users/package.json` (`dev`/`start` point at the Nest entrypoint)
- Modify: `services/users/Dockerfile` (the `CMD` entrypoint)
- Test: the 84 existing specs under `e2e/tests/` — **read-only**

- [ ] **Step 1: Confirm the spec count before starting**

```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure/e2e
grep -c "\bit(\|\btest(" tests/users.spec.ts tests/cache.spec.ts tests/notifications.spec.ts \
  tests/account-deletion.spec.ts tests/password-reset.spec.ts tests/otp.spec.ts \
  tests/gateway/users.spec.ts tests/gateway/notifications.spec.ts
```

Expected per the spec: 11 + 21 + 13 + 10 + 9 + 5 + 10 + 5 = **84**. If the real count differs, use the real one — the gate is "all of them", not "84 of them".

- [ ] **Step 2: Capture the Fastify baseline FIRST**

```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
make up && sleep 20
cd e2e && nvm use && pnpm exec playwright test 2>&1 | tee /tmp/e2e-fastify-baseline.txt | tail -20
```

**Record which specs pass on Fastify today.** A spec already failing before the migration is not this migration's regression, and without the baseline there is no way to tell the two apart. See [[e2e-variance-exceeds-effect]] — this suite has real run-to-run variance, so a single failure needs a re-run before it is called a regression.

- [ ] **Step 3: Point the service at the Nest entrypoint**

In `services/users/package.json`:

```json
"dev": "tsx watch --conditions=development --import ./src/shared/observability/tracing.ts src/nest/main.ts",
"start": "node --import ./dist/shared/observability/tracing.js dist/nest/main.js"
```

In `services/users/Dockerfile`, the `CMD` (line 118):

```dockerfile
# --import loads the OTel bootstrap in its OWN module graph, before the app's
# static imports resolve — the only ordering that instruments @grpc/grpc-js.
CMD ["node", "--import", "./dist/shared/observability/tracing.js", "dist/nest/main.js"]
```

- [ ] **Step 4: Rebuild and run the full suite against Nest**

```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
make down && make up && sleep 20
cd e2e && nvm use && pnpm exec playwright test 2>&1 | tee /tmp/e2e-nest.txt | tail -30
```

- [ ] **Step 5: Diff against the baseline**

```bash
diff <(grep -E "✓|✘|passed|failed" /tmp/e2e-fastify-baseline.txt) \
     <(grep -E "✓|✘|passed|failed" /tmp/e2e-nest.txt)
```

**Every spec that passed on Fastify must pass on Nest.** For each failure:

| Symptom | Diagnosis |
|---|---|
| Gateway 404 with `{"message":"Not Found"}` | The request never reached the service — a route is missing from the controller, or from `infra/modules/api-gateway/main.tf`'s route map, or has no `location` block in `nginx.conf`. A **401 is the good answer**: it proves the route resolves. |
| Service-shaped `{error: ...}` 404 | The route exists; the handler's routine-miss path is wrong. |
| A 400 where a 200 is expected | The `ZodValidationPipe` rejects a body the Fastify schema accepted — compare the schema wiring, not the schema. |
| `x-cache` header missing or wrong | Task 20's cache interceptor is not in the right pipeline position. |

- [ ] **Step 6: Re-run any single failure before calling it a regression**

```bash
cd e2e && nvm use && pnpm exec playwright test tests/<failing>.spec.ts --repeat-each=3
```

A spec that passes 2 of 3 times was flaky before this migration too. One that fails 3 of 3 is a real defect.

- [ ] **Step 7: Run the load tests to confirm the shape under sustained traffic**

```bash
cd e2e/load-tests && nvm use && pnpm exec gatling run --simulation <the users simulation>
```

Compare the drain rate and error rate against the Fastify run, not a single before/after latency number — see [[e2e-variance-exceeds-effect]].

- [ ] **Step 8: STOP and report**

**This is a stop point.** Do not proceed to Task 26 until the user has seen the full E2E result. Deleting the Fastify implementation is irreversible without a revert (spec: "No rollback window after cut-over"), and the evidence for that decision is this task's output.

Report: the baseline vs. Nest diff, any spec that needed a re-run, and the load-test comparison.

---

### Task 26: Delete the Fastify implementation

**Only after Task 25's gate is green and the user has authorized the cut-over.** One commit, so there is one clear point where the service becomes Nest-only.

**Files:**
- Delete: `services/users/src/server.ts`
- Delete: `services/users/src/shared/di/awilix-container.ts`
- Delete: `services/users/src/features/users/http/routes.ts`
- Delete: `services/users/src/features/users/http/cache-hooks.ts`
- Delete: `services/users/src/features/users/http/generate-openapi.ts`
- Delete: `services/users/src/shared/grpc/server.ts` (the hand-built server; `api-key-interceptor.ts` and `address.ts` STAY — Task 22 uses both)
- Delete: the superseded test files under `tests/features/` and `tests/shared/di/`
- Modify: `services/users/package.json` (drop the Fastify-only dependencies)

- [ ] **Step 1: Confirm nothing still imports what is about to be deleted**

```bash
cd services/users
for f in server routes cache-hooks awilix-container generate-openapi; do
  echo "--- $f ---"
  grep -rn "$f" src/ tests/ --include="*.ts" | grep -v "^src/nest/" | grep -v "src/$f.ts\|/$f.ts:"
done
```

Expected: no hits outside the files being removed. **A hit means something still depends on it — resolve that before deleting.**

- [ ] **Step 2: Delete the Fastify application files**

```bash
cd services/users
rm src/server.ts \
   src/shared/di/awilix-container.ts \
   src/features/users/http/routes.ts \
   src/features/users/http/cache-hooks.ts \
   src/features/users/http/generate-openapi.ts \
   src/shared/grpc/server.ts
```

- [ ] **Step 3: Delete the superseded tests**

Every test file under `tests/features/` and `tests/shared/di/` whose Nest counterpart exists under `tests/nest/`. **Keep every test that covers code still in use** — `tests/shared/` covers `src/shared/`, which was not rewritten. Specifically **keep** `tests/shared/grpc/api-key-interceptor.test.ts` and `api-key-interceptor.trace-context.test.ts`: Task 22 still uses that interceptor and those tests guard the JE-77 fix.

```bash
cd services/users
# List what has a Nest counterpart, then remove exactly those.
for f in $(find tests/features -name "*.test.ts"); do
  base=$(basename $f)
  if find tests/nest -name "$base" | grep -q .; then echo "SUPERSEDED: $f"; fi
done
```

Review that list by hand before deleting. `rm tests/shared/di/*.test.ts` as well — those test the container that no longer exists.

- [ ] **Step 4: Drop the Fastify-only dependencies**

```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
pnpm --filter @3mrai/users remove @fastify/awilix awilix fastify-type-provider-zod @fastify/swagger
```

**Keep `fastify`** — `@nestjs/platform-fastify` needs it — and **keep `@fastify/otel`**, which instruments the server underneath the adapter. Verify after removal:

```bash
cd services/users && nvm use && pnpm build && pnpm test
```

- [ ] **Step 5: Flatten `src/nest/` up to `src/`**

The parallel-build namespace has served its purpose and `src/nest/main.ts` reads oddly once it is the only implementation.

```bash
cd services/users/src && mv nest/* . && rmdir nest
```

Then update: the `#nest/*` subpath import in `package.json` (remove it; the moved files use `#shared`/`#features`), the alias in `vitest.config.ts`, every `#nest/...` import in `tests/nest/`, the `dev`/`start` scripts, and the Dockerfile `CMD` — all back to `src/main.ts` / `dist/main.js`.

```bash
cd services/users && grep -rln "#nest/" src/ tests/ | xargs sed -i '' 's|#nest/|#|g'
```

Check the result compiles before trusting the sed:

```bash
cd services/users && nvm use && pnpm build
```

- [ ] **Step 6: Re-run everything**

```bash
cd services/users && nvm use && pnpm test && pnpm build && pnpm run generate:openapi
git diff --stat openapi.yaml
```

Expected: the full unit suite green, a clean build, and **no change** to `openapi.yaml` beyond what Task 21 already landed.

- [ ] **Step 7: Re-run the E2E suite one final time**

```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
make down && make up && sleep 20
cd e2e && nvm use && pnpm exec playwright test
```

Expected: the same result as Task 25. The deletion must change nothing observable — if it does, something deleted was still load-bearing.

- [ ] **Step 8: Leave the work in the working tree**

---

### Task 27: Documentation propagation

A spec is not done when written — it is done when its decisions reach the notes they belong to. This is a gate enforced by the validator, not a suggestion. See [[doc-propagation]].

**Files (all written via the `obsidian-vault` agent — no other agent writes to `docs/`):**
- Modify: `docs/domains/users/specs/users-service-design.md`
- Modify: `docs/shared/patterns/cqrs.md`
- Modify: `docs/shared/patterns/dependency-injection.md`
- Modify: `docs/shared/conventions/testing.md`
- Modify: `docs/shared/conventions/openapi-specs.md`
- Create: `docs/lessons/2026-09-19-esbuild-drops-decorator-metadata.md`
- Create: `docs/lessons/2026-09-19-nest-grpc-interceptors-silently-dropped.md`
- Modify: `services/users/CLAUDE.md`

- [ ] **Step 1: Route the propagation through `obsidian-vault`**

The plan's `propagates-to:` frontmatter lists the five target notes. Each gets the migration's decisions folded in, bidirectional `## Related` links, and a bumped `updated:`.

- [ ] **Step 2: Write the two lessons — both cost real debugging time and both are silent failures**

**`2026-09-19-esbuild-drops-decorator-metadata.md`** — tsx and Vitest do not emit `design:paramtypes`, so Nest's type-based DI injects `undefined` while `tsc` builds a working service. Asymmetric and silent. Fix: `unplugin-swc` + `.swcrc` with `decoratorMetadata: true`, guarded by `tests/nest/di-metadata.test.ts`. Severity: it would have broken every handler task.

**`2026-09-19-nest-grpc-interceptors-silently-dropped.md`** — `GrpcOptions` declares no `interceptors` key. `server: { interceptors: [...] }` is dropped without a warning, and a call with a **wrong** `x-api-key` returns the user's data: an open authentication bypass with no error. They must go in `channelOptions`, which is what Nest forwards to `new grpc.Server(...)`. Guarded by the UNAUTHENTICATED test in `tests/nest/grpc/users-grpc.test.ts`. Severity: high — a security failure that a green suite hid.

- [ ] **Step 3: Update `services/users/CLAUDE.md`**

The service's own agent memory describes a Fastify + Awilix service. Rewrite the stack section, the DI section (Awilix PROXY → Nest providers and tokens), and §"Logging & tracing in this service" (the `withWorkflowSpan` wrapper → the `@Workflow()` decorator plus the interceptor, with the reason-deferral rule stated).

- [ ] **Step 4: Run the validator**

```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure && nvm use && node scripts/validate-vault.mjs
```

Expected: green. The "Propagation debt" count for pre-2026-07-28 notes is the gate working, not failing.

- [ ] **Step 5: Run the comment linter**

```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure && make lint-comments
```

Expected: no NEW violations. This migration wrote a lot of comments; the tense rule (describe the final state, never what changed) is the one most easily broken while porting.

- [ ] **Step 6: Leave the work in the working tree**

---

## Self-Review

Run against the spec after the plan is written.

**Spec coverage:**

| Spec section | Where it lands |
|---|---|
| D1 — Users only, Lambda out of scope | Out of scope, below |
| D2 — parallel build, single cut-over | `src/nest/` namespace; Tasks 25–26 |
| D3 — 84 E2E specs are the gate | Task 25 |
| D4 — tests rewritten, not weakened | DI-3; every handler task's assertion-diff step |
| D5 — Prisma/Fastify adapter/Zod/OTel kept | Tasks 1, 3; Task 2's `main.ts` contract |
| D6 — `@nestjs/cqrs` in full | Tasks 7–18 |
| D7 — interceptors and pipes | Tasks 5, 6 |
| D8 — Zod validation + OpenAPI, no bridge lib | Tasks 6, 21 |
| Finding #1 — routine vs thrown | Task 5 (`RoutineFailure`); Tasks 7, 9, 16, 17 |
| Finding #2 — reason deferral | Task 5 Step 5; Tasks 8, 9; mutation tests |
| Finding #3 — one failure, one log line | Task 5 Steps 5–6 |
| Finding #4 — tests must go through the bus | Every handler test builds a `CommandBus` |
| Finding #5 — a green suite is not evidence | Mutation steps in Tasks 5, 8, 22 |
| Surface 1 — HTTP, 20 routes | Tasks 19, 20; Task 24's route check |
| Surface 2 — gRPC | Task 22 (resolved by spike, not deferred) |
| Surface 3 — SQS consumer | Task 23 |
| Surface 4 — SNS publisher | Task 3 (`MessagingModule`) |
| Surface 5 — WebSocket/realtime | Task 3 (`RealtimeModule`) |
| Surface 6 — metrics, poller not started in tests | Tasks 3, 23; asserted in Task 3 Step 1 |
| Surface 7 — cache | Tasks 3, 20 |
| Risk — Awilix→Nest DI not mechanical | DI-1; Task 24's boot smoke test |
| Risk — ALS audit actor survives | Task 4 Step 7; Task 9 Step 4 |
| Risk — test rewrite volume | DI-3; tests ride with each handler |
| Risk — no rollback window | Task 25 Step 8 is an explicit stop point |

**Two spec statements this plan contradicts, both on measured evidence:**

1. **Spec Phase 0 says the gRPC hosting mechanism "needs a spike."** It was run (2026-09-19) and resolved: `@nestjs/microservices` is adopted, the JE-77 fix survives, and the plan records the silent-drop hazard the spike exposed. The spec's Phase 0 is therefore closed, not skipped.
2. **The spec does not anticipate the decorator-metadata gap.** DI-1 documents it. Without Task 1 the spec's Phase 2 would fail on its first handler.

**Type consistency:** `RoutineFailure` (Task 5) is returned by Tasks 7, 9, 16, 17 and unwrapped by the interceptor in Task 5. `@Workflow(flow)` (Task 5) is applied by every handler task. `grpcMicroserviceOptions(env)` (Task 22) is consumed by `main.ts` in the same task. The `DB`/`AUTH_PROVIDER`/`EVENT_PUBLISHER`/`REDIS`/`ENV` tokens (Task 2) are the same symbols every module and handler injects.

## Out of scope

- Orders (.NET/Wolverine) and Tracking (Go/Gin) — different languages and frameworks (spec D1).
- The events-pipeline Lambda — Nest's cold-start weight was judged not worth taking (spec D1).
- Any change to the 84 E2E specs (spec D3).
- Any change to a handler's externally visible behaviour. A handler test that must change to keep passing signals an unintended behaviour change.
- Rewriting anything under `src/shared/` other than its registration — the infrastructure adapters, domain types and Prisma extensions carry over as they are.
- Migrating `CacheGateway` to a Nest interceptor beyond the `GET /v1/users/me` response cache Task 20 covers.

## Related

- [[2026-09-19-users-nestjs-migration-design]]
- [[users-service-design]]
- [[cqrs]]
- [[dependency-injection]]
- [[testing]]
- [[openapi-specs]]
- [[screaming-architecture]]
- [[ADR-0002-cqrs]]
- [[ADR-0008-screaming-arch-di]]
- [[ADR-0019-distributed-tracing-opentelemetry]]
- [[logging-context]]
- [[audit-fields]]
- [[grpc-context-activate-at-dispatch]]
- [[2026-07-12-prisma-lazy-promise-als]]
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]
- [[health-check-logging]]
- [[auth-error-mapping]]
- [[soft-delete]]
- [[x-cache-response-header]]
- [[e2e-variance-exceeds-effect]]
- [[doc-propagation]]
- [[package-manager]]
- [[git-workflow]]
