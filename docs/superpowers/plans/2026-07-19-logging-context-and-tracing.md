---
title: Logging Context and Tracing Plan
type: plan
area: shared
status: draft
created: 2026-07-19
updated: 2026-07-19
tags:
  - type/plan
  - area/shared
  - status/draft
related:
  - "[[2026-07-19-logging-context-and-tracing-design]]"
  - "[[2026-07-16-structured-logging-and-dashboards-design]]"
  - "[[ADR-0018-observability-openobserve]]"
  - "[[2026-07-12-prisma-lazy-promise-als]]"
  - "[[testing]]"
---

# Logging Context and Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach a shared cross-service log context to every log line, add flow-level logs to the three flows that carry diagnostic value, and add real distributed tracing across the gRPC boundary.

**Architecture:** Three layers, in order. The context layer defines the shared field set once and both services adopt it together (Users via an AsyncLocalStorage sibling to the existing `actor-context.ts`, Orders via a Serilog `ILogEventEnricher` reading the existing `ICurrentCaller`). The flow-log layer adds explicit start/success/failure logs. The tracing layer installs the OpenTelemetry SDK in both services, adds a traces pipeline to the collector that already exists, and records the decision in a new ADR. No function signature changes in either service.

**Tech Stack:** Pino + AsyncLocalStorage (Users, TypeScript), Serilog enrichers (Orders, .NET), OpenTelemetry SDK (both), OpenTelemetry Collector, OpenObserve.

## Global Constraints

- **Never log** passwords, tokens, or full request bodies.
- Plaintext `email` appears **only** in login and register logs. Everywhere else uses `email_hash`.
- `email_hash` must be computed identically in both services or cross-service filtering silently fails to correlate: **SHA-256 of the email lowercased and trimmed, hex-encoded, truncated to the first 16 characters.**
- `duration_ms` (milliseconds), never `duration_s` — it is what both services already emit and is the OTel HTTP-semantic-convention unit.
- The shared context field names are identical in both services: `trace_id`, `span_id`, `cognito_sub`, `user_id`, `email_hash`, `email`, `order_id`, `duration_ms`. `tracking_id` and `type` are reserved and emitted by nothing.
- Context fields are **omitted when unknown** — never emitted as `null` or `""`.
- **Prisma lazy-promise pitfall:** any `await` must happen INSIDE an `AsyncLocalStorage.run` callback, never by passing a function that returns an un-started `PrismaPromise`. See `runAsActor` in `shared/audit/actor-context.ts` for the correct shape and [[2026-07-12-prisma-lazy-promise-als]].
- **Users hook-ordering invariant:** the `onRequest` hooks and the `fastifyAwilixPlugin` registration MUST stay declared above the `app.after()` block in `routes.ts`. Routes registered inside that callback inherit only hooks already registered on the root context; moving either below silently drops the context from every route.
- Existing E2E must keep passing. Baseline: **35 passed**.

---

## Layer 1 — Context

### Task 1: Shared context field contract + `email_hash` helper (Users)

**Files:**
- Create: `services/users/src/shared/logging/log-context.ts`
- Create: `services/users/src/shared/logging/email-hash.ts`
- Test: `services/users/src/shared/logging/email-hash.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `hashEmail(email: string): string` — SHA-256 of the lowercased, trimmed email, hex, first 16 chars. Orders must mirror this exactly in Task 3.
  - `LogContextStore` interface with optional `cognito_sub`, `user_id`, `email_hash`, `email`, `order_id`.
  - `logContext: AsyncLocalStorage<LogContextStore>`
  - `getLogContext(): LogContextStore` — always returns an object, `{}` when no store.
  - `setLogContext(fields: Partial<LogContextStore>): void` — merges into the ACTIVE store, for enrichment mid-request (e.g. once identity resolves). No-op when no store is active.
  - `runWithLogContext<T>(fields: LogContextStore, fn: () => Promise<T>): Promise<T>`

- [ ] **Step 1: Write the failing test for the hash helper**

`services/users/src/shared/logging/email-hash.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { hashEmail } from "./email-hash.js";

