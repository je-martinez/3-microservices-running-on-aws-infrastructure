---
title: Web App — NG_APP_* Environment Configuration
type: runbook
area: infra
status: active
created: 2026-09-15
updated: 2026-09-30
integration-status: verified
verified-on: 2026-09-15
verified-by: Jose E. Martinez
tags: [type/runbook, area/infra, status/active]
related:
  - "[[env-files]]"
  - "[[2026-09-29-web-env-consolidation-design]]"
  - "[[ADR-0017-floci-local]]"
  - "[[2026-08-05-realtime-tracking-events-websocket-design]]"
  - "[[2026-09-15-a-falsy-default-that-means-disabled-erases-the-difference-from-unconfigured]]"
  - "[[local-dev-floci]]"
---

# Web App — NG_APP_* Environment Configuration

## When to read this

Read this when `apps/web` behaves as if a feature is missing with no error in sight — no toasts,
no address autocomplete, no Stripe step, a flag that seems ignored. Nothing needs to be run on a
fresh clone: `make env-file` generates `.env.local.web` with all six `NG_APP_*` variables, and
`apps/web/angular.json` (`ngxEnv.files`) reads `../../.env.local.web` **first**. This is placed
under `docs/infrastructure/runbooks/` rather than a `docs/domains/<service>/` folder because there
is no `docs/domains/web/` — `apps/web` is a frontend app, not one of the four backend services, and
its local-dev plumbing (`make env-file`, `.env.local.web`, Floci-minted ids) is infrastructure.

## Where each value comes from

| File | Role |
|---|---|
| `.env.local.web` (repo root) | **Generated** by `make env-file`. Its AUTO box is rewritten every run (including `NG_APP_WS_URL`, whose `apiId` Floci remints on every apply); overrides and personal flags go in its **CUSTOM** box, which is preserved. The container build reads it too. |
| `apps/web/.env` | **Optional** per-machine override for `pnpm dev` only, read **second** so it wins. Correct when empty or absent. A key set here pins that value for `pnpm dev` and diverges it from the container; an **empty** assignment counts as a value and shadows the generated one just as a wrong one does. |

`apps/web/.env.example` states the same contract. Never hand-copy a generated value into
`apps/web/.env`: it goes stale the next time Floci remints the id. Keys belong in `.env.local.web`'s
CUSTOM box, never in `apps/web/.env` — see [[stripe-sandbox-setup]]. Full convention: [[env-files]];
the consolidation that removed the old copy step: [[2026-09-29-web-env-consolidation-design]].

## The incident this exists to prevent (2026-09-15)

The web app opened no WebSocket at all, so live toast notifications and the live unread badge
simply did not exist — no error, no log, a perfectly healthy-looking app. `NG_APP_WS_URL` was
empty in one file while the real value sat in another, with nothing bridging them. It survived an
entire milestone and was only caught when a browser E2E went looking for a socket in devtools.
Full account, including why the fix does not throw:
[[2026-09-15-a-falsy-default-that-means-disabled-erases-the-difference-from-unconfigured]]. The
consolidation now generates the value into the file the build reads first; the app also emits a
`console.warn` naming the variable when it is empty.

## The variables

Authoritative source: `apps/web/src/app/core/config/app-config.ts` (`parseAppConfig`) and the
types in `apps/web/src/env.d.ts`. Six variables.

