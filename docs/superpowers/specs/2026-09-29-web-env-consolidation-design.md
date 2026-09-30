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
inlines at COMPILE time, never at runtime. The `NG_APP_*` values also reach the web image as
Docker build args, and the two consumers used to read different files with disjoint keys.

Layout after this design (Decisions 9 and 10):

| | `.env.local.web` | `apps/web/.env` | root `.env` |
|---|---|---|---|
| Read by | compose `${VAR}` interpolation via `docker compose --env-file` (build args); nginx via `env_file:` (container start); `@ngx-env/builder` via the cascade | `@ngx-env/builder` (`pnpm dev` on :4200, `pnpm test`), first in precedence | tooling only; compose interpolates NOTHING from it |
| Written by | `make env-file` (AUTO + CUSTOM boxes) | HAND-MAINTAINED; the generator still syncs the `NG_APP_WS_URL` line | `make env-file` (AUTO + CUSTOM boxes) |
| Holds | six `NG_APP_*` plus `GEOAPIFY_API_KEY` | overrides only | `COGNITO_*`, `APIDOG_*`, `PENCIL_MCP_BIN`, DB ports |

Every `${...}` in `docker-compose.yml` was grepped: the only six interpolations in the whole file
are the web's `NG_APP_*` build args. Nothing else in compose reads the root `.env`.

The original cost that motivated this note: `NG_APP_STRIPE_ENABLED` lived by hand in
`apps/web/.env` and was never seeded, so turning Stripe on required setting it in TWO places, and
forgetting either left that environment silently without Stripe.

### Why the root `.env` is no longer the base

This note first proposed keeping the root `.env` as the base for `NG_APP_*`, on the premise that
Docker Compose interpolates `${VAR}` only from the root `.env`. The user objected on a repo
principle: every service owns its own `.env.local.<svc>`, consumed through `env_file:`, and the
root `.env` is deprecated. The principle was right.

The technical blocker was real, and is worth recording precisely. `NG_APP_*` are BUILD ARGS
(`docker-compose.yml`), and an `env_file:` entry cannot feed a build arg: it resolves at
container runtime, too late. Compose interpolation is the only mechanism that reaches a build
arg. The way out was `docker compose --env-file <path>`, which moves interpolation to that file
instead of the root `.env`. MEASURED before implementing:
`docker compose --env-file .env.local.web config` showed all six `NG_APP_*` build args resolving
from `.env.local.web`. See Decision 9.

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
MIGRATION. See Decisions 5 to 7. The `--env-file` change (Decisions 9 and 10) does not
alter this: the cascade still exists, so the hazard stands.

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
   the generator seeds `NG_APP_STRIPE_PUBLISHABLE_KEY=""` in the `.env.local.web` CUSTOM box while
   `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` live in `.env.local.users` / `.env.local.orders`.
   A developer pasting an `sk_` or `rk_` key into that CUSTOM box gets it inlined by BOTH
   `pnpm dev` and `docker compose build web`. The anchored prefix cannot help, because the NAME is
   legitimate. This design CONCENTRATES the mistake by making the `.env.local.web` CUSTOM box the single place
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

### Decision 4 — SUPERSEDED: `NG_APP_WS_URL` in the root `.env` AUTO box

This decision proposed adding `NG_APP_WS_URL` to the root `.env`'s AUTO box beside the existing
`WS_URL`. It is superseded and must NOT be implemented. It was the wrong direction: it would have
WORSENED the duplication the user objected to, by putting a second copy of a host-facing value in
a file whose role is being reduced. It treated the root as the base instead of questioning whether
the root should be involved at all. Decisions 9 and 10 replace it.

### Decision 5 — `apps/web/.env` is optional and overrides-only (PROPOSED, reframed)

What remains true: `apps/web/.env` is read first by the cascade and WINS over any other file
(finding 3), so it must carry overrides only, and existing files must have their base keys
STRIPPED (BLOCKER 1 migration).

What no longer applies: the premise that the root `.env` supplies the base. `.env.local.web` now
carries the `NG_APP_*` for the container build (via `--env-file`) and, via the cascade, for
`pnpm dev`.

`sync_web_ws_url()` still writes `NG_APP_WS_URL` into `apps/web/.env`, so that path is untouched
by this change. For the container it is now redundant, because `.env.local.web` already carries
the value. For `pnpm dev` it still takes effect, because `apps/web/.env` is read first by the
cascade's precedence. It is KEPT; removing it is a separate change.

### Decision 6 — `apps/web/.env.example` is rewritten to overrides-only (PROPOSED, not implemented)

Comment-only by default: no base keys, and no empty `NG_APP_*=` lines, because an empty line is
an active override rather than an absence (BLOCKER 1). `apps/web/CLAUDE.md` is updated so
`cp .env.example .env` is no longer the happy path. The `.env.example` files were updated to
describe the new layout (Decision 10), but the overrides-only rewrite proposed here is not
claimed as done.

### Decision 7 — the generator's absent-file hint stops recommending a copy (PROPOSED, not implemented)

The hint printed when `apps/web/.env` is absent must not recommend a wholesale copy, since that
reintroduces the shadowing keys.

### Decision 8 — `.env.local.web` stays the sole home of `GEOAPIFY_API_KEY` (PROPOSED, not implemented)

