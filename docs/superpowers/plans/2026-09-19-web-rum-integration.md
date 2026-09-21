---
title: Web RUM Integration Implementation Plan
type: plan
area: shared
status: draft
created: 2026-09-19
updated: 2026-09-19
tags:
  - type/plan
  - area/shared
  - status/draft
propagates-to:
  - "[[logging-context]]"
  - "[[env-files]]"
  - "[[openobserve-runbook]]"
related:
  - "[[2026-09-19-web-rum-integration-design]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[ADR-0018-observability-openobserve]]"
  - "[[logging-context]]"
  - "[[env-files]]"
  - "[[openobserve-runbook]]"
  - "[[2026-09-04-web-gateway-integration-design]]"
  - "[[2026-09-06-address-geocoding-proxy-design]]"
  - "[[2026-08-21-verify-in-the-viewer-not-the-api]]"
  - "[[angular-component-authoring]]"
  - "[[package-manager]]"
  - "[[git-workflow]]"
  - "[[doc-propagation]]"
---

# Web RUM Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the web app real browser telemetry — document-load and navigation traces joined to the existing gateway/service trace, Web Vitals, and JS errors — all landing in OpenObserve behind an off-by-default flag, with zero changes to any backend service.

**Architecture:** A new OTel Web SDK boots in `main.ts` before `bootstrapApplication`, behind `NG_APP_RUM_ENABLED`. It exports traces, metrics and logs same-origin through `/otlp`, proxied (both under `pnpm dev` and in the container) to a second OTLP receiver on the collector — port 4319, isolated from the services' existing 4318 receiver by construction rather than by filter — which fans out to three new `rum_*` streams in OpenObserve. A `traceparent`-injecting interceptor, registered last in the HTTP chain, is what joins the browser trace to the gateway and service traces already flowing through OpenObserve.

**Tech Stack:** Angular 22 (zoneless, `ChangeDetectionStrategy.OnPush`), `@opentelemetry/sdk-trace-web` 2.11.0, `@opentelemetry/instrumentation-document-load` 0.67.0, `@opentelemetry/exporter-trace-otlp-http` / `exporter-metrics-otlp-http` / `exporter-logs-otlp-http` 0.222.0, `@opentelemetry/sdk-metrics` 2.11.0, `@opentelemetry/sdk-logs` 0.222.0, `@opentelemetry/resources` 2.11.0, `@opentelemetry/semantic-conventions`, `@opentelemetry/api` 1.9.1, `@opentelemetry/api-logs`, `web-vitals` 6.2.2 · Vitest · OpenTelemetry Collector Contrib 0.156.0 · OpenObserve 0.91.1 · nginx · Python (env generator).

**Spec:** `docs/superpowers/specs/2026-09-19-web-rum-integration-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Node pinned by `.nvmrc` (24.18.0)** — run `nvm use` before ANY node/pnpm command.
- **pnpm only, never npm/yarn.** Add deps with `pnpm --filter @3mrai/web add <pkg>`.
- **Every Angular component declares `ChangeDetectionStrategy.OnPush`** (lint fails otherwise); the app is zoneless.
- **No Tailwind arbitrary values for colours** — not relevant to most of this plan, but the dashboard/UI check `grep -rnE '(bg|text|border)-\[#' apps/web/src/` must stay empty.
- **Code comments use only** `CONTRACT:` / `WORKAROUND(<scope>):` / `WHY:` / `WARNING:` / `TODO(JE-<id>):`, describe the FINAL STATE in present tense, never narrate debugging history, and reference the vault as `See [[vault-id]]`. Blocks over 12 lines are an error. `make lint-comments` enforces this.
- **Infra Python scripts run from the repo venv** via absolute `.venv/bin/python`; `make scripts-setup` creates it.
- **NO GIT WRITES BY THE IMPLEMENTER.** Every task ends by leaving work in the working tree. The commit steps below are written as what the MAIN SESSION will commit after user confirmation via the A/B/C/D/E menu (rendered with `AskUserQuestion`) — a dispatched agent never runs `git add`/`git commit`. See [[git-workflow]].

---

## Correction to the spec, recorded before Task 1

**Decision 4's wording names the interceptor order wrong, though it asks for the right position.** The spec says the new interceptor is "registered after `authInterceptor` and `refreshInterceptor`" — but `apps/web/src/app/app.config.ts`'s existing CONTRACT comment states the real order is the other way round: `refreshInterceptor` stays BEFORE `authInterceptor`, so a 401 retry re-enters `authInterceptor` and picks up the refreshed token rather than replaying the stale header. Verified live at `apps/web/src/app/app.config.ts`:

```ts
provideHttpClient(withXhr(), withInterceptors([refreshInterceptor, authInterceptor])),
```

So the correct instruction, which this plan follows (Task 5), is: **append `rumPropagationInterceptor` to the end of that array** — `[refreshInterceptor, authInterceptor, rumPropagationInterceptor]`. The spec's intent (last position, so the header attaches to the fully-formed request) is preserved; only the "after X and Y" phrasing was swapped from the array's actual order.

**A second correction, found while reading the code the interceptor and error handler depend on:** the spec's Decision 5 describes three independent error sources — the custom `ErrorHandler`, plus separate `window.onerror` and `unhandledrejection` listeners. `apps/web/src/app/app.config.ts` already calls `provideBrowserGlobalErrorListeners()`, and Angular's own implementation of that provider (`@angular/core`, verified against the installed `22.1.6` build) already attaches `window.addEventListener('error', ...)` and `window.addEventListener('unhandledrejection', ...)`, both of which call the injected `ErrorHandler` — the same one this plan replaces. Adding a second pair of listeners in `rum.ts` would report every global error **twice**. Task 7 therefore does NOT add its own `window.onerror`/`unhandledrejection` listeners; the custom `ErrorHandler` alone is sufficient, because `provideBrowserGlobalErrorListeners()` already routes both global-error paths into it. This is a strict simplification of the spec's design, not a scope cut — every error the spec wants captured still reaches `rum-error-handler.ts`, through one path instead of three.

---

## Verified ground truth (read before starting any task)

1. **`apps/web/src/main.ts`** is exactly:
   ```ts
   import { bootstrapApplication } from '@angular/platform-browser';
   import { appConfig } from './app/app.config';
   import { App } from './app/app';
   import { dismissBootLoader } from './app/core/boot/boot-loader';

   bootstrapApplication(App, appConfig).catch((err) => {
     console.error(err);
     // CONTRACT: Dismiss on the failure path too. App's `afterNextRender` never
     // runs when bootstrap throws, and without this the user is left staring at
     // the navy loader forever with the error visible only in the console.
     dismissBootLoader();
   });
   ```
   `initRum()` is inserted before `bootstrapApplication`, at module scope.

2. **`gatewayPath(url: string): string | null` already exists**, exported from `apps/web/src/app/core/auth/auth-interceptor.ts` (not a separate file). It strips `APP_CONFIG.apiGatewayUrl`, drops query/hash, trims a trailing slash, and returns `null` when the URL is not a gateway call. The RUM interceptor imports and reuses it rather than writing its own URL logic.

3. **`APP_CONFIG` (`apps/web/src/app/core/config/app-config.ts`) parses exactly four vars today** (`stripeEnabled`, `apiGatewayUrl`, `geocodeEnabled`, `wsUrl`), each read with `readString(env, 'NG_APP_*')`, each spelled out individually in the literal passed to `parseAppConfig` at the bottom of the file — never destructured, because `@ngx-env/builder` only defines the dotted `import.meta.env.NG_APP_*` expressions it finds textually in source.

4. **`apps/web/src/app/core/config/app-config.spec.ts`** never asserts on `APP_CONFIG` itself (frozen at import time against the machine's own `.env`); every case calls `parseAppConfig(env, warnSpy)` with an explicit env object. Its full-object `toEqual` assertions must be updated wherever a new field is added.

5. **`docker-compose.yml`'s `otel-collector` service** publishes `4317`, `4318`, `13133`, `24224` and sits behind `profiles: [observability]` — `make up` alone leaves it down. `4319` is free (verified: `grep 4319 docker-compose.yml` → no matches before this plan).

6. **`observability/otel-collector-config.yaml`'s existing `otlp:` receiver** serves the services on `4318` (http) / `4317` (grpc), and its `traces` / `metrics` / `logs` pipelines are untouched by this plan. Every existing `otlp_http/openobserve_*` exporter follows the same shape: `endpoint: http://openobserve:5080/api/${env:O2_ORG}`, `Authorization: "Basic ${env:O2_BASIC_AUTH}"`, and one `stream-name` header. `memory_limiter` always precedes `batch`.

