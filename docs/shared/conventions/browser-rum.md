---
title: "Browser RUM — Keeping New Work Observable"
type: convention
area: shared
status: active
created: 2026-09-20
updated: 2026-09-20
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[2026-09-19-web-rum-integration-design]]"
  - "[[logging-context]]"
  - "[[testing]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[ADR-0018-observability-openobserve]]"
  - "[[angular-component-authoring]]"
  - "[[openobserve-runbook]]"
  - "[[2026-08-21-verify-in-the-viewer-not-the-api]]"
  - "[[2026-09-20-a-shared-stream-widens-every-scoped-count]]"
---

# Browser RUM — Keeping New Work Observable

## Why this note exists

The web app now emits browser telemetry — OTel traces joined to the backend's, Web Vitals, JS
error logs (see [[2026-09-19-web-rum-integration-design]]). Nothing about that fact makes a
FUTURE endpoint, screen, or flow inherit it. A new feature can ship, the RUM dashboards stay
green because nothing broke, and the new surface is simply invisible — no error raised, no test
failing. This note is what makes the coverage survive the feature that adds the next screen: a
checklist per trigger, and the concrete failure each rule prevents.

## Trigger 1 — a new endpoint / a new API call from the web app

- **Call it through `ApiClient`** (`apps/web/src/app/core/http/api-client.ts`). This is not
  style: `rumPropagationInterceptor` is registered on Angular's `HttpClient` chain and keys off
  `gatewayPath(req.url)`. A raw `fetch()` bypasses the interceptor entirely — no CLIENT span, no
  `traceparent`, and the call is invisible in `app_traces` while everything else looks healthy.
  Verified during this work: a probe using raw `fetch()` produced no span at all.
- The interceptor is registered LAST: `[refreshInterceptor, authInterceptor,
  rumPropagationInterceptor]`. A new interceptor goes BEFORE it unless it has a specific reason
  not to — the RUM one must see the fully-formed request.
- Nothing else is needed for tracing. Do not add per-call instrumentation, and do NOT enable
  OTel's XHR auto-instrumentation "for completeness": it propagates independently via
  `propagateTraceHeaderCorsUrls` and would double every request's spans.

## Trigger 2 — a new screen / component

- **Do not swallow errors.** `RumErrorHandler` is Angular's `ErrorHandler`, so it only sees what
  actually reaches it. A component that catches its own `ApiError` and shows a message without
  rethrowing removes that failure from `rum_logs`. If a screen handles an error locally for UX,
  it must still let it reach the handler (rethrow, or report deliberately) — otherwise the error
  exists for the user and not for observability.
- **Redaction is the screen author's problem too.** Only these fields are ever emitted:
  `message`, `stack`, `type`, `route`, `trace_id`, `user_id`, and for an `ApiError`
  `status`/`detail`. NEVER a request body, a token, a plaintext email, or a query string. If a
  new error type carries a payload, it does not get emitted by default — extend the allow-list
  deliberately or leave it out. See [[logging-context]].
- `route` is `location.pathname` — never the full URL. A query string can carry identifying
  values.

## Trigger 3 — a new flow (a checkout step, a new journey across screens)

- Verify it **in the OpenObserve viewer**, not by an HTTP 200. Per
  [[2026-08-21-verify-in-the-viewer-not-the-api]], OpenObserve returns 200 and silently drops
  records — this bit twice during this work (a stale timestamp outside the retention window; a
  truncated capture that read as a false FAIL). Query the stream.
- What "covered" means for a new flow: its gateway calls appear in `app_traces` as CLIENT spans,
  marked `telemetry.source = rum` and named `RUM - <method> <route>`, sharing their `trace_id`
  with the backend spans they reached; a failure in it appears in `rum_logs`. One trace, browser
  to service, one waterfall.
- Allow a full export cycle before concluding anything is missing. `BatchSpanProcessor` batches,
  and it runs slower in a backgrounded tab — measure over several seconds, not one. A short
  window produces a false FAIL exactly as it produces a false PASS.

## Cross-cutting rules that bind all three

- **The flag gates everything.** `NG_APP_RUM_ENABLED` is off by default and the SDK is
  lazy-loaded behind a dynamic import. New telemetry code goes inside that gate — never at
  module scope in a file the app always loads. A static OTel import in an always-loaded file
  silently re-inflates the initial bundle even with the flag off; that happened here and cost
  173 kB before it was caught.
- **`pnpm build` is part of "done".** The initial-bundle budget (600 kB, `apps/web/angular.json`)
  is a real gate and `pnpm test`/`lint`/`typecheck` do not check it. A whole implementation plan
  ran to completion without it and shipped a budget breach.
- **Three surfaces emit, not one.** Span attributes (the interceptor), metric attributes (Web
  Vitals), and log records (the error handler). A redaction review that only looks at the error
  handler is incomplete.
- **Metric names are a contract with the dashboard.** `web_vitals_*` names are queried by
  `observability/dashboards/rum.dashboard.json`. Renaming one silently empties a panel.
