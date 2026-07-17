# Structured Logging & OpenObserve Dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `users` and `orders` emit a single OTel-aligned `snake_case` JSON log schema, parse that JSON into queryable columns in the OTel collector, and ship versioned per-service + global OpenObserve dashboards with an idempotent bootstrap.

**Architecture:** Approach A from the spec — a per-language logger shim plus a request hook/middleware per service, collector-side JSON flattening, and dashboards-as-code. Transport is unchanged: services log to stdout via Docker's `fluentd` driver into the collector's `fluent_forward` receiver. Logs-only per [[ADR-0018-observability-openobserve]].

**Tech Stack:** Node/Fastify + Pino (`users`), .NET 10 Minimal APIs + Serilog (`orders`), OpenTelemetry Collector contrib `0.156.0` (OTTL `transform` processor), OpenObserve `v0.91.1` (dashboards API), Docker Compose, Make.

## Scope Note

**Only `users` and `orders` are implemented by this plan.** `tracking` (FastAPI) and `events-pipeline` (Node) are scaffold-only today (empty dirs, `CMD` commented out in their Dockerfiles, not running). They adopt the same schema/shim when they are built — the design in the spec already covers all four. The shared Node Pino module (Task 3) is written so `events-pipeline` can import it later without change.

## Global Constraints

- **Node version:** repo-pinned via `.nvmrc` (24.18.0). Run `nvm use` before any Node command.
- **Node imports:** `users` uses Node subpath imports `#shared/*` and `#features/*` — NOT `@`. Match existing style.
- **Log schema field names:** `snake_case`, emitted exactly as: `timestamp`, `severity_text`, `severity_number`, `service_name`, `deployment_environment`, `message`, `trace_id`, `http_request_method`, `http_route`, `http_response_status_code`, `duration_ms`, `error_type`, `error_message`. Business attributes use an `app_*` prefix.
- **Severity mapping (OTel scale):** `DEBUG`=5, `INFO`=9, `WARN`=13, `ERROR`=17.
- **HTTP fields only on request logs; `error_*` only on error logs.** No noisy empty fields.
- **`trace_id`** is a per-service request/correlation id (generated or from an inbound header) — not distributed tracing.
- **Verify with `_search`, never stream-stats `doc_num`** (lagging counter — see [[openobserve-runbook]]).
- **Git:** the main session commits per the A/B/C/D/E menu — do NOT auto-commit or push. Leave work in the working tree. Conventional Commits, scope `users` / `orders` / `observability`.
- **Pinned images:** do not bump `otel/opentelemetry-collector-contrib:0.156.0` or `openobserve:v0.91.1`.

---

### Task 1: Capture the real OpenObserve dashboard JSON schema

De-risks the dashboards work: the OpenObserve `v0.91.1` dashboard JSON format must come from a real export, not invention. This task produces a reference artifact only.

**Files:**
- Create: `observability/dashboards/.gitkeep`
- Create: `observability/dashboards/README.md`

**Interfaces:**
- Produces: a documented, real dashboard-JSON template shape (fields like `dashboardId`, `title`, `panels[]`, `queries[]`, `layouts[]`) that Tasks 8–10 use verbatim as their structure.

- [ ] **Step 1: Ensure the observability stack is up**

Run: `make observability-up`
Expected: `3mrai-openobserve-1` and `3mrai-otel-collector-1` are `Up`. `curl -s -o /dev/null -w "%{http_code}" http://localhost:5080/healthz` prints `200`.

- [ ] **Step 2: Create one minimal dashboard in the UI**

Open http://localhost:5080 (login `admin@3mrai.local` / `Complexpass#123`). Create a dashboard named `_schema-probe` with a single bar/line panel over the `logs` stream (any field). Save it.

- [ ] **Step 3: Export it via the API and save as a reference template**

Run:
```bash
AUTH="YWRtaW5AM21yYWkubG9jYWw6Q29tcGxleHBhc3MjMTIz"
curl -s -H "Authorization: Basic $AUTH" \
  "http://localhost:5080/api/default/dashboards" | python3 -m json.tool > /tmp/oo-dashboards.json
head -c 4000 /tmp/oo-dashboards.json
```
Expected: JSON listing dashboards, including `_schema-probe`, showing the real structure (top-level keys, `panels`, `queries`, `layouts`).

- [ ] **Step 4: Write `observability/dashboards/README.md`**

Document, from the real export: the dashboard JSON top-level shape, how panels/queries are structured, the exact import endpoint (`POST /api/default/dashboards`) and update semantics (whether create-vs-update keys on `dashboardId`/`title`), and the Basic-auth header. Include a trimmed real example. This README is the contract Tasks 8–10 build against.