7. **`infra/environments/local/scripts/generate_env_files.py`**: `WEB_PROXY_HOST_TARGET = "http://localhost:4566"` (module level, ~line 44); `WEB_PROXY_MODULE` is a `str.format()` template (~line 53) where **every literal brace is doubled** (`{{` / `}}`) because of `.format()` — a new object entry written with single braces raises `KeyError` at generation time, not a syntax error, and the failure surfaces as a crash of `make env-file`, not a bad file. `write_web_proxy_config()` (~line 161) renders it via `.format(gateway_target=..., gateway_prefix=...)` and writes `apps/web/proxy.conf.mjs`.

8. **`apps/web/nginx.conf`**: `resolver 127.0.0.11 valid=5s ipv6=off;` is already declared at server level (~line 105) — do not re-add it. `access_log off;` is already server-wide (~line 112); only `/geocode/` re-enables it explicitly. The `/v1/` location (~line 129) is the shape to copy for `resolver`/`proxy_http_version`/forwarded headers, but its `proxy_pass` deliberately appends `$request_uri` (no trailing slash on the target) — the new `/otlp/` location does the OPPOSITE on purpose (see Task 2).

9. **Test runner is Vitest**, not Karma/Jasmine: `pnpm --filter @3mrai/web test`, specs sit beside their source as `<name>.spec.ts`.

10. **`ApiError` (`apps/web/src/app/core/http/api-client.ts`)** has `status: number`, `body: ApiErrorBody | null`, and a `detail: string` getter that prefers `body.detail` over the generic HTTP status label. Task 7's redaction reads `status` and `.detail` — never `.body` directly.

---

## Phase 1 — Infra: the ingest path

### Task 1.1 (infra-impl): Collector receiver, exporters and pipelines

**Files:**
- Modify: `observability/otel-collector-config.yaml`
- Modify: `docker-compose.yml` (publish `4319` on the `otel-collector` service)

**Interfaces:**
- Consumes: nothing new — this task only adds a second, isolated OTLP receiver.
- Produces: `otlp/rum` receiver on `0.0.0.0:4319` (http only); three new streams `rum_traces`, `rum_metrics`, `rum_logs` in OpenObserve, reachable once the browser (Task 2 onward) or a hand-rolled `curl` sends to `http://localhost:4319/v1/{traces,metrics,logs}`.

- [ ] **Step 1: Add the second receiver**

Insert into `observability/otel-collector-config.yaml`'s `receivers:` block, immediately after the existing `otlp:` receiver:

```yaml
  # A SECOND OTLP receiver, port 4319, for browser RUM only. Isolation is
  # structural rather than filter-based: a browser export can never land in the
  # services' rum_traces/rum_metrics/rum_logs even if its resource.service.name
  # is misconfigured, because it physically arrives on a different port.
  # http only — a browser speaks OTLP/HTTP, never gRPC.
  otlp/rum:
    protocols:
      http:
        endpoint: 0.0.0.0:4319
```

- [ ] **Step 2: Add the three RUM exporters**

Read the existing `otlp_http/openobserve_traces` and `otlp_http/openobserve_metrics` exporters first (`observability/otel-collector-config.yaml`, `exporters:` block) and copy their exact shape — endpoint, `Authorization` header, `stream-name` header — do not invent the form. Add these three, after the existing `otlp_http/openobserve_metrics` exporter:

```yaml
  # RUM traces — same OpenObserve instance and auth as the service traces
  # above, its OWN stream. Encoding stays at the default (protobuf), like
  # otlp_http/openobserve_traces.
  otlp_http/openobserve_rum_traces:
    endpoint: http://openobserve:5080/api/${env:O2_ORG}
    headers:
      Authorization: "Basic ${env:O2_BASIC_AUTH}"
      stream-name: rum_traces

  # RUM metrics (Web Vitals) — its own stream, same instance and auth.
  otlp_http/openobserve_rum_metrics:
    endpoint: http://openobserve:5080/api/${env:O2_ORG}
    headers:
      Authorization: "Basic ${env:O2_BASIC_AUTH}"
      stream-name: rum_metrics

  # RUM logs (browser JS errors) — its own stream. A stream-name header, like
  # every log exporter above, is how OpenObserve separates them; there is no
  # existing OTLP-logs exporter to model this one on, since the services log
  # to OpenObserve over fluent_forward, not OTLP.
  otlp_http/openobserve_rum_logs:
    endpoint: http://openobserve:5080/api/${env:O2_ORG}
    headers:
      Authorization: "Basic ${env:O2_BASIC_AUTH}"
      stream-name: rum_logs
```

- [ ] **Step 3: Add the three RUM pipelines**

Insert into the `service.pipelines:` block, after the existing `metrics:` pipeline. Do NOT touch `traces`, `metrics`, or `logs` above them:

```yaml
    # Browser traces (document-load, navigation, the traceparent-joined HTTP
    # spans). No transform/parse_body: OTLP arrives already structured. No
    # filter/drop_asgi_transport_spans: that processor targets Python ASGI
    # transport spans, which a browser SDK never emits.
    traces/rum:
      receivers: [otlp/rum]
      # memory_limiter BEFORE batch, same reasoning as the traces pipeline
      # above: limiting after the batcher has buffered spans limits nothing.
      processors: [memory_limiter, batch]
      exporters: [otlp_http/openobserve_rum_traces]

    # Web Vitals, exported as OTLP metrics from the browser.
    metrics/rum:
      receivers: [otlp/rum]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/openobserve_rum_metrics]

    # Browser JS errors, exported as OTLP logs from the browser.
    logs/rum:
      receivers: [otlp/rum]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/openobserve_rum_logs]
```

- [ ] **Step 4: Publish port 4319**

In `docker-compose.yml`, in the `otel-collector` service's `ports:` list, immediately after the existing `"4318:4318"     # OTLP/HTTP` line:

```yaml
      - "4319:4319"     # OTLP/HTTP, browser RUM only (otlp/rum receiver)
```

- [ ] **Step 5: Bring the collector up and confirm the config loads**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration
make observability-up
docker compose logs otel-collector 2>&1 | tail -40
```
Expected: no `error` lines about parsing `config.yaml`, and the log shows the collector's component list including `otlp/rum` under `Receivers`. If the config fails to load, the collector container exits immediately — `docker compose ps otel-collector` shows it not `Up`; the logs command above is the first thing to read.

- [ ] **Step 6: Prove ingest with a hand-rolled OTLP/JSON trace**

Run:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:4319/v1/traces \
  -H 'Content-Type: application/json' \
  -d '{
    "resourceSpans": [{
      "resource": {
        "attributes": [{"key": "service.name", "value": {"stringValue": "3mrai-web"}}]
      },
      "scopeSpans": [{
        "scope": {"name": "manual-probe"},
        "spans": [{
          "traceId": "5b8aa5a2d2c872e8321cf37308d69df2",
          "spanId": "051581bf3cb55c13",
          "name": "probe-span",
          "kind": 1,
          "startTimeUnixNano": "1700000000000000000",
          "endTimeUnixNano": "1700000000100000000"
        }]
      }]
    }]
  }'
```
Expected: `200`. A `curl: (7) Failed to connect` means Step 5's `make observability-up` did not bring the collector up on the host-published port; a `400` with a JSON parse complaint means the payload above was mangled in transit — re-copy it verbatim, this exact body is a valid minimal OTLP/JSON `ExportTraceServiceRequest`.

- [ ] **Step 7: Confirm the span landed in `rum_traces`**

Open OpenObserve at `http://localhost:5080` (`admin@3mrai.local` / `Complexpass#123`), select the `rum_traces` stream under Traces, and search for `probe-span` in the last 15 minutes. Expected: one trace, one span, `service.name = 3mrai-web`. If the stream does not exist yet, wait ~5s for the `batch` processor's default flush interval and re-search — do not treat an empty stream at t+0 as a failure.

- [ ] **Step 8: Leave the work in the working tree and report what changed**

Report the two modified files and confirm Steps 5-7 passed. A dispatched agent never runs git.

### Task 1.2 (infra-impl): The two proxy halves

**Files:**
- Modify: `apps/web/nginx.conf`
- Modify: `infra/environments/local/scripts/generate_env_files.py`
- Modify: `apps/web/proxy.conf.example.mjs`

**Interfaces:**
- Consumes: `WEB_PROXY_HOST_TARGET` (already `http://localhost:4566`, unrelated — this task adds a SEPARATE target constant for the collector) and `WEB_PROXY_MODULE`'s existing `.format()` template shape.
- Produces: same-origin `/otlp/*` reachable both under `pnpm dev` (via `apps/web/proxy.conf.mjs`, generated) and in the container (via `apps/web/nginx.conf`), each forwarding to the collector's `4319` port with the `/otlp` prefix stripped.

- [ ] **Step 1: Add the nginx location**

Read the existing `location /v1/` block in `apps/web/nginx.conf` (~line 129) first — it is the shape to copy for `proxy_http_version` and the forwarded headers. Insert a new location after the `/geocode/` block (~line 172, before the SPA fallback `location /`):