- **Browser traces share `app_traces` with the services — any aggregate over it must scope
  itself in SQL, not rely on the stream name.** Browser spans are distinguishable two ways: a
  `telemetry.source = rum` attribute (queryable) and a `RUM - ` name prefix (readable in a mixed
  waterfall), both applied by `transform/mark_rum_spans` in the collector; `service_name` also
  separates them (`3mrai-web` vs. `users`/`orders`/`tracking`/`events-pipeline`/`schema-seed`/
  `realtime-events`). A panel meaning "browser traces only" needs an explicit `WHERE
  service_name = '3mrai-web'` (or the `telemetry.source` attribute) — see
  [[2026-09-20-a-shared-stream-widens-every-scoped-count]] for what an unscoped `COUNT(DISTINCT
  trace_id)` over the shared stream actually returned.
- **The collector and the proxy have two halves each.** A new signal or path needs the collector
  pipeline (`observability/otel-collector-config.yaml`, RUM traffic arrives on its own receiver
  at port 4319) AND both proxy halves: `apps/web/nginx.conf` for the container and the GENERATED
  `apps/web/proxy.conf.mjs` (written by
  `infra/environments/local/scripts/generate_env_files.py` — editing only nginx leaves `pnpm dev`
  broken, silently).
- **Every gateway call is its own trace root; the page it came from is a link, never a parent.**
  `rumPropagationInterceptor` starts its CLIENT span from `ROOT_CONTEXT`, deliberately, so an
  in-flight span higher up the call stack can never silently re-parent it. The page-scoped root
  span still exists — the lazily-loaded SDK module creates it, a root-provided `RumNavigation`
  service rotates it on Angular Router `NavigationEnd`, and it is ended on `visibilitychange →
  hidden` / `pagehide` as a backstop so it is bounded and never left open for the tab's lifetime
  — but the interceptor only attaches to it as a span `link` plus a `page.route` attribute, both
  best-effort: present when a page span exists, silently omitted when it does not (flag off, SDK
  not yet loaded, or the call happens between navigations). The cross-service join depends only
  on the `traceparent` the interceptor injects, never on the link.
- **`page.route` is the route PATTERN, never the resolved URL.** `rum-navigation.ts` resolves it
  from Angular's Router via `routePatternOf()` — `/orders/:orderId`, not
  `/orders/ord_JIfKhAqF5eD9bV7KRnReGpda`; the root path reads `/`. A resolved id would give the
  attribute one distinct value per order, and grouping a screen's calls would then match a
  single visit instead of the screen — the opposite of what the attribute is for. The first
  `NavigationEnd` after `startRumSdk()` renames the bootstrap page span rather than starting a
  second one, because Router's initial `NavigationEnd` describes the same page view the SDK
  already started tracking from `location.pathname` (no Router exists yet at that point);
  starting a second span there would split one page view in two and orphan document-load's
  children.
- Rejected: parenting the CLIENT span off the page span. A real checkout puts 169 backend spans
  across four unrelated operations (`GET /notifications`, `GET /cart`, `PATCH /users/me`,
  `POST /orders`) into one trace, so investigating a single operation means paging past its
  neighbours — the common case. Linking keeps that same order at 83 spans, all its own. The tradeoff
  is honest, not free: OpenObserve v0.91.1 stores and indexes `links` as a queryable field, but
  its UI builds the waterfall from parent/child alone, so there is no clickable jump from a call
  back to its page — grouping a screen's calls is a `page_route` filter, not a hierarchy, and the
  page span and the calls it links are separate traces, not one waterfall.

## Known limitations — current facts, not aspirations

- **`cognito_sub` is never emitted.** The app never decodes the JWT client-side, so no
  synchronous source exists, and an `ErrorHandler` must not await one. `user_id` (the internal
  `usr_…` id from `SessionStore`) is what identifies a session.
- **`trace_id` reaches `rum_logs` only for errors from a gateway call.** The interceptor stamps
  it on the way past; a template error or a null dereference has no active span by the time
  `ErrorHandler` runs. Its absence there is expected, not a bug.
- Scope is LOCAL ONLY (docker compose + Floci). There is no deployed collector or AWS ingest
  path.

## Related

- [[2026-09-19-web-rum-integration-design]] — the design this convention generalises into a
  standing checklist.
- [[logging-context]] — the shared PII/redaction rules browser error logging follows.
- [[testing]] — the three-layer testing convention this note's triggers parallel for RUM
  coverage rather than functional correctness.
- [[ADR-0019-distributed-tracing-opentelemetry]] — the backend tracing decision RUM extends into
  the browser.
- [[ADR-0018-observability-openobserve]] — the OpenObserve backend RUM traces, metrics, and logs
  land in.
- [[angular-component-authoring]] — interceptor ordering and `app-config.ts` access patterns RUM
  follows.
- [[openobserve-runbook]] — local OpenObserve operations, including the trace-waterfall
  `gen_ai_operation_name` HTTP 400 trap.
- [[2026-08-21-verify-in-the-viewer-not-the-api]] — the verification standard behind Trigger 3's
  rule to query the stream, not trust a 200.
- [[2026-09-20-a-shared-stream-widens-every-scoped-count]] — the trap behind the cross-cutting
  rule that an aggregate over `app_traces` must scope itself in SQL.
