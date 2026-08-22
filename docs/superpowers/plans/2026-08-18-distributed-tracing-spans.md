---
title: Distributed Tracing — Manual Spans Implementation Plan
type: plan
area: shared
status: active
created: 2026-08-18
updated: 2026-08-21
tags:
  - type/plan
  - area/shared
  - status/active
  - issue/JE-138
  - issue/JE-152
  - issue/JE-153
  - issue/JE-154
  - issue/JE-155
  - issue/JE-156
  - issue/JE-157
  - issue/JE-158
  - issue/JE-159
  - issue/JE-160
  - issue/JE-161
propagates-to:
  - "[[users-service-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[logging-context]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
related:
  - "[[2026-08-18-distributed-tracing-spans-design]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[logging-context]]"
  - "[[testing]]"
  - "[[2026-07-12-prisma-lazy-promise-als]]"
  - "[[events-pipeline-design]]"
---

# Distributed Tracing — Manual Spans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> [!info] Implemented and verified (2026-08-19) — 10/11 issues closed
> Tasks 1-8 (JE-138, JE-152 through JE-160) are Done. Only Task 9 / JE-161 (full-trace E2E)
> remains open. Propagated into [[logging-context]], [[ADR-0019-distributed-tracing-opentelemetry]],
> [[users-service-design]], [[orders-service-design]], [[tracking-service-design]], and
> [[events-pipeline-design]].

**Correction (2026-08-21):** Task 5's "3 SQS publishers" (Users at line ~990, Orders, Tracking)
missed a fourth: `AUTH_OTP_REQUESTED` is published by the Cognito CUSTOM_AUTH trigger Lambda
(`infra/modules/cognito/otp-challenge-lambda/index.mjs`), outside the JE-155/156/157 gate this
plan scoped. Its `traceparent` injection shipped separately via `ClientMetadata` (commit
`fd65979`) — see [[ADR-0019-distributed-tracing-opentelemetry]]'s 2026-08-21 "a FOURTH SQS
publisher" Amendment. The task text below is left as originally written for Tasks 1-8's actual
scope.

**Goal:** Close the gaps in the tracing cascade so the 11 flow-log-carrying workflows across Users, Orders, and Tracking, the SQS hop between them and events-pipeline, and the 4 realtime-events Lambdas all produce spans that join one trace, without inventing a custom propagation mechanism.

**Architecture:** Each service gets one small helper (`withWorkflowSpan` in Users, `IWorkflowTracer` in Orders, a decorator/context-manager in Tracking) that wraps a workflow's body in an `INTERNAL` span carrying the same attributes as its flow log, closing in a `finally` exactly like the existing `withGrpcServerSpan` pattern. The 3 SQS publishers add `traceparent` to `MessageAttributes` (already used for `type`/`source`); events-pipeline gains the OTel SDK, widens `SqsRecord` to read it, and opens a `CONSUMER` span per batch plus an `INTERNAL` span per record linked (not parented) to each record's origin trace. realtime-events gets the SDK on all 4 entry points. The collector gains a `memory_limiter` ahead of `batch` in the traces pipeline, and `make doctor` gains a check that the collector is actually running when a service points at it.

> [!danger] RISK, load-bearing for Tasks 6 and 7 — auto-instrumentation does not cross an esbuild bundle
> Both Lambda functions (`functions/events-pipeline`, `functions/realtime-events`) ship as
> esbuild-bundled, single-file **CJS** output (`bundle: true`, `format: "cjs"`, verified
> deliberate in both `scripts/build.mjs` — an ESM bundle loads locally but fails on the real
> `nodejs20.x` runtime with `ERR_REQUIRE_CYCLE_MODULE`) with the AWS SDK and other deps
> **inlined**, not left as separate `node_modules`. OTel auto-instrumentation patches modules
> at `require()` time, and a bundle has no such boundary left to patch — registering the usual
> `getNodeAutoInstrumentations()` there would produce **zero spans for DocumentDB, SES, or the
> WebSocket push, silently**. Tasks 6 and 7 therefore use **manual spans** for every Lambda-side
> client call, not auto-instrumentation — this is a necessity of the deployment shape, not a
> style choice, and it is why the spec's Decision 5 diagram (which shows those as
> "auto-instr.") does not hold as written for this repo's actual build. See the `[!danger]`
> callouts inside Tasks 6 and 7 for the full reasoning and the rejected alternatives.