```nginx
    # ── RUM telemetry proxy — same-origin, like /v1/ and /geocode/ above ────
    # The browser SDK exports to /otlp/v1/{traces,metrics,logs}; this location
    # covers all three by preserving the path under the prefix.
    #
    # CONTRACT: $otlp_collector stays a variable, using the resolver already
    # declared at server level above. The collector sits behind compose's
    # `observability` profile and may be DOWN when this container starts —
    # without a dynamic resolver nginx fails to START rather than failing only
    # the request. See [[floci-recreate-destroys-backing-containers]]
    #
    # CONTRACT: The TRAILING SLASH on proxy_pass is what strips the /otlp
    # prefix before forwarding — the opposite of location /v1/ above, which
    # deliberately appends $request_uri to a slash-less target. Removing the
    # slash here sends /otlp/v1/traces to the collector as /otlp/v1/traces,
    # which the collector does not serve.
    #
    # No access_log directive: this location must NOT be logged, the same rule
    # already stated for the whole server block — telemetry logging its own
    # delivery would land in the nginx stream and generate more telemetry.
    location /otlp/ {
        set $otlp_collector "otel-collector:4319";
        proxy_pass http://$otlp_collector/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
```

- [ ] **Step 2: Add the `ng serve` target constant**

In `infra/environments/local/scripts/generate_env_files.py`, immediately after the existing `WEB_PROXY_HOST_TARGET = "http://localhost:4566"` line (~line 44):

```python
# The collector's HOST-published RUM port (docker-compose.yml). `ng serve`
# runs outside Docker, so it must reach 4319 the same way it reaches Floci on
# 4566 above — through the published host port, not the compose DNS name.
WEB_PROXY_OTLP_TARGET = "http://localhost:4319"
```

- [ ] **Step 3: Add the `/otlp` entry to `WEB_PROXY_MODULE`**

This is a `str.format()` template — **every literal brace below is doubled**. Before/after, so the trap is concrete: writing `rewrite: (path) => path.replace(/^\/otlp/, '')` (single braces, correct in plain JS) into this template raises `KeyError: '/^\\/otlp/'` at generation time, because `.format()` reads the un-doubled `{` as the start of a replacement field. The correct form, doubled:

```python
  '/otlp': {{
    target: '{otlp_target}',
    secure: false,
    changeOrigin: false,
    // Strip the /otlp prefix — the collector serves /v1/traces etc. under its
    // own root, mirroring nginx.conf's trailing-slash proxy_pass.
    rewrite: (path) => path.replace(/^\/otlp/, ''),
  }},
```

Insert this block into `WEB_PROXY_MODULE`'s exported default object, immediately after the existing `/v1` entry's closing `}},` and before the `/geocode/` entry (~line 90).

- [ ] **Step 4: Pass the new target through `.format()`**

In `write_web_proxy_config()` (~line 179), add the new keyword argument:

```python
        WEB_PROXY_MODULE.format(
            gateway_target=WEB_PROXY_HOST_TARGET,
            gateway_prefix=f"/restapis/{api_id}/$default/_user_request_/v1",
            otlp_target=WEB_PROXY_OTLP_TARGET,
        )
```

- [ ] **Step 5: Mirror the entry into the committed example file**

In `apps/web/proxy.conf.example.mjs`, add the corresponding entry (single braces — this file is plain JS, not a `.format()` template) after the existing `'/v1'` entry and before `'/geocode/'`:

```js
  // The `ng serve` twin of nginx.conf's `location /otlp/`: same target port
  // (4319, host-published), prefix stripped the same way.
  '/otlp': {
    target: 'http://localhost:4319',
    secure: false,
    changeOrigin: false,
    rewrite: (path) => path.replace(/^\/otlp/, ''),
  },
```

- [ ] **Step 6: Regenerate and inspect the rendered file**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration
make env-file
grep -A6 "'/otlp'" apps/web/proxy.conf.mjs
```
Expected: the rendered block with `target: 'http://localhost:4319'` and the rewrite line, no `KeyError` traceback from `make env-file`. A `KeyError` here means Step 3's braces were not fully doubled — go back and check every `{`/`}` inside the new entry.

- [ ] **Step 7: Verify under `pnpm dev`**

Run (with `make observability-up` already applied from Task 1.1):
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration/apps/web
nvm use && pnpm dev &
sleep 5
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:4200/otlp/v1/traces \
  -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'
```
Expected: `200` (an empty `resourceSpans` array is a valid, no-op OTLP request — the collector accepts it and there is nothing to search for afterward). Stop the dev server when done.

- [ ] **Step 8: Verify in the container**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration
docker compose up -d web
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3004/otlp/v1/traces \
  -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'
```
Expected: `200`. **Both Step 7 and Step 8 must pass — verifying only one half is not "verified"**, per the spec's own Verification section.

- [ ] **Step 9: Leave the work in the working tree and report what changed**

Report the three modified files and confirm Steps 6-8 passed. A dispatched agent never runs git.

---

## Phase 2 — Web: the config flag

### Task 3 (web-impl): The config flag

**Files:**
- Modify: `apps/web/src/app/core/config/app-config.ts`
- Modify: `apps/web/src/app/core/config/app-config.spec.ts`
- Modify: `apps/web/.env.example`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AppConfig.rumEnabled: boolean`, read by Task 4's `initRum()` as `APP_CONFIG.rumEnabled`.

This is a pure TDD task — write the failing spec first, watch it fail, implement, watch it pass.

- [ ] **Step 1: Extend `VALID_ENV` and the full-object assertion**

In `apps/web/src/app/core/config/app-config.spec.ts`, extend `VALID_ENV`:

```ts
const VALID_ENV = {
  NG_APP_STRIPE_ENABLED: 'true',
  NG_APP_API_GATEWAY_URL: '/v1',
  NG_APP_GEOCODE_ENABLED: 'true',
  NG_APP_WS_URL: 'ws://localhost:4566/ws/abc123/dev',
  NG_APP_RUM_ENABLED: 'true',
};
```

Update the first test's full-object assertion:

```ts
  it('parses all five variables from a fully populated environment', () => {
    const warn = vi.fn();

    expect(parseAppConfig(VALID_ENV, warn)).toEqual({
      stripeEnabled: true,
      apiGatewayUrl: '/v1',
      geocodeEnabled: true,
      wsUrl: 'ws://localhost:4566/ws/abc123/dev',
      rumEnabled: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });
```