- [ ] **Step 5: Delete the probe dashboard**

Delete `_schema-probe` from the UI (or via the API DELETE endpoint documented in Step 4) so it does not pollute the real set.

- [ ] **Step 6: Commit** (main session, via menu)

Staged: `observability/dashboards/.gitkeep`, `observability/dashboards/README.md`.
Message: `docs(observability): capture OpenObserve dashboard JSON schema reference`

---

### Task 2: Collector-side JSON flattening (OTTL transform processor)

Turns the JSON blob in `body` into top-level columns. This unblocks every dashboard, so it comes before the dashboards but can run in parallel with the service shims (Tasks 3–7) — the services already emit *some* JSON today (`users` does), enough to validate the processor.

**Files:**
- Modify: `observability/otel-collector-config.yaml`

**Interfaces:**
- Consumes: log records whose `body` is a JSON string with the schema fields.
- Produces: log records with the schema fields promoted to top-level attributes, queryable as columns in the OpenObserve `logs` stream.

- [ ] **Step 1: Add the transform processor to the config**

Edit `observability/otel-collector-config.yaml`. Under `processors:`, add a `transform` processor that parses `body` as JSON and merges the result into attributes. Then reference it in the logs pipeline BEFORE `batch`:

```yaml
processors:
  # Parse the service's JSON stdout line (carried in body) into top-level
  # attributes so OpenObserve exposes them as queryable columns. Services already
  # emit snake_case, so this only flattens — no per-service renaming.
  transform/parse_body:
    error_mode: ignore
    log_statements:
      - context: log
        statements:
          - merge_maps(attributes, ParseJSON(body), "upsert") where IsMatch(body, "^\\s*\\{")
  batch: {}
```
And update the pipeline:
```yaml
  pipelines:
    logs:
      receivers: [fluent_forward, aws_cloudwatch]
      processors: [transform/parse_body, batch]
      exporters: [otlp_http/openobserve]
```

- [ ] **Step 2: Recreate the collector and verify it starts**

Run:
```bash
docker compose --profile observability up -d --force-recreate otel-collector
sleep 5
docker logs 3mrai-otel-collector-1 --tail 20 2>&1 | grep -iE 'error|invalid|everything is ready'
```
Expected: `Everything is ready. Begin running and processing data.` and NO `error`/`invalid` lines. If the `transform` processor is unavailable or the OTTL statement is rejected, the collector logs a config error — see fallback in Step 4.

- [ ] **Step 3: Generate traffic and verify columns appear**

Run:
```bash
for i in $(seq 1 5); do curl -s -o /dev/null http://localhost:3000/health; done
sleep 12
AUTH="YWRtaW5AM21yYWkubG9jYWw6Q29tcGxleHBhc3MjMTIz"
NOW=$(python3 -c 'import time;print(int(time.time()*1_000_000))')
START=$(python3 -c 'import time;print(int((time.time()-600)*1_000_000))')
curl -s -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
  "http://localhost:5080/api/default/_search?type=logs" \
  -d "{\"query\":{\"sql\":\"SELECT severity_text, http_response_status_code, duration_ms FROM logs WHERE service_name IS NOT NULL ORDER BY _timestamp DESC LIMIT 3\",\"start_time\":$START,\"end_time\":$NOW}}"
```
Expected: rows where `severity_text`, `http_response_status_code`, `duration_ms` are populated as columns (not null), proving the flatten worked. NOTE: full population depends on `users` emitting the schema (Task 4); until then, at minimum the fields present in today's Pino output (e.g. a parsed `level`) must appear as top-level keys.

- [ ] **Step 4 (fallback, only if Step 2 errored): use `logstransform`**

If `transform`/OTTL `ParseJSON` is rejected by image `0.156.0`, replace the processor with the `logstransform` operator equivalent (a `json_parser` operator on `body`). Document which one worked in a one-line comment in the config. Re-run Steps 2–3.

- [ ] **Step 5: Commit** (main session, via menu)

Staged: `observability/otel-collector-config.yaml`.
Message: `feat(observability): flatten service JSON logs into columns in the collector`

---

### Task 3: Shared Node Pino logging module

The reusable logger config for the two Node services (`users` now, `events-pipeline` later). Lives in `users` for now since it is the only Node service with code; when `events-pipeline` is built it imports the same module (or it is promoted to a shared workspace package then).

**Files:**
- Create: `services/users/src/shared/logging/logger.ts`
- Test: `services/users/tests/shared/logger.test.ts`