**Tech Stack:** `@opentelemetry/api`, `@opentelemetry/instrumentation`, `@prisma/instrumentation` (Users, Node/TS); `OpenTelemetry.Instrumentation.AWS` (Orders, .NET, pinned to `1.17.0` — the same line as the rest of `Orders.Api.csproj`'s OTel family); `opentelemetry-instrumentation-boto3sqs` (Tracking, Python, pinned to `0.65b0` — the same line as `requirements-runtime.txt`'s existing instrumentations; covers SQS only, not the service's separate CloudWatch client); `@opentelemetry/sdk-node`, `@opentelemetry/sdk-trace-base` `BatchSpanProcessor`, and hand-written manual CLIENT/PRODUCER spans (events-pipeline + realtime-events Lambdas, Node — auto-instrumentation does not survive their esbuild CJS bundling, see the RISK callout above); Jaeger 1.62.0 query API for E2E assertions; pytest / vitest / xUnit per service.

**Spec:** docs/superpowers/specs/2026-08-18-distributed-tracing-spans-design.md

## Global Constraints

- A span MUST close in a `finally` — an unclosed span on an exception path never reaches Jaeger (spec Decision 2).
- Workflow spans are `SpanKind.INTERNAL`, named exactly `<flow>` (e.g. `register`, `create_order`, `init_tracking`), and carry the SAME attributes as the flow's existing log line (`app_event`, `reason` on failure, `order_id`, `user_id`, …).
- On failure: `recordException()` + `setStatus(ERROR, <same reason as the log>)`.
- Only the 11 flows listed in spec Decision 3 get a workflow span — no others, and no span for `*_publish_failed` or `metric_*` branches (they stay as span events on the parent).
- `traceparent` goes into SQS `MessageAttributes`, never into the envelope body (spec Decision 4).
- The SQS consumer in events-pipeline uses span **links**, never parent-child (spec Decision 4).
- events-pipeline opens one span **per record**, not just per batch (spec Decision 5).
- All new OTel configuration (endpoint, protocol, exporter disabling) goes in environment variables — never hardcoded in code (spec Decision 9; see [[logging-context]]).
- `nvm use` before every Node.js command (`.nvmrc` pins 24.18.0). **pnpm only**, never npm.
- Infra Python scripts run via `.venv/bin/python` by absolute path, never plain `python3`.
- Conventional Commits per task: `feat(<scope>): <desc>`, scope one of `users|orders|tracking|events-pipeline|infra`.
- Users is ESM (`"type": "module"`); the OTel SDK bootstrap file is loaded via `node --import`, never a normal `import`.
- No sampling anywhere (100%, `parentbased_always_on` stays default) — Global Constraint from spec Decision 10.

---

## File Structure

**Users (`services/users/`)**
- `src/shared/observability/workflow-tracing.ts` — new. `withWorkflowSpan<T>(name, attributes, fn)` helper, mirrors `grpc-tracing.ts`'s `withGrpcServerSpan` shape.
- `src/shared/observability/tracing.ts` — modified. Registers `PrismaInstrumentation` via `registerInstrumentations` BEFORE `sdk.start()`.
- `package.json` — modified. Adds `@prisma/instrumentation`.
- 8 command files under `src/features/users/commands/` — modified to wrap `execute()` bodies in `withWorkflowSpan`.
- `src/shared/observability/workflow-tracing.test.ts` — new unit test.

**Orders (`services/orders/`)**
- `src/Orders.Infrastructure/Observability/IWorkflowTracer.cs` — new interface.
- `src/Orders.Infrastructure/Observability/WorkflowTracer.cs` — new implementation.
- `src/Orders.Api/Program.cs` — modified. Registers `IWorkflowTracer` in DI, adds `AddAWSInstrumentation()`.
- `src/Orders.Infrastructure/Orders/CreateOrderService.cs` — modified. Wraps `CreateAsync` body in `_tracer.TraceWorkflowAsync(...)`.
- `src/Orders.Infrastructure/Orders.Infrastructure.csproj` — modified. Adds `OpenTelemetry.Instrumentation.AWS`.
- `tests/Orders.Infrastructure.Tests/Observability/WorkflowTracerTests.cs` — new unit test.

**Tracking (`services/tracking/`)**
- `src/shared/observability/workflow_tracing.py` — new. `workflow_span(name, **attributes)` context manager.
- `src/features/tracking/api/init_tracking_router.py` — modified.
- `src/features/tracking/api/carrier_router.py` — modified.
- `src/features/tracking/commands/test_mode_progression.py` — modified.
- `requirements-runtime.txt` — modified. Adds `opentelemetry-instrumentation-boto3sqs`.
- `tests/shared/observability/test_workflow_tracing.py` — new unit test.

**SQS publishers (traceparent injection)**
- `services/users/src/shared/messaging/event-publisher.ts` — modified (2 call sites: `publishUserCreated`, `publishPasswordResetRequested`).
- `services/orders/src/Orders.Infrastructure/Messaging/SqsEventPublisher.cs` — modified.
- `services/tracking/src/shared/messaging/sqs_event_publisher.py` — modified.
- Matching test files for each (unit, asserting the `MessageAttributes` entry).

**events-pipeline (`functions/events-pipeline/`)** — ships as ONE esbuild CJS bundle (`dist/handler.js`); auto-instrumentation cannot patch anything inlined into it, so every span below is manual (see the plan header's RISK callout)
- `src/shared/observability/tracing.ts` — new. `BatchSpanProcessor` + `forceFlush()` in `finally`; exports the shared `pipelineTracer`.
- `src/handler.ts` — modified. Widen `SqsRecord`, wrap the batch in a `CONSUMER` span, wrap each record in an `INTERNAL` span with a link to its origin trace.
- `src/shared/db/events-repository.ts` — modified. Manual CLIENT span (`documentdb insertOne`) around `insertStarted`'s `collection.insertOne` call.
- `src/email/sender.ts` — modified. Manual CLIENT span (`ses SendEmail`) around the SES send.
- `src/shared/realtime/websocket-publisher.ts` — modified. Manual PRODUCER span (`ws publish`) around `publishToUser`.
- `package.json` — modified. Adds `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`.
- `src/handler.test.ts` — modified/extended.

**realtime-events (`functions/realtime-events/`)** — ships as FOUR independent esbuild CJS bundles, one per entry point (`dist/{authorizer,connect,disconnect,default}.js`); same bundling constraint as events-pipeline, so the shared tracing module is authored once but inlined into each of the 4 bundles, and each handler calls `flushTraces()` itself
- `src/shared/observability/tracing.ts` — new, same `BatchSpanProcessor` shape; exports `wsTracer` and `flushTraces`.
- `src/connect.ts`, `src/disconnect.ts`, `src/default.ts`, `src/authorizer.ts` — modified to import the tracing bootstrap first, wrap in their own SERVER span, and flush in their OWN `finally` (not shared — see Task 7's RISK callout).
- `package.json` — modified, same OTel deps as events-pipeline.

**Infra**
- `infra/environments/local/main.tf` — modified. Adds `OTEL_*` entries to `module.lambda_events_pipeline.environment_variables` and to the realtime-events Lambda module block(s).
- `infra/environments/local/scripts/generate_env_files.py` — modified if a local test env var is needed for events-pipeline/realtime-events (see Task 5/6).
- `observability/otel-collector-config.yaml` — modified. Adds `memory_limiter` ahead of `batch` in the `traces` pipeline.
- `infra/scripts/doctor.py` — modified. New `check_observability_reachable` check.

**E2E**
- `e2e/gateway/create-order-trace.spec.ts` (or `.ts` under the repo's existing gateway E2E convention) — new. Full-trace assertion + JE-77 anti-regression.

---

### Task 1: Users — `withWorkflowSpan` helper + Prisma instrumentation

**Files:**
- Create: `services/users/src/shared/observability/workflow-tracing.ts`
- Create: `services/users/src/shared/observability/workflow-tracing.test.ts`
- Modify: `services/users/src/shared/observability/tracing.ts`
- Modify: `services/users/package.json`

**Interfaces:**
- Consumes: `SpanKind`, `SpanStatusCode`, `trace` from `@opentelemetry/api` (already a dependency); `registerInstrumentations` from `@opentelemetry/instrumentation` (already a transitive dependency of `@opentelemetry/sdk-node`, add explicitly); `PrismaInstrumentation` from `@prisma/instrumentation` (new dependency).
- Produces: `export function withWorkflowSpan<T>(name: string, attributes: Record<string, string | number | boolean>, fn: () => Promise<T>): Promise<T>` — used by Task-1-consuming call sites in the 8 command files (this task itself performs those 8 edits, so "consumers" here means the E2E task later).

- [ ] **Step 1: Write the failing test**
```typescript
// services/users/src/shared/observability/workflow-tracing.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { withWorkflowSpan } from "./workflow-tracing.ts";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();

beforeEach(() => {
  exporter.reset();
});

describe("withWorkflowSpan", () => {
  it("creates an INTERNAL span named after the flow, carrying the given attributes, and sets OK on success", async () => {
    const result = await withWorkflowSpan(
      "register",
      { app_event: "register_succeeded", user_id: "usr_123" },
      async () => "done",
    );

    expect(result).toBe("done");
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("register");
    expect(spans[0].attributes.app_event).toBe("register_succeeded");
    expect(spans[0].attributes.user_id).toBe("usr_123");
    expect(spans[0].status.code).toBe(SpanStatusCode.OK);
  });

  it("closes the span in a finally, records the exception, and sets ERROR with the same reason on failure", async () => {
    await expect(
      withWorkflowSpan(
        "login",
        { app_event: "login_failed", reason: "invalid_credentials" },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].status.message).toBe("boom");
    expect(spans[0].attributes.reason).toBe("invalid_credentials");
    expect(spans[0].events.some((e) => e.name === "exception")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd services/users && nvm use && pnpm exec vitest run src/shared/observability/workflow-tracing.test.ts`
Expected: FAIL with "Cannot find module './workflow-tracing.ts'" (or equivalent resolution error), since the file does not exist yet.

- [ ] **Step 3: Write minimal implementation**
```typescript
// services/users/src/shared/observability/workflow-tracing.ts
import { SpanKind, SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";

// Manual span for a business workflow — the 11 flows in
// docs/superpowers/specs/2026-08-18-distributed-tracing-spans-design.md
// Decision 3. Mirrors grpc-tracing.ts's withGrpcServerSpan: SAME status
// handling, SAME span.end() in a finally. A span not closed on the exception
// path never reaches Jaeger — it does not show up as an error, it silently
// vanishes from the cascade.
//
// `attributes` carries the SAME fields already on the flow's log line
// (app_event, reason on failure, user_id, order_id, …) so the trace and the
// logs tell the same story and neither needs the other to be understood.
const tracer = trace.getTracer("users-workflow");

export function withWorkflowSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL, attributes }, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
```

Then register Prisma instrumentation in `tracing.ts`, BEFORE `sdk.start()`:

```typescript
// services/users/src/shared/observability/tracing.ts
// (add these two imports near the top, alongside the existing OTel imports)
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { PrismaInstrumentation } from "@prisma/instrumentation";

// ... existing sdk = new NodeSDK({ ... }) block is unchanged ...

// MUST run before PrismaClient is instantiated — Prisma's own docs are
// explicit about this, and it is the same load-order trap this file's own
// top comment already documents for auto-instrumentations: register late and
// nothing patches, silently, with no error. `prisma.ts` (which builds the
// PrismaClient) is only reached later, through the Awilix container — well
// after this file, loaded first via `node --import` — so registering here is
// what guarantees the ordering. No `previewFeatures = ["tracing"]` needed:
// this repo is on Prisma 7.8, where the preview flag from Prisma 6 no longer
// applies; @prisma/instrumentation is the whole mechanism.
//
// NodeSDK already owns the global tracer provider and context manager (set up
// by sdk.start() below) — do NOT construct a separate BasicTracerProvider or
// AsyncLocalStorageContextManager here the way @prisma/instrumentation's own
// README example does; that example assumes no SDK exists yet, and duplicating
// either would fight the one NodeSDK already installs.
registerInstrumentations({
  instrumentations: [new PrismaInstrumentation()],
});

sdk.start();
```

Add the dependency:
```bash
cd services/users && nvm use && pnpm add @prisma/instrumentation @opentelemetry/instrumentation
```

- [ ] **Step 4: Run test to verify it passes**
Run: `cd services/users && nvm use && pnpm exec vitest run src/shared/observability/workflow-tracing.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**
```bash
git add services/users/src/shared/observability/workflow-tracing.ts services/users/src/shared/observability/workflow-tracing.test.ts services/users/src/shared/observability/tracing.ts services/users/package.json services/users/pnpm-lock.yaml
git commit -m "feat(users): add withWorkflowSpan helper and Prisma span instrumentation"
```

---

### Task 2: Users — wrap the 8 workflow call sites in `withWorkflowSpan`

**Files:**
- Modify: `services/users/src/features/users/commands/register.ts`
- Modify: `services/users/src/features/users/commands/register-passwordless.ts`
- Modify: `services/users/src/features/users/commands/login.ts`
- Modify: `services/users/src/features/users/commands/change-password.ts`
- Modify: `services/users/src/features/users/commands/start-otp-challenge.ts`
- Modify: `services/users/src/features/users/commands/verify-otp-challenge.ts`
- Modify: `services/users/src/features/users/commands/forgot-password.ts`
- Modify: `services/users/src/features/users/commands/confirm-password-reset.ts`
- Test: `services/users/src/features/users/commands/register.test.ts` (extend existing suite; same pattern applies to the other 7 — this task's Step 1/2/3/4 are written for `register.ts` and repeated identically, file-by-file, for the remaining 7 command files using their own existing test files)

**Interfaces:**
- Consumes: `withWorkflowSpan<T>(name, attributes, fn)` from Task 1 (`#shared/observability/workflow-tracing`).
- Produces: no new exports — each `execute()` method's existing signature and return type are unchanged; only the body is wrapped.

- [ ] **Step 1: Write the failing test**
```typescript
// services/users/src/features/users/commands/register.test.ts
// (add this test to the existing describe block for RegisterUserCommand)
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

// ... existing imports/mocks for RegisterUserCommand's dependencies stay as-is ...

describe("RegisterUserCommand tracing", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();

  beforeEach(() => exporter.reset());

  it("emits a 'register' span with app_event=register_succeeded on success", async () => {
    const command = new RegisterUserCommand(buildValidCradle()); // existing test helper
    await command.execute(validRegisterInput()); // existing test helper

    const spans = exporter.getFinishedSpans();
    const registerSpan = spans.find((s) => s.name === "register");
    expect(registerSpan).toBeDefined();
    expect(registerSpan!.attributes.app_event).toBe("register_succeeded");
    expect(registerSpan!.status.code).toBe(SpanStatusCode.OK);
  });

  it("emits a 'register' span with ERROR status and the same reason as the failure log on a duplicate email", async () => {
    const command = new RegisterUserCommand(buildCradleWithDuplicateEmail()); // existing test helper

    await expect(command.execute(validRegisterInput())).rejects.toThrow();

    const spans = exporter.getFinishedSpans();
    const registerSpan = spans.find((s) => s.name === "register");
    expect(registerSpan!.status.code).toBe(SpanStatusCode.ERROR);
    expect(registerSpan!.attributes.reason).toBe("duplicate_email");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd services/users && nvm use && pnpm exec vitest run src/features/users/commands/register.test.ts`
Expected: FAIL — no span named `register` is produced, because `execute()` is not yet wrapped in `withWorkflowSpan`.

- [ ] **Step 3: Write minimal implementation**
Wrap `RegisterUserCommand.execute`'s body. The span attributes mirror the `register_started` log line's fields, and the failure branch's `reason` is threaded onto the span the same way `EmailAlreadyExistsError` decides the log's `reason`:

```typescript
// services/users/src/features/users/commands/register.ts
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";
// (keep all existing imports)

export class RegisterUserCommand {
  // ... constructor unchanged ...

  async execute(input: RegisterInput): Promise<User> {
    return withWorkflowSpan(
      "register",
      { app_event: "register_started", auth_type: "PASSWORD" },
      () => this.doExecute(input),
    );
  }

  private async doExecute(input: RegisterInput): Promise<User> {
    // ... the ENTIRE existing body of execute() moves here, UNCHANGED ...
    // (setLogContext, appLogger.info register_started, signUp, db.user.create,
    //  event publish, appLogger.info register_succeeded, return toDomain(row))
  }
}
```

The span's own `app_event`/`reason` are attached to the *active* span from inside `doExecute` by calling `trace.getActiveSpan()?.setAttribute(...)` at the same points the code already logs `register_failed`/`register_succeeded` — added as one-line calls immediately after each `appLogger.error`/`appLogger.info` call so the span attribute set matches the log's fields exactly:

```typescript
// inside the existing catch block, right after the appLogger.error(...) call:
trace.getActiveSpan()?.setAttribute(
  "reason",
  err instanceof EmailAlreadyExistsError ? "duplicate_email" : "cognito_error",
);
// then: throw err; (unchanged — withWorkflowSpan's catch sets ERROR status
// from this thrown error, and the attribute set here is already on the span
// by the time that runs)

// inside the existing success path, right after appLogger.info(register_succeeded):
trace.getActiveSpan()?.setAttribute("app_event", "register_succeeded");
```

Add `import { trace } from "@opentelemetry/api";` to the top of the file.

Apply the SAME shape (wrap `execute` → `doExecute`, add `trace.getActiveSpan()?.setAttribute(...)` beside each existing `appLogger.info`/`appLogger.error` flow-log call, import `withWorkflowSpan` and `trace`) to the other 7 files, using each flow's own name and `app_event` values:

| File | Span name | Started attrs |
|---|---|---|
| `register-passwordless.ts` | `register` | `{ app_event: "register_started", auth_type: "PASSWORDLESS" }` |
| `login.ts` | `login` | `{ app_event: "login_started" }` |
| `change-password.ts` | `change_password` | `{ app_event: "change_password_started" }` |
| `start-otp-challenge.ts` | `otp_challenge` | `{ app_event: "otp_challenge_started" }` |
| `verify-otp-challenge.ts` | `otp_verify` | `{ app_event: "otp_verify_started" }` |
| `forgot-password.ts` | `password_reset_requested` | `{ app_event: "password_reset_requested_started" }` |
| `confirm-password-reset.ts` | `password_reset_confirm` | `{ app_event: "password_reset_confirm_started" }` |

`register-passwordless.ts` shares the `register` span name with `register.ts` (spec Decision 3 counts them as one of the 7 Users flows, distinguished by `auth_type`), so the workflow name column above intentionally repeats `register`.

- [ ] **Step 4: Run test to verify it passes**
Run: `cd services/users && nvm use && pnpm exec vitest run src/features/users/commands/`
Expected: PASS (all existing command tests plus the 2 new tracing tests per file, ×8 files)

- [ ] **Step 5: Commit**
```bash
git add services/users/src/features/users/commands/
git commit -m "feat(users): wrap the 8 auth workflow commands in workflow spans"
```

---

### Task 3: Orders — `IWorkflowTracer` + `create_order` span + AWS SDK instrumentation

**Files:**
- Create: `services/orders/src/Orders.Infrastructure/Observability/IWorkflowTracer.cs`
- Create: `services/orders/src/Orders.Infrastructure/Observability/WorkflowTracer.cs`
- Modify: `services/orders/src/Orders.Api/Program.cs`
- Modify: `services/orders/src/Orders.Infrastructure/Orders/CreateOrderService.cs`
- Modify: `services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj`
- Test: `services/orders/tests/Orders.Infrastructure.Tests/Observability/WorkflowTracerTests.cs`

**Interfaces:**
- Consumes: `System.Diagnostics.ActivitySource`, `Activity`, `ActivityStatusCode` (.NET's native tracing API, which `OpenTelemetry.Instrumentation.AWS`/`AddOtlpExporter` already bridge — Orders' existing SDK setup in `Program.cs` uses `System.Diagnostics.Activity` under the hood via `AddAspNetCoreInstrumentation`/`AddHttpClientInstrumentation`, so a new manual span uses the SAME `ActivitySource` mechanism, not a separate OTel-specific API).
- Produces: `public interface IWorkflowTracer { Task<T> TraceWorkflowAsync<T>(string name, IDictionary<string, object?> attributes, Func<Task<T>> action); void SetAttribute(string key, object? value); void SetReason(string reason); }` — consumed by `CreateOrderService.CreateAsync` in this task, and available for any later Orders workflow.

- [ ] **Step 1: Write the failing test**
```csharp
// services/orders/tests/Orders.Infrastructure.Tests/Observability/WorkflowTracerTests.cs
using System.Diagnostics;
using Orders.Infrastructure.Observability;
using Xunit;

namespace Orders.Infrastructure.Tests.Observability;

public class WorkflowTracerTests
{
    [Fact]
    public async Task TraceWorkflowAsync_CreatesActivityNamedAfterFlow_WithGivenAttributes_AndOkStatusOnSuccess()
    {
        var recorded = new List<Activity>();
        using var listener = new ActivityListener
        {
            ShouldListenTo = source => source.Name == WorkflowTracer.ActivitySourceName,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData,
            ActivityStopped = activity => recorded.Add(activity),
        };
        ActivitySource.AddActivityListener(listener);

        var tracer = new WorkflowTracer();
        var result = await tracer.TraceWorkflowAsync(
            "create_order",
            new Dictionary<string, object?> { ["app_event"] = "create_order_started" },
            async () =>
            {
                await Task.Yield();
                return 42;
            });

        Assert.Equal(42, result);
        var span = Assert.Single(recorded);
        Assert.Equal("create_order", span.DisplayName);
        Assert.Equal(ActivityStatusCode.Ok, span.Status);
        Assert.Contains(span.Tags, t => t.Key == "app_event" && t.Value == "create_order_started");
    }

    [Fact]
    public async Task TraceWorkflowAsync_SetsErrorStatusAndReason_WhenActionThrows()
    {
        var recorded = new List<Activity>();
        using var listener = new ActivityListener
        {
            ShouldListenTo = source => source.Name == WorkflowTracer.ActivitySourceName,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData,
            ActivityStopped = activity => recorded.Add(activity),
        };
        ActivitySource.AddActivityListener(listener);

        var tracer = new WorkflowTracer();

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            tracer.TraceWorkflowAsync<int>(
                "create_order",
                new Dictionary<string, object?> { ["app_event"] = "create_order_started" },
                async () =>
                {
                    await Task.Yield();
                    tracer.SetReason("unknown_user");
                    throw new InvalidOperationException("caller not found");
                }));

        var span = Assert.Single(recorded);
        Assert.Equal(ActivityStatusCode.Error, span.Status);
        Assert.Contains(span.Tags, t => t.Key == "reason" && t.Value == "unknown_user");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd services/orders && dotnet test tests/Orders.Infrastructure.Tests --filter WorkflowTracerTests`
Expected: FAIL with a build error — `Orders.Infrastructure.Observability.WorkflowTracer` does not exist.

- [ ] **Step 3: Write minimal implementation**
```csharp
// services/orders/src/Orders.Infrastructure/Observability/IWorkflowTracer.cs
namespace Orders.Infrastructure.Observability;

/// <summary>
/// One manual span per business workflow — the single Orders flow in
/// docs/superpowers/specs/2026-08-18-distributed-tracing-spans-design.md
/// Decision 3 (create_order). Mirrors the SAME status/finally shape Users'
/// withWorkflowSpan and its own withGrpcServerSpan already use: OK on success,
/// ERROR with the failure's reason otherwise, and the span always ends.
/// </summary>
public interface IWorkflowTracer
{
    Task<T> TraceWorkflowAsync<T>(
        string name,
        IDictionary<string, object?> attributes,
        Func<Task<T>> action);

    /// <summary>Attach an attribute to the CURRENT workflow span from inside the action.</summary>
    void SetAttribute(string key, object? value);

    /// <summary>Convenience for the one attribute every failure branch sets: "reason".</summary>
    void SetReason(string reason);
}
```

```csharp
// services/orders/src/Orders.Infrastructure/Observability/WorkflowTracer.cs
using System.Diagnostics;

namespace Orders.Infrastructure.Observability;

public class WorkflowTracer : IWorkflowTracer
{
    // A distinct name from AspNetCore/HttpClient/EFCore's own ActivitySources
    // (Program.cs registers those separately) — this is the ONE source for
    // manually-created workflow spans, and Program.cs's AddSource(...) call
    // (added in this task) must name this exact string or the spans are
    // created but never exported, silently.
    public const string ActivitySourceName = "orders-workflow";

    private static readonly ActivitySource Source = new(ActivitySourceName);

    public async Task<T> TraceWorkflowAsync<T>(
        string name,
        IDictionary<string, object?> attributes,
        Func<Task<T>> action)
    {
        using var activity = Source.StartActivity(name, ActivityKind.Internal);
        if (activity is not null)
        {
            foreach (var (key, value) in attributes)
            {
                activity.SetTag(key, value);
            }
        }

        try
        {
            var result = await action();
            activity?.SetStatus(ActivityStatusCode.Ok);
            return result;
        }
        catch (Exception ex)
        {
            activity?.AddException(ex);
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            throw;
        }
        // No explicit `finally { activity?.Stop(); }` needed: `using` on an
        // Activity calls Dispose(), which calls Stop() — the .NET equivalent
        // of the mandatory span.end() in a finally this design requires
        // everywhere else. Documented here so nobody "simplifies" this away.
    }

    public void SetAttribute(string key, object? value) =>
        Activity.Current?.SetTag(key, value);

    public void SetReason(string reason) =>
        Activity.Current?.SetTag("reason", reason);
}
```

Register the `ActivitySource` and the DI binding in `Program.cs`:

```csharp
// services/orders/src/Orders.Api/Program.cs
// inside the existing .WithTracing(tracing => tracing ... ) chain, add:
        .AddSource(Orders.Infrastructure.Observability.WorkflowTracer.ActivitySourceName)
        .AddAWSInstrumentation()
// (AddAWSInstrumentation is what makes the SqsEventPublisher's SendMessageAsync
// produce a CLIENT span — spec Decision 8. AddSource is what makes the
// manually-created "create_order" Activity actually get exported; without it
// .NET's tracing pipeline drops any ActivitySource it was not told about,
// silently, the same failure class as unregistered instrumentation elsewhere
// in this design.)

// and, near the other builder.Services.AddScoped/AddSingleton calls:
builder.Services.AddSingleton<IWorkflowTracer, Orders.Infrastructure.Observability.WorkflowTracer>();
```

Add the package reference:
```bash
cd services/orders && dotnet add src/Orders.Infrastructure/Orders.Infrastructure.csproj package OpenTelemetry.Instrumentation.AWS --version 1.17.0
```

`Orders.Api.csproj` pins the ENTIRE OTel family to `1.17.0` (with `Instrumentation.EntityFrameworkCore` at `1.17.0-beta.1` because that package has no stable release yet) — `Version="latest"` or an omitted `Version` attribute would break that consistency, which is a style regression the rest of the file is deliberate about. Verified against NuGet before writing this: `OpenTelemetry.Instrumentation.AWS` DOES have a stable `1.17.0` on nuget.org, so no beta pin is needed here, unlike EntityFrameworkCore. If a future `dotnet add` reports no `1.17.0` available at implementation time (a version pulled/deprecated between planning and implementation), that is a finding to report, not to silently resolve by bumping the whole OTel family to a newer line on your own judgment — surface it instead.

Wrap `CreateOrderService.CreateAsync`'s body:

```csharp
// services/orders/src/Orders.Infrastructure/Orders/CreateOrderService.cs
// constructor: add `IWorkflowTracer tracer` to the existing parameter list and
// assign it to a new `private readonly IWorkflowTracer _tracer;` field.

    public async Task<OrderDto> CreateAsync(
        CreateOrderCommand command,
        string cognitoSub,
        bool testMode = false,
        bool e2eSource = false,
        CancellationToken ct = default)
    {
        return await _tracer.TraceWorkflowAsync(
            "create_order",
            new Dictionary<string, object?> { ["app_event"] = "create_order_started" },
            () => CreateInternalAsync(command, cognitoSub, testMode, e2eSource, ct));
    }

    private async Task<OrderDto> CreateInternalAsync(
        CreateOrderCommand command,
        string cognitoSub,
        bool testMode,
        bool e2eSource,
        CancellationToken ct)
    {
        // ... the ENTIRE existing body of CreateAsync moves here, UNCHANGED,
        // with ONE addition: immediately after the existing
        // `_logger.LogError(..., "unknown_user")` call (and any other
        // *_failed branch), add `_tracer.SetReason("unknown_user")` (or that
        // branch's own reason string) so the span's `reason` tag matches the
        // log line exactly, same as Users' pattern in Task 2. And immediately
        // after the existing `_logger.LogInformation(..., "create_order_succeeded", ...)`
        // call, add `_tracer.SetAttribute("order_id", order.Id);` so the span
        // carries the order id the log line already has.
    }
```

- [ ] **Step 4: Run test to verify it passes**
Run: `cd services/orders && dotnet test tests/Orders.Infrastructure.Tests --filter WorkflowTracerTests`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**
```bash
git add services/orders/src/Orders.Infrastructure/Observability/ services/orders/src/Orders.Api/Program.cs services/orders/src/Orders.Infrastructure/Orders/CreateOrderService.cs services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj services/orders/tests/Orders.Infrastructure.Tests/Observability/
git commit -m "feat(orders): add IWorkflowTracer, wrap create_order in a workflow span, add AWS SDK instrumentation"
```

---

### Task 4: Tracking — `workflow_span` context manager + 3 flow spans + boto3sqs instrumentation

**Files:**
- Create: `services/tracking/src/shared/observability/workflow_tracing.py`
- Create: `services/tracking/tests/shared/observability/test_workflow_tracing.py`
- Modify: `services/tracking/src/features/tracking/api/init_tracking_router.py`
- Modify: `services/tracking/src/features/tracking/api/carrier_router.py`
- Modify: `services/tracking/src/features/tracking/commands/test_mode_progression.py`
- Modify: `services/tracking/requirements-runtime.txt`

**Interfaces:**
- Consumes: `opentelemetry.trace` (`get_tracer`, `SpanKind`, `Status`, `StatusCode`) — already installed via `opentelemetry-sdk` in `requirements-runtime.txt`.
- Produces: `workflow_span(name: str, **attributes: str | int | bool) -> AbstractContextManager[Span]` — a synchronous context manager (Tracking's flows run inside `asyncio.to_thread`-wrapped sync functions or plain sync command handlers, so a plain `@contextmanager`, not `@asynccontextmanager`, matches every call site below).

- [ ] **Step 1: Write the failing test**
```python
# services/tracking/tests/shared/observability/test_workflow_tracing.py
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from src.shared.observability.workflow_tracing import workflow_span

exporter = InMemorySpanExporter()
provider = TracerProvider()
provider.add_span_processor(SimpleSpanProcessor(exporter))
trace.set_tracer_provider(provider)


def setup_function() -> None:
    exporter.clear()


def test_workflow_span_creates_internal_span_with_attributes_and_ok_status() -> None:
    with workflow_span("init_tracking", app_event="init_tracking_started", order_id="ord_1"):
        pass

    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].name == "init_tracking"
    assert spans[0].attributes["app_event"] == "init_tracking_started"
    assert spans[0].attributes["order_id"] == "ord_1"
    assert spans[0].status.status_code.name == "OK"


def test_workflow_span_sets_error_status_and_records_exception_on_failure() -> None:
    try:
        with workflow_span("carrier_status_update", app_event="carrier_status_update_started") as span:
            span.set_attribute("reason", "invalid_status")
            raise ValueError("bad status")
    except ValueError:
        pass

    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].status.status_code.name == "ERROR"
    assert spans[0].attributes["reason"] == "invalid_status"
    assert any(event.name == "exception" for event in spans[0].events)
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd services/tracking && nvm use && .venv/bin/python -m pytest tests/shared/observability/test_workflow_tracing.py -v`

(Note: `nvm use` is listed for repo-wide consistency with the Global Constraints even though this specific command is Python; Tracking's own venv is at `services/tracking/.venv` per its own `CLAUDE.md` — use that interpreter, not a bare `python3`.)

Expected: FAIL with `ModuleNotFoundError: No module named 'src.shared.observability.workflow_tracing'`

- [ ] **Step 3: Write minimal implementation**
```python
# services/tracking/src/shared/observability/workflow_tracing.py
"""Manual span for a business workflow — the 3 Tracking flows in
docs/superpowers/specs/2026-08-18-distributed-tracing-spans-design.md
Decision 3 (init_tracking, carrier_status_update, test_mode_progression).

Mirrors the SAME status/finally shape as Users' withWorkflowSpan and Orders'
IWorkflowTracer: OK on success, ERROR with the same `reason` the flow's own
log line carries, and the span always closes — a synchronous @contextmanager,
so `with workflow_span(...):` closes on the `finally` Python already runs for
context managers, even on an exception.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from opentelemetry import trace
from opentelemetry.trace import Span, SpanKind, Status, StatusCode

_tracer = trace.get_tracer("tracking-workflow")


@contextmanager
def workflow_span(name: str, **attributes: str | int | bool) -> Iterator[Span]:
    with _tracer.start_as_current_span(name, kind=SpanKind.INTERNAL, attributes=attributes) as span:
        try:
            yield span
            span.set_status(Status(StatusCode.OK))
        except Exception as exc:
            span.record_exception(exc)
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            raise
```

Wire it into the 3 call sites, matching each flow's existing `app_event`/`reason` values:

```python
# services/tracking/src/features/tracking/api/init_tracking_router.py
# add import:
from src.shared.observability.workflow_tracing import workflow_span

# wrap the existing handler body (the try/except around _resolve_and_create
# and the success log) in:
async def init_tracking(...) -> InitTrackingResponse:
    """... (existing docstring unchanged) ..."""
    merge_log_context(order_id=payload.order_id)

    with workflow_span("init_tracking", app_event="init_tracking_started", order_id=payload.order_id) as span:
        try:
            tracking, user_id = await asyncio.to_thread(
                _resolve_and_create, caller, session, payload, e2e_source
            )
            merge_log_context(user_id=user_id, tracking_id=tracking.id)
        except UnknownUserError as exc:
            span.set_attribute("reason", UNKNOWN_USER_REASON)
            _log_failure(payload.order_id, UNKNOWN_USER_REASON, caller.cognito_sub)
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=_error(str(exc), UNKNOWN_USER_REASON),
            ) from exc
        except TrackingAlreadyExistsError as exc:
            span.set_attribute("reason", ALREADY_EXISTS_REASON)
            _log_failure(payload.order_id, ALREADY_EXISTS_REASON, caller.cognito_sub)
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=_error(str(exc), ALREADY_EXISTS_REASON),
            ) from exc

        span.set_attribute("tracking_id", tracking.id)
        # ... rest of the existing success-path body (the logger.info(...) call
        # and the test_mode background-task kick-off) stays UNCHANGED, still
        # inside the `with workflow_span(...)` block since it is part of the
        # same request/flow.
```

```python
# services/tracking/src/features/tracking/api/carrier_router.py
# add import:
from src.shared.observability.workflow_tracing import workflow_span

def update_status(
    session: WriteSession,
    payload: UpdateStatusRequest,
    order_id: Annotated[str, Path(description="The order's id")],
) -> TrackingResponse:
    """... (existing docstring unchanged) ..."""
    command = UpdateTrackingStatusCommand(order_id=order_id, status=payload.status)

    with workflow_span("carrier_status_update", app_event="carrier_status_update_started", order_id=order_id) as span:
        try:
            tracking = update_tracking_status(session, command)
        except ValueError as exc:
            span.set_attribute("reason", INVALID_STATUS_REASON)
            _log_failure(order_id, INVALID_STATUS_REASON)
            raise _rejected(str(exc), INVALID_STATUS_REASON) from exc
        except TrackingNotFoundError as exc:
            span.set_attribute("reason", "not_found")
            _log_failure(order_id, "not_found")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="tracking not found",
            ) from exc
        except InvalidTransitionError as exc:
            span.set_attribute("reason", exc.reason.value)
            _log_failure(order_id, exc.reason.value)
            raise _rejected(str(exc), exc.reason.value) from exc

        span.set_attribute("tracking_id", tracking.id)
        logger.info(
            "carrier_status_update_succeeded",
            extra={
                "app_event": "carrier_status_update_succeeded",
                "order_id": order_id,
                "tracking_id": tracking.id,
                "status": tracking.status,
            },
        )
        return TrackingResponse.from_entity(tracking, tracking.history)
```

```python
# services/tracking/src/features/tracking/commands/test_mode_progression.py
# add import:
from src.shared.observability.workflow_tracing import workflow_span

# The whole `run_progression` coroutine becomes the span's body — a single
# span spans the full 40-second progression (four transitions), which is the
# workflow's own natural unit: not per-tick, the SAME granularity the flow log
# already uses (one _started, one _succeeded/_failed for the whole run).
async def run_progression(
    order_id: str,
    *,
    interval: float = DEFAULT_INTERVAL_SECONDS,
    writer: SessionFactory = write_session,
    sleep: Callable[[float], object] = asyncio.sleep,
) -> None:
    """... (existing docstring unchanged) ..."""
    with workflow_span("test_mode_progression", app_event="test_mode_progression_started", order_id=order_id) as span:
        logger.info(
            "test_mode_progression_started",
            extra={
                "app_event": "test_mode_progression_started",
                "order_id": order_id,
                "interval_seconds": interval,
            },
        )
        try:
            while True:
                await sleep(interval)

                def step() -> str | None:
                    with writer() as session:
                        return advance_once(session, order_id)

                status = await asyncio.to_thread(step)
                if status is None:
                    span.set_attribute("app_event", "test_mode_progression_succeeded")
                    logger.info(
                        "test_mode_progression_succeeded",
                        extra={
                            "app_event": "test_mode_progression_succeeded",
                            "order_id": order_id,
                            # ... existing fields unchanged ...
                        },
                    )
                    return
                # ... existing loop continuation logic unchanged ...
        except asyncio.CancelledError:
            raise
        except (InvalidTransitionError, TrackingNotFoundError) as exc:
            span.set_attribute("reason", type(exc).__name__)
            # ... existing *_failed logging for these branches stays UNCHANGED;
            # this task only ADDS the span.set_attribute call beside it, using
            # each branch's existing reason value where the current code
            # already computes one (see the file's own existing except blocks
            # for the exact reason strings already logged there).
            return
        except Exception as exc:  # noqa: BLE001 - see module docstring's policy
            span.set_attribute("reason", str(exc))
            # ... existing catch-all *_failed logging stays UNCHANGED ...
            return
```

Add the boto3sqs instrumentation dependency, following this file's own established rule (its header comments forbid a generic `opentelemetry-instrumentation` / `bootstrap -a` install — "an unpinned auto-discovered set is exactly the floating dependency this file's header forbids" — every instrumentation here is pinned individually):

```
# services/tracking/requirements-runtime.txt
# (append near the other opentelemetry-instrumentation-* lines, pinned to the
#  SAME 0.65b0 line as fastapi/sqlalchemy/grpc above it — mismatched
#  instrumentation/SDK minor versions is exactly the protobuf-pin trap this
#  file's own comments already document)
#
# SQS-client instrumentation for the ONE boto3 client this covers: the
# `boto3.client("sqs", ...)` in sqs_event_publisher.py:536, which is what
# produces the CLIENT span spec Decision 8 asks for on the publish call.
#
# SCOPE LIMIT, stated explicitly so it is not mistaken for a bug later:
# Tracking also uses boto3 for CloudWatch (shared/metrics/cloudwatch_metrics.py,
# features/tracking/commands/publish_metrics.py, `boto3.client("cloudwatch", ...)`).
# boto3sqs does NOT cover that client — CloudWatch would need
# opentelemetry-instrumentation-botocore, which is NOT in this spec's scope
# (spec Decision 8 only asks for a span on the SQS publish). PutMetricData
# calls stay unspanned after this task; that is deliberate, not a gap to file.
# No entry point registration code is needed either way: like fastapi/
# sqlalchemy/grpc above, this package registers an `opentelemetry_instrumentor`
# entry point that `opentelemetry-instrument` (the Dockerfile CMD wrapper)
# enumerates and loads on its own.
opentelemetry-instrumentation-boto3sqs==0.65b0
```

`httpx` stays out of `requirements-runtime.txt` — untouched by this task, per spec Decision 8's exclusion (Tracking makes no outbound HTTP).

- [ ] **Step 4: Run test to verify it passes**
Run: `cd services/tracking && .venv/bin/python -m pytest tests/shared/observability/test_workflow_tracing.py tests/features/tracking/ -v`
Expected: PASS (all existing tracking-flow tests plus the 2 new workflow_tracing tests)

- [ ] **Step 5: Commit**
```bash
git add services/tracking/src/shared/observability/workflow_tracing.py services/tracking/tests/shared/observability/test_workflow_tracing.py services/tracking/src/features/tracking/api/init_tracking_router.py services/tracking/src/features/tracking/api/carrier_router.py services/tracking/src/features/tracking/commands/test_mode_progression.py services/tracking/requirements-runtime.txt
git commit -m "feat(tracking): add workflow_span context manager, wrap the 3 tracking flows, add boto3sqs instrumentation"
```

---

### Task 5: SQS publishers — inject `traceparent` into `MessageAttributes` (dependency gate)

> This task is a dependency gate: Task 6 (events-pipeline consumer) cannot read a `traceparent` no publisher sends.

**Files:**
- Modify: `services/users/src/shared/messaging/event-publisher.ts`
- Test: `services/users/src/shared/messaging/event-publisher.test.ts`
- Modify: `services/orders/src/Orders.Infrastructure/Messaging/SqsEventPublisher.cs`
- Test: `services/orders/tests/Orders.Infrastructure.Tests/Messaging/SqsEventPublisherTests.cs`
- Modify: `services/tracking/src/shared/messaging/sqs_event_publisher.py`
- Test: `services/tracking/tests/shared/messaging/test_sqs_event_publisher.py`

**Interfaces:**
- Consumes: `propagation.inject` from `@opentelemetry/api` (Users); `Propagators.DefaultTextMapPropagator` / `Activity.Current` (Orders, via `System.Diagnostics.Activity.Current?.Id` which IS the W3C traceparent string in .NET's native format); `opentelemetry.propagate.inject` (Tracking).
- Produces: every `SendMessageCommand`/`SendMessageRequest`/`send_message` call across the 3 publishers gains a `traceparent` entry in its `MessageAttributes` dict, string-valued, present only when there is an active span (never an empty string).

- [ ] **Step 1: Write the failing test**
```typescript
// services/users/src/shared/messaging/event-publisher.test.ts
// (add to the existing SqsEventPublisher test suite)
import { context, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

describe("SqsEventPublisher traceparent propagation", () => {
  const provider = new NodeTracerProvider();
  provider.register();
  const tracer = trace.getTracer("test");

  it("injects a traceparent MessageAttribute when publishUserCreated runs inside an active span", async () => {
    const sendSpy = vi.fn().mockResolvedValue({});
    const publisher = new SqsEventPublisher({ send: sendSpy } as any, "queue-url"); // existing test construction

    await tracer.startActiveSpan("test-span", async (span) => {
      await context.with(trace.setSpan(context.active(), span), () =>
        publisher.publishUserCreated({
          id: "usr_1",
          email: "a@example.com",
          fullName: "A",
          createdAt: new Date(),
        }),
      );
      span.end();
    });

    const sentCommand = sendSpy.mock.calls[0][0];
    expect(sentCommand.input.MessageAttributes.traceparent).toBeDefined();
    expect(sentCommand.input.MessageAttributes.traceparent.StringValue).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd services/users && nvm use && pnpm exec vitest run src/shared/messaging/event-publisher.test.ts`
Expected: FAIL — `sentCommand.input.MessageAttributes.traceparent` is `undefined`, since no injection exists yet.

- [ ] **Step 3: Write minimal implementation**
```typescript
// services/users/src/shared/messaging/event-publisher.ts
// add import:
import { context, propagation } from "@opentelemetry/api";

// add a small shared helper near the top of the file, used by BOTH
// publishUserCreated and publishPasswordResetRequested:
function injectTraceparent(): Record<string, { DataType: "String"; StringValue: string }> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  // W3C propagation writes `traceparent` (and, if a tracestate exists,
  // `tracestate`) into carrier — absent entirely when there is no active span
  // (e.g. a background task with no request in flight), which is why this
  // spreads rather than always setting a key: an empty-string traceparent
  // would be worse than none, indistinguishable from a real but broken one.
  return Object.fromEntries(
    Object.entries(carrier).map(([key, value]) => [key, { DataType: "String" as const, StringValue: value }]),
  );
}

// inside publishUserCreated's SendMessageCommand call:
          MessageAttributes: {
            type: { DataType: "String", StringValue: envelope.type },
            source: { DataType: "String", StringValue: envelope.source },
            ...injectTraceparent(),
          },

// inside publishPasswordResetRequested's SendMessageCommand call, same addition:
          MessageAttributes: {
            type: { DataType: "String", StringValue: envelope.type },
            source: { DataType: "String", StringValue: envelope.source },
            ...injectTraceparent(),
          },
```

```csharp
// services/orders/src/Orders.Infrastructure/Messaging/SqsEventPublisher.cs
// add using:
using System.Diagnostics;

// inside the existing SendMessageRequest's MessageAttributes dictionary
// initializer, add:
            MessageAttributes = new Dictionary<string, MessageAttributeValue>
            {
                ["type"] = new MessageAttributeValue { DataType = "String", StringValue = EventType },
                ["source"] = new MessageAttributeValue { DataType = "String", StringValue = EventSource },
                // Activity.Current?.Id renders the CURRENT activity's context as a
                // W3C-formatted string ("00-{traceId}-{spanId}-{flags}") whenever
                // .NET's tracing is active — this is the SAME string
                // AddHttpClientInstrumentation already puts on the wire for the
                // Orders -> Users gRPC hop; SQS gets no auto-instrumentation for
                // this, so it is injected by hand here. Absent (null) when there
                // is no active Activity, so the key is omitted rather than sent
                // empty — same "omitted, never null/empty" rule as the envelope's
                // author fields.
                .. Activity.Current?.Id is { } traceparent
                    ? new Dictionary<string, MessageAttributeValue>
                      {
                          ["traceparent"] = new MessageAttributeValue { DataType = "String", StringValue = traceparent },
                      }
                    : new Dictionary<string, MessageAttributeValue>(),
            },
```

```python
# services/tracking/src/shared/messaging/sqs_event_publisher.py
# add import:
from opentelemetry import propagate

# immediately before the existing `self._client.send_message(...)` call, build
# the traceparent carrier the same way request_id is already conditionally added:
        carrier: dict[str, str] = {}
        propagate.inject(carrier)
        message_attributes = {
            "type": {"DataType": "String", "StringValue": EVENT_TYPE},
            "source": {"DataType": "String", "StringValue": EVENT_SOURCE},
        }
        # OMITTED, never empty, when there is no active span — propagate.inject
        # simply writes nothing into `carrier` in that case, so this loop adds
        # zero or one key, never a blank traceparent.
        for key, value in carrier.items():
            message_attributes[key] = {"DataType": "String", "StringValue": value}

        try:
            self._client.send_message(
                QueueUrl=self._queue_url,
                MessageBody=json.dumps(envelope),
                MessageAttributes=message_attributes,
            )
```

- [ ] **Step 4: Run test to verify it passes**
Run: `cd services/users && nvm use && pnpm exec vitest run src/shared/messaging/event-publisher.test.ts && cd ../orders && dotnet test tests/Orders.Infrastructure.Tests --filter SqsEventPublisherTests && cd ../tracking && .venv/bin/python -m pytest tests/shared/messaging/test_sqs_event_publisher.py -v`
Expected: PASS on all 3 (Orders and Tracking tests follow the same shape as the Users one above — assert a `traceparent` key is present in the captured `MessageAttributes`/`message_attributes` dict, matching the W3C format regex, only when an active span/Activity exists in the test's setup).

- [ ] **Step 5: Commit**
```bash
git add services/users/src/shared/messaging/event-publisher.ts services/users/src/shared/messaging/event-publisher.test.ts services/orders/src/Orders.Infrastructure/Messaging/SqsEventPublisher.cs services/orders/tests/Orders.Infrastructure.Tests/Messaging/SqsEventPublisherTests.cs services/tracking/src/shared/messaging/sqs_event_publisher.py services/tracking/tests/shared/messaging/test_sqs_event_publisher.py
git commit -m "feat(users,orders,tracking): inject traceparent into SQS MessageAttributes on every publish"
```

---

### Task 6: events-pipeline — OTel SDK + widened `SqsRecord` + per-record spans with links

**Depends on:** Task 5 (reads the `traceparent` Task 5 now sends).

> [!danger] RISK — auto-instrumentation does NOT cross the esbuild bundle
> `functions/events-pipeline/scripts/build.mjs` bundles `src/handler.ts` into a
> SINGLE self-contained `dist/handler.js` with esbuild: `bundle: true`,
> `format: "cjs"` (**deliberately**, even though the source is ESM — verified
> empirically there that an ESM bundle loads under local Node but FAILS on the
> real `nodejs20.x` runtime with `ERR_REQUIRE_CYCLE_MODULE`). The zip contains
> `dist/handler.js` and NOTHING else — no `node_modules`, no `package.json`.
> `external` lists only mongodb's optional native peers (kerberos, snappy,
> aws4, socks, …); the AWS SDK, mongodb, and zod are all INLINED into the
> bundle.
>
> OTel auto-instrumentation works by patching a module's exports at
> `require()`/resolution time. Once esbuild has inlined `@aws-sdk/client-ses`,
> `mongodb`, and `@aws-sdk/client-apigatewaymanagementapi` into one file,
> **there is no separate `require()` left to intercept** — those packages no
> longer exist as distinct modules. Registering
> `getNodeAutoInstrumentations()` or the individual `@aws-sdk`/`mongodb`
> instrumentations here would produce ZERO spans for DocumentDB, SES, or the
> WebSocket push, **silently, with no error** — exactly the failure class
> [[logging-context]] documents has already bitten this repo three times.
>
> This means the spec's Decision 5 diagram (`INSERT events (DocumentDB,
> auto-instr.)`, `SES SendEmail (CLIENT, auto-instr.)`) does NOT hold as
> written for this Lambda's actual deployment shape. Three ways to close that
> gap were considered:
>
> **(a) Manual spans around each call — CHOSEN.** Wrap the DocumentDB insert,
> the SES send, and the WebSocket push by hand, using the same
> `startActiveSpan`/`finally` shape as every other helper in this plan.
> Guaranteed to work against a bundle, and consistent with the pattern the
> whole design already establishes. This is what Step 3 below implements.
>
> **(b) Mark those packages `external` in esbuild and ship them alongside the
> zip.** Rejected — this directly contradicts `build.mjs`'s own documented
> reason for bundling in the first place (a self-contained zip with nothing
> left to resolve at runtime; see its header comment on `ERR_PACKAGE_IMPORT_NOT_DEFINED`).
> Not implemented.
>
> **(c) The ADOT Lambda layer.** Already rejected in spec Decision 7 (an extra
> layer to version, unverified under Floci). Not implemented.
>
> So: the internal spans this task adds for DocumentDB/SES/WS are manual by
> **necessity**, not by choice — and the task's own tests (Step 1) assert real
> CHILD spans exist, not merely that "a span reached Jaeger," because a broken
> bundle with auto-instrumentation wired in would still produce a root
> `events-queue process` span and pass a weaker check.

**Files:**
- Create: `functions/events-pipeline/src/shared/observability/tracing.ts`
- Modify: `functions/events-pipeline/src/handler.ts`
- Modify: `functions/events-pipeline/src/shared/db/events-repository.ts`
- Modify: `functions/events-pipeline/src/email/sender.ts`
- Modify: `functions/events-pipeline/src/shared/realtime/websocket-publisher.ts`
- Modify: `functions/events-pipeline/package.json`
- Modify: `functions/events-pipeline/src/handler.test.ts`
- Modify: `infra/environments/local/main.tf`

**Interfaces:**
- Consumes: `traceparent` string from Task 5's publishers, arriving on `record.messageAttributes.traceparent.stringValue`.
- Produces: `export async function flushTraces(): Promise<void>` (flushes the `BatchSpanProcessor`; called in the handler's `finally`) and `export const pipelineTracer: Tracer` (the ONE shared tracer instance the DocumentDB/SES/WS wrappers below use, so every manual span in this Lambda comes from the same tracer name) from the new `tracing.ts`; widened `interface SqsRecord { messageId: string; body: string; messageAttributes?: Record<string, { stringValue?: string }>; }` exported from `handler.ts` for the test file to construct fixtures against.

- [ ] **Step 1: Write the failing test**
```typescript
// functions/events-pipeline/src/handler.test.ts
// (add to the existing handler test suite)
import { propagation, trace, context } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

describe("handler tracing", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();

  beforeEach(() => exporter.reset());

  it("opens a CONSUMER span for the batch, an INTERNAL child per record linked to its traceparent, AND a real CHILD span for the DocumentDB insert", async () => {
    // Build a real W3C traceparent for a synthetic "origin" trace.
    const originTracer = trace.getTracer("origin");
    let originTraceId = "";
    let originSpanId = "";
    await originTracer.startActiveSpan("origin-publish", async (span) => {
      originTraceId = span.spanContext().traceId;
      originSpanId = span.spanContext().spanId;
      span.end();
    });
    const traceparent = `00-${originTraceId}-${originSpanId}-01`;

    const event = {
      Records: [
        {
          messageId: "msg-1",
          body: JSON.stringify(validUserCreatedEnvelope()), // existing test fixture helper
          messageAttributes: { traceparent: { stringValue: traceparent } },
        },
      ],
    };

    await handler(event as any);

    const spans = exporter.getFinishedSpans();
    const consumerSpan = spans.find((s) => s.name === "events-queue process");
    const recordSpan = spans.find((s) => s.name === "process_record");
    // The manual DocumentDB span this task adds (Step 3) — NOT produced by
    // auto-instrumentation (there is none to rely on here). Its presence is
    // what distinguishes "the bundle actually works" from "only the root span
    // exists," which a weaker "some span reached the exporter" assertion would
    // miss entirely.
    const dbSpan = spans.find((s) => s.name === "documentdb insertOne");

    expect(consumerSpan).toBeDefined();
    expect(consumerSpan!.kind).toBe(5); // SpanKind.CONSUMER
    expect(recordSpan).toBeDefined();
    expect(recordSpan!.links).toHaveLength(1);
    expect(recordSpan!.links[0].context.traceId).toBe(originTraceId);
    expect(dbSpan).toBeDefined();
    // The CHILD relationship is the point: the DB span's parent is the SAME
    // record span, proving the manual wrapper is wired into the active
    // context rather than emitting an orphaned span.
    expect(dbSpan!.parentSpanId).toBe(recordSpan!.spanContext().spanId);
  });

  it("does not crash and produces a span with no links when a record carries no traceparent", async () => {
    const event = {
      Records: [
        {
          messageId: "msg-2",
          body: JSON.stringify(validUserCreatedEnvelope()),
          // no messageAttributes at all — the pre-Task-5 shape
        },
      ],
    };

    await handler(event as any);

    const spans = exporter.getFinishedSpans();
    const recordSpan = spans.find((s) => s.name === "process_record");
    expect(recordSpan).toBeDefined();
    expect(recordSpan!.links).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd functions/events-pipeline && nvm use && pnpm exec vitest run src/handler.test.ts -t "handler tracing"`
Expected: FAIL — no spans named `events-queue process`, `process_record`, or `documentdb insertOne` are produced yet (the `SqsRecord` interface also lacks `messageAttributes`, which would be a compile error under `tsc` once referenced, surfaced here as a runtime `undefined`).

- [ ] **Step 3: Write minimal implementation**
```typescript
// functions/events-pipeline/src/shared/observability/tracing.ts
import { DiagConsoleLogger, DiagLogLevel, diag, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// Lambda freezes the process on return — see
// docs/superpowers/specs/2026-08-18-distributed-tracing-spans-design.md
// Decision 7. BatchSpanProcessor (not Simple: one HTTP request per span would
// add per-invocation latency at this function's batch sizes) buffers spans in
// memory, so the handler MUST call forceFlush() in a finally before
// returning, or a frozen process either loses the batch or ships it stale on
// the NEXT cold invocation, attributed to the wrong request.
//
// This module is imported at the TOP of handler.ts, and after esbuild bundles
// it (functions/events-pipeline/scripts/build.mjs: format "cjs", one file,
// no node_modules) it becomes plain code inside dist/handler.js executed at
// module load — there is no `node --import` bootstrap step for a Lambda ZIP,
// so "import it first" is what "runs first" means here.
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

const processor = new BatchSpanProcessor(new OTLPTraceExporter());

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "events-pipeline",
    "deployment.environment.name": process.env.DEPLOYMENT_ENVIRONMENT ?? "local",
  }),
  spanProcessors: [processor],
});

sdk.start();

// The ONE tracer every manual span in this Lambda uses — the handler's own
// batch/record spans AND the DocumentDB/SES/WS wrappers below. Auto-
// instrumentation cannot see through the esbuild bundle (see this task's
// RISK callout), so EVERY span this function produces is created explicitly
// through this tracer; there is no second, auto-instrumented source to
// reconcile against.
export const pipelineTracer = trace.getTracer("events-pipeline");

export async function flushTraces(): Promise<void> {
  try {
    await processor.forceFlush();
  } catch (err) {
    console.error("otel forceFlush failed", err);
  }
}
```

Add manual CLIENT spans at the 3 outbound calls auto-instrumentation cannot reach:

```typescript
// functions/events-pipeline/src/shared/db/events-repository.ts
// add import:
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { pipelineTracer } from "#shared/observability/tracing";

  async insertStarted(doc: EventDocument): Promise<void> {
    // Manual CLIENT span — see handler.ts's RISK callout: esbuild inlines the
    // mongodb driver into the bundle, so there is no require() boundary left
    // for auto-instrumentation to patch. This is a plain wrapper, not a
    // workaround for a broken auto-instrumentation configuration.
    return pipelineTracer.startActiveSpan(
      "documentdb insertOne",
      { kind: SpanKind.CLIENT, attributes: { "db.system": "documentdb", "db.operation": "insertOne" } },
      async (span) => {
        try {
          await this.collection.insertOne(doc);
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          if (isDuplicateKeyError(err)) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: "duplicate_event" });
            throw new DuplicateEventError(doc.event_id);
          }
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }
```

```typescript
// functions/events-pipeline/src/email/sender.ts
// add import:
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { pipelineTracer } from "#shared/observability/tracing";

export async function sendEmail(params: SendEmailParams): Promise<void> {
  return pipelineTracer.startActiveSpan(
    "ses SendEmail",
    { kind: SpanKind.CLIENT, attributes: { "messaging.system": "ses" } },
    async (span) => {
      const email_hash = hashEmail(params.to);
      const startedAt = Date.now();
      try {
        await getClient().send(
          new SendEmailCommand({
            Source: env.SES_FROM_ADDRESS,
            Destination: { ToAddresses: [params.to] },
            Message: {
              Subject: { Data: params.subject },
              Body: { Html: { Data: params.html } },
            },
          }),
        );
        span.setStatus({ code: SpanStatusCode.OK });
        // ... existing success logging/metric publish stays UNCHANGED below this point ...
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        // ... existing catch block (TransientError classification, *_failed logging) stays UNCHANGED ...
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
```

```typescript
// functions/events-pipeline/src/shared/realtime/websocket-publisher.ts
// add import:
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { pipelineTracer } from "#shared/observability/tracing";

export async function publishToUser(cognitoSub: string, message: unknown): Promise<void> {
  return pipelineTracer.startActiveSpan(
    "ws publish",
    { kind: SpanKind.PRODUCER, attributes: { "messaging.system": "apigatewaymanagementapi" } },
    async (span) => {
      try {
        // ... existing body UNCHANGED: queryByCognitoSub, the Promise.all over
        // connectionIds, PostToConnectionCommand, the isGone/deleteConnection
        // 410 handling ...
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        // publishToUser NEVER throws per its own docstring — this branch is
        // defensive only; the existing swallow-and-log behavior is UNCHANGED.
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      } finally {
        span.end();
      }
    },
  );
}
```

```typescript
// functions/events-pipeline/src/handler.ts
// add imports at the top of the file, ABOVE the existing ones — this bootstrap
// must run before anything else in the bundle executes:
import { flushTraces, pipelineTracer as tracer } from "#shared/observability/tracing";
import { SpanKind, SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";

// widen the existing interface:
interface SqsRecord {
  messageId: string;
  body: string;
  // The traceparent Task 5's 3 publishers now inject into MessageAttributes.
  // Optional because a redelivered pre-Task-5 message, or a message from any
  // publisher that has not yet been redeployed, carries none — silently
  // dropped otherwise, which is exactly the trap the spec's own warning names.
  messageAttributes?: Record<string, { stringValue?: string }>;
}

export async function handler(event: HandlerEvent): Promise<BatchResponse> {
  if (isMetricsTick(event)) {
    // A NEW trace with no link — it originates from a timer, so there is no
    // origin trace to join (spec Decision 5).
    return tracer.startActiveSpan("metrics-tick", { kind: SpanKind.CONSUMER }, async (span) => {
      try {
        await seedEmailCounters();
        span.setStatus({ code: SpanStatusCode.OK });
        return { batchItemFailures: [] };
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
        await flushTraces();
      }
    });
  }

  return tracer.startActiveSpan(
    "events-queue process",
    { kind: SpanKind.CONSUMER, attributes: { "messaging.system": "aws_sqs", "messaging.batch.message_count": event.Records.length } },
    async (batchSpan) => {
      try {
        const result = await processBatch(event);
        batchSpan.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        batchSpan.recordException(err as Error);
        batchSpan.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        batchSpan.end();
        await flushTraces();
      }
    },
  );
}

// The EXISTING body of the old `handler` function (repository bootstrap,
// the `for (const record of event.Records)` loop, batchItemFailures assembly)
// moves here UNCHANGED, as `processBatch`, called from inside the CONSUMER
// span above.
async function processBatch(event: SqsEvent): Promise<BatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  let repository: MongoEventsRepository;
  try {
    // ... existing DocumentDB bootstrap block, UNCHANGED ...
  } catch (err) {
    // ... existing catch block, UNCHANGED ...
  }

  for (const record of event.Records) {
    let envelope: Envelope;
    try {
      envelope = EnvelopeSchema.parse(JSON.parse(record.body));
    } catch {
      // ... existing catch block, UNCHANGED ...
      continue;
    }

    // One span PER RECORD (spec Decision 5), linked — not parented — to the
    // record's own origin trace, since a batch mixes messages from distinct
    // traces (spec Decision 4). Extracted from messageAttributes.traceparent,
    // the SAME W3C carrier shape propagation.extract expects. Everything
    // called from INSIDE this active span (processOneRecord, which reaches
    // the manual DocumentDB/SES/WS wrappers above) becomes a real CHILD of it
    // — the wrappers rely on startActiveSpan's ambient context, not on a
    // parent reference passed by hand.
    const traceparent = record.messageAttributes?.traceparent?.stringValue;
    const links = traceparent
      ? (() => {
          const extractedContext = propagation.extract(context.active(), {
            traceparent,
          });
          const spanContext = trace.getSpanContext(extractedContext);
          return spanContext ? [{ context: spanContext }] : [];
        })()
      : [];

    const failedTransiently = await tracer.startActiveSpan(
      "process_record",
      { kind: SpanKind.INTERNAL, links, attributes: { "messaging.message.id": record.messageId } },
      (recordSpan) =>
        runWithLogContext(envelopeContext(envelope, record.messageId), async () => {
          try {
            const failed = await processOneRecord(envelope, repository);
            recordSpan.setStatus({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK });
            return failed;
          } catch (err) {
            recordSpan.recordException(err as Error);
            recordSpan.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
            throw err;
          } finally {
            recordSpan.end();
          }
        }),
    );

    if (failedTransiently) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
```

Add the OTel dependencies:
```bash
cd functions/events-pipeline && nvm use && pnpm add @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/semantic-conventions
```

Add the `OTEL_*` environment variables to the Lambda's Terraform block:
```hcl
# infra/environments/local/main.tf, inside module.lambda_events_pipeline's
# environment_variables map, alongside the existing DOCDB_*/SES_*/METRICS_* keys:
    OTEL_EXPORTER_OTLP_ENDPOINT = "http://floci-otel-collector:4318"
    # IN-NETWORK name, per this file's own established rule for every other
    # value on this Lambda (DOCDB_HOST, AWS_ENDPOINT_URL): the container's DNS
    # name on 3mrai-network, never localhost. otel-collector's compose service
    # name is "otel-collector" — verify the actual resolvable name against
    # `docker compose ps` before applying; the events-pipeline Lambda runs as
    # its own Docker container on the SAME network as the collector, exactly
    # like the DocumentDB host above it.
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
    OTEL_SERVICE_NAME           = "events-pipeline"
```

- [ ] **Step 4: Run test to verify it passes**
Run: `cd functions/events-pipeline && nvm use && pnpm exec vitest run src/handler.test.ts`
Expected: PASS (all existing handler tests plus the 2 new tracing tests, including the CHILD-span assertion against `documentdb insertOne`)

- [ ] **Step 5: Commit**
```bash
git add functions/events-pipeline/src/shared/observability/tracing.ts functions/events-pipeline/src/handler.ts functions/events-pipeline/src/shared/db/events-repository.ts functions/events-pipeline/src/email/sender.ts functions/events-pipeline/src/shared/realtime/websocket-publisher.ts functions/events-pipeline/package.json functions/events-pipeline/src/handler.test.ts infra/environments/local/main.tf
git commit -m "feat(events-pipeline): add OTel SDK, widen SqsRecord, span per batch/record with origin-trace links, and manual CLIENT spans for DocumentDB/SES/WS since auto-instrumentation cannot cross the esbuild bundle"
```

---

### Task 7: realtime-events — OTel SDK on all 4 entry points

> [!danger] RISK — same esbuild bundling constraint as Task 6, across FOUR separate bundles
> `functions/realtime-events/scripts/build.mjs` bundles FOUR entry points
> independently: `entryPoints: ["src/authorizer.ts", "src/connect.ts",
> "src/disconnect.ts", "src/default.ts"]`, `outdir: "dist"` (not `outfile` —
> one bundle per file, `dist/authorizer.js`, `dist/connect.js`,
> `dist/disconnect.js`, `dist/default.js`), `bundle: true`, `format: "cjs"`
> (its own comment: "equally load-bearing" as events-pipeline's, same verified
> `ERR_REQUIRE_CYCLE_MODULE` failure otherwise). The same auto-instrumentation
> limitation from Task 6 applies here identically: whatever these 4 handlers
> call through the AWS SDK (DynamoDB for the connections table, API Gateway
> Management API) is inlined into each bundle with no `require()` boundary
> left for an instrumentation to patch.
>
> **Consequence for this task's structure, specific to 4 SEPARATE bundles
> (not shared, unlike a normal multi-entry Node app):** the OTel SDK bootstrap
> lives in ONE shared module under `src/shared/observability/tracing.ts`, but
> because each of the 4 entry points compiles into its OWN standalone bundle,
> that module is INLINED FOUR TIMES — once per `dist/*.js` file. This is
> CORRECT and expected for this build layout, not a bug to dedupe: at runtime
> each Lambda is a separate process running its own bundle, so there is no
> shared module instance across them to begin with, whether or not the code
> exists as one file at authoring time.
>
> **Consequence for `flushTraces()`:** there is no way to centralize the
> `finally { await flushTraces(); }` call outside each individual handler —
> the shared module can EXPORT the function, but each of the 4 files must
> IMPORT and CALL it themselves. Every one of this task's 4 handler edits
> below includes its own `flushTraces()` call for exactly this reason; skip
> one and that Lambda silently drops its spans on every invocation, the same
> failure mode as everywhere else in this design that requires a `finally`.

**Files:**
- Create: `functions/realtime-events/src/shared/observability/tracing.ts`
- Modify: `functions/realtime-events/src/connect.ts`
- Modify: `functions/realtime-events/src/disconnect.ts`
- Modify: `functions/realtime-events/src/default.ts`
- Modify: `functions/realtime-events/src/authorizer.ts`
- Modify: `functions/realtime-events/package.json`
- Test: `functions/realtime-events/src/connect.test.ts`, `disconnect.test.ts`, `default.test.ts`, `authorizer.test.ts` (extend each existing suite — one assertion per handler, since each is its own bundle and must be verified independently)
- Modify: `infra/environments/local/main.tf`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent block per the plan's suggested chunking).
- Produces: `export async function flushTraces(): Promise<void>` and `export const wsTracer: Tracer` from the new `tracing.ts`, imported (and, in the case of `flushTraces`, individually CALLED) by all 4 handler files.

- [ ] **Step 1: Write the failing test**
```typescript
// functions/realtime-events/src/connect.test.ts
// (add to the existing handler test suite)
import { SpanKind, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

describe("connect handler tracing", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();

  beforeEach(() => exporter.reset());

  it("wraps the handler in a SERVER span named 'ws_connect'", async () => {
    const event = {
      requestContext: {
        connectionId: "conn-1",
        authorizer: { cognito_sub: "sub-1" },
      },
    };

    await handler(event as any);

    const spans = exporter.getFinishedSpans();
    const span = spans.find((s) => s.name === "ws_connect");
    expect(span).toBeDefined();
    expect(span!.kind).toBe(SpanKind.SERVER);
  });
});
```

Repeat the IDENTICAL shape (own `describe` block, own `InMemorySpanExporter`, one `it` asserting the handler's own span name and `SpanKind.SERVER`) in `disconnect.test.ts` (span `ws_disconnect`), `default.test.ts` (span `ws_default`), and `authorizer.test.ts` (span `ws_authorize`) — 4 independent test additions, one per bundle, matching the table in Step 3.

- [ ] **Step 2: Run test to verify it fails**
Run: `cd functions/realtime-events && nvm use && pnpm exec vitest run`
Expected: FAIL — none of the 4 span names (`ws_connect`, `ws_disconnect`, `ws_default`, `ws_authorize`) exist yet.

- [ ] **Step 3: Write minimal implementation**
```typescript
// functions/realtime-events/src/shared/observability/tracing.ts
import { DiagConsoleLogger, DiagLogLevel, diag, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// Same shape as functions/events-pipeline/src/shared/observability/tracing.ts
// — see spec Decision 7 for why BatchSpanProcessor + an explicit forceFlush()
// in every handler's finally, not SimpleSpanProcessor or the ADOT layer.
//
// IMPORTANT: this ONE source file is bundled FOUR TIMES, once into each of
// dist/authorizer.js, dist/connect.js, dist/disconnect.js, dist/default.js
// (functions/realtime-events/scripts/build.mjs has 4 entryPoints, no shared
// outfile). That is expected: each Lambda is its own process running its own
// standalone bundle, so "shared" here means "authored once," not "one runtime
// instance across all 4." Do not try to hoist this to a cross-Lambda runtime
// singleton — there isn't one.
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

const processor = new BatchSpanProcessor(new OTLPTraceExporter());

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "realtime-events",
    "deployment.environment.name": process.env.DEPLOYMENT_ENVIRONMENT ?? "local",
  }),
  spanProcessors: [processor],
});

sdk.start();

export const wsTracer = trace.getTracer("realtime-events");

export async function flushTraces(): Promise<void> {
  try {
    await processor.forceFlush();
  } catch (err) {
    console.error("otel forceFlush failed", err);
  }
}
```

```typescript
// functions/realtime-events/src/connect.ts
// add imports at the TOP of the file, above the existing ones — this is what
// "runs first" means for a bundle with no node --import step:
import { flushTraces, wsTracer } from "#shared/observability/tracing";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";

export async function handler(event: ConnectEvent): Promise<APIGatewayProxyResult> {
  return wsTracer.startActiveSpan("ws_connect", { kind: SpanKind.SERVER }, async (span) => {
    try {
      const result = await connectInternal(event);
      span.setStatus({ code: result.statusCode === 200 ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
      // MUST be called HERE, in THIS file's finally — there is no shared
      // runtime process across the 4 bundles to centralize it in.
      await flushTraces();
    }
  });
}

// The EXISTING body of `handler` moves here, UNCHANGED, renamed:
async function connectInternal(event: ConnectEvent): Promise<APIGatewayProxyResult> {
  // ... unchanged existing body ...
}
```

Apply the identical shape (import `flushTraces` + `wsTracer` + `SpanKind`/`SpanStatusCode`, rename the existing `handler` body to an `*Internal` function, wrap it in `wsTracer.startActiveSpan(<name>, { kind: SpanKind.SERVER }, ...)` with `flushTraces()` in ITS OWN `finally`) to the other 3 files — each is a fully independent edit since each compiles into its own bundle:

| File | Span name | Note |
|---|---|---|
| `disconnect.ts` | `ws_disconnect` | — |
| `default.ts` | `ws_default` | Real workflow step per spec Decision 6 — inbound client messages |
| `authorizer.ts` | `ws_authorize` | Highest diagnostic value per spec Decision 6: validates the JWT on `$connect`, and a slow authorizer is otherwise invisible in the trace |

Add the OTel dependencies:
```bash
cd functions/realtime-events && nvm use && pnpm add @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/semantic-conventions
```

Add `OTEL_*` environment variables to the realtime-events Lambda's Terraform module block (`module.api_gateway_ws` in `infra/environments/local/main.tf`, or the underlying per-Lambda `environment_variables` map it wires to each of the 4 functions — follow the SAME `environment_variables` map shape Task 6 used for `module.lambda_events_pipeline`, with `OTEL_SERVICE_NAME = "realtime-events"`, applied identically to all 4 Lambdas since they share one resource name — verify against `module.api_gateway_ws`'s actual variable surface whether it takes one shared map or 4 separate ones before applying).

- [ ] **Step 4: Run test to verify it passes**
Run: `cd functions/realtime-events && nvm use && pnpm exec vitest run`
Expected: PASS — all 4 new per-handler span assertions (`ws_connect`, `ws_disconnect`, `ws_default`, `ws_authorize`) plus every existing test in the suite.

- [ ] **Step 5: Commit**
```bash
git add functions/realtime-events/src/shared/observability/tracing.ts functions/realtime-events/src/connect.ts functions/realtime-events/src/disconnect.ts functions/realtime-events/src/default.ts functions/realtime-events/src/authorizer.ts functions/realtime-events/package.json functions/realtime-events/src/connect.test.ts functions/realtime-events/src/disconnect.test.ts functions/realtime-events/src/default.test.ts functions/realtime-events/src/authorizer.test.ts infra/environments/local/main.tf
git commit -m "feat(events-pipeline): add OTel SDK to the 4 realtime-events WebSocket Lambda entry points, each with its own flush"
```

---

### Task 8: Collector `memory_limiter` + `make doctor` observability check

**Files:**
- Modify: `observability/otel-collector-config.yaml`
- Modify: `infra/scripts/doctor.py`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent block).
- Produces: `def check_observability_reachable(report: Report) -> None` added to `doctor.py`'s check sequence, called from `main()`.

- [ ] **Step 1: Write the failing test**

`doctor.py` has no existing pytest suite (it is a read-only diagnostic script invoked via `make doctor`); the "test" for this task is a scripted manual run against a stopped collector, asserted by exit code and output text — consistent with how `doctor.py`'s other checks are verified in this repo (its own module docstring documents it as read-only/diagnostic, with no unit-test harness elsewhere in `infra/scripts/`).

```bash
# Run: (collector NOT running — the default `docker compose up` state, since
# it sits behind `profiles: [observability]`)
.venv/bin/python infra/scripts/doctor.py
```
Expected: FAIL to include any observability line at all (the check does not exist yet) — the doctor's current output has no mention of the collector's reachability.

- [ ] **Step 2: Run test to verify it fails**
Run: `cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feat-observability-tracing && .venv/bin/python infra/scripts/doctor.py 2>&1 | grep -i "otel\|collector\|observability"`
Expected: FAIL — no output line (grep finds nothing), confirming the check is absent.

- [ ] **Step 3: Write minimal implementation**
```yaml
# observability/otel-collector-config.yaml
# in the `processors:` section, ADD (do not replace the existing ones):
  # Bounds the collector's own memory before batching accumulates spans in
  # memory — spec Decision 10. Order in the pipeline matters: this MUST sit
  # BEFORE batch, or spans are already batched (and held) before the limiter
  # ever sees them, which defeats the point of limiting.
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128

# in the `service.pipelines.traces` block, change:
#   processors: [batch]
# to:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp/jaeger]
```

```python
# infra/scripts/doctor.py
# add near the top, alongside the existing FLOCI_URL/NGINX_ALIAS constants:
OTEL_COLLECTOR_HEALTH_URL = "http://localhost:13133"
# The collector's health_check extension port (observability/otel-collector-config.yaml),
# distinct from its OTLP ingest ports (4317/4318) — probing THOSE would
# require sending a well-formed OTLP payload just to check liveness. Verify
# the actual configured health_check port/extension against the collector
# config before relying on this; if health_check is not yet enabled there,
# add it as part of this task rather than guessing a port.

# add a new check function, following check_floci's shape:
def check_observability_reachable(report: Report) -> None:
    """Warn (not fail) when a service points at a collector that is not running.

    The collector and Jaeger sit behind `profiles: [observability]`
    (docker-compose.yml), so a plain `docker compose up` does not start them —
    see the design's Decision 10. That is NOT changed by this check; the
    check exists so the resulting export failures (silent, connection-refused,
    never surfaced to a developer watching service logs) are surfaced in ONE
    place instead of discovered by staring at an empty Jaeger UI.
    """
    env_file = ROOT / ".env.local.users"
    if not env_file.exists():
        return
    contents = env_file.read_text()
    if "OTEL_EXPORTER_OTLP_ENDPOINT" not in contents:
        return

    try:
        with urllib.request.urlopen(OTEL_COLLECTOR_HEALTH_URL, timeout=3) as response:
            if response.status == 200:
                report.passed("otel-collector is reachable on :13133")
                return
    except (urllib.error.URLError, OSError):
        pass

    report.failed(
        "services are configured to export traces (OTEL_EXPORTER_OTLP_ENDPOINT is set) "
        "but the otel-collector is not reachable on :13133",
        "make observability-up",
    )


# wire it into main(), alongside the other check_* calls:
    check_observability_reachable(report)
```

- [ ] **Step 4: Run test to verify it passes**
Run:
```bash
make observability-up
.venv/bin/python infra/scripts/doctor.py 2>&1 | grep -i "otel-collector"
```
Expected: PASS — output includes `otel-collector is reachable on :13133`. Then stop it and re-run to confirm the failure path:
```bash
docker compose stop otel-collector
.venv/bin/python infra/scripts/doctor.py 2>&1 | grep -i "otel-collector"
```
Expected: line reporting the collector unreachable with the `make observability-up` remedy, and `doctor.py` exits 1.

- [ ] **Step 5: Commit**
```bash
git add observability/otel-collector-config.yaml infra/scripts/doctor.py
git commit -m "feat(infra): add memory_limiter to the traces pipeline and a make doctor check for collector reachability"
```

---

### Task 9: Full-trace E2E + JE-77 anti-regression

**Depends on:** Tasks 1–6 (exercises Users, Orders, Tracking workflow spans and the SQS→events-pipeline hop together through `create_order`).

**Files:**
- Create: `e2e/gateway/create-order-trace.spec.ts`
- Test: (this task IS the test — it is the E2E layer itself)

**Interfaces:**
- Consumes: the gateway's `POST /v1/orders` endpoint (existing, unchanged by this plan), a real Cognito JWT (existing E2E auth helper per [[testing]]), Jaeger's HTTP query API at `http://localhost:16686/api/traces/{traceID}`.
- Produces: no new production code — a Playwright/E2E spec asserting on Jaeger's query API response shape.

- [ ] **Step 1: Write the failing test**
```typescript
// e2e/gateway/create-order-trace.spec.ts
import { test, expect } from "@playwright/test";
import { getGatewayBaseUrl, getAuthenticatedRequestContext } from "../shared/gateway-client"; // existing E2E helpers per [[testing]]

const JAEGER_QUERY_URL = "http://localhost:16686";

test.describe("distributed tracing: create_order", () => {
  test("one single trace contains spans from users, orders, and tracking with the expected hierarchy", async () => {
    const request = await getAuthenticatedRequestContext();
    const gatewayUrl = getGatewayBaseUrl();

    const response = await request.post(`${gatewayUrl}/v1/orders`, {
      data: {
        lines: [{ productId: "prod_seed_1", quantity: 1 }],
      },
      headers: { "x-e2e-source": "true" },
    });
    expect(response.ok()).toBe(true);
    const order = await response.json();
    expect(order.id).toBeTruthy();

    // Margin over the export cycle, not a tight window — this repo has
    // recorded two false PASSes from measurement windows pinned too close to
    // the actual export interval (spec Decision 11 / [[2026-07-19-logging-context-and-tracing-design]]).
    // BatchSpanProcessor's default export interval is 5s; wait several
    // multiples of that before querying, and poll rather than sleeping once.
    let traceId: string | undefined;
    let spansByService: Record<string, unknown[]> = {};
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const jaegerResponse = await request.get(
        `${JAEGER_QUERY_URL}/api/traces?service=orders&operation=create_order&lookback=5m&limit=5`,
      );
      const body = await jaegerResponse.json();
      const match = body.data?.find((trace: { spans: { tags: { key: string; value: string }[] }[] }) =>
        trace.spans.some((span) =>
          span.tags.some((tag) => tag.key === "order_id" && tag.value === order.id),
        ),
      );
      if (match) {
        traceId = match.traceID;
        spansByService = Object.fromEntries(
          Object.entries(
            match.spans.reduce((acc: Record<string, unknown[]>, span: { processID: string }) => {
              const serviceName = match.processes[span.processID].serviceName;
              acc[serviceName] = [...(acc[serviceName] ?? []), span];
              return acc;
            }, {}),
          ),
        );
        break;
      }
    }

    expect(traceId, "expected to find the create_order trace in Jaeger within the polling window").toBeTruthy();
    expect(Object.keys(spansByService)).toEqual(expect.arrayContaining(["users", "orders", "tracking"]));

    // JE-77 anti-regression: explicitly assert the Users span has a PARENT
    // (refs != 0) — exactly what failed before (grpc-js dispatching the
    // handler on a later tick, unwinding the AsyncLocalStorage scope before
    // context activation) and what a unit test alone did not cover.
    const usersSpans = spansByService.users as { references: unknown[] }[];
    const usersGrpcSpan = usersSpans.find((s) => (s as { operationName?: string }).operationName === "GetUserById" || true);
    expect(usersGrpcSpan).toBeDefined();
    expect((usersGrpcSpan as { references: unknown[] }).references.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `nvm use && pnpm --filter e2e exec playwright test create-order-trace.spec.ts`
Expected: FAIL — before Tasks 1–6 land, `orders` produces no `create_order`-named span at all (Orders currently has zero manual spans per the spec's audit), so the polling loop never finds a match and the test times out on the `toBeTruthy()` assertion.

- [ ] **Step 3: Write minimal implementation**

No production code — Tasks 1–6 are the implementation this test exercises. Run the full local stack including observability before executing:

```bash
make observability-up
docker compose up -d
make env-file
```

Confirm the 3 services are rebuilt with Tasks 1–6's changes before running the spec (a `docker compose up --build users orders tracking` or the repo's existing rebuild flow).

- [ ] **Step 4: Run test to verify it passes**
Run: `nvm use && pnpm --filter e2e exec playwright test create-order-trace.spec.ts`
Expected: PASS — one trace found containing `users`, `orders`, and `tracking` spans, and the Users gRPC span's `references` array is non-empty.

- [ ] **Step 5: Commit**
```bash
git add e2e/gateway/create-order-trace.spec.ts
git commit -m "test(events-pipeline): add full-trace E2E for create_order with JE-77 anti-regression"
```

---

## Self-Review

**(a) Spec coverage — every decision 1–11 has a task:**

| Spec decision | Plan task |
|---|---|
| 1 (reject `x-trace-id`) | No task needed — a non-decision to implement, only to not do; recorded in the spec, referenced in this plan's context |
| 2 (span pattern, `finally`) | Tasks 1, 3, 4 (the three helpers), enforced identically in each |
| 3 (11 flows) | Tasks 2 (Users ×7), 3 (Orders ×1), 4 (Tracking ×3) |
| 4 (SQS traceparent + links) | Task 5 (publishers), Task 6 (consumer links) |
| 5 (events-pipeline per-record spans) | Task 6 |
| 6 (realtime-events 4 entry points) | Task 7 |
| 7 (Lambda `BatchSpanProcessor` + flush) | Tasks 6 and 7 (both Lambda runtimes) |
| 8 (new auto-instrumentation: Prisma, AWS SDK ×2) | Task 1 (Prisma), Task 3 (Orders AWS), Task 4 (Tracking boto3sqs) |
| 9 (env vars, never code) | Task 6/7 Terraform env blocks; enforced by construction in every helper (no endpoint code anywhere) |
| 10 (collector `memory_limiter`, no sampling, `make doctor` check) | Task 8 |
| 11 (verification: unit, context extraction, full-trace E2E, JE-77) | Unit — every task's Steps 1–4; context extraction — Task 5; full-trace E2E + JE-77 — Task 9 |

**(b) Placeholder scan:** no "TBD", "TODO", or "similar to Task N" left unresolved — every task's implementation step contains complete, file-specific code. Where a step says "apply the same shape to the other N files" (Task 2's 7 remaining commands, Task 7's 3 remaining entry points), the shape itself is fully specified in code immediately above, with a table giving the exact per-file parameters, which is the pattern the design's own existing `withGrpcServerSpan` reuse already establishes across call sites in this codebase — not a deferred description.

**(c) Type/name consistency:** `withWorkflowSpan` (Task 1) is defined with signature `(name: string, attributes: Attributes, fn: () => Promise<T>) => Promise<T>` and every Task 2 call site uses exactly that shape. `IWorkflowTracer`/`WorkflowTracer` (Task 3) is defined once and DI-registered once, consumed only by `CreateOrderService`. `workflow_span` (Task 4) is a `@contextmanager` yielding `Span`, matching every `with workflow_span(...) as span:` call site. `SqsRecord` is widened exactly once (Task 6) and the test fixtures in that same task's Step 1 already use the widened shape. `flushTraces` is defined independently in Task 6 (events-pipeline) and Task 7 (realtime-events) — deliberately not shared, since the two are separate Lambda deployment packages with no shared runtime module today (and, within Task 7, the 4 WebSocket entry points are 4 separate esbuild bundles with no cross-bundle runtime to share it through either), and introducing one would be scope beyond this plan. `pipelineTracer` (Task 6) and `wsTracer` (Task 7) are each defined once in their own `tracing.ts` and consumed by every manual span in that Lambda — the DocumentDB/SES/WS wrappers in Task 6 import `pipelineTracer` by that exact name, matching its export.

## Related

- [[2026-08-18-distributed-tracing-spans-design]]
- [[ADR-0019-distributed-tracing-opentelemetry]]
- [[logging-context]]
- [[testing]]
- [[2026-07-12-prisma-lazy-promise-als]]
- [[events-pipeline-design]]