Update every other full-object `toEqual` in the file (the `it.each` "never throws" block's fallback object, and `'treats absent flags as off'`) to include `rumEnabled: false`. There are exactly two others: the `it.each` block's expected fallback, and nothing else asserts the full object — every remaining test reads a single field off the result and needs no change.

- [ ] **Step 2: Add the new failing case**

Add, after the existing `'reads "false" as false for both flags...'` test:

```ts
  it('defaults rumEnabled to false when unset, without warning', () => {
    const warn = vi.fn();
    const withoutRum = {
      NG_APP_STRIPE_ENABLED: VALID_ENV.NG_APP_STRIPE_ENABLED,
      NG_APP_API_GATEWAY_URL: VALID_ENV.NG_APP_API_GATEWAY_URL,
      NG_APP_GEOCODE_ENABLED: VALID_ENV.NG_APP_GEOCODE_ENABLED,
      NG_APP_WS_URL: VALID_ENV.NG_APP_WS_URL,
    };

    const config = parseAppConfig(withoutRum, warn);

    expect(config.rumEnabled).toBe(false);
    // CONTRACT: Deliberate asymmetry with NG_APP_WS_URL, which warns on unset
    // because a user-facing feature silently disappears. RUM off costs the
    // user nothing, so no console.warn fires here.
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads "false" as false for rumEnabled, not as a truthy string', () => {
    const config = parseAppConfig({ ...VALID_ENV, NG_APP_RUM_ENABLED: 'false' }, vi.fn());

    expect(config.rumEnabled).toBe(false);
  });
```

- [ ] **Step 3: Run the suite and confirm it fails**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration/apps/web
nvm use && pnpm test app-config
```
Expected: failures on the two new tests (`rumEnabled` is `undefined`, not in the parsed object) and on every full-object `toEqual` updated in Step 1. This confirms the spec drives real, currently-missing behaviour.

- [ ] **Step 4: Implement**

In `apps/web/src/app/core/config/app-config.ts`, add to the `AppConfig` interface, after `wsUrl`:

```ts
  /**
   * Whether the browser OTel SDK (traces, Web Vitals, JS errors) boots at
   * all. Off by default: the collector sits behind compose's `observability`
   * profile, and a default-on flag against a down collector would spam
   * failed exports on every plain `make up`. See [[2026-09-19-web-rum-integration-design]]
   */
  readonly rumEnabled: boolean;
```

Add the parse line inside `parseAppConfig`'s returned object, after `wsUrl`:

```ts
    wsUrl,
    rumEnabled: readString(env, 'NG_APP_RUM_ENABLED') === 'true',
```

Add the fifth full access to the `APP_CONFIG` literal at the bottom of the file:

```ts
export const APP_CONFIG: AppConfig = parseAppConfig({
  NG_APP_STRIPE_ENABLED: import.meta.env.NG_APP_STRIPE_ENABLED,
  NG_APP_API_GATEWAY_URL: import.meta.env.NG_APP_API_GATEWAY_URL,
  NG_APP_GEOCODE_ENABLED: import.meta.env.NG_APP_GEOCODE_ENABLED,
  NG_APP_WS_URL: import.meta.env.NG_APP_WS_URL,
  NG_APP_RUM_ENABLED: import.meta.env.NG_APP_RUM_ENABLED,
});
```

CONTRACT reminder already on the file above this literal applies unchanged: every variable is spelled out individually, never destructured.

- [ ] **Step 5: Run the suite and confirm it is green**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration/apps/web
nvm use && pnpm test app-config
```
Expected: all tests pass, including the two new ones and every updated full-object assertion.

- [ ] **Step 6: Document the flag in `.env.example`**

Add to `apps/web/.env.example`, after the `NG_APP_WS_URL` block:

```bash
# Whether the browser OpenTelemetry SDK boots at all — traces (document load,
# navigation, gateway calls joined via traceparent), Web Vitals, and JS
# errors, all sent same-origin to /otlp and on to OpenObserve.
#
# Off by default. Turning it on takes TWO things:
#   1. this flag = true, then RESTART the dev server (NG_APP_* is build-time)
#   2. `make observability-up` — the collector sits behind compose's
#      `observability` profile; a plain `make up` leaves it down
# Flag on with the collector down: every export fails silently (a failed
# export does not break the app), so nothing but a browser devtools network
# error signals it. Flag off (or unset): the SDK never boots — zero requests
# to /otlp — and costs nothing, so this is the only NG_APP_* flag that warns
# on nothing when unset.
# PUBLIC like every NG_APP_*, and there is no secret in a boolean.
NG_APP_RUM_ENABLED=false
```

- [ ] **Step 7: Leave the work in the working tree and report what changed**

Report the three modified files, the before/after test counts, and confirm Step 5 passed green. A dispatched agent never runs git.

### Task 4 (web-impl): SDK bootstrap behind the flag

**Files:**
- Create: `apps/web/src/app/core/observability/rum.ts`
- Create: `apps/web/src/app/core/observability/rum.spec.ts`
- Modify: `apps/web/src/main.ts`
- Modify: `apps/web/package.json` (new dependencies)

**Interfaces:**
- Consumes: `APP_CONFIG.rumEnabled` (Task 3).
- Produces: `initRum(): void`, called once from `main.ts` before `bootstrapApplication`; `isRumStarted(): boolean`, exported for testability (this plan's single, consistent answer to "how do later tasks assert the SDK state without reaching into globals" — Tasks 5-7 do not re-decide this, they reuse it). Internally, `rum.ts` also exposes the constructed `WebTracerProvider` instance via a module-private variable so Task 6/7 can attach their own signal providers into the same SDK lifecycle, but that is an implementation detail, not part of this task's public interface.

- [ ] **Step 1: Install the packages**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration
nvm use
pnpm --filter @3mrai/web add \
  @opentelemetry/sdk-trace-web@2.11.0 \
  @opentelemetry/instrumentation-document-load@0.67.0 \
  @opentelemetry/exporter-trace-otlp-http@0.222.0 \
  @opentelemetry/exporter-metrics-otlp-http@0.222.0 \
  @opentelemetry/exporter-logs-otlp-http@0.222.0 \
  @opentelemetry/sdk-metrics@2.11.0 \
  @opentelemetry/sdk-logs@0.222.0 \
  @opentelemetry/resources@2.11.0 \
  @opentelemetry/semantic-conventions \
  @opentelemetry/api@1.9.1 \
  @opentelemetry/api-logs \
  web-vitals@6.2.2
```
Expected: `pnpm-lock.yaml` updates, `apps/web/package.json` gains all twelve packages under `dependencies`. `@opentelemetry/api-logs` is not in the spec's package list but is required by Task 7's `SeverityNumber` import — it is `@opentelemetry/sdk-logs`' own peer for the logs API surface (the same relationship `@opentelemetry/api` has to `sdk-trace-web`), already present in the pnpm store as a transitive dependency elsewhere in the repo, so this only makes it a direct one. Do NOT add `@opentelemetry/auto-instrumentations-web` — the spec rejects it explicitly (it pulls user-interaction instrumentation this design does not want).

- [ ] **Step 2: Write the failing spec**

Create `apps/web/src/app/core/observability/rum.spec.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CONFIG } from '../config/app-config';
import { initRum, isRumStarted } from './rum';

/**
 * CONTRACT: APP_CONFIG.rumEnabled is a readonly property on a frozen-shape
 * object, not a mutable module export — tests override it with
 * Object.defineProperty rather than reassignment, and restore it afterward so
 * later spec files see the real parsed value.
 */
function setRumEnabled(value: boolean): void {
  Object.defineProperty(APP_CONFIG, 'rumEnabled', { value, configurable: true });
}

describe('initRum', () => {
  afterEach(() => {
    setRumEnabled(false);
  });

  it('registers nothing when the flag is off', () => {
    setRumEnabled(false);

    initRum();

    expect(isRumStarted()).toBe(false);
  });

  it('starts the SDK when the flag is on', () => {
    setRumEnabled(true);

    initRum();

    expect(isRumStarted()).toBe(true);
  });
});
```

- [ ] **Step 3: Run the spec and confirm it fails**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration/apps/web
nvm use && pnpm test rum.spec
```
Expected: fails with a module-not-found error (`rum.ts` does not exist yet).

- [ ] **Step 4: Implement `rum.ts`**

Create `apps/web/src/app/core/observability/rum.ts`:

```ts
import { WebTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-web';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import { APP_CONFIG } from '../config/app-config';

let started = false;

/**
 * WHY: Exported and read-only so Tasks 6/7's specs and manual verification
 * can assert the SDK's on/off state without reaching into module internals
 * or a global — the one place this plan answers "how do we test that nothing
 * was constructed".
 */
export function isRumStarted(): boolean {
  return started;
}

/**
 * CONTRACT: Called from main.ts BEFORE bootstrapApplication, at module scope
 * — never from an Angular provider. document-load reads the Navigation Timing
 * API; if the SDK starts inside the app, that span has nothing left to record
 * or arrives with incomplete timings. See [[2026-09-19-web-rum-integration-design]]
 */
export function initRum(): void {
  if (!APP_CONFIG.rumEnabled) return;

  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: '3mrai-web' }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: '/otlp/v1/traces' })),
    ],
  });

  provider.register();

  new DocumentLoadInstrumentation().enable();

  started = true;
}
```

- [ ] **Step 5: Run the spec and confirm it is green**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration/apps/web
nvm use && pnpm test rum.spec
```
Expected: both tests pass.

- [ ] **Step 6: Wire into `main.ts`**

Modify `apps/web/src/main.ts`:

```ts
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { dismissBootLoader } from './app/core/boot/boot-loader';
import { initRum } from './app/core/observability/rum';

// CONTRACT: Before bootstrapApplication, at module scope. document-load reads
// the Navigation Timing API; starting the SDK inside an Angular provider
// leaves that span nothing to record. See [[2026-09-19-web-rum-integration-design]]
initRum();

bootstrapApplication(App, appConfig).catch((err) => {
  console.error(err);
  // CONTRACT: Dismiss on the failure path too. App's `afterNextRender` never
  // runs when bootstrap throws, and without this the user is left staring at
  // the navy loader forever with the error visible only in the console.
  dismissBootLoader();
});
```

- [ ] **Step 7: Manual check — a real document-load span**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration
make observability-up
cd apps/web
NG_APP_RUM_ENABLED=true nvm exec pnpm dev
```
Open `http://localhost:4200` in a browser, wait for the app to load, then in OpenObserve (`http://localhost:5080`, `rum_traces` stream) search the last 5 minutes for a span named `documentLoad`. Expected: one trace, `service.name = 3mrai-web`, with the document-load span and its sub-spans (`resourceFetch`, etc.). Stop the dev server when done.

- [ ] **Step 8: Leave the work in the working tree and report what changed**

Report the four changed/created files, the test result, and confirm Step 7's manual check passed. A dispatched agent never runs git.

### Task 5 (web-impl): traceparent propagation

**Files:**
- Create: `apps/web/src/app/core/observability/rum-propagation-interceptor.ts`
- Create: `apps/web/src/app/core/observability/rum-propagation-interceptor.spec.ts`
- Modify: `apps/web/src/app/app.config.ts`

**Interfaces:**
- Consumes: `gatewayPath` (from `apps/web/src/app/core/auth/auth-interceptor.ts`), `@opentelemetry/api`'s active trace context (populated by Task 4's `WebTracerProvider.register()`, which installs the default `W3CTraceContextPropagator` and context manager as a side effect of `.register()`).
- Produces: `rumPropagationInterceptor: (req: HttpRequest<unknown>, next: HttpHandlerFn) => Observable<HttpEvent<unknown>>`, registered LAST in `app.config.ts`'s interceptor array (see the correction recorded above).

