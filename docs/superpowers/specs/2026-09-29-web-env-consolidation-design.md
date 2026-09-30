---
title: "Web Env Consolidation — One Source for NG_APP_* Design"
type: spec
area: shared
status: draft
created: 2026-09-29
updated: 2026-09-30
tags:
  - type/spec
  - area/shared
  - status/draft
related:
  - "[[env-files]]"
  - "[[web-app-env-config]]"
  - "[[2026-09-04-web-gateway-integration-design]]"
  - "[[2026-09-06-address-geocoding-proxy-design]]"
  - "[[browser-rum]]"
  - "[[local-dev]]"
  - "[[testing]]"
propagates-to:
  - "[[env-files]]"
  - "[[web-app-env-config]]"
---

# Web Env Consolidation — One Source for NG_APP_* Design

## Context

`apps/web/` gets build-time config from `NG_APP_*` variables that `@ngx-env/builder` 22.0.0
inlines at COMPILE time, never at runtime. Today two `.env` files with disjoint keys serve two
different consumers:

| | root `.env` | `apps/web/.env` |
|---|---|---|
| Read by | `docker-compose.yml` `${VAR}` → web image build args | `@ngx-env/builder` (`pnpm dev` on :4200, `pnpm test`) |
| Written by | `make env-file` (AUTO + CUSTOM boxes) | HAND-MAINTAINED; the generator syncs only the `NG_APP_WS_URL` line |

A third file, `.env.local.web`, holds `GEOAPIFY_API_KEY`, read at request time by
`apps/web/proxy.conf.mjs` (dev) and nginx (container).

The concrete cost: `NG_APP_STRIPE_ENABLED` lives by hand in `apps/web/.env` and is never
seeded. Turning Stripe on requires setting it in TWO places, and forgetting either leaves that
environment silently without Stripe.

## How `/v1` resolves

The bundle only ever ships the string `/v1`.

- `pnpm dev` (:4200): `apps/web/proxy.conf.mjs` rewrites `/v1` →
  `localhost:4566/restapis/<api-id>/$default/_user_request_/v1`. The api id is hardcoded there
  and `make env-file` REGENERATES that file in full (`write_web_proxy_config`).
- Container: `apps/web/nginx.conf` uses `${API_GATEWAY_PROXY_HOST}` / `${API_GATEWAY_API_ID}`,
  rendered by nginx's envsubst entrypoint at container start.
- The REST api id therefore NEVER enters the bundle, and `NG_APP_API_GATEWAY_URL=/v1` is
  identical in both environments. It is relative on purpose: nothing in this repo sends CORS
  headers, so an absolute origin dies at the preflight.
- What DOES change per Floci apply AND enters the bundle is `ws_url`. `api_id` (REST) and
  `ws_url` (WebSocket) are two separate terraform outputs, so their ids legitimately differ.

## Verified mechanism findings

