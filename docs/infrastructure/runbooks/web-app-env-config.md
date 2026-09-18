---
title: Web App — NG_APP_* Environment Configuration
type: runbook
area: infra
status: active
created: 2026-09-15
updated: 2026-09-15
integration-status: verified
verified-on: 2026-09-15
verified-by: Jose E. Martinez
tags: [type/runbook, area/infra, status/active]
related:
  - "[[env-files]]"
  - "[[ADR-0017-floci-local]]"
  - "[[2026-08-05-realtime-tracking-events-websocket-design]]"
  - "[[2026-09-15-a-falsy-default-that-means-disabled-erases-the-difference-from-unconfigured]]"
  - "[[local-dev-floci]]"
---

# Web App — NG_APP_* Environment Configuration

## When to run this

Run this after `cp apps/web/.env.example apps/web/.env` on a fresh clone, and again any time
`apps/web` behaves as if a feature is missing with no error in sight — no toasts, no address
autocomplete, a flag that seems ignored. `apps/web/.env` is gitignored and hand-maintained; a
fresh clone starts with none, so every `NG_APP_*` read is `undefined` until this runbook is
followed. This is placed under `docs/infrastructure/runbooks/` rather than a
`docs/domains/<service>/` folder because there is no `docs/domains/web/` — `apps/web` is a
frontend app, not one of the four backend services the domain split covers, and its local-dev
plumbing (`make env-file`, `.env.local.web`, Floci-minted ids) is infrastructure the same way
the other runbooks in this folder are.

## The incident this exists to prevent (2026-09-15)

`apps/web/.env.example` ships `NG_APP_WS_URL=` **empty**. `make env-file` generates the real
value into `.env.local.web` as `WS_URL=ws://localhost:4566/ws/{apiId}/{stage}`. **Nothing
bridges those two files.** The result: the web app opened no WebSocket at all, so live toast
notifications and the live unread badge simply did not exist — no error, no log, a
perfectly healthy-looking app. It survived an entire milestone and was only caught when a
browser E2E went looking for a socket in devtools. Full account, including why the fix does not
throw: [[2026-09-15-a-falsy-default-that-means-disabled-erases-the-difference-from-unconfigured]].
As of this date the app at least emits a `console.warn` naming the variable — but the value
still has to be copied by hand, which is exactly the procedure below.

## First run on a fresh clone

```bash
cp apps/web/.env.example apps/web/.env
```

Then fill it in following the table below. Skipping this step is invisible: the app boots,
routes, and renders normally — `NG_APP_*` reads `undefined`, which the parser in
`apps/web/src/app/core/config/app-config.ts` treats as `false` for every boolean flag and as
`""` for `NG_APP_WS_URL`.

## The variables

Authoritative source: `apps/web/src/app/core/config/app-config.ts` (`parseAppConfig`). Four
variables today.