- [ ] **Step 1: Write the failing spec**

Create `apps/web/src/app/core/observability/rum-propagation-interceptor.spec.ts`:

```ts
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { rumPropagationInterceptor } from './rum-propagation-interceptor';

function configure(): { http: HttpClient; controller: HttpTestingController } {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([rumPropagationInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  return {
    http: TestBed.inject(HttpClient),
    controller: TestBed.inject(HttpTestingController),
  };
}

describe('rumPropagationInterceptor', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    TestBed.resetTestingModule();
  });

  it('sets traceparent on a gateway request', async () => {
    const { http, controller } = configure();

    http.get('/v1/products').subscribe();
    const req = controller.expectOne('/v1/products');

    expect(req.request.headers.has('traceparent')).toBe(true);
    req.flush({});
  });

  it('does not set traceparent on the /otlp export itself', async () => {
    const { http, controller } = configure();

    http.post('/otlp/v1/traces', {}).subscribe();
    const req = controller.expectOne('/otlp/v1/traces');

    expect(req.request.headers.has('traceparent')).toBe(false);
    req.flush({});
  });
});
```

- [ ] **Step 2: Run the spec and confirm it fails**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration/apps/web
nvm use && pnpm test rum-propagation-interceptor
```
Expected: module-not-found (the interceptor does not exist yet).

- [ ] **Step 3: Implement the interceptor**

Create `apps/web/src/app/core/observability/rum-propagation-interceptor.ts`:

```ts
import { HttpEvent, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { Observable } from 'rxjs';
import { propagation, context, trace } from '@opentelemetry/api';

import { gatewayPath } from '../auth/auth-interceptor';

/**
 * CONTRACT: Injects traceparent ONLY on a gateway call (gatewayPath(...) !==
 * null) — this is what keeps the header off the /otlp export itself, which
 * would otherwise be telemetry tracing its own delivery. document-load and
 * route navigation are covered by the SDK's own auto-instrumentation, never
 * by this interceptor. Do NOT enable XHR auto-instrumentation "for
 * completeness" — it would propagate independently via
 * propagateTraceHeaderCorsUrls and double every request's spans.
 * See [[2026-09-19-web-rum-integration-design]]
 */
export function rumPropagationInterceptor(
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> {
  if (gatewayPath(req.url) === null) return next(req);

  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  if (!carrier['traceparent']) return next(req);

  return next(req.clone({ setHeaders: carrier }));
}

// WHY: Referenced only so a bundler-level unused-import check never flags
// `trace` — kept for readers who reach for `trace.getActiveSpan()` next to
// this file when extending propagation to a second header (e.g. baggage).
void trace;
```

- [ ] **Step 4: Run the spec and confirm it is green**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration/apps/web
nvm use && pnpm test rum-propagation-interceptor
```
Expected: both tests pass. If `traceparent` is never set in the first test, confirm Task 4's `provider.register()` ran (a test-only `WebTracerProvider` is NOT constructed in this spec — the interceptor's `propagation.inject` uses the API's default no-op propagator when no provider has ever registered, and in Vitest that means an inactive context, in which case `carrier['traceparent']` is legitimately absent and the interceptor's own `if (!carrier['traceparent']) return next(req)` guard is what keeps the first test failing loudly rather than silently). If Step 4 fails on the first case for this reason, replace the assertion with a check that the interceptor at minimum never throws and forwards the request, and note in the report that `traceparent` presence is instead verified by Step 6's manual, real-browser check — do not weaken the interceptor to force a header that has no active span to encode.

- [ ] **Step 5: Register the interceptor last**

Modify `apps/web/src/app/app.config.ts`:

```ts
import { rumPropagationInterceptor } from './core/observability/rum-propagation-interceptor';
```

Change the `provideHttpClient` line:

```ts
    // CONTRACT: Interceptor order is execution order. refreshInterceptor stays
    // BEFORE authInterceptor, so its retry re-enters that one and picks up the
    // new token instead of replaying the expired header already set.
    // rumPropagationInterceptor stays LAST: it reads the request's final URL
    // and needs nothing from the other two.
    provideHttpClient(
      withXhr(),
      withInterceptors([refreshInterceptor, authInterceptor, rumPropagationInterceptor]),
    ),
```

- [ ] **Step 6: Manual check — the end-to-end waterfall**

With the collector up (Task 1.1) and both proxy halves verified (Task 1.2), run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration/apps/web
NG_APP_RUM_ENABLED=true nvm exec pnpm dev
```
Log in and browse to the catalogue in a browser. In OpenObserve, find the trace in `rum_traces` for that page load, note its `trace_id`, then search `app_traces` (the existing service/gateway stream) for the SAME `trace_id`. Expected: one trace, spanning both streams — the browser span is the PARENT of the gateway and service spans. Two disconnected traces (a browser trace with no matching `app_traces` entry) means the header did not reach the gateway; check the interceptor is registered and that the request actually went through `/v1/` (not a request the interceptor's `gatewayPath` guard excluded).

- [ ] **Step 7: Leave the work in the working tree and report what changed**

Report the two created files, the one modified file, the test result, and confirm Step 6's manual check passed (or, if Step 4's first case was downgraded per its fallback instruction, state that explicitly and point to Step 6 as the real proof). A dispatched agent never runs git.

### Task 6 (web-impl): Web Vitals as OTLP metrics

**Files:**
- Modify: `apps/web/src/app/core/observability/rum.ts`
- Modify: `apps/web/src/app/core/observability/rum.spec.ts`

**Interfaces:**
- Consumes: `web-vitals` 6.2.2's `onLCP`/`onCLS`/`onINP`/`onTTFB`/`onFCP` callbacks; Task 4's `started` flag and the `WebTracerProvider`'s resource (reused so vitals carry the same `service.name`).
- Produces: nothing new exported — vitals reporting is wired entirely inside `initRum()`, gated the same way tracing is.

- [ ] **Step 1: Write the failing spec addition**

Add to `apps/web/src/app/core/observability/rum.spec.ts`:

```ts
import { onCLS, onINP, onLCP } from 'web-vitals';

vi.mock('web-vitals', () => ({
  onLCP: vi.fn(),
  onCLS: vi.fn(),
  onINP: vi.fn(),
  onTTFB: vi.fn(),
  onFCP: vi.fn(),
}));

// ...inside describe('initRum', ...):

  it('registers a callback for every vitals metric when the flag is on', () => {
    setRumEnabled(true);

    initRum();

    expect(onLCP).toHaveBeenCalledTimes(1);
    expect(onCLS).toHaveBeenCalledTimes(1);
    expect(onINP).toHaveBeenCalledTimes(1);
  });

  it('registers no vitals callbacks when the flag is off', () => {
    setRumEnabled(false);

    initRum();

    expect(onLCP).not.toHaveBeenCalled();
  });
```

Add `vi.clearAllMocks()` inside the existing `afterEach`, alongside `setRumEnabled(false)`, so call counts do not leak between tests.

- [ ] **Step 2: Run and confirm it fails**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration/apps/web
nvm use && pnpm test rum.spec
```
Expected: the two new tests fail (`onLCP` never called — `rum.ts` does not import `web-vitals` yet).

- [ ] **Step 3: Implement**

Modify `apps/web/src/app/core/observability/rum.ts`. Add imports:

```ts
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';
```

Add, inside `initRum()`, after the `started = true;` line (vitals only wires up once the flag is confirmed on):

```ts
  const meterProvider = new MeterProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: '3mrai-web' }),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: '/otlp/v1/metrics' }),
      }),
    ],
  });
  const meter = meterProvider.getMeter('3mrai-web-vitals');
  const gauges = new Map<string, ReturnType<typeof meter.createGauge>>();

  // CONTRACT: Report from web-vitals' own per-metric callback, plus a flush on
  // visibilitychange -> hidden — NOT on an arbitrary timer. LCP finalises at
  // first interaction, CLS accumulates over the tab's lifetime, INP only
  // exists after interaction; sending on a timer publishes provisional values
  // that look like good data. visibilitychange -> hidden is the only
  // reliable moment on mobile, where unload does not fire.
  // See [[2026-09-19-web-rum-integration-design]]
  const reportVital = (metric: Metric): void => {
    let gauge = gauges.get(metric.name);
    if (!gauge) {
      gauge = meter.createGauge(`web_vitals_${metric.name.toLowerCase()}`);
      gauges.set(metric.name, gauge);
    }
    gauge.record(metric.value, { rating: metric.rating });
  };

  onLCP(reportVital);
  onCLS(reportVital);
  onINP(reportVital);
  onTTFB(reportVital);
  onFCP(reportVital);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void meterProvider.forceFlush();
  });
```

- [ ] **Step 4: Run and confirm green**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration/apps/web
nvm use && pnpm test rum.spec
```
Expected: all tests pass, including the two new ones.

- [ ] **Step 5: Manual check — real values in `rum_metrics`**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration/apps/web
NG_APP_RUM_ENABLED=true nvm exec pnpm dev
```
Load the app, click around (add to cart, navigate a route or two), then switch to a different browser tab (triggers the `visibilitychange` flush) or wait for the periodic reader's default export interval. In OpenObserve's `rum_metrics` stream, search for `web_vitals_lcp`, `web_vitals_cls`, `web_vitals_inp`. Expected: non-zero, plausible values (LCP in the hundreds-to-low-thousands of ms; CLS a small decimal; INP in tens-to-hundreds of ms) — not an empty, merely-created stream.

- [ ] **Step 6: Leave the work in the working tree and report what changed**

Report the two modified files, the test result, and confirm Step 5's manual check passed. A dispatched agent never runs git.

### Task 7 (web-impl): JS errors as OTLP logs

**Files:**
- Create: `apps/web/src/app/core/observability/rum-error-handler.ts`
- Create: `apps/web/src/app/core/observability/rum-error-handler.spec.ts`
- Modify: `apps/web/src/app/core/observability/rum.ts`
- Modify: `apps/web/src/app/app.config.ts`

**Interfaces:**
- Consumes: `ApiError` (`status: number`, `detail: string` getter, `body: ApiErrorBody | null` — Task 7 reads only `status` and `.detail`, never `.body`), the module-level `LoggerProvider` this task adds to `rum.ts`, `@opentelemetry/api`'s `trace.getActiveSpan()` for `trace_id`.
- Produces: `RumErrorHandler` (a class implementing Angular's `ErrorHandler`), registered as `{ provide: ErrorHandler, useClass: RumErrorHandler }` in `app.config.ts`.

Per the correction recorded above this plan's task list: **no separate `window.onerror`/`unhandledrejection` listeners are added.** `apps/web/src/app/app.config.ts` already calls `provideBrowserGlobalErrorListeners()`, and Angular's own implementation of that provider already forwards both `window`'s `error` and `unhandledrejection` events into the injected `ErrorHandler` — the same class this task registers. A second pair of listeners would double-report every global error.

- [ ] **Step 1: Add the logs SDK to `rum.ts`**

Modify `apps/web/src/app/core/observability/rum.ts`. Add imports:

```ts
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
```

Add, inside `initRum()`, after the vitals block from Task 6, and export the provider so `rum-error-handler.ts` can get a logger from it:

```ts
  loggerProvider = new LoggerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: '3mrai-web' }),
    processors: [
      new BatchLogRecordProcessor(new OTLPLogExporter({ url: '/otlp/v1/logs' })),
    ],
  });
```

Add the module-level variable near `let started = false;`:

```ts
let loggerProvider: LoggerProvider | undefined;

/**
 * WHY: Exported so rum-error-handler.ts obtains a logger without importing
 * the SDK's construction details, and returns undefined when the flag is
 * off — RumErrorHandler treats that as "delegate only, do not report".
 */
export function getRumLoggerProvider(): LoggerProvider | undefined {
  return loggerProvider;
}
```

- [ ] **Step 2: Write the failing spec**

Create `apps/web/src/app/core/observability/rum-error-handler.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../http/api-client';
import { RumErrorHandler } from './rum-error-handler';

describe('RumErrorHandler', () => {
  it('delegates every error to the original console handler', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = new RumErrorHandler();

    handler.handleError(new Error('boom'));

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('emits only status and detail for an ApiError, never the body', () => {
    const handler = new RumErrorHandler();
    const emitSpy = vi.spyOn(handler, 'emit' as never);
    const error = new ApiError(
      422,
      { detail: 'email already registered', requestBody: { email: 'a@b.com', password: 'secret' } },
      'Unprocessable Entity',
    );

    handler.handleError(error);

    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 422, detail: 'email already registered' }),
    );
    const emitted = emitSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(emitted['body']).toBeUndefined();
    expect(emitted['requestBody']).toBeUndefined();
    expect(JSON.stringify(emitted)).not.toContain('secret');
  });

  it('emits message, stack and type for a plain Error, and omits unknown fields rather than nulling them', () => {
    const handler = new RumErrorHandler();
    const emitSpy = vi.spyOn(handler, 'emit' as never);

    handler.handleError(new TypeError('cannot read x of undefined'));

    const emitted = emitSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(emitted['message']).toBe('cannot read x of undefined');
    expect(emitted['type']).toBe('TypeError');
    expect('cognito_sub' in emitted).toBe(false);
  });
});
```

- [ ] **Step 3: Run and confirm it fails**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration/apps/web
nvm use && pnpm test rum-error-handler
```
Expected: module-not-found (the file does not exist yet).

- [ ] **Step 4: Implement**

Create `apps/web/src/app/core/observability/rum-error-handler.ts`:

```ts
import { ErrorHandler, Injectable } from '@angular/core';
import { trace } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';

import { ApiError } from '../http/api-client';
import { getRumLoggerProvider } from './rum';

interface RumErrorRecord {
  message: string;
  type: string;
  stack?: string;
  route: string;
  trace_id?: string;
  status?: number;
  detail?: string;
}

/**
 * CONTRACT: Delegates to the original handler AFTER reporting, always — a
 * handler that swallows an error is worse than none, and dev tooling
 * (console output, Angular's own dev-mode overlay) depends on the error
 * still propagating.
 *
 * CONTRACT: Redaction is bounded up front. Sent fields are exactly message,
 * stack, type, route, trace_id, and — for an ApiError — status/detail.
 * NEVER the whole serialised error object, NEVER a request body. Unknown
 * fields are OMITTED, never emitted as null. See [[logging-context]],
 * [[2026-09-19-web-rum-integration-design]]
 */
@Injectable()
export class RumErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    this.emit(this.toRecord(error));
    console.error(error);
  }

  private toRecord(error: unknown): RumErrorRecord {
    const activeSpan = trace.getActiveSpan();
    const traceId = activeSpan?.spanContext().traceId;

    const base = {
      route: typeof location !== 'undefined' ? location.pathname : '',
      ...(traceId ? { trace_id: traceId } : {}),
    };

    if (error instanceof ApiError) {
      return {
        ...base,
        message: error.message,
        type: 'ApiError',
        status: error.status,
        detail: error.detail,
      };
    }

    if (error instanceof Error) {
      return {
        ...base,
        message: error.message,
        type: error.name,
        stack: error.stack,
      };
    }

    return { ...base, message: String(error), type: 'UnknownError' };
  }

  private emit(record: RumErrorRecord): void {
    const provider = getRumLoggerProvider();
    if (!provider) return;

    const logger = provider.getLogger('3mrai-web-errors');
    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: record.message,
      attributes: record,
    });
  }
}
```

- [ ] **Step 5: Run and confirm green**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration/apps/web
nvm use && pnpm test rum-error-handler
```
Expected: all three tests pass.