| Variable | What it does | Left unset |
|---|---|---|
| `NG_APP_STRIPE_ENABLED` | Offers the Stripe payment step at checkout. | Off — absent-means-off is correct here; checkout just skips the Stripe step. |
| `NG_APP_STRIPE_PUBLISHABLE_KEY` | The `pk_...` publishable key the Payment Element mounts with. Never a secret or restricted key. | The Stripe step cannot mount. |
| `NG_APP_API_GATEWAY_URL` | Base path every gateway call hangs off. | Falls back to `/v1` in code (`DEFAULT_API_GATEWAY_URL`) — a safe default, not a silent gap. |
| `NG_APP_GEOCODE_ENABLED` | Offers address autocomplete at checkout. | Off — the checkout address field renders a plain input. Needs `GEOAPIFY_API_KEY` set server-side too (`.env.local.web`'s CUSTOM box) — see [[env-files]]. |
| `NG_APP_WS_URL` | Host-facing realtime WebSocket URL, e.g. `ws://localhost:4566/ws/<apiId>/<stage>`. | **No sensible default exists** — the URL carries an `apiId` Floci mints fresh on every `terraform apply`. Empty, the app starts with no socket; realtime toasts and the live unread badge are silently absent. `make env-file` generates it. |
| `NG_APP_RUM_ENABLED` | Whether the browser OTel SDK boots at all; off costs the user nothing. | Off. See [[browser-rum]]. |

`NG_APP_WS_URL` is different in kind from the flags: it is a value with no fallback that means
anything. See
[[2026-09-15-a-falsy-default-that-means-disabled-erases-the-difference-from-unconfigured]] for why
a falsy default collapsing "unconfigured" into "disabled" is the root cause.

> [!warning] Never use `WS_MANAGEMENT_ENDPOINT` as the web URL
> `NG_APP_WS_URL` is the HOST-facing URL a browser dials. `WS_MANAGEMENT_ENDPOINT` is the
> in-network publish endpoint (`http://floci:4566/execute-api/{apiId}/{stage}`) only a Lambda
> container can reach, and answers a browser handshake with an S3 XML body rather than a normal
> error — see [[2026-08-05-realtime-tracking-events-websocket-design]]'s "Floci local URL shapes"
> section.

## Symptom table

| Symptom | Cause | How to confirm |
|---|---|---|
| No toasts, and the unread badge only updates on a full page reload | `NG_APP_WS_URL` empty, stale, or shadowed by an `apps/web/.env` assignment | Open the browser console — `app-config.ts` logs `MISSING_WS_URL_WARNING` when it is empty (nothing is logged for a *stale* value). Check devtools' Network → WS filter for a socket other than Vite's HMR connection. Check `apps/web/.env` for an `NG_APP_WS_URL=` line — delete it, then `make env-file` if the generated value is stale. |
| Address autocomplete never suggests anything at checkout | `NG_APP_GEOCODE_ENABLED` unset (or `GEOAPIFY_API_KEY` missing/invalid in `.env.local.web`'s CUSTOM box) | Flag off with a valid key: no suggestions, proxy still answers 200. Flag on with no key: the `/geocode/` proxy answers 503 instead of calling Geoapify unauthenticated. Check both independently — see [[env-files]]. |
| Checkout never shows the Stripe step | `NG_APP_STRIPE_ENABLED` unset or `false` | Expected default state — confirm the flag is `true` in `.env.local.web`'s CUSTOM box, and that `apps/web/.env` does not assign it empty. |
| An edit "does nothing" — the flag looks ignored even after saving | **The trap that catches everyone.** `NG_APP_*` values are inlined at BUILD time by `@ngx-env/builder`, not read at runtime. A browser reload re-serves the bundle already compiled with the old value. | **Restart `pnpm dev`** (or `docker compose build web` for the container). A reload is not enough. |

## `NG_APP_*` values are public

Every `NG_APP_*` value ships inside the compiled bundle and is readable by anyone who opens
devtools — flags and publishable keys only, never a secret. This is `apps/web/CLAUDE.md` §2c's
golden rule; see that file for the full statement, not restated here.

## Verification

- `grep '^NG_APP_' .env.local.web` shows all six variables with the values intended for this
  session (no bare `NG_APP_WS_URL=` left empty unless realtime is deliberately off).
- `apps/web/.env` is absent or empty, unless a per-machine `pnpm dev` override is deliberate.
- After restarting `pnpm dev`, the browser console shows **no** `MISSING_WS_URL_WARNING`.
- Devtools' Network → WS tab shows a socket to `ws://localhost:4566/ws/...` (not only Vite's
  HMR connection) once a page that opens the notifications socket has loaded.
- Triggering a tracking status change (see
  [[2026-08-05-realtime-tracking-events-websocket-design]]) produces a live toast and an
  unread-badge update without a page reload.

## Related

- [[env-files]] — the generated-vs-hand-maintained env file convention this runbook follows;
  that note also carries the bidirectional link back here.
- [[2026-09-29-web-env-consolidation-design]] — the consolidation that made `.env.local.web` the
  file the web build reads first and retired the manual copy step.
- [[ADR-0017-floci-local]] — the local AWS emulator that mints the `apiId` `NG_APP_WS_URL` embeds,
  and why that id is not stable across a rebuild.
- [[2026-08-05-realtime-tracking-events-websocket-design]] — the realtime WebSocket design this
  variable connects to, including the HOST-facing-vs-in-network URL distinction.
- [[2026-09-15-a-falsy-default-that-means-disabled-erases-the-difference-from-unconfigured]] —
  the lesson recording why this gap existed for a whole milestone undetected.
- [[local-dev-floci]] — the `make bootstrap` chain that produces `.env.local.web` in the first
  place.
- [[stripe-sandbox-setup]] — where Stripe keys belong (never in `apps/web/.env`).
- [[browser-rum]] — what `NG_APP_RUM_ENABLED` switches on.