`GEOAPIFY_API_KEY` is read at request time (`apps/web/proxy.conf.mjs`, nginx) and never enters the
bundle. `docs/shared/conventions/env-files.md` currently names `@ngx-env/builder` as a consumer of
`.env.local.web`; that must be corrected during propagation to reflect the split between the
`GEOAPIFY_API_KEY` request-time use and the `NG_APP_*` build-time use (Decisions 9 and 10).

### Decision 9 — compose interpolates from `.env.local.web` via `--env-file` (IMPLEMENTED)

The `Makefile` defines `COMPOSE := docker compose --env-file .env.local.web`, one line covering all
15 `$(COMPOSE)` uses.

`CONTRACT:` do NOT drop the `--env-file .env.local.web` flag. Without it compose reads the root
`.env`, where the `NG_APP_*` keys no longer live, so every build arg silently falls back to its
default and the bundle ships with Stripe and RUM off. No error, no warning.

The unused `ENV_FILE := .env` definition was deleted from the `Makefile` (one definition, zero
references, verified).

Verified: `docker compose --env-file .env.local.web config` resolves all six `NG_APP_*`; running
`config` WITHOUT the flag falls back to the defaults (the exact failure the `CONTRACT:`
documents); `make ps` and the Makefile targets work.

### Decision 10 — the six `NG_APP_*` generate into `.env.local.web` (IMPLEMENTED)

`infra/environments/local/scripts/generate_env_files.py` writes:

- AUTO box: `NG_APP_WS_URL` and `NG_APP_API_GATEWAY_URL`.
- CUSTOM box: `NG_APP_STRIPE_ENABLED`, `NG_APP_STRIPE_PUBLISHABLE_KEY`, `NG_APP_GEOCODE_ENABLED`,
  `NG_APP_RUM_ENABLED`.

The root `.env` spec no longer writes any of them and its header now says tooling tokens only.
Both `.env.example` files describe the new layout, and `.env.example`'s `.env.local.web` section
matches the generated file key-for-key. The root `.env`'s CUSTOM box (`APIDOG_*`,
`PENCIL_MCP_BIN`) survived regeneration.

Migration detail: after the first `make env-file`, the `NG_APP_*` keys existed in BOTH files. The
generator had stopped writing them to the root, but the root's CUSTOM box PRESERVES whatever is in
it by design, so they were removed from the root by hand. A fresh clone does not hit this.

## Confirmed safe

- Service secret files (`.env.local.users`, `.env.local.orders`, `.env.local.debug`, ...) are never
  read by the web build (finding 6).
- `verbose` logging prints names only (finding 7).
- The production/image path is unaffected, conditional on Decisions 2 and 3.

## Operator rules

Which file feeds which process:

| File | Feeds |
|---|---|
| `.env.local.web` | the web service TWICE, by two mechanisms resolving at different times: `env_file:` for nginx (`GEOAPIFY_API_KEY`) at container start, and `--env-file` interpolation for the `NG_APP_*` build args at image build. Also the cascade base for `pnpm dev` |
| `apps/web/.env` | `pnpm dev` on :4200 and `pnpm test` only (overrides, read first) |
| root `.env` | tooling tokens only; compose interpolates nothing from it |

Every `make env-file` that changes WS or a flag requires RESTARTING `pnpm dev` and running
`docker compose build web`. `NG_APP_*` is inlined at build time, so a restart re-serves the old
bundle; never restart to apply a changed `NG_APP_*`.

Do not create a bare `.env.local`, `.env.production` or `.env.development` at the repo root or in
`apps/web/`: `@ngx-env` would read them (finding 6).

## Implementation status

Implemented in the working tree (uncommitted at the time of writing): Decisions 1, 3, 9 and 10.
Verified after Decisions 1 and 3: `pnpm test` 588/588, typecheck clean, lint clean; a Docker
builder-stage build printed `Environment files: none` and still inlined all six `NG_APP_*` from
build args, with the filter shown as `^(?-i:NG_APP_)`; and a lowercase `ng_app_sneaky` canary in
the root `.env` was filtered out and did NOT reach the bundle. Verification for Decisions 9 and 10
is listed under each.

Decision 2 is a contract already satisfied by the current `angular.json`. Decision 4 is
superseded. Decisions 5 to 8 remain proposed.

## Known-stale documentation

Recorded as found; these predate this design and are fixed during propagation:

- Root `.env.example` claimed `.env` holds only four compose-interpolated vars; it was updated with Decision 10, verify during propagation.
- `docs/shared/conventions/env-files.md` names `@ngx-env/builder` as a consumer of
  `.env.local.web`.
- `docs/infrastructure/runbooks/web-app-env-config.md` says nothing bridges `WS_URL` into
  `apps/web/.env`, which `sync_web_ws_url` already contradicts.

## Out of scope and open

- **Pre-existing bug, now moot.** The developer's root `.env` held NO `NG_APP_*` keys though the
  generator declared five, because a CUSTOM box only seeds ABSENT keys on regeneration. Since the
  keys now live in `.env.local.web` and compose reads it through `--env-file`, the failure mode
  that remains is dropping the flag (Decision 9 `CONTRACT:`).
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