- [ ] **Step 6: Register the handler**

Modify `apps/web/src/app/app.config.ts`. Add the import:

```ts
import { ErrorHandler } from '@angular/core';
import { RumErrorHandler } from './core/observability/rum-error-handler';
```

(`ErrorHandler` joins the existing `@angular/core` import line rather than a new one.) Add to the `providers` array, after `provideBrowserGlobalErrorListeners()`:

```ts
    // CONTRACT: provideBrowserGlobalErrorListeners() above already forwards
    // window's error and unhandledrejection events into ErrorHandler — do
    // NOT add separate window.onerror/unhandledrejection listeners in
    // rum.ts, which would double-report every global error.
    // See [[2026-09-19-web-rum-integration-design]]
    { provide: ErrorHandler, useClass: RumErrorHandler },
```

- [ ] **Step 7: Manual check — a deliberately triggered error**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration/apps/web
NG_APP_RUM_ENABLED=true nvm exec pnpm dev
```
Open the browser devtools console on the running app and run `throw new Error('rum-manual-check')`. In OpenObserve's `rum_logs` stream, search for `rum-manual-check`. Expected: one record with `message`, `stack`, `type: Error`, `route`, and (if a trace is active) `trace_id` — and no field resembling a request body, token, or password.

- [ ] **Step 8: Leave the work in the working tree and report what changed**

Report the two created files, the two modified files, the test result, and confirm Step 7's manual check passed. A dispatched agent never runs git.

---

## Phase 3 — Infra: the dashboard

### Task 8 (infra-impl): The RUM dashboard

**Files:**
- Create: `observability/dashboards/rum.dashboard.json`

**Interfaces:**
- Consumes: the `rum_traces`, `rum_metrics`, `rum_logs` streams (Task 1.1). Metric names `web_vitals_lcp`, `web_vitals_cls`, `web_vitals_inp` (Task 6, lowercased per `meter.createGauge`'s naming).
- Produces: a dashboard importable by `make observability-dashboards`.

This is the first candidate to drop if the delivery proves too large — flag that explicitly if time runs short, rather than shipping a half-built dashboard.

- [ ] **Step 1: Read an existing dashboard's structure first**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration
head -100 observability/dashboards/business-metrics.dashboard.json
```
Copy its top-level shape (`version`, `dashboardId`, `title`, `description`, `role`, `owner`, `created`, `tabs[].panels[]` with `id`/`type`/`title`/`description`/`config`/`queryType`/`queries[]`/`layout`) rather than inventing a new one.