| Variable | What it does | Left unset |
|---|---|---|
| `NG_APP_STRIPE_ENABLED` | Offers the Stripe payment step at checkout. | Off — absent-means-off is correct here; no error, checkout just skips the Stripe step. |
| `NG_APP_API_GATEWAY_URL` | Base path every gateway call hangs off. | Falls back to `/v1` in code (`DEFAULT_API_GATEWAY_URL`) — a safe default, not a silent gap. |
| `NG_APP_GEOCODE_ENABLED` | Offers address autocomplete at checkout. | Off — absent-means-off is correct; the checkout address field just renders a plain input. Needs `GEOAPIFY_API_KEY` set server-side too (`.env.local.web`'s CUSTOM box) — see [[env-files]]. |
| `NG_APP_WS_URL` | Host-facing realtime WebSocket URL, e.g. `ws://localhost:4566/ws/<apiId>/<stage>`. | **No sensible default exists** — the URL carries an `apiId` Floci mints fresh on every `terraform apply`, so it cannot be hardcoded. Left blank, the app starts with no socket at all; realtime toasts and the live unread badge are silently absent, and notifications arrive only on the next page load. |

`NG_APP_STRIPE_ENABLED` and `NG_APP_GEOCODE_ENABLED` are flags where "absent means off" is the
intended, safe behavior. `NG_APP_WS_URL` is different in kind: it is not a flag, it is a value
with no fallback that means anything, which is why it is the one this runbook exists for. See
[[2026-09-15-a-falsy-default-that-means-disabled-erases-the-difference-from-unconfigured]] for
why a falsy default collapsing "unconfigured" into "disabled" is the root cause, not a one-off
bug in this variable.

## The bridge — copying `WS_URL` into `apps/web/.env`

After `make env-file` (see [[local-dev-floci]] / [[ADR-0017-floci-local]] for the Floci
bootstrap this depends on), `WS_URL` lands in `.env.local.web` at the repo root. Nothing copies
it into `apps/web/.env` automatically. Do it by hand:

```bash
grep '^WS_URL=' .env.local.web | sed 's/^WS_URL=/NG_APP_WS_URL=/' >> apps/web/.env
```

Then remove the old (empty, or stale) `NG_APP_WS_URL=` line above the one you just appended, so
`apps/web/.env` does not carry two conflicting definitions. Restart `pnpm dev` afterward — see
the build-time trap below.

**This must be redone whenever Floci remints the API id** — a `make clean` followed by
`make bootstrap` (see [[local-dev-floci]]) assigns a new `apiId`, so the previously-copied
`NG_APP_WS_URL` becomes stale and the WebSocket handshake fails against the old URL. There is no
warning that the URL is stale specifically (the `console.warn` below only fires for a value that
is *empty*, not one that is wrong) — treat every `make clean`/rebuild as a cue to re-run this
bridge.

> [!warning] Never copy `WS_MANAGEMENT_ENDPOINT`
> `WS_URL` is the HOST-facing URL a browser dials. `WS_MANAGEMENT_ENDPOINT` is the in-network
> publish endpoint (`http://floci:4566/execute-api/{apiId}/{stage}`) only a Lambda container can
> reach, and answers a browser handshake with an S3 XML body rather than a normal error — see
> [[2026-08-05-realtime-tracking-events-websocket-design]]'s "Floci local URL shapes" section.
> Copying the wrong one is a believable-looking mistake that fails in a confusing way.

## Symptom table

| Symptom | Cause | How to confirm |
|---|---|---|
| No toasts, and the unread badge only updates on a full page reload | `NG_APP_WS_URL` unset or stale | Open the browser console — `app-config.ts` logs `MISSING_WS_URL_WARNING` naming the variable when it's empty (nothing is logged for a *stale* value, since it parses as a normal, non-empty string). Check devtools' Network → WS filter for a socket other than Vite's HMR connection — if the only WS entry is HMR, the app never dialed the realtime socket. |
| Address autocomplete never suggests anything at checkout | `NG_APP_GEOCODE_ENABLED` unset (or `GEOAPIFY_API_KEY` missing/invalid in `.env.local.web`'s CUSTOM box) | Flag off with a valid key: no suggestions, proxy still answers 200. Flag on with no key: the `/geocode/` proxy answers 503 instead of calling Geoapify unauthenticated. Check both independently — see [[env-files]]. |
| Checkout never shows the Stripe step | `NG_APP_STRIPE_ENABLED` unset or `false` | Expected default state — confirm the flag is `true` in `apps/web/.env` if the step should appear. |
| A `.env` edit "does nothing" — the flag looks ignored even after saving | **The trap that catches everyone.** `NG_APP_*` values are inlined at BUILD time by `@ngx-env/builder`, not read at runtime. A browser reload re-serves the bundle already compiled with the old value. | **Restart `pnpm dev`.** A reload is not enough. This cost real time in this session: the E2E's toast tests failed against a dev server started days earlier, and only a restart fixed them. |

## `NG_APP_*` values are public

Every `NG_APP_*` value ships inside the compiled bundle and is readable by anyone who opens
devtools — flags and publishable keys only, never a secret. This is `apps/web/CLAUDE.md` §2c's
golden rule; see that file for the full statement, not restated here.

## Verification

- `cat apps/web/.env` shows all four variables with the values intended for this session (no
  bare `NG_APP_WS_URL=` left empty unless realtime is deliberately being left off).
- After restarting `pnpm dev`, the browser console shows **no** `MISSING_WS_URL_WARNING`.
- Devtools' Network → WS tab shows a socket to `ws://localhost:4566/ws/...` (not only Vite's
  HMR connection) once a page that opens the notifications socket has loaded.
- Triggering a tracking status change (see
  [[2026-08-05-realtime-tracking-events-websocket-design]]) produces a live toast and an
  unread-badge update without a page reload.

## Related

- [[env-files]] — the generated-vs-hand-maintained env file convention this runbook's bridge
  procedure is a manual workaround for; that note also carries the bidirectional link back here.
- [[ADR-0017-floci-local]] — the local AWS emulator that mints the `apiId` `NG_APP_WS_URL` embeds,
  and why that id is not stable across a rebuild.
- [[2026-08-05-realtime-tracking-events-websocket-design]] — the realtime WebSocket design this
  variable connects to, including the HOST-facing-vs-in-network URL distinction.
- [[2026-09-15-a-falsy-default-that-means-disabled-erases-the-difference-from-unconfigured]] —
  the lesson recording why this gap existed for a whole milestone undetected, and the fix's
  reasoning.
- [[local-dev-floci]] — the `make bootstrap` chain that produces `.env.local.web` in the first
  place.