1. `@ngx-env/builder` 22.0.0 exposes an `ngxEnv` option block with `root` ("Root directory of
   the project to find .env files") and `prefix`.
2. **The build already reads the repo-root `.env`, before any change.** `@dotenv-run/core`'s
   `env.js:96` defaults `root` to `findRootPath()`, and `root.js:21-37` find-ups
   `pnpm-workspace.yaml` from the cwd and returns the repo root. This repo has
   `pnpm-workspace.yaml` at its root. REPRODUCED: with `ngxEnv` REMOVED from `angular.json`
   entirely and a canary present ONLY in the root `.env`, `pnpm build` printed
   `Root directory: <repo root>`, loaded `✔ apps/web/.env` AND `✔ <repo>/.env`, and the canary
   reached the compiled bundle. In Docker the same holds: cwd is `/app/apps/web` and
   `pnpm-workspace.yaml` is COPYed to `/app` (Dockerfile:50), so the default root is already
   `/app`.
   - **Method error, recorded.** An earlier revision of this note credited
     `"ngxEnv": {"root": "../.."}` with introducing the cascade. That measurement was taken WITH
     the option and never WITHOUT it, so it could not tell the option's effect from the default's.
     The `root` option is a no-op wherever the pnpm-workspace marker exists.
3. MEASURED: precedence. With the same key in both files, `apps/web/.env` WINS.
4. `unit-test` (`pnpm test`) inherits `ngxEnv` from its `buildTarget`, so the `build.options`
   block also covers it.
5. MEASURED in Docker: `docker build` printed `Environment files: none` and still inlined all six
   `NG_APP_*` from build args. `.dockerignore` excludes the dotenv files and the Dockerfile COPYs
   no `.env`, so in-image there is no dotenv file; `@ngx-env` falls back to `process.env`, which
   is where ARG→ENV values live.
6. **Which files `@ngx-env` can read.** `buildEnvFiles` (`env.js:55-65`) expands only to
   `.env.<environment>.local`, `.env.<environment>`, `.env.local` and `.env`. `.env.local` is NOT
   `.env.local.users`, so no service secret file name collides. REPRODUCED by reproducing the
   expansion for `production`, `development` and unset. The service secret files are NEVER read.
   Latent case: a bare `.env.local` at the repo root WOULD be read. None exists today, and neither
   does `.env.production` or `.env.development`.
7. `verbose` prints variable NAMES only. Printing values needs the `unsecure` option, which this
   repo does not set (`env.js:33-41`).
8. Angular's architect merges configuration options into the base options with a SHALLOW spread
   (`node-modules-architect-host.js:205-216`), so an object-valued option under
   `configurations.<name>` REPLACES the base block wholesale. See Decision 2.

## Findings from adversarial review

Found by independent multi-provider review (two angles, then a third security/deployment angle)
and then independently reproduced by the main session.

### BLOCKER 1 — an empty child key shadows a real root value

Because `apps/web/.env` wins, and `apps/web/.env.example` ships `NG_APP_WS_URL=` (empty) plus a
full base key set, a leftover or freshly-copied child file DEFEATS the root base. MEASURED: with
`NG_APP_STRIPE_PUBLISHABLE_KEY=pk_test_<canary>` in the root and an EMPTY key of the same name in
`apps/web/.env`, the canary did NOT reach the bundle. The empty value won.

`apps/web/CLAUDE.md` and the generator's absent-file hint both tell developers to
`cp .env.example .env`, which reintroduces exactly those shadowing keys. Underlying cause:
`@dotenv-run/core` loads project-directory files before ancestors and `dotenv` does not overwrite
an already-set key, so first-wins means the child always beats the root.

This is independent of the root-default finding above: the cascade exists either way, so the
shadowing hazard is real either way. Resolution: cascade alone is NOT enough, it requires a
MIGRATION. See Decisions 5 to 7.

### BLOCKER 2 — the `NG_APP` prefix filter is unanchored and case-insensitive

`env.js:102` builds the filter as `new RegExp(prefix, "i")` and `env.js:45-48` applies it with
`.test(key)`. MEASURED against that exact regex: `NG_APP_STRIPE_ENABLED` matches (intended), but
so do `MY_NG_APP_SECRET`, `STRIPE_NG_APP_KEY`, `ng_app_lowercase` and `PREFIX_ng_APP_TOKEN`.
`STRIPE_SECRET_KEY` and `COGNITO_CLIENT_ID` do NOT match, so no leak follows from the current
variable names. But the filter is a substring match, not a prefix match, and it also admits
`NODE_ENV`.

Because the root `.env` is ALREADY in the build's dotenv path (finding 2), this is a CURRENT
exposure, not one induced by this design. The anchored prefix stands on its own merits regardless
of the rest of this design. Resolution: Decision 1.

### HIGH-1 — an anchored prefix is still case-insensitive

`^NG_APP_` closes substring matches but not casing, because `env.js:102` always wraps a string
prefix as `new RegExp(prefix, "i")`. REPRODUCED under the pinned Node 24.18.0: `^NG_APP_` still
matches `ng_app_sneaky` and `Ng_App_Mixed`. The shipped prefix is `^(?-i:NG_APP_)`, an inline
case-sensitivity modifier. Under Node 24 it matches `NG_APP_STRIPE_ENABLED` and rejects
`ng_app_sneaky`, `Ng_App_Mixed`, `MY_NG_APP_SECRET`, `NG_APPX` and `NODE_ENV`. Node is pinned to
24.18.0 in `.nvmrc`, `engines` and `node:24-alpine` in the Dockerfile, so the modifier is
available everywhere this builds.

### HIGH-2 — a configuration-level `ngxEnv` silently drops the anchor

Per finding 8, an `ngxEnv` block under `configurations.production` or `configurations.development`
replaces the base block wholesale instead of merging. Consequences: the `application` builder
falls back to the schema default `prefix: "NG_APP"` and the exposure silently reopens; and in
`dev-server` / `unit-test`, `prefix` can end up `undefined`, in which case `env.js:101-103`
returns ALL of `process.env`. Detectability is nil: no error, identical output, no gate.
Resolution: Decision 2.

### MEDIUM findings

1. **No value guard on the publishable key.** `app-config.ts` reads it with no `pk_` check, and
   the generator seeds `NG_APP_STRIPE_PUBLISHABLE_KEY=""` in the root CUSTOM box while
   `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` live in `.env.local.users` / `.env.local.orders`.
   A developer pasting an `sk_` or `rk_` key into that CUSTOM box gets it inlined by BOTH
   `pnpm dev` and `docker compose build web`. The anchored prefix cannot help, because the NAME is
   legitimate. This design CONCENTRATES the mistake by making the root CUSTOM box the single place
   people edit Stripe settings for both surfaces. Suggested mitigation, NOT yet implemented:
   reject a value matching `^(sk|rk)_` or `^whsec_` in `parseAppConfig`, in the generator, or as
   a Dockerfile assertion before `ng build`.
2. **`.dockerignore` matched only the context root.** `.env` / `.env.*` had no `**/`, so
   `apps/web/.env` was still uploadable, and a broadened `COPY` would bake it into a layer.
   `@ngx-env` reads a project-local `.env` BEFORE the repo root, so that copy would also beat the
   build args. FIXED, see Decision 3.
3. **The root exclusion was already load-bearing**, before this design, because the default root is
   already `/app` in the builder stage. A relaxed `.dockerignore` or a `COPY . .` in the builder
   stage would put the root `.env` into the build's `process.env`, and no gate in this repo would
   catch it.

## Decisions

### Decision 1 — anchored, case-sensitive prefix, and NO `root` option (IMPLEMENTED)

`apps/web/angular.json`'s `build.options` carries `"ngxEnv": { "prefix": "^(?-i:NG_APP_)" }`.

The `root` option is deliberately omitted. It is a no-op here: `findRootPath()` already resolves
the repo root (or `/app` in Docker) from the `pnpm-workspace.yaml` marker, and that default is the
actual mechanism (finding 2). Setting `root` would add no behaviour and imply a design choice that
was never made.

`CONTRACT:` the `^(?-i:NG_APP_)` prefix is the boundary between a public bundle value and a
private one. Do NOT rely on the default prefix (a case-insensitive substring match), and do NOT
shorten it to `^NG_APP_` (still case-insensitive, HIGH-1).

### Decision 2 — `ngxEnv` lives ONLY in `build.options` (CONTRACT)

`CONTRACT:` `ngxEnv` is declared in `build.options` and NEVER inside a `configurations` entry
(`production`, `development`, or any other). Architect option merging is a shallow spread
(finding 8), so a configuration-level block replaces the anchored one and silently reopens the
exposure (HIGH-2). `angular.json` accepts no comments, so this contract lives here in the vault.

The production/image path is unaffected. That statement is TRUE but CONDITIONAL on this contract
and on the `COPY`s and `.dockerignore` staying narrow (Decision 3).

### Decision 3 — `.dockerignore` excludes dotenv files at any depth (IMPLEMENTED)

`.dockerignore` carries `**/.env`, `**/.env.*` and `!**/.env.example`, with a `CONTRACT:` comment.
REPRODUCED before and after with a throwaway `docker build`: only `.env.example` now survives into
the build context.

### Decision 4 — the root `.env` AUTO box carries `NG_APP_WS_URL` beside `WS_URL` (PROPOSED, not implemented)

Add `NG_APP_WS_URL` to the root `.env`'s AUTO box ALONGSIDE the existing `WS_URL`. `@ngx-env`
filters by prefix, so it would read `WS_URL` and ignore it. Two keys, one host-facing value:
`WS_URL` for compose interpolation, `NG_APP_WS_URL` for the cascade.

### Decision 5 — `apps/web/.env` becomes optional and overrides-only (PROPOSED, not implemented)

Once Decision 4 lands, :4200 works from the root alone, so `sync_web_ws_url` is no longer
load-bearing for the socket. It is KEPT anyway, because it remains correct when a developer does
keep a child file, and removing it is a separate change.

Existing `apps/web/.env` files must have their base keys STRIPPED (BLOCKER 1 migration).

### Decision 6 — `apps/web/.env.example` is rewritten to overrides-only (PROPOSED, not implemented)

Comment-only by default: no base keys, and no empty `NG_APP_*=` lines, because an empty line is
an active override rather than an absence (BLOCKER 1). `apps/web/CLAUDE.md` is updated so
`cp .env.example .env` is no longer the happy path.

### Decision 7 — the generator's absent-file hint stops recommending a copy (PROPOSED, not implemented)

The hint printed when `apps/web/.env` is absent must not recommend a wholesale copy, since that
reintroduces the shadowing keys.

### Decision 8 — `.env.local.web` stays the sole home of `GEOAPIFY_API_KEY` (PROPOSED, not implemented)

`.env.local.web` is NOT an `@ngx-env` input. `docs/shared/conventions/env-files.md` currently
states otherwise and must be corrected during propagation.

## Confirmed safe

- Service secret files (`.env.local.users`, `.env.local.orders`, `.env.local.debug`, ...) are never
  read by the web build (finding 6).
- `verbose` logging prints names only (finding 7).
- The production/image path is unaffected, conditional on Decisions 2 and 3.

## Operator rules

Which file feeds which process:

| File | Feeds |
|---|---|
| `apps/web/.env` | `pnpm dev` on :4200 only (overrides on top of the root) |
| root `.env` | compose build args AND the cascade base (read by default, finding 2) |
| `.env.local.web` | nginx / Geoapify proxy (request time), never the bundle |

Every `make env-file` that changes WS or a flag requires RESTARTING `pnpm dev` and REBUILDING the
web container. `NG_APP_*` is inlined at build time, and a restart re-serves the old bundle.

Do not create a bare `.env.local`, `.env.production` or `.env.development` at the repo root or in
`apps/web/`: `@ngx-env` would read them (finding 6).

## Implementation status

Implemented in the working tree (uncommitted at the time of writing): Decisions 1 and 3.
Verified after both: `pnpm test` 588/588, typecheck clean, lint clean; a Docker builder-stage
build printed `Environment files: none` and still inlined all six `NG_APP_*` from build args, with
the filter shown as `^(?-i:NG_APP_)`; and a lowercase `ng_app_sneaky` canary in the root `.env`
was filtered out and did NOT reach the bundle.

Decision 2 is a contract already satisfied by the current `angular.json`. Decisions 4 to 8 are
proposals and remain to be implemented.

## Known-stale documentation

Recorded as found; these predate this design and are fixed during propagation:

- Root `.env.example` still claims `.env` holds only four compose-interpolated vars.
- `docs/shared/conventions/env-files.md` names `@ngx-env/builder` as a consumer of
  `.env.local.web`.
- `docs/infrastructure/runbooks/web-app-env-config.md` says nothing bridges `WS_URL` into
  `apps/web/.env`, which `sync_web_ws_url` already contradicts.

## Out of scope and open

- **Pre-existing bug, separate from this design.** The developer's root `.env` currently holds NO
  `NG_APP_*` keys though the generator declares five, because the CUSTOM box only seeds ABSENT
  keys on regeneration and that file predates the Stripe additions. Consequence:
  `docker compose build web` today falls back to Stripe OFF and an empty publishable key,
  silently. Fixed by running `make env-file`.
- **End-to-end verification on :4200 is STILL NOT done.** Floci is up, but
  `aws apigateway get-rest-apis` returns an empty list and `localhost:3004/v1/users/health`
  answers 502, so the gateway could not be exercised. The cascade is proven by build-log and
  bundle-canary evidence, NOT by a live :4200 request.
- **Publishable-key value guard** (MEDIUM 1) is a suggested mitigation, not implemented.
- **Review coverage.** The security/deployment angle HAS now been reviewed, by a third provider.
  The originally assigned provider (Antigravity CLI) never started its turn because it was not
  signed in, so that angle was re-run on another provider.

## Related

- [[env-files]] — the generated-env-file convention this design amends (cascade base, `.env.local.web` ownership).
- [[web-app-env-config]] — the runbook whose `WS_URL` bridging claim is stale.
- [[2026-09-04-web-gateway-integration-design]] — origin of the relative `/v1` same-origin contract.
- [[2026-09-06-address-geocoding-proxy-design]] — origin of `.env.local.web` and the Geoapify proxy.
- [[browser-rum]] — another `NG_APP_*` build-time flag consumer (`NG_APP_RUM_ENABLED`).
- [[local-dev]] — the local workflow that restarts `pnpm dev` and rebuilds the web container.
- [[testing]] — `pnpm test` inherits `ngxEnv` through the `unit-test` builder's `buildTarget`.