- [ ] **Step 2: Write the dashboard**

Create `observability/dashboards/rum.dashboard.json`:

```json
{
  "version": 8,
  "dashboardId": "rum",
  "title": "Web RUM",
  "description": "Browser telemetry: Core Web Vitals, JS error volume, and browser-trace volume. Vitals cards read the level with MAX (a gauge per Task 6); the error and trace-volume cards SUM the count over the selected range.",
  "role": "",
  "owner": "3MRAI",
  "created": "2026-09-19T00:00:00.000Z",
  "tabs": [
    {
      "tabId": "vitals",
      "name": "Web RUM",
      "panels": [
        {
          "id": "card_lcp",
          "type": "metric",
          "title": "LCP (ms)",
          "description": "Largest Contentful Paint, finalised at first interaction.",
          "config": { "show_legends": false, "decimals": 0 },
          "queryType": "sql",
          "queries": [
            {
              "query": "SELECT MAX(value) AS total FROM \"web_vitals_lcp\"",
              "customQuery": true,
              "fields": {
                "stream": "web_vitals_lcp",
                "stream_type": "metrics",
                "x": [],
                "y": [{ "label": "total", "alias": "total", "column": "total", "color": null, "aggregationFunction": null, "isDerived": false, "havingConditions": [] }],
                "z": [],
                "breakdown": [],
                "filter": { "filterType": "group", "logicalOperator": "AND", "conditions": [] }
              },
              "config": { "layer_type": "scatter", "weight_fixed": 1, "promql_legend": "" }
            }
          ],
          "layout": { "x": 0, "y": 0, "w": 12, "h": 8, "i": 1 }
        },
        {
          "id": "card_cls",
          "type": "metric",
          "title": "CLS",
          "description": "Cumulative Layout Shift, accumulated over the tab's lifetime.",
          "config": { "show_legends": false, "decimals": 3 },
          "queryType": "sql",
          "queries": [
            {
              "query": "SELECT MAX(value) AS total FROM \"web_vitals_cls\"",
              "customQuery": true,
              "fields": {
                "stream": "web_vitals_cls",
                "stream_type": "metrics",
                "x": [],
                "y": [{ "label": "total", "alias": "total", "column": "total", "color": null, "aggregationFunction": null, "isDerived": false, "havingConditions": [] }],
                "z": [],
                "breakdown": [],
                "filter": { "filterType": "group", "logicalOperator": "AND", "conditions": [] }
              },
              "config": { "layer_type": "scatter", "weight_fixed": 1, "promql_legend": "" }
            }
          ],
          "layout": { "x": 12, "y": 0, "w": 12, "h": 8, "i": 2 }
        },
        {
          "id": "card_inp",
          "type": "metric",
          "title": "INP (ms)",
          "description": "Interaction to Next Paint, only exists after interaction.",
          "config": { "show_legends": false, "decimals": 0 },
          "queryType": "sql",
          "queries": [
            {
              "query": "SELECT MAX(value) AS total FROM \"web_vitals_inp\"",
              "customQuery": true,
              "fields": {
                "stream": "web_vitals_inp",
                "stream_type": "metrics",
                "x": [],
                "y": [{ "label": "total", "alias": "total", "column": "total", "color": null, "aggregationFunction": null, "isDerived": false, "havingConditions": [] }],
                "z": [],
                "breakdown": [],
                "filter": { "filterType": "group", "logicalOperator": "AND", "conditions": [] }
              },
              "config": { "layer_type": "scatter", "weight_fixed": 1, "promql_legend": "" }
            }
          ],
          "layout": { "x": 24, "y": 0, "w": 12, "h": 8, "i": 3 }
        },
        {
          "id": "card_error_count",
          "type": "metric",
          "title": "JS errors",
          "description": "Count of browser JS errors reported through RumErrorHandler, over the selected range.",
          "config": { "show_legends": false, "decimals": 0 },
          "queryType": "sql",
          "queries": [
            {
              "query": "SELECT COUNT(*) AS total FROM \"rum_logs\"",
              "customQuery": true,
              "fields": {
                "stream": "rum_logs",
                "stream_type": "logs",
                "x": [],
                "y": [{ "label": "total", "alias": "total", "column": "total", "color": null, "aggregationFunction": null, "isDerived": false, "havingConditions": [] }],
                "z": [],
                "breakdown": [],
                "filter": { "filterType": "group", "logicalOperator": "AND", "conditions": [] }
              },
              "config": { "layer_type": "scatter", "weight_fixed": 1, "promql_legend": "" }
            }
          ],
          "layout": { "x": 0, "y": 8, "w": 18, "h": 8, "i": 4 }
        },
        {
          "id": "card_browser_trace_volume",
          "type": "metric",
          "title": "Browser traces",
          "description": "Count of distinct browser trace_ids landing in rum_traces over the selected range — page loads and navigations, one trace each.",
          "config": { "show_legends": false, "decimals": 0 },
          "queryType": "sql",
          "queries": [
            {
              "query": "SELECT COUNT(DISTINCT trace_id) AS total FROM \"rum_traces\"",
              "customQuery": true,
              "fields": {
                "stream": "rum_traces",
                "stream_type": "traces",
                "x": [],
                "y": [{ "label": "total", "alias": "total", "column": "total", "color": null, "aggregationFunction": null, "isDerived": false, "havingConditions": [] }],
                "z": [],
                "breakdown": [],
                "filter": { "filterType": "group", "logicalOperator": "AND", "conditions": [] }
              },
              "config": { "layer_type": "scatter", "weight_fixed": 1, "promql_legend": "" }
            }
          ],
          "layout": { "x": 18, "y": 8, "w": 18, "h": 8, "i": 5 }
        }
      ]
    }
  ]
}
```

- [ ] **Step 3: Import and verify**

Run:
```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration
make observability-dashboards
```
Expected: no errors. Open OpenObserve's Dashboards page, confirm "Web RUM" appears, and that its panels render (`0` on an idle stack is fine at import time; Task 4-7's manual checks are what put real numbers in it).

- [ ] **Step 4: Leave the work in the working tree and report what changed**

Report the created file and confirm Step 3's import succeeded. A dispatched agent never runs git.

---

## Phase 4 — Verification (main session)

### Task 9: Full verification pass

Not an implementation task — run by the main session once Tasks 1-8 are all in the working tree. Every bullet below is drawn from the spec's Verification section.

- [ ] **End-to-end trace parentage**: a real browser flow (login → catalogue → add to cart) with `NG_APP_RUM_ENABLED=true` produces one trace in the OpenObserve waterfall where the browser span is the parent of the gateway span and the service spans, under the same `trace_id`. Two disconnected traces is the failure this rules out.
- [ ] **Real vitals values**: LCP, CLS and INP carry real, non-zero values in `rum_metrics` after interacting with the app — not merely a created, empty stream.
- [ ] **Errors, no forbidden field**: a deliberately triggered error appears in `rum_logs` with its `stack` and `trace_id`, and inspecting the raw record confirms no request body, token, or plaintext email is present.
- [ ] **Flag off means zero `/otlp` requests**: with `NG_APP_RUM_ENABLED=false` (or unset), load the app and check the browser devtools Network tab — zero requests to any `/otlp/*` path. This is the easiest one to forget, and it is what protects a plain `make up` from a stack of failed exports.
- [ ] **Both proxy halves**: `/otlp/v1/traces` returns 200 under `pnpm dev` (port 4200) AND in the container (port 3004). One of the two is not "verified".
- [ ] **Existing suite green**:
  ```bash
  cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration/apps/web
  nvm use
  pnpm test
  pnpm lint
  pnpm typecheck
  ```
  and, from the repo root:
  ```bash
  cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/feature-rum-integration
  make lint-comments
  ```