**Interfaces:**
- Produces:
  - `buildLoggerOptions(opts: { serviceName: string; environment: string }): LoggerOptions` — Pino options that emit the `snake_case` schema.
  - `SEVERITY_NUMBER: Record<string, number>` — `{ DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 }`.
  - Field renames: Pino `level`(string) → `severity_text` (uppercased) + `severity_number`; `time` → `timestamp`; `msg` → `message`; injects `service_name`, `deployment_environment`.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/shared/logger.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import pino from "pino";
import { buildLoggerOptions, SEVERITY_NUMBER } from "#shared/logging/logger";

function capture(): { lines: string[]; stream: { write: (s: string) => void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (s: string) => lines.push(s) } };
}

describe("buildLoggerOptions", () => {
  it("emits the snake_case OTel-aligned schema", () => {
    const { lines, stream } = capture();
    const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);
    log.info({ trace_id: "req-1" }, "request completed");
    const rec = JSON.parse(lines[0]);
    expect(rec.severity_text).toBe("INFO");
    expect(rec.severity_number).toBe(SEVERITY_NUMBER.INFO);
    expect(rec.service_name).toBe("users");
    expect(rec.deployment_environment).toBe("local");
    expect(rec.message).toBe("request completed");
    expect(rec.trace_id).toBe("req-1");
    expect(rec.timestamp).toBeDefined();
    expect(rec.level).toBeUndefined();
    expect(rec.msg).toBeUndefined();
  });

  it("maps error severity number", () => {
    const { lines, stream } = capture();
    const log = pino(buildLoggerOptions({ serviceName: "users", environment: "local" }), stream);
    log.error({ error_type: "ValidationError" }, "boom");
    const rec = JSON.parse(lines[0]);
    expect(rec.severity_text).toBe("ERROR");
    expect(rec.severity_number).toBe(17);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/users && nvm use && npx vitest run tests/shared/logger.test.ts`
Expected: FAIL — cannot resolve `#shared/logging/logger`.

- [ ] **Step 3: Write the module**

Create `services/users/src/shared/logging/logger.ts`:
```ts
import type { LoggerOptions } from "pino";

export const SEVERITY_NUMBER: Record<string, number> = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
};

export function buildLoggerOptions(opts: {
  serviceName: string;
  environment: string;
}): LoggerOptions {
  return {
    base: {
      service_name: opts.serviceName,
      deployment_environment: opts.environment,
    },
    messageKey: "message",
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: {
      // Drop Pino's default numeric level; emit OTel-aligned fields instead.
      level(label) {
        const severity = label.toUpperCase();
        return {
          severity_text: severity,
          severity_number: SEVERITY_NUMBER[severity] ?? SEVERITY_NUMBER.INFO,
        };
      },
      // Strip the default `pid`/`hostname` bindings from `base` noise if present.
      bindings() {
        return {};
      },
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd services/users && npx vitest run tests/shared/logger.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit** (main session, via menu)

Staged: `services/users/src/shared/logging/logger.ts`, `services/users/tests/shared/logger.test.ts`.
Message: `feat(users): shared Pino logger emitting the OTel-aligned snake_case schema`

---

### Task 4: Wire the schema logger + request logging into `users`

Replaces `Fastify({ logger: true })` with the shared logger and adds an `onResponse` request log in the schema.

**Files:**
- Modify: `services/users/src/features/users/http/routes.ts:83`
- Modify: `services/users/src/shared/config/env.ts` (add a `DEPLOYMENT_ENVIRONMENT` with a default)
- Test: `services/users/tests/shared/request-log.test.ts`

**Interfaces:**
- Consumes: `buildLoggerOptions` (Task 3).
- Produces: every HTTP response emits one log with `http_request_method`, `http_route`, `http_response_status_code`, `duration_ms`, `trace_id`.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/shared/request-log.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildApp } from "#features/users/http/routes";

describe("request logging", () => {
  it("emits a schema request log on each response", async () => {
    const lines: string[] = [];
    const app = buildApp({ logStream: { write: (s: string) => lines.push(s) } });
    await app.inject({ method: "GET", url: "/health" });
    const reqLog = lines.map((l) => JSON.parse(l)).find((r) => r.http_route);
    expect(reqLog).toBeDefined();
    expect(reqLog.http_request_method).toBe("GET");
    expect(reqLog.http_response_status_code).toBeDefined();
    expect(typeof reqLog.duration_ms).toBe("number");
    expect(reqLog.trace_id).toBeDefined();
    await app.close();
  });
});
```
NOTE: if `buildApp` currently takes no args, this task adds an optional `{ logStream }` param for testability (see Step 3). Adjust the `/health` URL to any registered route if `/health` 404s — the assertion only needs `http_route` present.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/users && npx vitest run tests/shared/request-log.test.ts`
Expected: FAIL — no `http_route` field (current logger is default Pino) or `buildApp` signature mismatch.

- [ ] **Step 3: Update `buildApp` in `routes.ts`**

At `services/users/src/features/users/http/routes.ts:83`, replace `const app = Fastify({ logger: true });` with the schema logger and an `onResponse` hook. Read `env` for service/environment:
```ts
import { buildLoggerOptions } from "#shared/logging/logger";
import { env } from "#shared/config/env";

// (inside buildApp — accept an optional stream for tests)
export function buildApp(opts?: { logStream?: { write: (s: string) => void } }) {
  const app = Fastify({
    logger: buildLoggerOptions({
      serviceName: "users",
      environment: env.DEPLOYMENT_ENVIRONMENT,
    }),
    ...(opts?.logStream ? { loggerInstance: undefined } : {}),
  } as never);
  // If a test stream was supplied, pipe Pino to it.
  // (Fastify supports passing a Pino stream via `logger: { stream }`; use that form.)

  app.addHook("onResponse", (req, reply, done) => {
    req.log.info(
      {
        http_request_method: req.method,
        http_route: req.routeOptions?.url ?? req.url,
        http_response_status_code: reply.statusCode,
        duration_ms: reply.elapsedTime,
        trace_id: req.id,
      },
      "request completed",
    );
    done();
  });

  return app;
}
```
IMPLEMENTATION NOTE for the engineer: Fastify accepts either `logger: <pinoOptions>` or `logger: { ...options, stream }`. To honor the optional test stream, build the options from `buildLoggerOptions(...)` and, when `opts?.logStream` is set, pass `{ ...loggerOptions, stream: opts.logStream }` as the `logger` value; otherwise pass `loggerOptions` directly. Keep `req.id` as `trace_id` (Fastify's default `genReqId` yields `req-N`).

- [ ] **Step 4: Add `DEPLOYMENT_ENVIRONMENT` to env**

In `services/users/src/shared/config/env.ts`, add to the zod schema:
```ts
  DEPLOYMENT_ENVIRONMENT: z.string().default("local"),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd services/users && npx vitest run tests/shared/request-log.test.ts tests/shared/logger.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite regression**

Run: `cd services/users && npx vitest run`
Expected: all existing tests still PASS (the logger change must not break `smoke.test.ts` etc.).

- [ ] **Step 7: Commit** (main session, via menu)

Staged: `services/users/src/features/users/http/routes.ts`, `services/users/src/shared/config/env.ts`, `services/users/tests/shared/request-log.test.ts`.
Message: `feat(users): emit schema request logs via onResponse hook`

---

### Task 5: Re-write key `users` business-event logs to the schema

Only existing domain events — do not invent new ones. Find current `app.log`/`req.log` business calls and normalize them (add `app_*` attributes, keep `message`).

**Files:**
- Modify: whichever `services/users/src/features/users/**` files already emit business logs (e.g. user created / cognito webhook). Locate with grep in Step 1.
- Test: extend `services/users/tests/shared/request-log.test.ts` or the relevant feature test.

**Interfaces:**
- Consumes: the app logger (Task 4).
- Produces: business logs carry `app_*` fields + `message`, plus the common base fields.

- [ ] **Step 1: Locate existing business logs**

Run:
```bash
cd services/users && grep -rnE '\.log\.(info|warn|error)|log\.(info|warn|error)' src/features 2>/dev/null
```
Expected: a list of current business log call sites. If NONE exist (only framework logs), this task is a no-op — record that and skip to Step 4.

- [ ] **Step 2: Normalize each call site**

For each business log found, convert ad-hoc fields to `app_*` and ensure a clear `message`. Example (user created):
```ts
req.log.info({ app_user_id: user.id, app_event: "user_created" }, "user created");
```
Keep the wording of `message` human-readable; move IDs/entities to `app_*`.

- [ ] **Step 3: Add/adjust a test asserting the normalized shape**

Add a test that drives the relevant endpoint and asserts the business log has `app_event` and `message` set and no bare/un-prefixed business fields.

- [ ] **Step 4: Run tests**

Run: `cd services/users && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit** (main session, via menu)

Staged: modified feature files + test.
Message: `refactor(users): normalize business-event logs to the shared schema`

---

### Task 6: Add Serilog schema logging to `orders`

The biggest change — `orders` currently logs plain text. Add Serilog with a JSON formatter that emits the `snake_case` schema.

**Files:**
- Modify: `services/orders/src/Orders.Api/Orders.Api.csproj` (add Serilog packages)
- Create: `services/orders/src/Orders.Api/Logging/SchemaLogFormatter.cs`
- Modify: `services/orders/src/Orders.Api/Program.cs` (wire Serilog)
- Test: `services/orders/tests/Orders.Tests/Logging/SchemaLogFormatterTests.cs`

**Interfaces:**
- Produces: all `orders` logs are single-line JSON with `severity_text`, `severity_number`, `service_name`, `deployment_environment`, `message`, `timestamp`.

- [ ] **Step 1: Add Serilog packages**

In `services/orders/src/Orders.Api/Orders.Api.csproj`, add:
```xml
    <PackageReference Include="Serilog.AspNetCore" Version="8.0.3" />
    <PackageReference Include="Serilog.Formatting.Compact" Version="3.0.0" />
```
Run: `cd services/orders && dotnet restore`
Expected: restore succeeds.

- [ ] **Step 2: Write the failing formatter test**

Create `services/orders/tests/Orders.Tests/Logging/SchemaLogFormatterTests.cs`:
```csharp
using System.IO;
using System.Text.Json;
using Serilog.Events;
using Serilog.Parsing;
using Orders.Api.Logging;
using Xunit;

public class SchemaLogFormatterTests
{
    [Fact]
    public void Emits_snake_case_otel_schema()
    {
        var formatter = new SchemaLogFormatter(serviceName: "orders", environment: "local");
        var evt = new LogEvent(
            DateTimeOffset.UtcNow,
            LogEventLevel.Information,
            exception: null,
            new MessageTemplateParser().Parse("order created"),
            new List<LogEventProperty>());
        using var sw = new StringWriter();
        formatter.Format(evt, sw);
        using var doc = JsonDocument.Parse(sw.ToString());
        var root = doc.RootElement;
        Assert.Equal("INFO", root.GetProperty("severity_text").GetString());
        Assert.Equal(9, root.GetProperty("severity_number").GetInt32());
        Assert.Equal("orders", root.GetProperty("service_name").GetString());
        Assert.Equal("local", root.GetProperty("deployment_environment").GetString());
        Assert.Equal("order created", root.GetProperty("message").GetString());
        Assert.True(root.TryGetProperty("timestamp", out _));
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd services/orders && dotnet test --filter SchemaLogFormatterTests`
Expected: FAIL — `SchemaLogFormatter` does not exist / does not compile.

- [ ] **Step 4: Implement the formatter**

Create `services/orders/src/Orders.Api/Logging/SchemaLogFormatter.cs`:
```csharp
using System.IO;
using System.Text.Json;
using Serilog.Events;
using Serilog.Formatting;

namespace Orders.Api.Logging;

// Emits one JSON line per event in the shared snake_case OTel-aligned schema.
public sealed class SchemaLogFormatter : ITextFormatter
{
    private readonly string _serviceName;
    private readonly string _environment;

    private static readonly Dictionary<LogEventLevel, (string Text, int Number)> Severity = new()
    {
        [LogEventLevel.Verbose] = ("DEBUG", 5),
        [LogEventLevel.Debug] = ("DEBUG", 5),
        [LogEventLevel.Information] = ("INFO", 9),
        [LogEventLevel.Warning] = ("WARN", 13),
        [LogEventLevel.Error] = ("ERROR", 17),
        [LogEventLevel.Fatal] = ("ERROR", 17),
    };

    public SchemaLogFormatter(string serviceName, string environment)
    {
        _serviceName = serviceName;
        _environment = environment;
    }

    public void Format(LogEvent logEvent, TextWriter output)
    {
        var (text, number) = Severity[logEvent.Level];
        using var stream = new MemoryStream();
        using (var w = new Utf8JsonWriter(stream))
        {
            w.WriteStartObject();
            w.WriteString("timestamp", logEvent.Timestamp.UtcDateTime.ToString("o"));
            w.WriteString("severity_text", text);
            w.WriteNumber("severity_number", number);
            w.WriteString("service_name", _serviceName);
            w.WriteString("deployment_environment", _environment);
            w.WriteString("message", logEvent.RenderMessage());
            if (logEvent.Exception is not null)
            {
                w.WriteString("error_type", logEvent.Exception.GetType().Name);
                w.WriteString("error_message", logEvent.Exception.Message);
            }
            // Structured properties: emit as-is (callers use snake_case / app_* keys).
            foreach (var prop in logEvent.Properties)
            {
                w.WritePropertyName(prop.Key);
                w.WriteStringValue(prop.Value.ToString().Trim('"'));
            }
            w.WriteEndObject();
        }
        output.Write(System.Text.Encoding.UTF8.GetString(stream.ToArray()));
        output.Write('\n');
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd services/orders && dotnet test --filter SchemaLogFormatterTests`
Expected: PASS.

- [ ] **Step 6: Wire Serilog in `Program.cs`**

In `services/orders/src/Orders.Api/Program.cs`, after `var builder = WebApplication.CreateBuilder(args);`, add:
```csharp
using Serilog;
using Orders.Api.Logging;

var environment = builder.Configuration["DEPLOYMENT_ENVIRONMENT"] ?? "local";
builder.Host.UseSerilog((ctx, cfg) => cfg
    .MinimumLevel.Information()
    .WriteTo.Console(new SchemaLogFormatter("orders", environment)));
```

- [ ] **Step 7: Build and full test run**

Run: `cd services/orders && dotnet build && dotnet test`
Expected: build succeeds, all tests PASS.

- [ ] **Step 8: Commit** (main session, via menu)

Staged: csproj, `SchemaLogFormatter.cs`, `Program.cs`, formatter test.
Message: `feat(orders): structured JSON logging via Serilog schema formatter`

---

### Task 7: Add request logging + business-event logs to `orders`

Serilog request middleware (method/route/status/duration/trace_id) and normalize existing business logs.

**Files:**
- Modify: `services/orders/src/Orders.Api/Program.cs` (add `UseSerilogRequestLogging` with enrichers)
- Modify: existing business-log call sites in `services/orders/src/**` (locate in Step 1)
- Test: `services/orders/tests/Orders.Tests/Logging/RequestLogTests.cs` (via `OrdersApiFactory`)

**Interfaces:**
- Consumes: Serilog setup (Task 6), the existing `OrdersApiFactory` test harness.
- Produces: each HTTP response emits a request log with `http_request_method`, `http_route`, `http_response_status_code`, `duration_ms`, `trace_id`.

- [ ] **Step 1: Locate existing business logs**

Run:
```bash
cd services/orders && grep -rnE 'ILogger|_logger\.|Log\.(Information|Error|Warning)' src 2>/dev/null | grep -v Migrations
```
Expected: current business log sites (e.g. order created). If none, the business-log part is a no-op — record and cover only request logging.

- [ ] **Step 2: Add request-logging middleware**

In `Program.cs`, after `var app = builder.Build();`, add:
```csharp
app.UseSerilogRequestLogging(options =>
{
    options.MessageTemplate = "request completed";
    options.EnrichDiagnosticContext = (diag, http) =>
    {
        diag.Set("http_request_method", http.Request.Method);
        diag.Set("http_route", http.GetEndpoint()?.DisplayName ?? http.Request.Path.Value);
        diag.Set("http_response_status_code", http.Response.StatusCode);
        diag.Set("trace_id", http.TraceIdentifier);
    };
});
```
NOTE: `UseSerilogRequestLogging` emits `duration_ms` equivalent as `Elapsed`. Add `duration_ms` explicitly by setting `diag.Set("duration_ms", ...)` is not available pre-completion; instead rely on Serilog's `Elapsed` property and map it in the formatter, OR set `options.GetLevel` untouched and post-process. Simplest correct path: keep Serilog's built-in elapsed and add a property rename in `SchemaLogFormatter` so a property named `Elapsed`/`ElapsedMilliseconds` is emitted as `duration_ms`. Implement that rename in the formatter's property loop (map key `Elapsed`/`ElapsedMilliseconds` → `duration_ms`, numeric).

- [ ] **Step 3: Write the request-log test**

Create `services/orders/tests/Orders.Tests/Logging/RequestLogTests.cs` using `OrdersApiFactory` to issue a request and assert the emitted log (captured via a test sink or by pointing Serilog at an in-memory `TextWriter`) contains `http_route`, `http_request_method`, `http_response_status_code`, `duration_ms`, `trace_id`.

IMPLEMENTATION NOTE: if capturing Serilog output in-test is awkward with `OrdersApiFactory`, assert via a custom `ITextFormatter`-backed `StringWriter` sink registered in the test host's Serilog config. Show the wiring in the test.

- [ ] **Step 4: Normalize business logs**

Convert located business logs to `app_*` + clear `message` (e.g. `_logger.LogInformation("order created {app_order_id}", order.Id)` with message-template properties that land as `app_order_id`).

- [ ] **Step 5: Build and test**

Run: `cd services/orders && dotnet build && dotnet test`
Expected: PASS.

- [ ] **Step 6: Commit** (main session, via menu)

Staged: `Program.cs`, business files, `RequestLogTests.cs`, formatter rename.
Message: `feat(orders): request logging + business-event logs in the shared schema`

---

### Task 8: End-to-end verification of the schema in OpenObserve

Before dashboards, prove both services' logs land as columns. No dashboards can be trusted until this passes.

**Files:** none (verification task). Optionally create: `observability/dashboards/VERIFY.md` capturing the working queries.

- [ ] **Step 1: Rebuild and restart both services + collector**

Run:
```bash
docker compose up -d --build users orders
docker compose --profile observability up -d --force-recreate otel-collector openobserve
sleep 8
```

- [ ] **Step 2: Generate traffic to both**

Run:
```bash
for i in $(seq 1 10); do curl -s -o /dev/null http://localhost:3000/health; curl -s -o /dev/null http://localhost:3001/; done
sleep 15
```

- [ ] **Step 3: Query per-service columns**

Run:
```bash
AUTH="YWRtaW5AM21yYWkubG9jYWw6Q29tcGxleHBhc3MjMTIz"
NOW=$(python3 -c 'import time;print(int(time.time()*1_000_000))')
START=$(python3 -c 'import time;print(int((time.time()-1800)*1_000_000))')
for svc in users orders; do
  echo "--- $svc ---"
  curl -s -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
    "http://localhost:5080/api/default/_search?type=logs" \
    -d "{\"query\":{\"sql\":\"SELECT COUNT(*) n, MAX(http_response_status_code) st FROM logs WHERE service_name='$svc'\",\"start_time\":$START,\"end_time\":$NOW}}"
done
```
Expected: for BOTH `users` and `orders`, `n > 0` and `st` populated — i.e. `service_name` and `http_response_status_code` are real columns for both services.

- [ ] **Step 4: Record the working queries**

Write the confirmed SQL (request rate, error count, latency percentiles) into `observability/dashboards/VERIFY.md` — these become the panel queries in Tasks 9–10.

- [ ] **Step 5: Commit** (main session, via menu)

Staged: `observability/dashboards/VERIFY.md`.
Message: `test(observability): verify both services emit the schema as OpenObserve columns`

---

### Task 9: Per-service dashboards (users + orders) as versioned JSON

**Files:**
- Create: `observability/dashboards/users.dashboard.json`
- Create: `observability/dashboards/orders.dashboard.json`

**Interfaces:**
- Consumes: the real dashboard JSON shape (Task 1 README) and the verified queries (Task 8 VERIFY.md).

- [ ] **Step 1: Author `users.dashboard.json`**

Using the real template from Task 1, create a dashboard filtered to `service_name='users'` with panels: request rate (timeseries), errors by `http_response_status_code`, latency p50/p95/p99 of `duration_ms`, top `http_route` by volume and latency, recent errors table (`error_type`/`error_message`). Use the exact SQL from `VERIFY.md`.

- [ ] **Step 2: Author `orders.dashboard.json`**

Same panel set filtered to `service_name='orders'`, plus one business panel (orders created/min) using the `app_*` field confirmed in Task 7. If no business event exists yet, omit that panel and note it.

- [ ] **Step 3: Validate the JSON parses**

Run: `for f in observability/dashboards/*.dashboard.json; do python3 -m json.tool "$f" > /dev/null && echo "$f OK"; done`
Expected: both print `OK`.

- [ ] **Step 4: Commit** (main session, via menu)

Staged: the two dashboard JSON files.
Message: `feat(observability): per-service golden-signals dashboards (users, orders)`

---

### Task 10: Global overview dashboard + idempotent bootstrap

**Files:**
- Create: `observability/dashboards/overview.dashboard.json`
- Create: `scripts/import-dashboards.mjs`
- Modify: `Makefile` (add `observability-dashboards` target)

**Interfaces:**
- Consumes: dashboard JSON files (Tasks 9–10), the import endpoint from Task 1 README.
- Produces: `make observability-dashboards` imports/updates all dashboards idempotently.

- [ ] **Step 1: Author `overview.dashboard.json`**

Cross-service panels: request volume per `service_name` (side by side), error rate per service, p95 latency per service, error count per service (last hour). SQL groups by `service_name`.

- [ ] **Step 2: Write the import script**

Create `scripts/import-dashboards.mjs` that reads every `observability/dashboards/*.dashboard.json`, and for each POSTs to `http://localhost:5080/api/default/dashboards` with the Basic-auth header. Idempotent: first GET the existing dashboards; if one matches by title, use the update path (PUT/POST with its id per the Task 1 README); else create. Read creds from env with the runbook defaults as fallback:
```js
const AUTH = process.env.O2_BASIC_AUTH ?? "YWRtaW5AM21yYWkubG9jYWw6Q29tcGxleHBhc3MjMTIz";
const BASE = process.env.O2_URL ?? "http://localhost:5080";
```
Use only Node built-ins (`fs`, `fetch`) — no new deps. Log each dashboard as `created` or `updated`.

- [ ] **Step 3: Add the Make target**

In `Makefile`, add (mirror the `observability-up` style, add to `.PHONY`):
```makefile
observability-dashboards: ## Import/update OpenObserve dashboards from observability/dashboards/*.json
	nvm use >/dev/null 2>&1 || true
	node scripts/import-dashboards.mjs
```

- [ ] **Step 4: Run the bootstrap twice (idempotency check)**

Run:
```bash
nvm use && make observability-dashboards && make observability-dashboards
```
Expected: first run reports `created` for each dashboard; second run reports `updated` (NOT duplicated). Confirm in the UI that exactly one of each dashboard exists.

- [ ] **Step 5: Verify dashboards render with live data**

Generate traffic (Task 8 Step 2), open each dashboard in the UI, confirm panels show data.

- [ ] **Step 6: Commit** (main session, via menu)

Staged: `overview.dashboard.json`, `scripts/import-dashboards.mjs`, `Makefile`.
Message: `feat(observability): overview dashboard + idempotent dashboard bootstrap`

---

### Task 11: Update the runbook and spec scope note

**Files:**
- Modify: `docs/shared/observability/openobserve-runbook.md` (route through `obsidian-vault`)
- Modify: `docs/superpowers/specs/2026-07-16-structured-logging-and-dashboards-design.md` (scope note — route through `obsidian-vault`)

- [ ] **Step 1: Runbook — document viewing dashboards**

Via the `obsidian-vault` agent: add a section to the runbook covering `make observability-dashboards`, where the JSON lives, how to add a panel (edit JSON → re-run target), and that dashboards are logs-derived (no metrics). Keep the existing gotchas.

- [ ] **Step 2: Spec — record implemented scope**

Via `obsidian-vault`: add a one-line note to the spec that immediate implementation covered `users` + `orders`; `tracking` + `events-pipeline` adopt the schema when built.

- [ ] **Step 3: Validate the vault**

Run: `nvm use && node scripts/validate-vault.mjs`
Expected: `Vault validation passed`.

- [ ] **Step 4: Commit** (main session, via menu)

Staged: runbook + spec.
Message: `docs(observability): document dashboards workflow and implemented scope`

---

## Self-Review

**Spec coverage:**
- Log schema (snake_case, OTel-aligned) → Tasks 3, 6 (define), 4, 7 (emit). ✓
- Automatic request logging + correlation id → Tasks 4 (users), 7 (orders). ✓
- Business events re-written → Tasks 5 (users), 7 (orders). ✓
- Collector-side parsing → Task 2. ✓
- Per-service + global dashboards, versioned JSON, idempotent bootstrap → Tasks 1, 9, 10. ✓
- Verification via `_search` not stream-stats → Tasks 2, 8. ✓
- Gap acknowledged: `tracking` + `events-pipeline` are scaffold-only → deferred by the Scope Note, recorded in Task 11. This is an intentional, user-approved scope reduction, not an omission.

**Placeholder scan:** No "TBD"/"handle edge cases". The two "if none exist, no-op" branches (Tasks 5, 7 Step 1) are explicit conditional instructions with a defined outcome, not placeholders.

**Type consistency:** `buildLoggerOptions({ serviceName, environment })` and `SEVERITY_NUMBER` are consistent across Tasks 3–4. `SchemaLogFormatter(serviceName, environment)` consistent across Tasks 6–7. Field names match the Global Constraints list everywhere. `duration_ms` sourcing is called out explicitly in Task 7 Step 2.

**Risk sequencing:** The two spec risks (collector processor availability, dashboard JSON format) are Tasks 2 and 1 respectively — both have explicit fallbacks and run before dependent work.

## Related

- [[2026-07-16-structured-logging-and-dashboards-design]]
- [[ADR-0018-observability-openobserve]]
- [[openobserve-runbook]]