describe("hashEmail", () => {
  it("is stable for the same email", () => {
    expect(hashEmail("user@example.com")).toBe(hashEmail("user@example.com"));
  });

  it("normalizes case and surrounding whitespace", () => {
    const canonical = hashEmail("user@example.com");
    expect(hashEmail("USER@example.com")).toBe(canonical);
    expect(hashEmail("  user@example.com  ")).toBe(canonical);
  });

  it("differs for different emails", () => {
    expect(hashEmail("a@example.com")).not.toBe(hashEmail("b@example.com"));
  });

  it("is 16 hex characters", () => {
    expect(hashEmail("user@example.com")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not contain the original email", () => {
    expect(hashEmail("user@example.com")).not.toContain("user");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `nvm use && pnpm --filter @3mrai/users test email-hash`
Expected: FAIL — cannot resolve `./email-hash.js`.

- [ ] **Step 3: Implement the hash helper**

`services/users/src/shared/logging/email-hash.ts`:

```typescript
import { createHash } from "node:crypto";

// Truncated to 16 hex chars: enough to make collisions irrelevant at our scale
// while keeping log lines readable. Orders computes this IDENTICALLY (see
// Orders.Api/Logging/EmailHash.cs) — the two must agree exactly or filtering a
// user across services silently returns nothing.
const HASH_LENGTH = 16;

/** Stable, non-reversible id for an email. Safe to log anywhere. */
export function hashEmail(email: string): string {
  return createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, HASH_LENGTH);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `nvm use && pnpm --filter @3mrai/users test email-hash`
Expected: PASS, 5 tests.

- [ ] **Step 5: Implement the context store**

`services/users/src/shared/logging/log-context.ts`:

```typescript
import { AsyncLocalStorage } from "node:async_hooks";

// Per-request log context, merged into EVERY log line by the `formatters.log`
// hook in `logger.ts`. A sibling to `shared/audit/actor-context.ts`, which uses
// the same mechanism for the audit actor — see that file for why AsyncLocalStorage
// (the Pino logger, like the Prisma client, is process-wide and cannot read a
// per-request Awilix scope).
//
// Fields are OPTIONAL and omitted when unknown: a `user_id` of null in the log
// stream is worse than no key at all, because it looks like a resolved value.
export interface LogContextStore {
  cognito_sub?: string;
  user_id?: string;
  email_hash?: string;
  /** Plaintext email. ONLY set on login/register, where no user_id exists yet. */
  email?: string;
  order_id?: string;
}

export const logContext = new AsyncLocalStorage<LogContextStore>();

/** The active context, or an empty object outside a request. */
export function getLogContext(): LogContextStore {
  return logContext.getStore() ?? {};
}

/**
 * Merge fields into the ACTIVE store, for enrichment part-way through a request
 * (e.g. once identity resolution produces a user_id). No-op outside a request.
 * Mutates in place so already-captured references see the update.
 */
export function setLogContext(fields: Partial<LogContextStore>): void {
  const store = logContext.getStore();
  if (store) Object.assign(store, fields);
}

/**
 * Run `fn` with `fields` as the log context for its whole async call chain.
 *
 * NOTE the `async () => await fn()` shape — NOT `logContext.run(fields, fn)`.
 * Passing `fn` directly lets a callback that returns a lazy PrismaPromise exit
 * the store before the query starts, so the context is lost at the await site.
 * Same hazard `runAsActor` documents in shared/audit/actor-context.ts.
 */
export function runWithLogContext<T>(
  fields: LogContextStore,
  fn: () => Promise<T>,
): Promise<T> {
  return logContext.run(fields, async () => await fn());
}
```

- [ ] **Step 6: Commit**

```bash
git add services/users/src/shared/logging/
git commit -m "feat(users): add shared log-context store and email-hash helper"
```

---

### Task 2: Merge the context into every Users log line

**Files:**
- Modify: `services/users/src/shared/logging/logger.ts` (the `formatters.log` function)
- Modify: `services/users/src/features/users/http/routes.ts` (the `onRequest` hook)
- Test: `services/users/src/shared/logging/log-context.test.ts`

**Interfaces:**
- Consumes: `getLogContext`, `runWithLogContext`, `hashEmail` (Task 1).
- Produces: every Pino log line carries the active context fields.

- [ ] **Step 1: Write the failing test**

`services/users/src/shared/logging/log-context.test.ts`:

```typescript
import pino from "pino";
import { describe, expect, it } from "vitest";
import { buildLoggerOptions } from "./logger.js";
import { runWithLogContext, setLogContext } from "./log-context.js";

function captureLine(fn: () => void): Record<string, unknown> {
  const lines: string[] = [];
  const logger = pino(
    buildLoggerOptions({ serviceName: "users", environment: "test" }),
    { write: (line: string) => lines.push(line) },
  );
  (globalThis as { __testLogger?: unknown }).__testLogger = logger;
  fn.call({ logger });
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe("log context enrichment", () => {
  it("adds context fields to a log line inside a context", async () => {
    const lines: string[] = [];
    const logger = pino(
      buildLoggerOptions({ serviceName: "users", environment: "test" }),
      { write: (line: string) => lines.push(line) },
    );

    await runWithLogContext({ cognito_sub: "sub-1", user_id: "usr_1" }, async () => {
      logger.info("in context");
    });

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.cognito_sub).toBe("sub-1");
    expect(parsed.user_id).toBe("usr_1");
    expect(parsed.message).toBe("in context");
  });

  it("omits unknown fields rather than emitting null", async () => {
    const lines: string[] = [];
    const logger = pino(
      buildLoggerOptions({ serviceName: "users", environment: "test" }),
      { write: (line: string) => lines.push(line) },
    );

    await runWithLogContext({ cognito_sub: "sub-1" }, async () => {
      logger.info("partial");
    });

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.cognito_sub).toBe("sub-1");
    expect("user_id" in parsed).toBe(false);
    expect("email" in parsed).toBe(false);
  });

  it("picks up fields added mid-request via setLogContext", async () => {
    const lines: string[] = [];
    const logger = pino(
      buildLoggerOptions({ serviceName: "users", environment: "test" }),
      { write: (line: string) => lines.push(line) },
    );

    await runWithLogContext({ cognito_sub: "sub-1" }, async () => {
      setLogContext({ user_id: "usr_late" });
      logger.info("after enrichment");
    });

    expect(JSON.parse(lines[0]!).user_id).toBe("usr_late");
  });

  it("emits no context fields outside a request", () => {
    const lines: string[] = [];
    const logger = pino(
      buildLoggerOptions({ serviceName: "users", environment: "test" }),
      { write: (line: string) => lines.push(line) },
    );

    logger.info("outside");

    const parsed = JSON.parse(lines[0]!);
    expect("cognito_sub" in parsed).toBe(false);
    expect(parsed.service_name).toBe("users");
  });

  it("lets an explicit log field win over the context", async () => {
    const lines: string[] = [];
    const logger = pino(
      buildLoggerOptions({ serviceName: "users", environment: "test" }),
      { write: (line: string) => lines.push(line) },
    );

    await runWithLogContext({ order_id: "ord_ctx" }, async () => {
      logger.info({ order_id: "ord_explicit" }, "override");
    });

    expect(JSON.parse(lines[0]!).order_id).toBe("ord_explicit");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `nvm use && pnpm --filter @3mrai/users test log-context`
Expected: FAIL — context fields are absent from the emitted lines.

- [ ] **Step 3: Merge the context in `formatters.log`**

In `services/users/src/shared/logging/logger.ts`, add the import at the top:

```typescript
import { getLogContext } from "./log-context.js";
```

Then change the `log(object)` formatter so the context is merged FIRST and the explicit object wins. Replace the existing `log(object)` body with:

```typescript
      log(object) {
        // Context first, explicit log fields second: an explicit field on the
        // call site always beats the ambient request context. Unknown context
        // fields are simply absent from the store, so nothing null is emitted.
        const merged = { ...getLogContext(), ...object } as Record<string, unknown>;

        const err = (merged as { err?: unknown }).err;
        if (err && typeof err === "object") {
          const errObj = err as {
            constructor?: { name?: string };
            type?: string;
            name?: string;
            message?: string;
          };
          return {
            ...merged,
            error_type: errObj.constructor?.name ?? errObj.type ?? errObj.name ?? "Error",
            error_message: errObj.message ?? "",
          };
        }
        return merged;
      },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `nvm use && pnpm --filter @3mrai/users test log-context`
Expected: PASS, 5 tests.

- [ ] **Step 5: Populate the context per request**

In `services/users/src/features/users/http/routes.ts`, inside the existing `onRequest` hook (the one that reads `x-user-id` and registers the Awilix scope), the store must wrap the REST of the request. Fastify hooks cannot wrap downstream handlers with `AsyncLocalStorage.run` via `done()`, so use `logContext.enterWith` instead, which binds the store to the current async context without needing a callback:

```typescript
import { logContext } from "../../../shared/logging/log-context.js";
```

Add immediately after `const routePath = ...` and before the 401 short-circuit:

```typescript
    // enterWith (not .run): a Fastify onRequest hook returns via done() rather
    // than wrapping the downstream handler in a callback, so there is no
    // function to run the store around. enterWith binds the store to the
    // current async resource, and every continuation of this request inherits
    // it. Populated with what is known now; `setLogContext` adds user_id and
    // email_hash later, once identity resolution or the auth handler produces
    // them.
    logContext.enterWith(actor === undefined ? {} : { cognito_sub: actor });
```

- [ ] **Step 6: Verify a real request carries the context**

Run (stack up):

```bash
docker compose logs --no-log-prefix --tail 200 users | grep '"http_route"' | tail -1 | python3 -m json.tool
```

Then hit an authenticated route and re-check. Expected: the request-completed log line for an authenticated route includes `cognito_sub`; the health route's line does not.

- [ ] **Step 7: Run the whole Users suite**

Run: `nvm use && pnpm --filter @3mrai/users test`
Expected: all pass, no regressions.

- [ ] **Step 8: Commit**

```bash
git add services/users/src/shared/logging/logger.ts services/users/src/shared/logging/log-context.test.ts services/users/src/features/users/http/routes.ts
git commit -m "feat(users): merge request log context into every log line"
```

---

### Task 3: Orders context enricher (mirror of Task 1+2)

**Files:**
- Create: `services/orders/src/Orders.Api/Logging/EmailHash.cs`
- Create: `services/orders/src/Orders.Api/Logging/LogContextEnricher.cs`
- Modify: `services/orders/src/Orders.Api/Program.cs` (Serilog setup + `AddHttpContextAccessor`)
- Test: `services/orders/tests/Orders.Tests/Logging/EmailHashTests.cs`

**Interfaces:**
- Consumes: the field contract from Task 1 (names and hash algorithm must match exactly).
- Produces: every Serilog event carries `cognito_sub` and, when resolved, `user_id`.

- [ ] **Step 1: Write the failing hash test**

`services/orders/tests/Orders.Tests/Logging/EmailHashTests.cs`:

```csharp
using Orders.Api.Logging;
using Xunit;

namespace Orders.Tests.Logging;

public class EmailHashTests
{
    [Fact]
    public void IsStableForTheSameEmail() =>
        Assert.Equal(EmailHash.Compute("user@example.com"), EmailHash.Compute("user@example.com"));

    [Fact]
    public void NormalizesCaseAndWhitespace()
    {
        var canonical = EmailHash.Compute("user@example.com");
        Assert.Equal(canonical, EmailHash.Compute("USER@example.com"));
        Assert.Equal(canonical, EmailHash.Compute("  user@example.com  "));
    }

    [Fact]
    public void Is16HexCharacters() =>
        Assert.Matches("^[0-9a-f]{16}$", EmailHash.Compute("user@example.com"));

    // The cross-service contract: this exact value is what the Users service's
    // hashEmail() produces for the same input. If this test fails, filtering a
    // user across services silently returns nothing.
    [Fact]
    public void MatchesTheUsersServiceForAKnownInput() =>
        Assert.Equal("b4c9a289323b21a0", EmailHash.Compute("user@example.com"));
}
```

- [ ] **Step 2: Get the expected hash from the Users implementation**

The literal above is a placeholder until confirmed. Compute the real value and paste it into the test:

```bash
nvm use && node -e "console.log(require('node:crypto').createHash('sha256').update('user@example.com').digest('hex').slice(0,16))"
```

Replace `b4c9a289323b21a0` in the test with the printed value before running it.

- [ ] **Step 3: Run it to verify it fails**

Run: `dotnet test services/orders/Orders.sln --filter EmailHashTests`
Expected: FAIL — `EmailHash` does not exist.

- [ ] **Step 4: Implement the hash**

`services/orders/src/Orders.Api/Logging/EmailHash.cs`:

```csharp
using System.Security.Cryptography;
using System.Text;

namespace Orders.Api.Logging;

// Cross-service contract: MUST match services/users/src/shared/logging/email-hash.ts
// exactly (SHA-256 of the trimmed, lowercased email, hex, first 16 chars). If the
// two drift, filtering one user across both services silently returns nothing.
public static class EmailHash
{
    private const int HashLength = 16;

    public static string Compute(string email)
    {
        var normalized = email.Trim().ToLowerInvariant();
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(normalized));
        return Convert.ToHexString(digest).ToLowerInvariant()[..HashLength];
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `dotnet test services/orders/Orders.sln --filter EmailHashTests`
Expected: PASS, 4 tests — including the cross-service parity test.

- [ ] **Step 6: Implement the enricher**

`services/orders/src/Orders.Api/Logging/LogContextEnricher.cs`:

```csharp
using Microsoft.AspNetCore.Http;
using Orders.Api.Identity;
using Serilog.Core;
using Serilog.Events;

namespace Orders.Api.Logging;

// Attaches the shared cross-service log context to every event, mirroring the
// Users service's AsyncLocalStorage store. Reads the request-scoped
// ICurrentCaller through IHttpContextAccessor, so no call site has to pass
// identity into the logger.
//
// Reads the caller on EVERY event rather than caching: ICurrentCaller resolves
// the internal usr_ id lazily (ResolveInternalUserIdAsync), so user_id is
// absent early in a request and present later. Caching would freeze the empty
// early value onto the whole request.
//
// Fields are omitted when unknown — never emitted as null.
public sealed class LogContextEnricher(IHttpContextAccessor accessor) : ILogEventEnricher
{
    public void Enrich(LogEvent logEvent, ILogEventPropertyFactory factory)
    {
        var caller = accessor.HttpContext?.RequestServices?.GetService<ICurrentCaller>();
        if (caller?.CognitoSub is { Length: > 0 } sub)
        {
            logEvent.AddPropertyIfAbsent(factory.CreateProperty("cognito_sub", sub));
        }
    }
}
```

- [ ] **Step 7: Wire it into Serilog**

In `services/orders/src/Orders.Api/Program.cs`, add `builder.Services.AddHttpContextAccessor();` before the Serilog setup, then change the Serilog configuration to attach the enricher:

```csharp
builder.Services.AddHttpContextAccessor();

var deploymentEnvironment = builder.Configuration["DEPLOYMENT_ENVIRONMENT"] ?? "local";
builder.Host.UseSerilog((context, services, cfg) => cfg
    .MinimumLevel.Information()
    .Enrich.With(new LogContextEnricher(services.GetRequiredService<IHttpContextAccessor>()))
    .WriteTo.Console(new SchemaLogFormatter("orders", deploymentEnvironment)));
```

Note the three-argument `UseSerilog` overload — the two-argument one used today has no `services` parameter, so the enricher could not resolve `IHttpContextAccessor`.

- [ ] **Step 8: Verify against the running service**

Run:

```bash
docker compose up -d --build orders
docker compose logs --no-log-prefix --tail 100 orders | grep '"http_route"' | tail -1 | python3 -m json.tool
```

Expected: the request-completed line for an authenticated route includes `cognito_sub`.

- [ ] **Step 9: Run the Orders suite**

Run: `dotnet test services/orders/Orders.sln`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add services/orders/src/Orders.Api/Logging/ services/orders/src/Orders.Api/Program.cs services/orders/tests/
git commit -m "feat(orders): add log-context enricher and cross-service email hash"
```

---

## Layer 2 — Flow logs

### Task 4: Register and login flow logs (Users)

**Files:**
- Modify: `services/users/src/features/users/commands/register.ts`
- Modify: `services/users/src/features/users/commands/login.ts`

**Interfaces:**
- Consumes: `setLogContext`, `hashEmail` (Task 1); the merged context (Task 2).
- Produces: `app_event` values `register_started`, `register_succeeded`, `register_failed`, `login_started`, `login_succeeded`, `login_failed`, each with a `reason` on failure.

**Field discipline:** these two flows are the ONLY place plaintext `email` may be logged. Set it via `setLogContext({ email, email_hash: hashEmail(email) })` at the start of the flow so both ride on every subsequent line of that request.

- [ ] **Step 1: Read the current register command**

Run: `sed -n '1,80p' services/users/src/features/users/commands/register.ts`

Identify the distinguishable failure modes actually present (duplicate email, Cognito rejection, DB failure) — log one branch per mode that already exists in the code. Do NOT invent failure modes the code cannot produce.

- [ ] **Step 2: Add the register flow logs**

At the start of the register handler, before any work:

```typescript
setLogContext({ email, email_hash: hashEmail(email) });
log.info({ app_event: "register_started" }, "Starting user registration");
```

On success, after the user row exists:

```typescript
setLogContext({ user_id: user.id });
log.info(
  { app_event: "register_succeeded", user_id: user.id },
  "User registration completed",
);
```

On each failure branch, one line naming the reason — for the duplicate-email branch:

```typescript
log.error(
  { app_event: "register_failed", reason: "duplicate_email" },
  "User registration failed: a user with this email already exists",
);
```

For the Cognito branch:

```typescript
log.error(
  { err, app_event: "register_failed", reason: "cognito_error" },
  "User registration failed: could not create the user in Cognito",
);
```

For the database branch:

```typescript
log.error(
  { err, app_event: "register_failed", reason: "database_error" },
  "User registration failed: could not persist the user",
);
```

- [ ] **Step 3: Add the login flow logs**

Same shape in `login.ts`: `login_started` on entry (with `setLogContext({ email, email_hash: hashEmail(email) })`), `login_succeeded` with the resolved `user_id`, and `login_failed` with `reason` per branch that exists (`invalid_credentials`, `user_not_confirmed`, `cognito_error`). Never log the password or the returned tokens.

- [ ] **Step 4: Verify the logs appear and carry the context**

Run (stack up):

```bash
EMAIL="flowtest+$(date +%s)@example.com"
curl -s -X POST "$(grep API_GATEWAY_URL .env | cut -d= -f2-)/v1/users/register" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Passw0rd!\",\"firstName\":\"Flow\",\"lastName\":\"Test\"}" >/dev/null
docker compose logs --no-log-prefix --tail 50 users | grep register_ | python3 -m json.tool
```

Expected: a `register_started` line and a `register_succeeded` line, both carrying `email`, `email_hash`, and the success line also `user_id`.

- [ ] **Step 5: Verify no password leaked**

Run:

```bash
docker compose logs --no-log-prefix --tail 200 users | grep -ci 'passw0rd!' || echo "0 occurrences — PASS"
```

Expected: `0 occurrences — PASS`.

- [ ] **Step 6: Run the Users suite**

Run: `nvm use && pnpm --filter @3mrai/users test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add services/users/src/features/users/commands/
git commit -m "feat(users): add register and login flow logs"
```

---

### Task 5: Create-order flow logs + Orders request-log alignment

**Files:**
- Modify: `services/orders/src/Orders.Application/**/CreateOrderService.cs` (path confirmed in Step 1)
- Modify: `services/orders/src/Orders.Api/Program.cs` (`EnrichDiagnosticContext`)

**Interfaces:**
- Consumes: the enricher (Task 3).
- Produces: `app_event` values `create_order_started`, `create_order_succeeded`, `create_order_failed`; `order_id` on the success line.

- [ ] **Step 1: Locate the create-order service and its failure modes**

Run: `find services/orders -name "CreateOrderService.cs" -exec grep -n "throw new\|Exception" {} +`

The known modes are `UnknownUserException`, `InsufficientStockException`, and unknown-product. Log one branch per mode that actually exists.

- [ ] **Step 2: Add the flow logs**

Inject `ILogger<CreateOrderService>` into the service. At entry:

```csharp
_logger.LogInformation("Starting order creation {app_event}", "create_order_started");
```

On success, after the order is persisted:

```csharp
_logger.LogInformation(
    "Order creation completed {app_event} {order_id}",
    "create_order_succeeded", order.Id);
```

On each failure branch:

```csharp
_logger.LogError(
    "Order creation failed: unknown user {app_event} {reason}",
    "create_order_failed", "unknown_user");
```

```csharp
_logger.LogError(
    "Order creation failed: insufficient stock {app_event} {reason}",
    "create_order_failed", "insufficient_stock");
```

Serilog's message template captures the named properties as structured fields, and `SchemaLogFormatter` writes them as top-level JSON keys — so `app_event`, `reason`, and `order_id` become queryable columns without extra work.

- [ ] **Step 3: Align the request log's trace_id source**

In `Program.cs`'s `EnrichDiagnosticContext`, `trace_id` is currently `http.TraceIdentifier` (an ASP.NET-local id). Leave it for now — Task 8 replaces it with the OTel trace id in both services at once, so they change together rather than diverging mid-block.

Confirm the other request-log fields already match Users' shape: `http_request_method`, `http_route`, `http_response_status_code`, and `duration_ms` (renamed from `Elapsed` by the formatter). No change needed if they do.

- [ ] **Step 4: Verify**

Run:

```bash
docker compose up -d --build orders
# create an order through the gateway, then:
docker compose logs --no-log-prefix --tail 50 orders | grep create_order_ | python3 -m json.tool
```

Expected: `create_order_started` and `create_order_succeeded` lines, the latter carrying `order_id`, both carrying `cognito_sub` from the enricher.

- [ ] **Step 5: Run the Orders suite**

Run: `dotnet test services/orders/Orders.sln`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add services/orders/src/
git commit -m "feat(orders): add create-order flow logs"
```

---

## Layer 3 — Tracing

### Task 6: OpenTelemetry SDK in Users

**Files:**
- Create: `services/users/src/shared/observability/tracing.ts`
- Modify: `services/users/src/server.ts` (import tracing FIRST)
- Modify: `services/users/package.json`
- Modify: `docker-compose.yml` (OTLP endpoint env var for `users`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: OTel spans exported over OTLP; `trace.getActiveSpan()` available for Task 8.

- [ ] **Step 1: Install the SDK**

Run:

```bash
nvm use && pnpm --filter @3mrai/users add @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/semantic-conventions
```

- [ ] **Step 2: Write the tracing bootstrap**

`services/users/src/shared/observability/tracing.ts`:

```typescript
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from "@opentelemetry/semantic-conventions/incubating";

// MUST be imported before anything else in the process (see server.ts): the
// auto-instrumentations patch modules as they are required, so any module
// loaded earlier — fastify, @grpc/grpc-js, @prisma/client — escapes
// instrumentation entirely and its spans never appear.
const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "users",
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env.DEPLOYMENT_ENVIRONMENT ?? "local",
  }),
  traceExporter: new OTLPTraceExporter({
    // The collector's OTLP/HTTP receiver, added in Task 9.
    url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://otel-collector:4318"}/v1/traces`,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // fs spans are pure noise at this scale and drown the useful ones.
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
  ],
});

sdk.start();

process.on("SIGTERM", () => {
  void sdk.shutdown().finally(() => process.exit(0));
});
```

- [ ] **Step 3: Import it first in the entrypoint**

At the very TOP of `services/users/src/server.ts`, above every other import:

```typescript
// Must be first: the OTel auto-instrumentations patch modules at require time,
// so anything imported above this line runs uninstrumented.
import "./shared/observability/tracing.js";
```

- [ ] **Step 4: Add the endpoint env var**

In `docker-compose.yml`, add to the `users` service environment:

```yaml
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
```

- [ ] **Step 5: Verify the SDK starts without breaking the service**

Run:

```bash
docker compose up -d --build users
docker compose logs --tail 30 users
curl -s "$(grep API_GATEWAY_URL .env | cut -d= -f2-)/v1/users/health"
```

Expected: `{"status":"ok"}`, and no OTel errors in the logs. Export failures are expected until Task 9 adds the collector receiver — the service must still serve traffic regardless.

- [ ] **Step 6: Commit**

```bash
git add services/users/package.json services/users/src/shared/observability/ services/users/src/server.ts docker-compose.yml pnpm-lock.yaml
git commit -m "feat(users): bootstrap the OpenTelemetry SDK"
```

---

### Task 7: OpenTelemetry SDK in Orders

**Files:**
- Modify: `services/orders/src/Orders.Api/Orders.Api.csproj`
- Modify: `services/orders/src/Orders.Api/Program.cs`
- Modify: `docker-compose.yml` (OTLP endpoint env var for `orders`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: OTel spans over OTLP; `Activity.Current` available for Task 8.

- [ ] **Step 1: Add the packages**

Run:

```bash
cd services/orders/src/Orders.Api && \
dotnet add package OpenTelemetry.Extensions.Hosting && \
dotnet add package OpenTelemetry.Instrumentation.AspNetCore && \
dotnet add package OpenTelemetry.Instrumentation.GrpcNetClient && \
dotnet add package OpenTelemetry.Instrumentation.EntityFrameworkCore && \
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol
```

- [ ] **Step 2: Wire tracing in Program.cs**

Add after `builder.Services.AddHttpContextAccessor();`:

```csharp
// Distributed tracing. GrpcNetClient instrumentation is what makes the
// Orders -> Users identity call a child span of the incoming request rather
// than an unrelated trace: it injects the W3C traceparent header automatically.
builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService(
        serviceName: "orders",
        serviceVersion: "1.0.0"))
    .WithTracing(tracing => tracing
        .AddAspNetCoreInstrumentation()
        .AddGrpcClientInstrumentation()
        .AddEntityFrameworkCoreInstrumentation()
        .AddOtlpExporter(o =>
        {
            o.Endpoint = new Uri(
                builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]
                ?? "http://otel-collector:4318");
            o.Protocol = OpenTelemetry.Exporter.OtlpExportProtocol.HttpProtobuf;
        }));
```

- [ ] **Step 3: Add the endpoint env var**

In `docker-compose.yml`, add to the `orders` service environment:

```yaml
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
```

- [ ] **Step 4: Verify the service still starts and serves**

Run:

```bash
docker compose up -d --build orders
docker compose logs --tail 30 orders
```

Expected: the service starts and serves requests. Export errors until Task 9 are acceptable; a crash is not.

- [ ] **Step 5: Commit**

```bash
git add services/orders/src/Orders.Api/Orders.Api.csproj services/orders/src/Orders.Api/Program.cs docker-compose.yml
git commit -m "feat(orders): bootstrap OpenTelemetry tracing"
```

---

### Task 8: Replace the local trace_id with the real OTel trace id

**Files:**
- Modify: `services/users/src/features/users/http/routes.ts` (the `onResponse` request log)
- Modify: `services/users/src/shared/logging/logger.ts` (context merge)
- Modify: `services/orders/src/Orders.Api/Program.cs` (`EnrichDiagnosticContext`)
- Modify: `services/orders/src/Orders.Api/Logging/LogContextEnricher.cs`

**Interfaces:**
- Consumes: the SDKs from Tasks 6 and 7, and the context plumbing from Tasks 2 and 3.
- Produces: `trace_id` and `span_id` on every log line in both services, identical to the ids in the exported spans.

This is the join key between logs and traces: without it, the two systems cannot be correlated even though both are ingested.

- [ ] **Step 1: Emit the OTel ids in Users' log context**

In `services/users/src/shared/logging/logger.ts`, import the API:

```typescript
import { trace } from "@opentelemetry/api";
```

In the `log(object)` formatter, add the active span's ids before merging:

```typescript
      log(object) {
        const span = trace.getActiveSpan()?.spanContext();
        const traceFields = span
          ? { trace_id: span.traceId, span_id: span.spanId }
          : {};
        const merged = {
          ...traceFields,
          ...getLogContext(),
          ...object,
        } as Record<string, unknown>;
        // ... error promotion unchanged
      },
```

- [ ] **Step 2: Drop the Fastify request id from the request log**

In `routes.ts`'s `onResponse` hook, remove `trace_id: req.id` from the logged object — the formatter now supplies the real OTel `trace_id` for every line, including this one. Leaving it would override the real id with Fastify's local one, since explicit fields win.

- [ ] **Step 3: Emit the OTel ids in Orders**

In `LogContextEnricher.Enrich`, add before the caller lookup:

```csharp
        var activity = System.Diagnostics.Activity.Current;
        if (activity is not null)
        {
            logEvent.AddPropertyIfAbsent(
                factory.CreateProperty("trace_id", activity.TraceId.ToString()));
            logEvent.AddPropertyIfAbsent(
                factory.CreateProperty("span_id", activity.SpanId.ToString()));
        }
```

- [ ] **Step 4: Drop TraceIdentifier from the request log**

In `Program.cs`'s `EnrichDiagnosticContext`, remove the `diag.Set("trace_id", http.TraceIdentifier);` line. The enricher now supplies the real trace id, and `AddPropertyIfAbsent` would otherwise lose to the diagnostic-context value.

- [ ] **Step 5: Verify the ids match the spans**

Run (stack up, after creating an order through the gateway):

```bash
docker compose logs --no-log-prefix --tail 100 orders | grep '"trace_id"' | tail -1 | python3 -c "import json,sys; d=json.load(sys.stdin); print('trace_id:', d.get('trace_id'))"
```

Expected: a 32-hex-character trace id (OTel format), NOT ASP.NET's `0HN…:00000001` shape.

- [ ] **Step 6: Commit**

```bash
git add services/users/src/shared/logging/logger.ts services/users/src/features/users/http/routes.ts services/orders/src/Orders.Api/
git commit -m "feat(observability): use the real OTel trace id in logs across both services"
```

---

### Task 9: Collector traces pipeline

**Files:**
- Modify: `observability/otel-collector-config.yaml`
- Modify: `docker-compose.yml` (expose the collector's OTLP ports if not already)

**Interfaces:**
- Consumes: OTLP exports from Tasks 6 and 7.
- Produces: traces ingested into OpenObserve.

- [ ] **Step 1: Add the OTLP receiver**

In `observability/otel-collector-config.yaml`, under `receivers:`, add:

```yaml
  # OTLP from the services' OpenTelemetry SDKs (traces). The logs pipeline keeps
  # using fluent_forward — services still log to stdout via Docker's fluentd
  # driver; only traces arrive over OTLP.
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
      grpc:
        endpoint: 0.0.0.0:4317
```

- [ ] **Step 2: Add the traces exporter**

Under `exporters:`, add:

```yaml
  # Same OpenObserve instance as logs, different stream. Keeping both in one
  # backend is what lets trace_id join a log line to its span (see ADR on
  # tracing, written in Task 11).
  otlp_http/openobserve_traces:
    endpoint: http://openobserve:5080/api/default
    headers:
      Authorization: "Basic ${env:O2_BASIC_AUTH}"
      stream-name: traces
```

- [ ] **Step 3: Add the pipeline**

Under `service.pipelines:`, alongside the existing `logs:` pipeline:

```yaml
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp_http/openobserve_traces]
```

- [ ] **Step 4: Expose the collector ports**

In `docker-compose.yml`, ensure the `otel-collector` service publishes/exposes `4317` and `4318` on the compose network so `users` and `orders` can reach `http://otel-collector:4318`.

- [ ] **Step 5: Verify traces are received**

Run:

```bash
docker compose up -d otel-collector
docker compose restart users orders
# exercise a flow through the gateway, then:
docker compose logs --tail 40 otel-collector | grep -i "trace\|error"
```

Expected: no exporter errors. Traces flowing.

- [ ] **Step 6: Commit**

```bash
git add observability/otel-collector-config.yaml docker-compose.yml
git commit -m "feat(observability): add a traces pipeline to the otel collector"
```

---

### Task 10: Verify cross-service trace propagation

**Files:**
- No source changes — this is the acceptance gate for the tracing layer.

**Interfaces:**
- Consumes: Tasks 6–9.
- Produces: evidence that one trace spans both services.

- [ ] **Step 1: Exercise the cross-service flow**

Create an order through the gateway. That path calls Users over gRPC for identity resolution, which is the only cross-service hop in the system today.

```bash
GW=$(grep API_GATEWAY_URL .env | cut -d= -f2-)
# obtain a token via login, then POST /v1/orders (see e2e/ for the exact shape)
```

- [ ] **Step 2: Confirm both services logged the SAME trace_id**

```bash
docker compose logs --no-log-prefix --tail 200 orders | grep create_order_succeeded | tail -1 \
  | python3 -c "import json,sys; print('orders trace:', json.load(sys.stdin)['trace_id'])"
docker compose logs --no-log-prefix --tail 200 users | grep '"http_route"' | tail -1 \
  | python3 -c "import json,sys; print('users  trace:', json.load(sys.stdin).get('trace_id'))"
```

Expected: the two trace ids are IDENTICAL for the same logical request. That is the proof W3C `traceparent` propagated over gRPC. If they differ, gRPC client instrumentation is not injecting the header — check `AddGrpcClientInstrumentation` in Orders.

- [ ] **Step 3: Confirm the trace is queryable in OpenObserve**

Open OpenObserve and query the `traces` stream for that trace id. Expected: spans from both `orders` and `users`, with the Users span a child of the Orders span.

- [ ] **Step 4: Confirm no PII leaked**

```bash
docker compose logs --no-log-prefix --tail 500 users orders | grep -c '"email":' || echo "0"
docker compose logs --no-log-prefix --tail 500 users orders | grep '"email":' | python3 -c "
import json,sys
for line in sys.stdin:
    try: d = json.loads(line)
    except ValueError: continue
    assert d.get('app_event','').startswith(('register','login')), f\"email outside auth flow: {d.get('app_event')}\"
print('PASS: plaintext email only in auth flows')
"
```

Expected: `PASS` — every plaintext `email` occurrence sits on a `register_*` or `login_*` event.

- [ ] **Step 5: Run the full E2E suite**

Run: `nvm use && pnpm --filter @3mrai/e2e test`
Expected: 35 passed, matching the pre-block baseline.

- [ ] **Step 6: Commit the verification record**

```bash
git commit --allow-empty -m "test(observability): verify cross-service trace propagation"
```

---

### Task 11: The ADR and the convention note

**Files:**
- Create: `docs/shared/decisions/ADR-0019-distributed-tracing-opentelemetry.md` (via the `obsidian-vault` agent)
- Create: `docs/shared/conventions/logging-context.md` (via the `obsidian-vault` agent)
- Modify: `CLAUDE.md`, `services/users/CLAUDE.md`, `services/orders/CLAUDE.md`

**Interfaces:**
- Consumes: everything above, as the worked example.
- Produces: the durable record. ADR-0019 is REQUIRED by the spec — it resolves the trade-off ADR-0018 explicitly deferred.

- [ ] **Step 1: Write ADR-0019**

Dispatch `obsidian-vault` to create `docs/shared/decisions/ADR-0019-distributed-tracing-opentelemetry.md` with standard ADR structure (Context / Decision / Consequences / Related) recording:

- **Context:** ADR-0018 chose OpenObserve over SigNoz for logs and stated that distributed tracing was out of scope, noting OpenObserve's APM maturity is below SigNoz's and that *"if distributed tracing becomes a hard requirement, the backend is re-evaluated in a future ADR"*. Block 2 of the Developer Experience milestone makes tracing a hard requirement, triggering exactly that re-evaluation.
- **Decision:** Adopt the OpenTelemetry SDK in both services and keep OpenObserve as the trace backend, accepting the weaker APM exploration UI.
- **Consequences:** Traces and logs share one backend and join on `trace_id`; the APM UI is less ergonomic than SigNoz/Jaeger for waterfalls and service maps; the decision is reversible because the collector's trace pipeline is a standard OTLP exporter, so re-pointing it is a config change, not re-instrumentation; a second trace-only backend was considered and rejected for now.
- **Supersedes:** the tracing/logs-only stance of [[ADR-0018-observability-openobserve]] (its OpenObserve-over-SigNoz backend choice STANDS) and the tracing Non-Goal of [[2026-07-16-structured-logging-and-dashboards-design]].

- [ ] **Step 2: Write the logging-context convention**

Dispatch `obsidian-vault` to create `docs/shared/conventions/logging-context.md` recording: the full field table, the `email_hash` algorithm as a cross-service contract (SHA-256, trimmed + lowercased, hex, first 16 chars), the rule that plaintext email appears only in login/register, the `app_event`/`reason` naming pattern for flow logs, the rule that unknown fields are omitted rather than emitted as null, and that `tracking_id`/`type` are reserved for services not yet built.

- [ ] **Step 3: Reference it from the CLAUDE.md files**

Root `CLAUDE.md` gets a short subsection under Working rules pointing at the convention and stating the never-log rules. Each service's `CLAUDE.md` gets the service-specific mechanism (Users: the ALS store and the lazy-promise pitfall; Orders: the Serilog enricher and `IHttpContextAccessor`).

- [ ] **Step 4: Validate the vault**

Run: `nvm use && node scripts/validate-vault.mjs`
Expected: passes with no broken wikilinks.

- [ ] **Step 5: Commit**

```bash
git add docs/ CLAUDE.md services/users/CLAUDE.md services/orders/CLAUDE.md
git commit -m "docs(vault): add ADR-0019 tracing decision and the logging-context convention"
```

---

## Related

- [[2026-07-19-logging-context-and-tracing-design]]
- [[2026-07-16-structured-logging-and-dashboards-design]]
- [[ADR-0018-observability-openobserve]]
- [[2026-07-12-prisma-lazy-promise-als]]
- [[testing]]