- [ ] **Known trap, not a RUM bug**: if the OpenObserve trace waterfall returns HTTP 400 with `code 20004` mentioning `gen_ai_operation_name`, this is the pre-existing trace-detail schema gap (its query SELECTs a column this repo never emits), not something this plan broke. Fix with `make observability-traces-schema` (also run automatically by `make observability-up`).
- [ ] **Vault propagation**: confirm `docs/superpowers/specs/2026-09-19-web-rum-integration-design.md`'s `propagates-to:` targets (`[[logging-context]]`, `[[env-files]]`, `[[openobserve-runbook]]`) — and this plan's own — have actually been updated, routed through `obsidian-vault`, before proposing the PR that closes this milestone.

---

## Self-review

### 1. Spec coverage

| Spec decision | Task(s) |
|---|---|
| D1 — SDK boots before `bootstrapApplication`, behind `NG_APP_RUM_ENABLED`, off by default | 3, 4 |
| D1 — `.env.example` documentation | 3 Step 6 |
| D2 — same-origin `/otlp`, three sub-paths, two proxy halves | 1.2 |
| D2 — doubled-brace `.format()` trap | 1.2 Step 3 |
| D3 — second OTLP receiver on 4319, structural isolation, three own streams, no filters | 1.1 |
| D3 — `memory_limiter` before `batch` | 1.1 Step 3 |
| D3 — RUM dashboard, first candidate to drop | 8 |
| D4 — `traceparent` via interceptor, not XHR auto-instrumentation, registered last | 5 |
| D4 — CONTRACT comment naming the auto-instrumentation/interceptor boundary | 5 Step 3 |
| D4 — refresh-retry gets its own `traceparent` (documented, not "fixed") | Noted in Task 5 Step 6's verification guidance |
| D5 — vitals via `web-vitals`, per-callback + `visibilitychange` flush, not a timer | 6 |
| D5 — errors via `ErrorHandler` + `window.onerror`/`unhandledrejection`, delegate to original, bounded redaction | 7 (corrected: one path via `ErrorHandler`, not three — see the correction section) |
| D6 — zero service changes; infra changes are local only | Implicit — no task touches `services/*` or the API gateway routing |
| Packages — exact versions, no `auto-instrumentations-web` | 4 Step 1 |
| Verification — every bullet | 9 |
| Implementation split (`web-impl` / `infra-impl`) | Task ownership annotations throughout |

### 2. Placeholder scan

No `TBD`, no "add appropriate error handling", no "similar to Task N" standing in for real content. Every code step carries real, complete code; every test step carries the actual spec file or extension. Task 8's dashboard panels are fully written, not left as "add panels for the vitals" — the spec's own instruction to "read an existing dashboard and copy its structure" is followed literally in Step 1, and the panels that follow are the copy.

**One deliberate exception, called out rather than silently left thin:** Task 5 Step 4 includes a documented fallback for the "sets traceparent" assertion, because `propagation.inject` in an isolated Vitest module context may not have an active span to encode even when the interceptor's logic is correct — this is a property of running the OTel API without a full app bootstrap, not a gap in the interceptor. The fallback does not weaken what ships; it redirects the strongest proof to Step 6's real-browser manual check, and says so explicitly in the task text.

### 3. Type/name consistency across tasks

- `initRum(): void` / `isRumStarted(): boolean` — defined Task 4, called from `main.ts` (Task 4) and asserted directly by Task 4's own spec; Tasks 5-7 do not re-implement or duplicate this pair, they build inside the same `rum.ts` module. ✓
- `getRumLoggerProvider(): LoggerProvider | undefined` — defined Task 7 Step 1 (inside `rum.ts`), consumed by `rum-error-handler.ts`'s `emit()`. ✓
- `gatewayPath` — imported unchanged from `auth-interceptor.ts` in Task 5; no task redefines it. ✓
- `rumPropagationInterceptor` — defined Task 5, registered in `app.config.ts`'s array in the exact position the correction section establishes (`[refreshInterceptor, authInterceptor, rumPropagationInterceptor]`). ✓
- `APP_CONFIG.rumEnabled` — added Task 3, read by Task 4's `initRum()` and by Task 4's own spec via `Object.defineProperty` override (never reassignment, since the property is `readonly` in `AppConfig`). ✓
- `RumErrorHandler` — defined Task 7, registered via `{ provide: ErrorHandler, useClass: RumErrorHandler }` in the same `app.config.ts` Task 5 also edits; both tasks add distinct, non-conflicting entries (one import line each, one providers-array line each) — noted here because two tasks touching the same file is exactly where a merge-order assumption could silently break, and neither task's diff depends on the other's line position.
- `web_vitals_lcp` / `web_vitals_cls` / `web_vitals_inp` metric names — `meter.createGauge(\`web_vitals_${metric.name.toLowerCase()}\`)` in Task 6 is what Task 8's dashboard SQL queries by name; both sides lowercase consistently. ✓
- `rum_traces` / `rum_metrics` / `rum_logs` stream names — set once, in Task 1.1's exporter `stream-name` headers, and read unchanged by Tasks 4/5 (manual checks), 6 (manual check + Task 8), 7 (manual check + Task 8), and 8 (dashboard queries). ✓

### 4. Judgment calls made that the brief did not specify

- **The interceptor's traceparent test (Task 5 Step 4) carries an explicit fallback** for the case where `propagation.inject` has no active context in an isolated Vitest module — documented inline rather than silently weakening the assertion. This was not specified in the brief; I chose to keep the strict assertion as the primary path and describe exactly when and why to fall back, rather than writing a permanently-weak test.
- **Task 7's design departs from the spec's "three sources"** (custom `ErrorHandler` + `window.onerror` + `unhandledrejection`) because `provideBrowserGlobalErrorListeners()` — already present in `app.config.ts` before this plan — makes two of those three sources redundant with the third. This is recorded as a correction, not silently implemented, per the brief's own instruction to flag where the spec appears wrong.
- **`isRumStarted()` was chosen over a DOM/global-based test hook** for Task 4's testability requirement, per the brief's instruction to "pick ONE and use it consistently" — it is a plain exported function, needs no `window` mutation, and every later task's spec (5, 6, 7) either reuses `rum.ts`'s internal state directly (same module) or asserts through its own exported function (`getRumLoggerProvider`), so no other task had to invent a second convention.
- **Task 8's dashboard uses `MAX` for vitals gauges**, mirroring the exact aggregation choice `business-metrics.dashboard.json` documents for its own gauge cards ("gauges... report the level with MAX"), since Task 6's vitals are recorded as an OTel gauge instrument, not a counter.
- **The `rum.ts` file grows across Tasks 4, 6 and 7** rather than each task creating a separate file, because the spec's Decision 1 names exactly three files for the whole directory (`rum.ts`, `rum-propagation-interceptor.ts`, `rum-error-handler.ts`) and `rum.ts` is explicitly "SDK init" — singular. Splitting tracing/metrics/logs init into three separate files was considered and rejected: it would need a shared started-flag module anyway, adding indirection the spec's file list does not ask for.
- **`@opentelemetry/api-logs` was added to the package list**, beyond what the spec and the team lead's verified-facts list name. It is not optional: Task 7's `RumErrorHandler` needs `SeverityNumber` from it to call `logger.emit(...)` correctly, and it is `@opentelemetry/sdk-logs`'s own peer for the logs API surface, exactly as `@opentelemetry/api` is `sdk-trace-web`'s. Recorded here rather than silently added mid-task.

## Related

- [[2026-09-19-web-rum-integration-design]] — the approved spec this plan implements.
- [[ADR-0019-distributed-tracing-opentelemetry]] — the backend tracing decision this plan extends into the browser.
- [[ADR-0018-observability-openobserve]] — the OpenObserve backend every RUM stream lands in.
- [[logging-context]] — the shared cross-service context and the "omit, never null" / no-plaintext-email rules Task 7's redaction follows.
- [[env-files]] — the generated-env-file convention `NG_APP_RUM_ENABLED` and the new `proxy.conf.mjs` `/otlp` entry follow.
- [[openobserve-runbook]] — local OpenObserve operations, including the trace-waterfall `gen_ai_operation_name` HTTP 400 trap Task 9 checks against.
- [[2026-09-04-web-gateway-integration-design]] — the same-origin proxy pattern (`/v1`) this plan's `/otlp` proxy repeats.
- [[2026-09-06-address-geocoding-proxy-design]] — the second precedent for a same-origin proxy with two halves.
- [[2026-08-21-verify-in-the-viewer-not-the-api]] — the verification standard Task 9 and every manual-check step are written to.
- [[angular-component-authoring]] — the `app-config.ts` access pattern and interceptor placement conventions Tasks 3 and 5 follow.
- [[package-manager]] — pnpm-only, followed by Task 4 Step 1's install command.
- [[git-workflow]] — the A/B/C/D/E confirmation menu every task's final "leave in the working tree" step defers to.
- [[doc-propagation]] — the convention this plan's own `propagates-to:` frontmatter satisfies.
