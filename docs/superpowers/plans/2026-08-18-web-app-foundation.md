---
title: Web App Foundation & Pencil Design Extraction — Plan
type: plan
area: shared
status: draft
created: 2026-08-18
updated: 2026-08-18
tags: [type/plan, area/shared, status/draft, phase/1]
related:
  - "[[2026-08-17-web-app-foundation-design]]"
  - "[[web-app-foundation-milestone]]"
  - "[[package-manager]]"
  - "[[testing]]"
  - "[[doc-propagation]]"
  - "[[email-templates]]"
propagates-to:
  - "[[index]]"
  - "[[testing]]"
---

# Web App Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/web/` — an Angular + NgRx + Tailwind app where all 18 designed screens (36 frames, desktop + mobile) are laid out and reachable by routing — together with the `pencil-design-extraction` skill, the `web-impl` agent, and the convention note that make the design reproducible.

**Architecture:** Angular standalone components with signals, one responsive component per screen (390px + 1440px from the same `.pen` frame pair). Design tokens are read from the `.pen` via the Pencil MCP server and emitted into Tailwind v4's CSS-first `@theme` block. Phase 1 renders typed fixtures derived from the three services' `openapi.yaml`; no screen calls the gateway.

**Tech Stack:** Angular 21.2.20, NgRx 21.1.1 (`@ngrx/store` + `@ngrx/signals`), Tailwind CSS 4.3.3 (`@tailwindcss/postcss`), `@ngx-env/builder` 21.0.1 (build-time env vars), TypeScript 5.9.x, Node 24.18.0, pnpm 9.15.0, Playwright 1.48+ (existing `e2e/` project).

**Spec:** `docs/superpowers/specs/2026-08-17-web-app-foundation-design.md`

## Global Constraints

These apply to **every** task below. They are not repeated per task.

- **pnpm only, never npm or yarn.** Use `pnpm add`, `pnpm --filter`, and `pnpm dlx` in place of `npx`. A bare `npm install` corrupts the pnpm tree. → [[package-manager]]
  **Running a binary the workspace already installed** (e.g. `ng` after Task 1): `cd apps/web && pnpm exec <bin>`. `pnpm dlx` downloads a throwaway copy and `pnpm --filter <pkg> dlx` is not valid at all — it errors with `Unknown option: 'recursive'`.
- **Run `nvm use` before any Node command.** Node is pinned to **24.18.0** by `.nvmrc`.
- **Versions are pinned to these exact majors:** Angular **21.x** (`@angular/core` 21.2.20, `@angular/cli` 21.2.21), NgRx **21.1.1**, Tailwind **4.3.3**. See "Version decision" below — do **not** install Angular 22.
- **Tailwind v4 has no `tailwind.config.ts`.** Tokens go in a CSS `@theme` block. The spec's D6 text says `theme.extend`; that is v3 syntax and is superseded here (see "Deviations from the spec").
- **Never use Tailwind arbitrary values for design colours.** `bg-brand-navy`, never `bg-[#2D3748]` (spec D6).
- **Never put a secret in an `NG_APP_*` variable.** Everything `@ngx-env/builder` exposes is compiled into the bundle and readable by anyone who opens devtools. A feature flag and a Stripe *publishable* key are fine; a secret key is not. → Task 2b
- **Code, comments, filenames and docs in English.** Converse with the user in Spanish.
- **Never commit.** Every task ends with work in the working tree; the main session commits via the A/B/C/D/E menu. The `git commit` steps in the task bodies below are the *proposed* message for that menu, not an instruction to self-commit.
- **`docs/` is written only by `obsidian-vault`.** Tasks touching the vault must route through that agent.
- **Do not hand-edit anything in `apps/web/design/exports/`.** Re-export instead (spec D3).

---

## Version decision — Angular 21, not 22 (resolved during planning)

The spec says "Angular latest version". At planning time (2026-08-18) the registry shows **Angular 22.1.2** as latest, but:

| Package | Latest stable | Peer requirement |
| --- | --- | --- |
| `@angular/core` | 22.1.2 | — |
| `@ngrx/store` / `@ngrx/signals` | **21.1.1** | `@angular/core` **^21.0.0** |
| `@ngrx/signals` `next` | 22.0.0-**rc.0** | `@angular/core` ^22.0.0 |
| `@ngx-env/builder` | 22.0.0 (latest) | `@angular/build` **^22.0.0** |
| `@ngx-env/builder` | **21.0.1** | `@angular/build` ^21.0.0 |

**NgRx has no stable release for Angular 22.** Choosing Angular 22 means either an RC state library or no NgRx — both contradict the spec, which names NgRx as a hard requirement. This plan therefore pins **Angular 21.2.20 + NgRx 21.1.1**, the newest fully-stable combination.

Verified as compatible: `@angular/build@21.2.21` declares `tailwindcss: "^2.0.0 || ^3.0.0 || ^4.0.0"` as a peer, so Tailwind 4 installs cleanly **without** the `--force` flag that Tailwind's own Angular guide still recommends (that instruction targets Angular's older v3-only peer range and does not apply here).

Angular 21 engines: `^20.19.0 || ^22.12.0 || >=24.0.0` — satisfied by the repo's pinned Node 24.18.0.

`@ngx-env/builder` pins to **21.0.1** for the same reason: its `latest` (22.0.0) peers `@angular/build ^22.0.0`. Installing `latest` here breaks the build.

**When NgRx 22 goes stable, upgrading all three together is a single follow-up task.** It is deliberately not in phase 1.

---

## Deviations from the spec (read before starting)

Three spec statements were checked against reality during planning and did not survive. The decisions stand; the mechanics changed.

1. **D6 says tokens land in `tailwind.config.ts` → `theme.extend`.** That is Tailwind v3. Tailwind 4 is CSS-first: tokens are CSS custom properties inside `@theme { }` in the stylesheet, and there is no config file by default. The *intent* of D6 — named tokens, never arbitrary values — is preserved exactly; only the file and syntax change. Task 3 implements the v4 form.

2. **Token names need a namespace prefix in v4.** Tailwind 4 derives utilities from namespaced variables: `--color-brand-navy` produces `bg-brand-navy`/`text-brand-navy`. A bare `--brand-navy` produces **no utility at all**. The `.pen` variable names must therefore be *mapped*, not copied verbatim. Task 3 defines the mapping table.

3. **The e2e suite runs Playwright, not Vitest.** `e2e/CLAUDE.md` §1 claims "Runner: **Vitest**", but `e2e/package.json` has `"test": "playwright test"` with `@playwright/test`, and every spec imports from `@playwright/test`. The config file is authoritative; the nested CLAUDE.md is stale. This plan uses Playwright. **Fixing that stale line is out of scope here** — flag it to the user as a separate one-line docs fix.

---

## File Structure

```
apps/web/
├── CLAUDE.md                          nested project memory            (Task 12)
├── DESIGN.md                          distilled design system           (Task 4)
├── package.json                       @3mrai/web                        (Task 1)
├── angular.json, tsconfig*.json       CLI scaffold                      (Task 1)
├── .postcssrc.json                    @tailwindcss/postcss              (Task 2)
├── .env.example                       NG_APP_* contract                 (Task 2b)
├── design/
│   ├── README.md                      "nothing here is imported"        (Task 5)
│   └── exports/<screen>.html          committed snapshots               (Task 5)
└── src/
    ├── styles.css                     @import tailwindcss + @theme      (Task 3)
    ├── env.d.ts                       import.meta.env types             (Task 2b)
    ├── main.ts, index.html            bootstrap                         (Task 1)
    └── app/
        ├── app.ts, app.routes.ts      shell + route table               (Task 6)
        ├── core/
        │   ├── config/                APP_CONFIG (build-time flags)     (Task 2b)
        │   ├── layout/                AppHeader, MobileAppHeader        (Task 7)
        │   └── overlay/               overlay-store (cart/menu/notifs)  (Task 8)
        ├── shared/ui/                 18 reusable components         (Tasks 7, 9)
        ├── fixtures/                  typed sample data                 (Task 4b)
        └── features/
            ├── auth/                  6 screens                         (Task 9)
            ├── catalogue/             1 screen                          (Task 10)
            ├── cart/                  overlay + Stripe payment          (Task 10)
            ├── checkout/              1 screen                          (Task 10)
            ├── orders/                2 screens                         (Task 11)
            ├── account/               profile + menu overlay            (Task 11)
            └── notifications/         panel + toast overlays            (Task 11)

.claude/skills/pencil-design-extraction/SKILL.md                          (Task 13)
.claude/agents/web-impl.md                                                (Task 14)
docs/shared/conventions/pencil-design-extraction.md                       (Task 15)
e2e/tests/web/navigation.spec.ts                                          (Task 16)
```

---

## Frame ID reference (read from the `.pen`, 2026-08-18 — 26 variables)

The skill and the export tasks need real node ids. All 59 root frames, verified live via `Get(document, …)`:

**Reusable components (20).** `M8f7U` Logo Lockup · `TLRTA` Field · `sHl96` Button Primary · `aUEDx` Button Ghost · `NZ7jF` OTP Digit · `WXmng` Brand Panel · `u2nnov` Mobile Brand Header · `EMNqu` App Header · `QmNIg` Product Card · `L5XVFs` Cart Line · `ET6dr` Cart Drawer · `B6fdc` Account Menu · `l7LGs` Status Badge · `l6TyrG` Order Card · `fguH5` Mobile App Header · `tWTSZ` Mobile Order Card · `qwO6X` Notification Item · `LWQ8g` Notifications Panel · `jYz4h` Toast Notification · `S59Ud1` Tracking Status Icon

**Variant sheets (2, not components).** `UOHCo` Status Badge — States · `hImQh` Tracking Status — Icons

**Scratch (1, ignore).** `bi8Au` Frame 800x600 — empty, not part of the design.

**Screens (36 frames = 18 pairs).** The spec says "39 screen frames"; the live read counts **36**. The difference is the 2 variant sheets and the empty scratch frame, which the spec's arithmetic folded into its screen total. 18 responsive components is the number that matters for the task breakdown, and it is what Tasks 9–11 build.

| Area | Desktop | id | Mobile | id |
| --- | --- | --- | --- | --- |
| Auth | Login — Email & Password | `I4wRF` | Mobile — Login Email & Password | `MnqTi` |
| Auth | Login — Passwordless | `j0sCI` | Mobile — Login Passwordless | `drEOJ` |
| Auth | Verify Code — OTP | `V16TI` | Mobile — Verify Code | `zouHC` |
| Auth | Register — Email & Password | `q52fsc` | Mobile — Register Email & Password | `L4qQLy` |
| Auth | Register — Passwordless | `UK1Bu` | Mobile — Register Passwordless | `t2OrS` |
| Auth | Set New Password — Forced | `atwtV` | Mobile — Set New Password | `G6lEnQ` |
| Catalogue | Home — Products | `eK0x6` | Mobile — Home Products | `ffO4d` |
| Cart | Home — Cart Open (saved address) | `wevx6` | Mobile — Cart (saved address) | `OIjLT` |
| Cart | Home — Cart Open (no address) | `eig49` | Mobile — Cart (no address) | `KzgZN` |
| Cart | Home — Cart Payment (Stripe) | `hed4V` | Mobile — Cart Payment (Stripe) | `NfXeq` |
| Checkout | Checkout — Payment | `DOtD2` | Mobile — Checkout Payment | `P0lhqj` |
| Account | Profile | `hZ87b` | Mobile — Profile | `nyVEI` |
| Account | Home — Account Menu | `H2A9g` | Mobile — Account Menu | `pD15E` |
| Orders | Orders — List | `rGwBO` | Mobile — Orders List | `OoNex` |
| Orders | Orders — Detail | `x7ABM` | Mobile — Orders Detail | `eq3Tk` |
| Notifications | Home — Notifications (Unread) | `mSssa` | Mobile — Notifications (Unread) | `MP3DR` |
| Notifications | Home — Notifications (Read) | `YZIGp` | Mobile — Notifications (Read) | `b6S5Bl` |
| Notifications | Home — Notification Toast | `IQCEF` | Mobile — Notification Toast | `UpmOQ` |

**Overlay vs page, verified by inspecting each frame's children:**

```
Home — Products          [eK0x6] -> ref:App Header | frame:Body          ← real page
Checkout — Payment       [DOtD2] -> ref:App Header | frame:Body          ← real page
Home — Cart Open (saved) [wevx6] -> frame:Page | rectangle:Scrim | ref:Cart Drawer
Home — Account Menu      [H2A9g] -> frame:Page | ref:Account Menu
Home — Notifications     [mSssa] -> frame:Page | ref:Notifications Panel
Home — Cart Payment      [hed4V] -> frame:Page | rectangle:Scrim | ref:Cart Drawer — Payment
```

Frames whose first child is `Page` + an overlay are **UI state over the catalogue route**, not routes of their own. This is the empirical basis for the route map in Task 6.

---

## Design tokens (read live from the `.pen`, 2026-08-18)

`GetVariables()` returned exactly 26 variables (verified live 2026-08-18; an earlier count of 27 mistakenly included the table header). Values verified identical to `assets/email/DESIGN.md` where they overlap — **web and email share one design system**.

| `.pen` name | Type | Value |
| --- | --- | --- |
| `brand-navy` | color | `#2D3748` |
| `brand-navy-deep` | color | `#1F2733` |
| `brand-orange` | color | `#F7941D` |
| `brand-orange-light` | color | `#FFF4E5` |
| `brand-orange-text` | color | `#C2710E` |
| `bg-body` | color | `#F4F4F5` |
| `bg-white` | color | `#FFFFFF` |
| `bg-subtle` | color | `#FAFAFA` |
| `text-primary` | color | `#1A1A2E` |
| `text-secondary` | color | `#6B7280` |
| `text-muted` | color | `#9CA3AF` |
| `text-on-dark` | color | `#E8EAEE` |
| `border-color` | color | `#E5E7EB` |
| `border-strong` | color | `#D1D5DB` |
| `success-green` | color | `#10B981` |
| `success-bg` | color | `#ECFDF5` |
| `success-text` | color | `#047857` |
| `danger-red` | color | `#DC2626` |
| `info-blue` | color | `#2563EB` |
| `info-bg` | color | `#EFF6FF` |
| `warn-text` | color | `#B45309` |
| `warn-bg` | color | `#FFF7ED` |
| `font-heading` | string | `Inter` |
| `font-body` | string | `Inter` |
| `radius-md` | number | `10` |
| `field-height` | number | `56` |

---

## Fixture contracts (read from the three `openapi.yaml`, 2026-08-18)

Phase-1 fixtures are typed from these. Four traps found while reading them — the plan encodes each:

1. **Orders emits every integer as `type: [integer, string]`.** `unitPriceCents`, `totalCents`, `quantity`, `width`, `height` may arrive as `12345` **or** `"12345"`. Fixture types model this as `IntLike = number | string` with a `toInt()` coercion helper.
2. **Orders is camelCase but its embedded `TrackingDto` is snake_case.** One response body contains both `order.userId` and `order.tracking.user_id`. Fixture types mirror the wire faithfully rather than normalising — normalising here would hide the real inconsistency from phase 2.
3. **Tracking's `status` has no enum in the contract** (deliberately — see the `UpdateStatusRequest` description). The five values live only in `services/tracking/src/features/tracking/domain/status.py`. The design's `Status Badge — States` frame carries the identical list: `PLACED → PROCESSING → SHIPPED → OUT_FOR_DELIVERY → DELIVERED`. Fixtures define that union locally and cite both sources.
4. **`OrderLineDto` carries only `productId`** — no name, image, or unit price. Rendering an order line requires a client-side join against `GET /v1/products`. Fixtures must include the join, or the Orders screens cannot render.

Also: `User.address` is `anyOf: [{}, null]` — completely untyped in the contract. Phase 1 defines a local `Address` shape from the **design's** profile/checkout fields and marks it clearly as design-derived, not contract-derived.

---

## Task list

Tasks 1–6 are sequential (each depends on the previous). Tasks 9–11 are independent of each other once 7 and 8 land, and are the natural batch boundaries for review.

---

### Task 1: Scaffold `apps/web` and join the workspace

**Files:**
- Create: `apps/web/` (Angular CLI output: `package.json`, `angular.json`, `tsconfig.json`, `tsconfig.app.json`, `src/main.ts`, `src/index.html`, `src/app/app.ts`, `src/app/app.config.ts`, `src/app/app.routes.ts`)
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json` (root, scripts block)

**Interfaces:**
- Consumes: nothing.
- Produces: a buildable `@3mrai/web` package; `pnpm web:build` and `pnpm web:test` at the repo root.

- [ ] **Step 1: Generate the app with the Angular CLI, pinned to 21**

From the repo root. `--skip-install` because pnpm installs from the workspace root, not from inside the package.

```bash
nvm use
pnpm dlx @angular/cli@21.2.21 new web \
  --directory=apps/web \
  --style=css \
  --ssr=false \
  --routing=true \
  --package-manager=pnpm \
  --skip-git \
  --skip-install
```

- [ ] **Step 2: Rename the package and pin exact versions**

Edit `apps/web/package.json` — set the name and strip the CLI's caret ranges on the three pinned majors:

```json
{
  "name": "@3mrai/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "ng serve",
    "build": "ng build",
    "test": "ng test",
    "lint": "ng lint",
    "typecheck": "tsc --noEmit -p tsconfig.app.json"
  }
}
```

Leave the CLI-generated `dependencies` / `devDependencies` blocks in place; Step 4 adds to them.

- [ ] **Step 3: Register the package in the workspace**

Add to `pnpm-workspace.yaml`, after the `e2e/load-tests` line:

```yaml
  - "apps/web"
```

Add to the root `package.json` `scripts` block, following the existing `users:*` naming:

```json
    "web:dev": "pnpm --filter @3mrai/web dev",
    "web:build": "pnpm --filter @3mrai/web build",
    "web:test": "pnpm --filter @3mrai/web test",
    "web:lint": "pnpm --filter @3mrai/web lint",
    "web:typecheck": "pnpm --filter @3mrai/web typecheck",
```

- [ ] **Step 4: Install NgRx**

```bash
nvm use
pnpm --filter @3mrai/web add @ngrx/store@21.1.1 @ngrx/signals@21.1.1
```

- [ ] **Step 5: Verify the build passes**

```bash
nvm use && pnpm install && pnpm web:build
```

Expected: `Application bundle generation complete`, exit 0. If pnpm reports a peer conflict on `@angular/core`, the wrong Angular major was installed — check `apps/web/package.json` says `21.` and not `22.`.

- [ ] **Step 6: Commit** *(proposed message — main session confirms via the A/B/C/D/E menu)*

```
build(web): scaffold apps/web with Angular 21 + NgRx 21

Angular 21 rather than 22: NgRx has no stable release for 22
(@ngrx/signals 22 is rc.0 only), and the spec requires NgRx.

Spec: docs/superpowers/specs/2026-08-17-web-app-foundation-design.md
Plan: docs/superpowers/plans/2026-08-18-web-app-foundation.md
```

---

### Task 2: Wire Tailwind 4

**Files:**
- Create: `apps/web/.postcssrc.json`
- Create: `apps/web/eslint.config.js` (via `ng add angular-eslint`)
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/angular.json` (lint target)
- Modify: `apps/web/package.json` (deps)

**Interfaces:**
- Consumes: Task 1's scaffold.
- Produces: Tailwind utilities available in every component template.

- [ ] **Step 1: Install Tailwind**

No `--force`: `@angular/build@21` already peers `tailwindcss ^4.0.0`.

```bash
nvm use
pnpm --filter @3mrai/web add -D tailwindcss@4.3.3 @tailwindcss/postcss@4.3.3 postcss@^8.4.0
```

- [ ] **Step 1b: Install ESLint — `web:lint` has no backing target without it**

Task 1 declares a `lint` script, but Angular 21's `ng new` no longer scaffolds
ESLint: `angular.json` has only `build`, `serve` and `test` targets, so
`pnpm web:lint` exits 1 with *"Cannot find lint target"*. Tasks 7, 9, 10, 11 and
the `web-impl` agent all use that command to verify their work.

`angular-eslint@21.4.0`, not `latest` — `latest` (22.1.0) targets Angular 22:

```bash
nvm use && cd apps/web
pnpm exec ng add angular-eslint@21.4.0 --skip-confirmation
```

> [!warning] `pnpm --filter <pkg> dlx` is not a valid invocation
> It fails with `Unknown option: 'recursive'`, and a bare `pnpm dlx ng add`
> resolves the wrong `ng` package (no bin). To run a binary that the workspace
> package already has installed — which `@angular/cli` is, after Task 1 — use
> `pnpm exec` from inside that package's directory. Reserve `pnpm dlx` for
> binaries that are NOT installed (Task 1's `ng new` is the correct use: at that
> point no CLI exists yet).

If the schematic tries to reach the network for a version it cannot resolve, add
the dep and config by hand instead:

```bash
nvm use
pnpm --filter @3mrai/web add -D angular-eslint@21.4.0 eslint@^9
```

then add the `lint` target to `apps/web/angular.json`:

```json
"lint": {
  "builder": "@angular-eslint/builder:lint",
  "options": { "lintFilePatterns": ["src/**/*.ts", "src/**/*.html"] }
}
```

Verify it actually runs — the whole point of this step:

```bash
nvm use && pnpm web:lint
```

Expected: exit 0 (no findings on the scaffold). **A non-zero exit here means the
lint target still is not wired**, and five later tasks will inherit a broken
check.

- [ ] **Step 2: Create the PostCSS config**

`apps/web/.postcssrc.json` — Angular's build picks this up automatically:

```json
{
  "plugins": {
    "@tailwindcss/postcss": {}
  }
}
```

- [ ] **Step 3: Import Tailwind in the stylesheet**

Replace the whole contents of `apps/web/src/styles.css`:

```css
@import "tailwindcss";
```

- [ ] **Step 4: Prove a utility actually compiles**

Add a Tailwind class to `apps/web/src/app/app.ts`'s template — a colour that is **not** a design token, so it is obviously temporary:

```html
<h1 class="text-3xl font-bold underline">tailwind-probe</h1>
```

Build, then grep the output CSS for the generated rule:

```bash
nvm use && pnpm web:build
grep -r "text-3xl" apps/web/dist/ | head -3
```

Expected: at least one match. **No match means PostCSS never ran** — check `.postcssrc.json` is at `apps/web/`, not the repo root.

- [ ] **Step 5: Remove the probe**

Delete the probe `<h1>` from `app.ts`. It exists only to prove step 4; leaving it ships a stray heading.

- [ ] **Step 6: Commit**

```
build(web): add Tailwind CSS 4 and ESLint

No --force needed: @angular/build 21 peers tailwindcss ^4.0.0.
angular-eslint pinned to the 21 line; Angular 21's ng new no longer
scaffolds a lint target, which left `pnpm web:lint` failing.
```

---

### Task 2b: Build-time environment config and the Stripe flag

**Files:**
- Modify: `apps/web/angular.json` (builder swap)
- Modify: `apps/web/package.json` (dep)
- Create: `apps/web/src/env.d.ts`
- Create: `apps/web/.env.example`
- Create: `apps/web/src/app/core/config/app-config.ts`
- Modify: `.env.example` (repo root — document the new variable)

**Interfaces:**
- Consumes: Task 1's scaffold.
- Produces: `APP_CONFIG` with `stripeEnabled: boolean`, consumed by Task 10. (No route is gated by the flag — both checkout paths live under `/checkout` — so Task 6 does not read it.)

**Why a builder and not `environment.ts`.** Angular's native `fileReplacements`
would work, but the repo already expresses configuration as `.env` files
([[env-files]]). `@ngx-env/builder` keeps that shape: it reads `.env` at build
time and inlines any `NG_APP_*` variable into the bundle.

> [!warning] Everything exposed here is PUBLIC
> There is no `process.env` in a browser. `@ngx-env/builder` **compiles the
> value into the JavaScript bundle**, so anyone can read it with devtools. Its
> own docs say it plainly: *"Do not store any secrets (such as private API keys)
> in your Angular app!"*
>
> A feature flag is safe. A Stripe **publishable** key (`pk_...`) is safe — it is
> designed to be public. A Stripe **secret** key (`sk_...`) must never appear
> here; it belongs to a backend service that does not exist yet.

**Version pin.** `@ngx-env/builder@21.0.1`, not `latest` — `latest` (22.0.0)
peers `@angular/build ^22.0.0` and will not install against Angular 21.

- [ ] **Step 1: Install and swap the builder**

```bash
nvm use
pnpm --filter @3mrai/web add -D @ngx-env/builder@21.0.1
```

In `apps/web/angular.json`, replace the builder on the `build`, `serve` and
`test` targets:

```json
"build": { "builder": "@ngx-env/builder:application" },
"serve": { "builder": "@ngx-env/builder:dev-server" },
"test":  { "builder": "@ngx-env/builder:karma" }
```

Swap only the `builder` strings; leave every `options` block untouched.

- [ ] **Step 2: Declare the variables**

`apps/web/.env.example` — committed, the contract; `.env` itself stays git-ignored:

```sh
# Whether the Stripe payment path is offered at checkout.
# false -> "Checkout — Payment" (design frame DOtD2)
# true  -> the Stripe step in the cart drawer (design frame hed4V)
# PUBLIC: compiled into the bundle. Never put a secret key in an NG_APP_* var.
NG_APP_STRIPE_ENABLED=false
```

`apps/web/src/env.d.ts` — without this, `import.meta.env` is untyped:

```ts
/**
 * Types for the build-time variables @ngx-env/builder inlines.
 * Only NG_APP_*-prefixed variables are exposed; everything here is PUBLIC.
 */
interface ImportMetaEnv {
  readonly NG_APP_STRIPE_ENABLED: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 3: Parse it once, in one place**

Every `NG_APP_*` value arrives as a **string**: `"false"` is truthy in JS, so
reading `import.meta.env.NG_APP_STRIPE_ENABLED` directly in a template enables
Stripe exactly when it should be off. Parse once and never re-read the raw value.

`apps/web/src/app/core/config/app-config.ts`:

```ts
/**
 * Build-time configuration, inlined by @ngx-env/builder.
 *
 * Every NG_APP_* value is a STRING — "false" is truthy — so it is parsed here,
 * once, and the rest of the app reads the boolean. Nothing else in the app may
 * read import.meta.env directly.
 *
 * PUBLIC: these values ship inside the bundle. Never a secret.
 */
export interface AppConfig {
  /** Whether the Stripe payment path is offered at checkout. */
  readonly stripeEnabled: boolean;
}

export const APP_CONFIG: AppConfig = {
  stripeEnabled: import.meta.env.NG_APP_STRIPE_ENABLED === "true",
};
```

- [ ] **Step 4: Document it in the root `.env.example`**

Add to the CUSTOM box, beside `APIDOG_*` and `PENCIL_MCP_BIN`:

```sh
# ─── apps/web (build-time, PUBLIC) ────────────────────────────────────────────
# Read by @ngx-env/builder and COMPILED INTO THE BUNDLE — never a secret here.
# Gates the Stripe checkout path; both paths exist in the design.
NG_APP_STRIPE_ENABLED=false
```

- [ ] **Step 5: Verify BOTH values, not just the default**

A flag tested in one position is not tested. Check the value actually reaches
the bundle and that `"false"` does not read as true:

```bash
cd apps/web
nvm use
echo 'NG_APP_STRIPE_ENABLED=true' > .env
pnpm build && grep -rl "stripeEnabled" dist/ >/dev/null && echo "built with true"
echo 'NG_APP_STRIPE_ENABLED=false' > .env
pnpm build
```

Expected: both builds succeed. Then confirm the parse is correct — with the flag
`false`, the string `"false"` must not survive as a truthy value:

```bash
grep -rc 'NG_APP_STRIPE_ENABLED' dist/ 2>/dev/null || echo "inlined, not read at runtime"
```

`@ngx-env/builder` replaces the expression at build time, so the variable **name**
should not appear in the output — its value is already substituted. If the name
survives, the builder swap in step 1 did not take effect.

- [ ] **Step 6: Commit**

```
build(web): build-time env config via @ngx-env/builder

NG_APP_STRIPE_ENABLED gates the Stripe checkout path. Pinned to 21.0.1:
latest (22.0.0) peers @angular/build ^22. Parsed once in app-config.ts
because every NG_APP_* value is a string and "false" is truthy.
```

---

### Task 3: Emit the 26 design tokens into Tailwind's `@theme`

**Files:**
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 2's Tailwind setup.
- Produces: the token utility vocabulary every later component uses — `bg-brand-navy`, `text-ink-primary`, `rounded-md`, `h-field`, `font-body`.

**Naming rule.** Tailwind 4 generates utilities from *namespaced* variables. `--color-x` → `bg-x`/`text-x`/`border-x`. A bare `--brand-navy` generates nothing. Two `.pen` names also collide with utility prefixes and must be renamed rather than copied:

| `.pen` name | Problem if copied verbatim | Mapped to | Utility |
| --- | --- | --- | --- |
| `bg-body` | `--color-bg-body` → `bg-bg-body` (stutters) | `surface-body` | `bg-surface-body` |
| `bg-white` | same stutter, and shadows Tailwind's own `white` | `surface-white` | `bg-surface-white` |
| `bg-subtle` | same stutter | `surface-subtle` | `bg-surface-subtle` |
| `text-primary` | `--color-text-primary` → `text-text-primary` | `ink-primary` | `text-ink-primary` |
| `text-secondary` | same | `ink-secondary` | `text-ink-secondary` |
| `text-muted` | same | `ink-muted` | `text-ink-muted` |
| `text-on-dark` | same | `ink-on-dark` | `text-ink-on-dark` |
| `border-color` | `border-border-color` | `line` | `border-line` |
| `border-strong` | `border-border-strong` | `line-strong` | `border-line-strong` |
| `success-text` / `warn-text` | `text-success-text` | `success-ink` / `warn-ink` | `text-success-ink` |

Every other name maps straight through (`brand-navy` → `--color-brand-navy`).

- [ ] **Step 1: Write the `@theme` block**

Append to `apps/web/src/styles.css`, below the `@import`:

```css
/* Design tokens — generated from assets/web-app/web-app.pen via the Pencil MCP
 * `GetVariables()`. Do NOT hand-edit: re-run the pencil-design-extraction skill.
 * Some names are remapped from their .pen originals to avoid Tailwind v4 utility
 * stutter (bg-body -> bg-bg-body); see the mapping table in the plan.
 * These values are SHARED WITH THE EMAIL TEMPLATES (assets/email/DESIGN.md) —
 * changing a brand colour here is a two-surface change. */
@theme {
  /* Brand */
  --color-brand-navy: #2D3748;
  --color-brand-navy-deep: #1F2733;
  --color-brand-orange: #F7941D;
  --color-brand-orange-light: #FFF4E5;
  --color-brand-orange-text: #C2710E;

  /* Surfaces (.pen: bg-*) */
  --color-surface-body: #F4F4F5;
  --color-surface-white: #FFFFFF;
  --color-surface-subtle: #FAFAFA;

  /* Text (.pen: text-*) */
  --color-ink-primary: #1A1A2E;
  --color-ink-secondary: #6B7280;
  --color-ink-muted: #9CA3AF;
  --color-ink-on-dark: #E8EAEE;

  /* Borders (.pen: border-color, border-strong) */
  --color-line: #E5E7EB;
  --color-line-strong: #D1D5DB;

  /* Semantic */
  --color-success-green: #10B981;
  --color-success-bg: #ECFDF5;
  --color-success-ink: #047857;
  --color-danger-red: #DC2626;
  --color-info-blue: #2563EB;
  --color-info-bg: #EFF6FF;
  --color-warn-ink: #B45309;
  --color-warn-bg: #FFF7ED;

  /* Type */
  --font-heading: Inter, ui-sans-serif, system-ui, sans-serif;
  --font-body: Inter, ui-sans-serif, system-ui, sans-serif;

  /* Metrics (.pen numbers are px) */
  --radius-md: 10px;
  --spacing-field: 56px;
}
```

- [ ] **Step 2: Self-host Inter**

The design uses Inter; the HTML export links Google Fonts, which is snapshot scaffolding and must not ship (spec D4b).

```bash
nvm use
pnpm --filter @3mrai/web add @fontsource/inter
```

Add above the `@import "tailwindcss"` line in `styles.css`:

```css
@import "@fontsource/inter/400.css";
@import "@fontsource/inter/500.css";
@import "@fontsource/inter/600.css";
@import "@fontsource/inter/700.css";
```

- [ ] **Step 3: Set the body defaults**

Append to `styles.css`:

```css
body {
  background-color: var(--color-surface-body);
  color: var(--color-ink-primary);
  font-family: var(--font-body);
}
```

- [ ] **Step 4: Prove the tokens generate real utilities**

Temporarily add to `app.ts`'s template:

```html
<div class="bg-brand-navy text-ink-on-dark rounded-md h-field">token-probe</div>
```

```bash
nvm use && pnpm web:build
grep -rE "background-color:\s*var\(--color-brand-navy\)|#2D3748" apps/web/dist/ | head -3
```

Expected: a match. **No match means the token name is wrong** — the most likely cause is a missing `--color-` prefix, which silently produces no utility rather than an error.

- [ ] **Step 5: Remove the probe and rebuild**

Delete the probe div. Run `pnpm web:build` to confirm still green.

- [ ] **Step 6: Commit**

```
feat(web): add the 26 design tokens to Tailwind's @theme

Read from web-app.pen via GetVariables(). Tailwind 4 is CSS-first, so
these are @theme custom properties, not tailwind.config.ts theme.extend
as the spec's D6 predates the v4 syntax.
```

---

### Task 4: Write `apps/web/DESIGN.md`

**Files:**
- Create: `apps/web/DESIGN.md`

**Interfaces:**
- Consumes: the token table and frame inventory above.
- Produces: the distilled design system read by humans and by `web-impl`; the **route map** consumed by Task 6. This is the second of D1's three artefacts.

- [ ] **Step 1: Write the document**

Model the structure on `assets/email/DESIGN.md`, which is proven at the right level of detail. Required sections, in order:

1. `# 3MRAI Web App — Design System` + `Design source: assets/web-app/web-app.pen`
2. `## Design Tokens` — the 26-row table above, in **three columns**: `.pen` name, value, **Tailwind utility** (`bg-brand-navy`). The third column is what makes the file usable while writing a component.
3. `## Shared with the email templates` — one paragraph stating `brand-navy`, `brand-orange`, `text-primary`/`ink-primary`, `success-green` and Inter are identical in `assets/email/DESIGN.md`, so a rebrand touches both surfaces.
4. `## Reusable components` — the 20 frames, each with its node id, its target path under `src/app/shared/ui/`, and its inputs where the design shows states.
5. `## Screens → routes` — the route map table from Task 6.
6. `## Overlays are not routes` — the verified child-structure evidence quoted above.
7. `## Assets` — the three reference kinds from spec D5b and how each resolves.
8. `## Related` — wikilinks to `[[email-templates]]` and the spec.

- [ ] **Step 2: Verify every token row matches `styles.css`**

A drifted table is worse than no table. Check mechanically:

```bash
grep -oE '^\s*--color-[a-z-]+' apps/web/src/styles.css | sed 's/.*--color-//' | sort > /tmp/css-tokens.txt
grep -oE '`(bg|text|border)-[a-z-]+`' apps/web/DESIGN.md | tr -d '`' | sed -E 's/^(bg|text|border)-//' | sort -u > /tmp/doc-tokens.txt
diff /tmp/css-tokens.txt /tmp/doc-tokens.txt
```

Expected: no lines unique to `css-tokens.txt`. (Extra doc lines are fine — `rounded-md` and `h-field` are not `--color-*`.)

- [ ] **Step 3: Commit**

```
docs(web): distil web-app.pen into apps/web/DESIGN.md

Tokens, the 20 reusable components, the screen->route map, and the
overlay-vs-route distinction read from the .pen via MCP.
```

---

### Task 4b: Typed fixtures from `openapi.yaml`

**Files:**
- Create: `apps/web/src/app/fixtures/api-types.ts`
- Create: `apps/web/src/app/fixtures/catalogue.fixture.ts`
- Create: `apps/web/src/app/fixtures/orders.fixture.ts`
- Create: `apps/web/src/app/fixtures/user.fixture.ts`
- Create: `apps/web/src/app/fixtures/notifications.fixture.ts`

**Interfaces:**
- Consumes: nothing in the app; derives from `services/*/openapi.yaml` (spec D7).
- Produces: `Product`, `ProductImage`, `Order`, `OrderLine`, `OrderWithTracking`, `Tracking`, `TrackingStatus`, `User`, `Address`, `AppNotification`, `IntLike`, `toInt()`, and the `PRODUCTS` / `ORDERS` / `CURRENT_USER` / `NOTIFICATIONS` constants that every screen renders.

- [ ] **Step 1: Write the types**

`apps/web/src/app/fixtures/api-types.ts`:

```ts
/**
 * Phase-1 fixture types, derived from the services' openapi.yaml.
 * Phase 2 swaps the DATA SOURCE, not these types or the templates.
 *
 * Field names mirror the wire EXACTLY, including the case inconsistency
 * between Orders (camelCase) and its embedded tracking (snake_case).
 * Normalising here would hide a real contract inconsistency from phase 2.
 */

/**
 * Orders is a .NET service whose int64/uint32 fields serialise as
 * `type: [integer, string]` — a value may arrive as 12345 OR "12345".
 * Every numeric field from Orders uses this type.
 */
export type IntLike = number | string;

/** Coerce an IntLike to a number. Throws rather than yielding NaN silently. */
export function toInt(value: IntLike): number {
  const n = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`toInt: not an integer: ${String(value)}`);
  return n;
}

/** Format integer cents as a display price. No currency in any contract. */
export function formatCents(value: IntLike): string {
  return (toInt(value) / 100).toFixed(2);
}

/** services/orders/openapi.yaml — ProductImageDto. Note: `uri`, not `url`. */
export interface ProductImage {
  uri: string;
  width: IntLike;
  height: IntLike;
  blurhash: string;
}

/** services/orders/openapi.yaml — ProductDto. */
export interface Product {
  id: string;
  name: string;
  description: string;
  unitPriceCents: IntLike;
  unitsInStock: IntLike;
  categories: string[];
  image: ProductImage | null;
}

/**
 * services/orders/openapi.yaml — OrderLineDto.
 * Carries ONLY productId: no name, image, or unit price. Rendering a line
 * requires joining against the product catalogue (see joinOrderLine).
 */
export interface OrderLine {
  productId: string;
  quantity: IntLike;
  subtotalCents: IntLike;
  taxCents: IntLike;
  totalCents: IntLike;
}

/** services/orders/openapi.yaml — OrderDto. No status field on the wire. */
export interface Order {
  id: string;
  userId: string;
  cognitoSub: string;
  subtotalCents: IntLike;
  taxCents: IntLike;
  shippingCents: IntLike;
  totalCents: IntLike;
  createdAt: string;
  lines: OrderLine[];
}

/**
 * The five delivery statuses.
 * NOT in any openapi.yaml — Tracking deliberately types `status` as a bare
 * string so an unknown value yields 400 from the handler rather than 422 from
 * Pydantic. Source of truth:
 *   services/tracking/src/features/tracking/domain/status.py
 * The design agrees: frame `Status Badge — States` (UOHCo) lists exactly these.
 */
export type TrackingStatus =
  | "PLACED"
  | "PROCESSING"
  | "SHIPPED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED";

export const TRACKING_STATUSES: readonly TrackingStatus[] = [
  "PLACED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
] as const;

/** snake_case: Tracking is FastAPI, and Orders copies its shape verbatim. */
export interface TrackingHistoryEntry {
  tracking_id: string;
  user_id: string;
  order_id: string;
  status: TrackingStatus;
  datetime: string;
}

/** Keys itself as `id` while history entries key it as `tracking_id`. */
export interface Tracking {
  id: string;
  user_id: string;
  order_id: string;
  status: TrackingStatus;
  datetime: string;
  history: TrackingHistoryEntry[];
}

/** GET /v1/orders/my-orders returns an array of THESE, not of bare orders. */
export interface OrderWithTracking {
  order: Order;
  tracking: Tracking | null;
}

/**
 * NOT from a contract. User.address is `anyOf: [{}, null]` in
 * services/users/openapi.yaml — completely untyped. These fields are read from
 * the DESIGN's profile and checkout frames. Phase 2 must reconcile them with
 * whatever the backend settles on.
 */
export interface Address {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/**
 * services/users/openapi.yaml — User.
 *
 * All 15 properties are `required` AND `additionalProperties: false`, so the
 * wire payload carries exactly these keys — the audit quartet included. They
 * are nullable, not optional: the service always sends the key, sometimes null.
 */
export interface User {
  id: string;
  email: string;
  fullName: string;
  address: Address | null;
  phoneNumber: string | null;
  tags: string[];
  authType: "PASSWORD" | "PASSWORDLESS";
  mustChangePassword: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  deletedBy: string | null;
  deletedAt: string | null;
  isDeleted: boolean;
}

/**
 * NOT from a contract — no service exposes a notifications endpoint today.
 * Read from the design's Notification Item (qwO6X) and Toast (jYz4h) frames.
 */
export interface AppNotification {
  id: string;
  title: string;
  body: string;
  status: TrackingStatus | null;
  createdAt: string;
  read: boolean;
}

/** An order line resolved against the catalogue, for rendering. */
export interface ResolvedOrderLine extends OrderLine {
  product: Product | null;
}

/** Join a line to its product. Returns product: null for a delisted product. */
export function joinOrderLine(line: OrderLine, catalogue: readonly Product[]): ResolvedOrderLine {
  return { ...line, product: catalogue.find((p) => p.id === line.productId) ?? null };
}
```

- [ ] **Step 2: Write the fixture data**

`apps/web/src/app/fixtures/catalogue.fixture.ts` — at least 6 products so the grid fills, at least one with `image: null` and one out of stock, so empty/edge states are visible during layout:

```ts
import type { Product } from "./api-types";

/** Product ids use the `prd_` nano-id prefix, as the service does. */
export const PRODUCTS: readonly Product[] = [
  {
    id: "prd_V1StGXR8Z5",
    name: "Aurora Desk Lamp",
    description: "Warm-dimming LED desk lamp with a matte aluminium arm.",
    unitPriceCents: 8900,
    unitsInStock: 42,
    categories: ["lighting", "office"],
    image: {
      uri: "http://localhost:4566/post-3mrai-local-post-assets/web-app/placeholder-product.png",
      width: 640,
      height: 640,
      blurhash: "LkQ0aQof00ofoffQayfQ00ayD%ay",
    },
  },
  // ...five more, following the same shape.
  // Deliberate coverage:
  //   - one with `image: null`            (the design's no-image card state)
  //   - one with `unitsInStock: 0`        (the out-of-stock state)
  //   - one with `unitPriceCents: "12900"` as a STRING, exercising IntLike
  //   - one with three categories         (chip overflow)
];
```

Write `orders.fixture.ts` (3 orders: one `PLACED`, one `SHIPPED`, one `DELIVERED` with full history, plus one with `tracking: null`), `user.fixture.ts` (one `CURRENT_USER` with a populated `Address`), and `notifications.fixture.ts` (4 notifications, 2 unread — the design has distinct Read and Unread frames).

- [ ] **Step 3: Verify the fixtures typecheck**

```bash
nvm use && pnpm web:typecheck
```

Expected: exit 0, no errors. A `Type 'string' is not assignable to type 'number'` here means `IntLike` was not used on an Orders numeric field.

- [ ] **Step 4: Commit**

```
feat(web): typed phase-1 fixtures derived from the service contracts

Types mirror the wire exactly, including Orders' [integer,string] unions
and the camelCase/snake_case split inside OrderWithTracking. TrackingStatus
is defined locally and cites its source: the contract has no enum.
```

---

### Task 5: Export the HTML snapshots

**Files:**
- Create: `apps/web/design/README.md`
- Create: `apps/web/design/exports/*.html` (36 screens + 20 components)

**Interfaces:**
- Consumes: the frame-id table above.
- Produces: the committed reference snapshots every later layout task reads — D1's third artefact, produced by D4b's `Export()`.

- [ ] **Step 1: Write the README first**

`apps/web/design/README.md` — written **before** the exports, so no snapshot ever sits here unexplained:

```markdown
# Design exports — reference only

HTML snapshots of the frames in `assets/web-app/web-app.pen`, produced by the
Pencil MCP `Export(..., "html-tailwind", ...)` call.

## Nothing in this folder is imported by the application

Not by a component, not by a build step, not at runtime. `apps/web/src/` reads
none of it. These files exist so that "what did this screen look like in the
design?" can be answered without opening Pencil, and so a design change shows up
as a reviewable diff in a pull request.

## Do not hand-edit these files

A hand-edited export is a third source of truth that lies. Re-export instead:
re-run the `pencil-design-extraction` skill.

## What is deliberately NOT reusable here

- Colours are arbitrary values (`bg-[#1F2733]`), not design tokens. The tokens
  live in `apps/web/src/styles.css`, read from the `.pen` via `GetVariables()`.
- Each file is one frame at one fixed width. Components are responsive across
  the 390/1440 pair.
- The files link `cdn.tailwindcss.com` and Google Fonts. The app self-hosts
  Inter and compiles Tailwind at build time.
- Some frames reference an `images.unsplash.com` placeholder. That is design-time
  stock art, not brand artwork, and must never ship.

Structure, spacing and layer names (`data-pencil-name`) ARE worth reading.
```

- [ ] **Step 2: Export every frame over MCP**

For each id in the frame-id table, call the Pencil MCP `execute` tool. Filenames are kebab-cased frame names:

```js
Export(["I4wRF"], "html-tailwind",
       "apps/web/design/exports/login-email-password.html",
       { includeLayerNames: true });
```

Batch them; do not do 56 separate round-trips. Skip `bi8Au` (the empty scratch frame).

- [ ] **Step 3: Verify the exports landed and are non-trivial**

```bash
ls apps/web/design/exports/*.html | wc -l          # expect 56
find apps/web/design/exports -name '*.html' -size -2k    # expect NO output
```

A file under 2 KB is an empty or failed export. Re-export any that appear.

- [ ] **Step 4: Confirm no export is referenced from src/**

```bash
grep -rn "design/exports" apps/web/src/ || echo "OK: no src reference"
```

Expected: `OK: no src reference`.

- [ ] **Step 5: Commit**

```
docs(web): commit HTML snapshots of all 56 design frames

Reference only — nothing here is imported (see design/README.md).
Produced by Export(..., "html-tailwind", { includeLayerNames: true }).
```

---

### Task 6: App shell and the route map

**Files:**
- Modify: `apps/web/src/app/app.routes.ts`
- Modify: `apps/web/src/app/app.ts`
- Modify: `apps/web/src/app/app.config.ts`
- Create: `apps/web/src/app/core/layout/shell.ts`

**Interfaces:**
- Consumes: Task 1's scaffold.
- Produces: `routes` (the full route table), `<router-outlet>` mounting, and the NgRx store provider that Task 8 registers into.

**The route map.** Derived from the frame inventory plus the verified overlay evidence. Overlay frames get **no route** — they are UI state over `/`.

| Route | Screen frames | Component |
| --- | --- | --- |
| `/login` | `I4wRF` / `MnqTi` | `features/auth/login-password` |
| `/login/passwordless` | `j0sCI` / `drEOJ` | `features/auth/login-passwordless` |
| `/verify` | `V16TI` / `zouHC` | `features/auth/verify-code` |
| `/register` | `q52fsc` / `L4qQLy` | `features/auth/register-password` |
| `/register/passwordless` | `UK1Bu` / `t2OrS` | `features/auth/register-passwordless` |
| `/password/new` | `atwtV` / `G6lEnQ` | `features/auth/set-new-password` |
| `/` | `eK0x6` / `ffO4d` | `features/catalogue/home` |
| `/checkout` | `DOtD2` / `P0lhqj` | `features/checkout/checkout-payment` |
| `/orders` | `rGwBO` / `OoNex` | `features/orders/orders-list` |
| `/orders/:orderId` | `x7ABM` / `eq3Tk` | `features/orders/order-detail` |
| `/profile` | `hZ87b` / `nyVEI` | `features/account/profile` |
| `**` | — | redirect to `/` |

**No route** (overlay state on `/`): Cart Drawer (`wevx6`/`eig49`/`hed4V`), Account Menu (`H2A9g`), Notifications (`mSssa`/`YZIGp`), Toast (`IQCEF`).

- [ ] **Step 1: Write the route table**

`apps/web/src/app/app.routes.ts` — lazy `loadComponent` throughout, so one broken screen cannot break the whole bundle:

```ts
import type { Routes } from "@angular/router";

export const routes: Routes = [
  {
    path: "login",
    loadComponent: () => import("./features/auth/login-password").then((m) => m.LoginPasswordPage),
    title: "Sign in — 3MRAI",
  },
  // ...one entry per row of the route table above.
  { path: "**", redirectTo: "" },
];
```

- [ ] **Step 2: Register the store**

`apps/web/src/app/app.config.ts` — mount NgRx now so phase 2 does not restructure the app to introduce it:

```ts
import { provideStore } from "@ngrx/store";

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    // Phase 1 exercises almost none of this. It is registered up front so
    // phase 2 adds reducers rather than rewiring bootstrap.
    provideStore({}),
  ],
};
```

- [ ] **Step 3: Placeholder every route so navigation works before layout exists**

Each `features/**` component referenced above must exist now, even if its body is one line. A route pointing at a missing file is a build error, and Tasks 9–11 replace these bodies one at a time.

```ts
import { Component } from "@angular/core";

@Component({
  selector: "app-login-password",
  template: `<h1 class="text-ink-primary">Login — Email & Password</h1>`,
})
export class LoginPasswordPage {}
```

- [ ] **Step 4: Verify every route resolves**

```bash
nvm use && pnpm web:build
```

Expected: exit 0. A `Could not resolve "./features/..."` means a placeholder from step 3 is missing.

- [ ] **Step 5: Commit**

```
feat(web): app shell, route map and NgRx store registration

Overlay frames (cart, account menu, notifications, toast) get NO route —
their .pen frames wrap a Page plus a Scrim, so they are UI state over the
catalogue route rather than destinations.
```

---

### Task 7: Layout primitives — the shared components

**Files:**
- Create: `apps/web/src/app/shared/ui/logo-lockup.ts` (`M8f7U`)
- Create: `apps/web/src/app/shared/ui/field.ts` (`TLRTA`)
- Create: `apps/web/src/app/shared/ui/button-primary.ts` (`sHl96`)
- Create: `apps/web/src/app/shared/ui/button-ghost.ts` (`aUEDx`)
- Create: `apps/web/src/app/shared/ui/otp-digit.ts` (`NZ7jF`)
- Create: `apps/web/src/app/shared/ui/status-badge.ts` (`l7LGs`, states from `UOHCo`)
- Create: `apps/web/src/app/shared/ui/tracking-status-icon.ts` (`S59Ud1`, states from `hImQh`)
- Create: `apps/web/src/app/shared/ui/brand-panel.ts` (`WXmng`)
- Create: `apps/web/src/app/shared/ui/mobile-brand-header.ts` (`u2nnov`)
- Create: `apps/web/src/app/core/layout/app-header.ts` (`EMNqu` + `fguH5`)

**Interfaces:**
- Consumes: tokens (Task 3), `TrackingStatus` (Task 4b).
- Produces: `LogoLockup`, `Field`, `ButtonPrimary`, `ButtonGhost`, `OtpDigit`, `StatusBadge`, `TrackingStatusIcon`, `BrandPanel`, `MobileBrandHeader`, `AppHeader` — the vocabulary Tasks 9–11 compose. Every one is standalone (the Angular 19+ default — the flag is omitted) and uses `input()` signals.

- [ ] **Step 1: Read each component's export before writing it**

For each frame id, open `apps/web/design/exports/<name>.html` and read the flex structure, gaps and paddings. Per spec D2 the **structure** is legitimate to follow; the arbitrary colour classes are not — replace `bg-[#2D3748]` with `bg-brand-navy`.

- [ ] **Step 2: Write `status-badge.ts` first — it has the most explicit spec**

The `Status Badge — States` frame (`UOHCo`) enumerates exactly the five backend statuses, so its inputs are fully determined:

```ts
import { Component, computed, input } from "@angular/core";
import type { TrackingStatus } from "../../fixtures/api-types";

/**
 * Design: frame `Status Badge` (l7LGs); states from `Status Badge — States` (UOHCo),
 * whose label reads:
 *   ORDER STATUS — PLACED -> PROCESSING -> SHIPPED -> OUT_FOR_DELIVERY -> DELIVERED
 * Identical to the backend enum in tracking's domain/status.py.
 */
@Component({
  selector: "app-status-badge",
  template: `
    <span
      class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold"
      [class]="palette()"
    >
      {{ label() }}
    </span>
  `,
})
export class StatusBadge {
  readonly status = input.required<TrackingStatus>();

  /** Token utilities only — never an arbitrary hex (spec D6). */
  protected readonly palette = computed(() => {
    switch (this.status()) {
      case "PLACED":
        return "bg-surface-subtle text-ink-secondary";
      case "PROCESSING":
        return "bg-warn-bg text-warn-ink";
      case "SHIPPED":
      case "OUT_FOR_DELIVERY":
        return "bg-info-bg text-info-blue";
      case "DELIVERED":
        return "bg-success-bg text-success-ink";
    }
  });

  protected readonly label = computed(() => this.status().replaceAll("_", " "));
}
```

Confirm the five colour choices against the `UOHCo` export before finalising; the switch above must match the design, not merely be plausible.

- [ ] **Step 3: Write the remaining nine components**

Same pattern: `input()` signals for every variable the design shows, `computed()` for derived classes, token utilities only. `AppHeader` merges `EMNqu` (1440) and `fguH5` (390) into one responsive component per spec D8 — the mobile header's `Menu Sheet` trigger is an `@Output`/`output()` the shell binds in Task 8.

- [ ] **Step 4: Verify no arbitrary colour values slipped in**

This is the reviewable symptom D6 exists to catch:

```bash
grep -rnE '(bg|text|border)-\[#' apps/web/src/ && echo "FAIL: arbitrary colour" || echo "OK: tokens only"
```

Expected: `OK: tokens only`.

- [ ] **Step 5: Typecheck and build**

```bash
nvm use && pnpm web:typecheck && pnpm web:build
```

- [ ] **Step 6: Commit**

```
feat(web): shared UI primitives translated from the design components

Nine components from their .pen frames: structure follows each frame's
flex layout, styling uses design tokens only. StatusBadge's five states
match both the design's variant sheet and tracking's backend enum.
```

---

### Task 8: Overlay state

**Files:**
- Create: `apps/web/src/app/core/overlay/overlay-store.ts`
- Create: `apps/web/src/app/core/overlay/scrim.ts`
- Modify: `apps/web/src/app/core/layout/shell.ts`

**Interfaces:**
- Consumes: `@ngrx/signals`.
- Produces: `OverlayStore` with `openCart()`, `openCartPayment()`, `openAccountMenu()`, `openNotifications()`, `close()`, the `active` state signal (type `OverlayKind`), and the `isOpen` / `hasScrim` computed signals; `Scrim`. Tasks 10 and 11 render into this. **The signal is `active`, not `activeOverlay`.**

- [ ] **Step 1: Write the store**

The design's four overlay frames are mutually exclusive — each shows exactly one panel over a `Page`. That makes one discriminated signal correct, not four booleans:

```ts
import { computed } from "@angular/core";
import { patchState, signalStore, withComputed, withMethods, withState } from "@ngrx/signals";

/**
 * Which overlay covers the current route, if any.
 *
 * The design's frames — Home — Cart Open (wevx6), Home — Account Menu (H2A9g),
 * Home — Notifications (mSssa) — each wrap a `Page` plus ONE overlay, never two.
 * A single discriminated value makes that exclusivity unrepresentable-otherwise;
 * four independent booleans would allow states the design does not define.
 */
export type OverlayKind = "cart" | "cart-payment" | "account-menu" | "notifications" | null;

/**
 * The toast is deliberately NOT an OverlayKind.
 *
 * The other four are mutually exclusive panels: the design never shows two at
 * once, which is what the single `active` signal encodes. A toast is different
 * in kind — it is transient, carries no Scrim (verified: only the three cart
 * frames have one), and can legitimately appear WHILE the cart is open. Folding
 * it into `active` would make "toast" close the cart, which no frame implies.
 * Task 11 models it as its own independent signal.
 */

export const OverlayStore = signalStore(
  { providedIn: "root" },
  withState<{ active: OverlayKind }>({ active: null }),
  withComputed(({ active }) => ({
    isOpen: computed(() => active() !== null),
    /** The Scrim is present for the cart frames; the menu/panel frames have none. */
    hasScrim: computed(() => active() === "cart" || active() === "cart-payment"),
  })),
  withMethods((store) => ({
    openCart: () => patchState(store, { active: "cart" }),
    openCartPayment: () => patchState(store, { active: "cart-payment" }),
    openAccountMenu: () => patchState(store, { active: "account-menu" }),
    openNotifications: () => patchState(store, { active: "notifications" }),
    close: () => patchState(store, { active: null }),
  })),
);
```

- [ ] **Step 2: Write the Scrim**

```ts
import { Component, output } from "@angular/core";

/** The `Scrim` rectangle in the cart frames. Dismisses the overlay on click. */
@Component({
  selector: "app-scrim",
  template: `
    <div
      class="fixed inset-0 z-40 bg-black/40"
      role="presentation"
      (click)="dismiss.emit()"
    ></div>
  `,
})
export class Scrim {
  readonly dismiss = output<void>();
}
```

- [ ] **Step 3: Verify the exclusivity holds**

Since phase 1 ships no component unit tests (spec D9), verify by reasoning + build: `active` is a single field, so two overlays cannot be open. Confirm no component calls two `open*` methods in sequence:

```bash
nvm use && pnpm web:build
```

- [ ] **Step 4: Commit**

```
feat(web): overlay state store for cart, account menu and notifications

One discriminated signal rather than four booleans: every overlay frame in
the design wraps a Page plus exactly one panel.
```

---

### Task 9: Auth screens (6 screens, 12 frames)

**Files:**
- Create: `apps/web/src/app/features/auth/login-password.ts` (`I4wRF`/`MnqTi`)
- Create: `apps/web/src/app/features/auth/login-passwordless.ts` (`j0sCI`/`drEOJ`)
- Create: `apps/web/src/app/features/auth/verify-code.ts` (`V16TI`/`zouHC`)
- Create: `apps/web/src/app/features/auth/register-password.ts` (`q52fsc`/`L4qQLy`)
- Create: `apps/web/src/app/features/auth/register-passwordless.ts` (`UK1Bu`/`t2OrS`)
- Create: `apps/web/src/app/features/auth/set-new-password.ts` (`atwtV`/`G6lEnQ`)

**Interfaces:**
- Consumes: `BrandPanel`, `MobileBrandHeader`, `Field`, `ButtonPrimary`, `ButtonGhost`, `OtpDigit`, `LogoLockup` (Task 7); `routes` (Task 6).
- Produces: six routed page components, replacing Task 6's placeholders.

**Responsive rule (spec D8).** One component per screen. The 1440 frame pairs a `Brand Panel` beside the form; the 390 frame stacks a `Mobile Brand Header` above it. That is the same component with `hidden lg:flex` / `lg:hidden`, not two components.

- [ ] **Step 1: Replace the `login-password` placeholder**

Read `apps/web/design/exports/login-email-password.html` and `mobile-login-email-password.html` side by side first.

```ts
import { Component } from "@angular/core";
import { RouterLink } from "@angular/router";
import { BrandPanel } from "../../shared/ui/brand-panel";
import { MobileBrandHeader } from "../../shared/ui/mobile-brand-header";
import { Field } from "../../shared/ui/field";
import { ButtonPrimary } from "../../shared/ui/button-primary";

/**
 * Design: `Login — Email & Password` (I4wRF, 1440) and
 *         `Mobile — Login Email & Password` (MnqTi, 390).
 * One component, two breakpoints (spec D8).
 * Phase 1: layout and navigation only — the form does not submit anywhere.
 */
@Component({
  selector: "app-login-password",
  imports: [RouterLink, BrandPanel, MobileBrandHeader, Field, ButtonPrimary],
  template: `
    <main class="flex min-h-screen bg-surface-body">
      <!-- 1440 only: the Brand Panel sits beside the form -->
      <app-brand-panel class="hidden lg:flex lg:w-[560px]" />

      <section class="flex flex-1 flex-col items-center justify-center px-6">
        <!-- 390 only: the brand becomes a header above the form -->
        <app-mobile-brand-header class="lg:hidden" />
        <form class="w-full max-w-[380px] flex flex-col gap-4" (submit)="$event.preventDefault()">
          <h1 class="font-heading text-2xl font-bold text-ink-primary">Sign in</h1>
          <app-field label="Email" type="email" />
          <app-field label="Password" type="password" />
          <app-button-primary label="Sign in" />
          <a routerLink="/login/passwordless" class="text-sm text-brand-orange-text">
            Sign in without a password
          </a>
        </form>
      </section>
    </main>
  `,
})
export class LoginPasswordPage {}
```

`(submit)="$event.preventDefault()"` is deliberate: phase 1 must not navigate away or POST anywhere.

- [ ] **Step 2: Write the remaining five auth screens**

Same pattern. `verify-code` composes six `OtpDigit`s (the OTP is 6 digits — `^\d{6}$` in `OtpVerifyInput`). `set-new-password` renders the password checklist from `atwtV`.

- [ ] **Step 3: Verify navigation between auth screens**

```bash
nvm use && pnpm web:build
```

Then check every `routerLink` points at a declared route:

```bash
grep -rhoE 'routerLink="[^"]+"' apps/web/src/app/features/auth/ | sort -u
```

Cross-check each against the route table in Task 6.

- [ ] **Step 4: Verify no arbitrary colours**

```bash
grep -rnE '(bg|text|border)-\[#' apps/web/src/app/features/auth/ && echo "FAIL" || echo "OK"
```

- [ ] **Step 5: Commit**

```
feat(web): lay out the six auth screens

Each screen is one responsive component spanning its 1440/390 frame pair.
Forms render but do not submit — phase 1 is layout and navigation only.
```

---

### Task 10: Catalogue, cart and checkout (4 screens + 3 overlay states)

**Files:**
- Create: `apps/web/src/app/features/catalogue/home.ts` (`eK0x6`/`ffO4d`)
- Create: `apps/web/src/app/shared/ui/product-card.ts` (`QmNIg`)
- Create: `apps/web/src/app/shared/ui/cart-line.ts` (`L5XVFs`)
- Create: `apps/web/src/app/features/cart/cart-drawer.ts` (`ET6dr`; states `wevx6`/`eig49`/`hed4V`)
- Create: `apps/web/src/app/features/checkout/checkout-payment.ts` (`DOtD2`/`P0lhqj`)

**Interfaces:**
- Consumes: `PRODUCTS` (Task 4b), `OverlayStore` (Task 8), `AppHeader` (Task 7), `APP_CONFIG` (Task 2b).
- Produces: `Home`, `ProductCard`, `CartLine`, `CartDrawer`, `CheckoutPayment`.

**Paired frames are one component in two states (spec D8).** `Cart Open (saved address)` and `(no address)` differ only by whether an address block renders — one `CartDrawer` with an `address` input, not two components.

- [ ] **Step 1: Write `ProductCard`**

`image` is nullable and `unitPriceCents` is `IntLike` — both must be handled or the grid breaks on the fixture rows that exercise them:

```ts
import { Component, computed, input } from "@angular/core";
import { formatCents, type Product, toInt } from "../../fixtures/api-types";

/** Design: `Product Card` (QmNIg, 318px wide). */
@Component({
  selector: "app-product-card",
  template: `
    <article class="flex flex-col gap-3 rounded-md bg-surface-white p-4 border border-line">
      @if (product().image; as image) {
        <img
          [src]="image.uri"
          [width]="image.width"
          [height]="image.height"
          [alt]="product().name"
          class="w-full rounded-md object-cover"
        />
      } @else {
        <!-- The design has no artwork for this state; a token surface stands in. -->
        <div class="aspect-square w-full rounded-md bg-surface-subtle"></div>
      }
      <h3 class="font-heading text-base font-semibold text-ink-primary">{{ product().name }}</h3>
      <p class="text-sm text-ink-secondary line-clamp-2">{{ product().description }}</p>
      <div class="flex items-center justify-between">
        <span class="font-semibold text-ink-primary">{{ price() }}</span>
        @if (outOfStock()) {
          <span class="text-xs font-semibold text-danger-red">Out of stock</span>
        }
      </div>
    </article>
  `,
})
export class ProductCard {
  readonly product = input.required<Product>();
  protected readonly price = computed(() => formatCents(this.product().unitPriceCents));
  protected readonly outOfStock = computed(() => toInt(this.product().unitsInStock) === 0);
}
```

- [ ] **Step 2: Write `Home` rendering the fixture catalogue**

```ts
protected readonly products = PRODUCTS;
```

with `@for (product of products; track product.id)`. Mount `CartDrawer`, `AccountMenu` and `NotificationsPanel` conditionally off `OverlayStore.active()` — this route is where all four overlay frames live.

> [!warning] The panel must sit ABOVE its own scrim
> Task 8's `Scrim` is `fixed inset-0 z-40`. Every overlay panel — `CartDrawer`,
> `AccountMenu`, `NotificationsPanel` — needs a z-index **above 40** (`z-50`), or it
> renders *underneath* the scrim that is supposed to sit behind it. The design's
> frame order says the same thing: `Page | Scrim | Cart Drawer`. Nothing enforces
> this automatically, and the failure is silent at build time — it only shows up
> as a dimmed, unclickable panel on screen.

- [ ] **Step 3: Write `CartDrawer` with both address states**

```ts
/**
 * Design: `Cart Drawer` (ET6dr), shown in `Home — Cart Open (saved address)`
 * (wevx6) and `(no address)` (eig49). ONE component: the frames differ only by
 * whether a saved address renders (spec D8).
 * `Home — Cart Payment (Stripe)` (hed4V) is this drawer in its payment step.
 */
readonly address = input<Address | null>(null);
readonly step = input<"cart" | "payment">("cart");
```

- [ ] **Step 4: Write `CheckoutPayment` — both paths, selected by the flag**

`Checkout — Payment` (`DOtD2`) is a real page (`App Header` + `Body`), unlike the
cart overlays. `Home — Cart Payment (Stripe)` (`hed4V`) is the *other* path.
**`NG_APP_STRIPE_ENABLED` (Task 2b) decides which one the user gets** — both are
built, neither is dead code.

Neither path submits anywhere: no payment backend exists yet (there is no Stripe
reference anywhere in the repo — not in a service, not in Terraform, not in an
`.env`). Phase 1 lays out both and wires neither.

```ts
import { Component, computed } from "@angular/core";
import { APP_CONFIG } from "../../core/config/app-config";

/**
 * Design: `Checkout — Payment` (DOtD2, 1440) / `Mobile — Checkout Payment` (P0lhqj).
 *
 * Two payment paths exist in the design and NG_APP_STRIPE_ENABLED picks one:
 *   false -> this page's own card fields (DOtD2)
 *   true  -> the Stripe step, laid out in the cart drawer (hed4V)
 *
 * Phase 1 renders both and submits neither — no payment backend exists.
 */
@Component({ selector: "app-checkout-payment", /* ... */ })
export class CheckoutPayment {
  /** Read from APP_CONFIG, never from import.meta.env — see app-config.ts. */
  protected readonly stripeEnabled = computed(() => APP_CONFIG.stripeEnabled);
}
```

Bind it in the template with `@if (stripeEnabled()) { … } @else { … }`.

- [ ] **Step 4b: Build the Stripe step in the cart drawer**

`hed4V` / `NfXeq` is `CartDrawer` in its `step: "payment"` state — the input
already declared in step 3, not a new component. Gate the transition into that
step on `APP_CONFIG.stripeEnabled` so the drawer cannot reach a step the build
has disabled.

- [ ] **Step 5: Build and check both cart states render**

```bash
nvm use && pnpm web:build && pnpm web:typecheck
grep -rnE '(bg|text|border)-\[#' apps/web/src/app/features/ && echo "FAIL" || echo "OK"
```

- [ ] **Step 6: Commit**

```
feat(web): catalogue, cart drawer and checkout layout

Cart's saved-address and no-address frames are one component with an
`address` input. Both checkout paths are built and NG_APP_STRIPE_ENABLED
selects between them; neither submits, as no payment backend exists.
```

---

### Task 11: Orders, account and notifications (7 screens)

**Files:**
- Create: `apps/web/src/app/features/orders/orders-list.ts` (`rGwBO`/`OoNex`)
- Create: `apps/web/src/app/features/orders/order-detail.ts` (`x7ABM`/`eq3Tk`)
- Create: `apps/web/src/app/shared/ui/order-card.ts` (`l6TyrG` + `tWTSZ`)
- Create: `apps/web/src/app/features/account/profile.ts` (`hZ87b`/`nyVEI`)
- Create: `apps/web/src/app/features/account/account-menu.ts` (`B6fdc`; `H2A9g`/`pD15E`)
- Create: `apps/web/src/app/features/notifications/notifications-panel.ts` (`LWQ8g`; `mSssa`/`YZIGp`)
- Create: `apps/web/src/app/shared/ui/notification-item.ts` (`qwO6X`)
- Create: `apps/web/src/app/shared/ui/toast-notification.ts` (`jYz4h`; `IQCEF`/`UpmOQ`)

**Interfaces:**
- Consumes: `ORDERS`, `CURRENT_USER`, `NOTIFICATIONS`, `joinOrderLine`, `PRODUCTS` (Task 4b); `StatusBadge`, `TrackingStatusIcon` (Task 7); `OverlayStore` (Task 8).
- Produces: the last seven screens; every route in Task 6's table now renders real layout.

- [ ] **Step 1: Write `OrderCard`, joining lines to products**

This is where the `OrderLineDto`-carries-only-`productId` trap bites. Without the join there is no name to render:

```ts
import { Component, computed, input } from "@angular/core";
import { joinOrderLine, type OrderWithTracking } from "../../fixtures/api-types";
import { PRODUCTS } from "../../fixtures/catalogue.fixture";

/**
 * Design: `Order Card` (l6TyrG, 1040) and `Mobile Order Card` (tWTSZ, 342).
 *
 * OrderLineDto carries ONLY productId — no name, image or unit price — so a
 * line is joined against the catalogue to render. In phase 2 this join moves to
 * a selector over real catalogue data; the template does not change.
 */
@Component({ selector: "app-order-card", /* ... */ })
export class OrderCard {
  readonly entry = input.required<OrderWithTracking>();
  protected readonly lines = computed(() =>
    this.entry().order.lines.map((line) => joinOrderLine(line, PRODUCTS)),
  );
}
```

Render `tracking` via `StatusBadge` when non-null; the fixture includes an order with `tracking: null` precisely so that branch is exercised.

- [ ] **Step 2: Write `OrderDetail` with the tracking timeline**

`Orders — Detail` (`x7ABM`) shows the status history. Render `tracking.history` with `TrackingStatusIcon` per entry.

- [ ] **Step 3: Write `Profile`**

Renders `CURRENT_USER`. The address fields come from the design, not from a contract (`User.address` is untyped) — note that in a comment.

- [ ] **Step 4: Write the three overlay components**

`AccountMenu`, `NotificationsPanel` and `ToastNotification` mount off `OverlayStore`. The Read/Unread frame pair is one `NotificationsPanel` reading each item's `read` flag.

- [ ] **Step 5: Full verification**

```bash
nvm use && pnpm web:typecheck && pnpm web:build && pnpm web:lint
grep -rnE '(bg|text|border)-\[#' apps/web/src/ && echo "FAIL: arbitrary colour" || echo "OK: tokens only"
```

- [ ] **Step 6: Commit**

```
feat(web): orders, profile and notification screens

Order lines join against the catalogue fixture — OrderLineDto carries only
productId, so rendering a line name requires the join both here and in
phase 2.
```

---

### Task 12: `apps/web/CLAUDE.md`

**Files:**
- Create: `apps/web/CLAUDE.md`

**Interfaces:**
- Consumes: everything built so far.
- Produces: the nested project memory `web-impl` reads first, every time.

- [ ] **Step 1: Write it, following `services/users/CLAUDE.md`'s structure**

Required sections: `## 1. Stack & versions` (with the Angular-21-not-22 reason stated, so nobody "upgrades" it back into an NgRx conflict — and the same note for `@ngx-env/builder` 21.0.1), `## 2. Commands`, `## 2a. GOLDEN RULE — tokens, never arbitrary values` (with the `grep` check from Task 7 step 4), `## 2b. GOLDEN RULE — NG_APP_* is public` (everything the builder inlines ships in the bundle; flags and publishable keys only, never a secret; read `APP_CONFIG`, never `import.meta.env` directly), `## 3. Folder structure`, `## 4. Conventions (referenced, never duplicated)` using `../../docs/...` relative links paired with `[[wikilinks]]`, `## 5. Agent rules`, `## 6. Design reference` (pointing at `DESIGN.md`, `design/exports/`, and the spec).

- [ ] **Step 2: Verify the relative links resolve**

From `apps/web/`, `../../docs/...` is the correct depth — same as `services/users/`.

```bash
grep -oE '\]\(\.\./\.\./[^)]+\)' apps/web/CLAUDE.md | tr -d '](' | sed 's/)$//' | while read -r p; do
  [ -e "apps/web/$p" ] && echo "OK   $p" || echo "DEAD $p"
done
```

Expected: every line `OK`.

- [ ] **Step 3: Commit**

```
docs(web): add apps/web/CLAUDE.md nested project memory
```

---

### Task 13: The `pencil-design-extraction` skill

**Files:**
- Create: `.claude/skills/pencil-design-extraction/SKILL.md`

**Interfaces:**
- Consumes: everything learned in Tasks 3–5 — this skill is how that becomes repeatable.
- Produces: the skill `web-impl` preloads.

**House style** (from `floci` and `gatling-js`, the two repo-authored skills — every other skill under `.claude/skills/` is vendored and its frontmatter is *not* the pattern):

```yaml
---
name: pencil-design-extraction
description: Use when translating a Pencil .pen design into code — reading frames, extracting design tokens, exporting HTML snapshots, resolving referenced images, or writing an Angular component from a design frame. Use it before touching apps/web/src or assets/web-app/web-app.pen, because .pen files are encrypted and only reachable over the Pencil MCP server, and the bridge that looks correct is the one that silently fails every call.
metadata:
  area: shared
  source: docs/superpowers/specs/2026-08-17-web-app-foundation-design.md
  verified: 2026-08-18
---
```

- [ ] **Step 1: Write the six-step procedure**

Sections, in order, following the spec's skill definition:

1. `## When to use`
2. `## Step 1 — Locate the source, and say which one you used.` (spec D4) MCP first (`get_app_state`, `GetVariables()`, `Get()`); `apps/web/design/exports/*.html` only as fallback. **Announcing the reader is mandatory** — a silent fallback yields tokens inferred from flattened CSS while the reader believes they came from design variables.
3. `## Step 2 — Distil to DESIGN.md.`
4. `## Step 3 — Export the snapshot.` `Export([id], "html-tailwind", "apps/web/design/exports/<screen>.html", {includeLayerNames: true})`.
5. `## Step 4 — Resolve assets` — the three kinds of spec D5b, below.
6. `## Step 5 — Emit tokens` — with the v4 `@theme` namespace mapping table from Task 3, since that is exactly the step easiest to get silently wrong.
7. `## Step 6 — Write the component.`
8. `## Verified quirks (read before debugging)` — the MCP bridge trap, below.
9. `## Related`

- [ ] **Step 2: Write the asset-classification section**

```markdown
## Step 4 — Resolve assets: three kinds, three resolutions (spec D5, D5b)

An export references images in three distinct ways. Scanning only `<img>` tags
misses the first, which is a CSS background.

1. **Local repo asset** — `bg-[url('../img/standalone-logo.png')]`, relative to
   the `.pen`. Resolve against `assets/`, look the path up in
   `assets/assets.manifest.json` (keys are repo-relative, e.g.
   `email/blank-dot.png`), and use the manifest's `url`. If it is missing: copy
   the file into `assets/web-app/` and run `make assets-sync` — no need to ask.

   `make assets-sync` requires `make post-infra` to have run (it reads the bucket
   name and base URL from Terraform outputs). If the stack is down the sync
   fails: **still copy the files**, and report the pending command. Copying is
   safe and idempotent; blocking layout work on infrastructure it does not need
   is not.

2. **Inline Lucide icon** — `data-icon-set="lucide"`, `data-icon-name="mail"`.
   **Not an asset.** Nothing to sync; render the named icon in the component.
   This is the web's advantage over email, where inline SVG is unusable and the
   same icons had to become PNGs in the bucket ([[email-templates]]).

3. **Remote stock placeholder** — an `images.unsplash.com` URL.
   **Neither a repo asset nor final artwork.** Do NOT copy it into `assets/`,
   and do NOT ship a template pointing at Unsplash — that hotlinks a third party
   from production. Render a token-coloured placeholder and flag the frame as
   needing real artwork. Brand photography is a content decision with no owner
   yet; flagging keeps it visible instead of silently shipping.
```

- [ ] **Step 3: Write the quirks section**

```markdown
## Verified quirks (read before debugging)

1. **The Cursor bridge starts cleanly and fails every call.**
   `~/.pencil/mcp/cursor/… --app cursor --agent claudeCodeCLI` answers every
   request with `Failed to access file. A file needs to be open in the editor`
   even with the file demonstrably open — the Pen renderer reports
   `connectedAgents: []`, so the app never registers the agent. Reconnecting does
   not help; it leaks orphaned server processes. This cost six failed attempts to
   diagnose. Only the binary bundled in the app, run with `--app desktop`, works.
   `.mcp.json` resolves it via `scripts/pencil_mcp.py`; `PENCIL_MCP_BIN` in `.env`
   overrides the search.

2. **`Export("html-tailwind")` emits flexbox, not absolute positioning.**
   Verified on `Login — Email & Password`: zero `position:absolute`. The
   export's STRUCTURE is directly readable as the target layout.

3. **The export does not know the design variables.** Colours come out as
   arbitrary values (`bg-[#1F2733]`), never `bg-brand-navy`. Tokens must come
   from `GetVariables()`. Copying the export's classes hard-codes every hex and
   is the one failure this convention exists to prevent.

4. **`execute` runs a script body, not a function body.** A top-level `return`
   is a SyntaxError; use `Print()`.

5. **`Get(node, visitor, {depth: 1})` does not limit the visitor** — it still
   descends. To keep only root frames, test `if (!ctx.parentCtx)`.

6. **Exports carry scaffolding that must never ship:** a
   `cdn.tailwindcss.com` script tag and Google Fonts links. The app compiles
   Tailwind at build time and self-hosts Inter.
```

- [ ] **Step 4: Verify the skill loads**

```bash
ls -la .claude/skills/pencil-design-extraction/SKILL.md
head -6 .claude/skills/pencil-design-extraction/SKILL.md
```

`name:` must equal the directory name exactly, or the skill will not resolve.

- [ ] **Step 5: Commit**

```
feat(agents): add the pencil-design-extraction skill

Six steps from .pen to Angular component, plus the verified quirks —
including the Cursor bridge that starts cleanly and fails every call.
```

---

### Task 14: The `web-impl` agent

**Files:**
- Create: `.claude/agents/web-impl.md`
- Modify: `CLAUDE.md` (root, two registration points + one enumeration)

**Interfaces:**
- Consumes: Task 13's skill (an agent's `skills:` list must name a skill that exists), `apps/web/CLAUDE.md` (Task 12).
- Produces: the seventh domain-layer implementer.

**Frontmatter shape is enforced by `scripts/normalize_agent_frontmatter.py`.** It folds `description: >-` into one line for providers with weak YAML parsers. Constraints: the file must start with exactly `---` on line 1; the closing `---` must be a bare line with no trailing spaces; `description: >-` must have nothing after the indicator; continuation lines must be indented exactly two spaces. A non-indented continuation silently truncates the description.

- [ ] **Step 1: Write the agent**

```markdown
---
name: web-impl
model: opus
skills:
  - pencil-design-extraction
  - typescript-pro
  - typescript-advanced-types
description: >-
  Code implementer for the 3MRAI web app (Angular, NgRx, Tailwind) in apps/web.
  Use to implement a single web task from the plan — a screen, a shared
  component, design tokens, or routing. Writes ONLY source code — never touches
  git or Linear. Reads apps/web/CLAUDE.md for its stack/conventions and
  apps/web/DESIGN.md for the design system, translates Pencil frames via the
  pencil-design-extraction skill, and leaves the work in the working tree for
  the main session to commit.
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Skill
---

# Web App Implementer

You implement the **web app** in `apps/web/` and nothing else. You are a thin
specialist: your stack and conventions are **not** in this file — they live in
`apps/web/CLAUDE.md`. Read that first, every time.

## Hard rules

- **Write only source code.** You do **not** run `git commit`, `git push`,
  `git branch`, `gh`, or any git/GitHub write — even though you have Bash.
  Leave your work in the working tree; the main session commits it.
- **Never touch Linear.** Issue status is moved by `linear-pm` via the parent.
- **Never use a Tailwind arbitrary value for a design colour.** `bg-brand-navy`,
  never `bg-[#2D3748]`. The tokens are in `apps/web/src/styles.css`, read from
  the `.pen`; an arbitrary hex is the detectable symptom of a skipped step.
- **Never import from `apps/web/design/exports/`.** Those snapshots are visual
  reference. Read them for structure and spacing; copy no styling from them.
- Stay within the single task you were handed (YAGNI).

## How to operate

0. **Load `pencil-design-extraction` before reading any design.** `.pen` files
   are encrypted and reachable only over the Pencil MCP server — never with Read
   or Grep — and the bridge that looks correct is the one that fails every call.

1. **Read your context.** `apps/web/CLAUDE.md` (stack, commands, conventions),
   `apps/web/DESIGN.md` (tokens, components, the screen→route map), and the
   spec at `docs/superpowers/specs/2026-08-17-web-app-foundation-design.md`.

2. **Read the frame before writing the component.** Both frames of the pair —
   1440 and 390 — because one responsive component spans them. Building from
   the desktop frame alone produces a component that has to be rewritten.

3. **Implement**, following the patterns already in `apps/web/src/app/shared/ui/`.

4. **Run the checks and read the output, not just the exit code.**
   `nvm use && pnpm web:typecheck && pnpm web:build && pnpm web:lint`, then the
   token check: `grep -rnE '(bg|text|border)-\[#' apps/web/src/` must find
   nothing. A green build with hard-coded hex values is a failed task.

5. **Leave the work in the working tree** and report: paths changed, real
   command output, anything you could not verify, and a proposed
   Conventional-Commits message. Do not commit.

## Conventions

- Converse with the user in Spanish (repo convention); code/comments in English.
- Your final message is consumed by the parent: summarize files changed, real
  command output, and the proposed commit message.
```

- [ ] **Step 2: Register in the root `CLAUDE.md` — point A (`### Subagents`)**

Insert after the `e2e-impl` bullet, before the blank line preceding "When `github-ops` is used":

```markdown
- **`web-impl`** (`.claude/agents/web-impl.md`) — the web app in `apps/web/` (Angular + NgRx + Tailwind). Reads `apps/web/CLAUDE.md` and `apps/web/DESIGN.md`, and translates Pencil frames through the `pencil-design-extraction` skill. **Never uses a Tailwind arbitrary value for a design colour** — a hard-coded hex is the detectable symptom of a skipped token step.
```

- [ ] **Step 3: Register in the root `CLAUDE.md` — point B (domain layer)**

In `### Implementation agents & flow`, change `six **code-only** implementers` to `seven`, and append to the list:

```markdown
- **Domain layer:** `solutions-architect` (read-only planner — returns a **Coordination Plan**, writes nothing) and seven **code-only** implementers: `users-impl`, `orders-impl`, `tracking-impl`, `events-pipeline-impl`, `infra-impl`, `e2e-impl` (Playwright specs + Gatling load simulations; reads `e2e/CLAUDE.md`), and `web-impl` (Angular screens and components; reads `apps/web/CLAUDE.md`).
```

- [ ] **Step 4: Update the nested-CLAUDE.md enumeration**

The line beginning "Each service's stack/conventions live in its nested…" lists every nested location. Add `apps/web/CLAUDE.md`:

```markdown
Each service's stack/conventions live in its nested `services/<svc>/CLAUDE.md` (or `infra/CLAUDE.md`, `apps/web/CLAUDE.md`, or `functions/<name>/CLAUDE.md` for the events-pipeline Lambda), created at the start of that service's milestone — the implementer agents are thin and defer to it.
```

- [ ] **Step 5: Verify the frontmatter survives normalization**

```bash
nvm use
.venv/bin/python scripts/normalize_agent_frontmatter.py .claude/agents /tmp/normalized-agents
grep -A2 '^description:' /tmp/normalized-agents/web-impl.md
```

Expected: one `description: "…"` line containing the **whole** description. A truncated value means a continuation line lost its two-space indent.

- [ ] **Step 6: Commit**

```
feat(agents): add the web-impl implementer and register it

Seventh domain-layer implementer, owning apps/web/. Registered in both
root CLAUDE.md lists and the nested-CLAUDE.md enumeration.
```

---

### Task 15: The convention note

**Files:**
- Create: `docs/shared/conventions/pencil-design-extraction.md`
- Modify: `docs/00-overview/index.md` and/or `docs/plans/index.md` (indexing)

**Interfaces:**
- Consumes: Tasks 13 and 14.
- Produces: the vault's record of the convention, per the golden rule (vault first, memory second).

**This task must be routed through the `obsidian-vault` agent** — it is the sole writer of `docs/`.

- [ ] **Step 1: Have `obsidian-vault` write the note**

In English, with frontmatter (`title`, `type: convention`, `area: shared`, `status: active`, `created: 2026-08-18`, `updated: 2026-08-18`, folder-style tags) and a closing `## Related`. Content:

- The `.pen` is the source of truth; three artefacts derive from it.
- Tokens come from `GetVariables()`, never from an export's classes. **Web and email share one design system** — a brand colour change is a two-surface change.
- Exports are committed snapshots, never imported, never hand-edited.
- The three kinds of asset reference and their resolutions.
- The MCP bridge configuration, and why the per-editor bridge must never be used.
- Link `[[email-templates]]`, `[[package-manager]]`, `[[testing]]`, and the spec.

- [ ] **Step 2: Index the note**

Per [[doc-propagation]], link it from `docs/00-overview/index.md`.

- [ ] **Step 3: Run the validator — this is a gate, not a suggestion**

```bash
nvm use && node scripts/validate-vault.mjs
```

Expected: `Vault validation passed`. It checks frontmatter enums, broken wikilinks, and the `propagates-to:` propagation gate.

- [ ] **Step 4: Hand-check the anchor links**

The validator does **not** check intra-note anchors, nor wikilink anchors (`[[note#Heading]]`). Verify any by hand.

- [ ] **Step 5: Commit**

```
docs(vault): record the Pencil design-extraction convention

Routed through obsidian-vault. Vault first, per the golden rule.
```

---

### Task 16: Navigation E2E

**Files:**
- Create: `e2e/tests/web/navigation.spec.ts`
- Modify: `e2e/playwright.config.ts` (add the `web` project)

**Interfaces:**
- Consumes: every route from Task 6.
- Produces: the phase-1 verification layer (spec D9).

**Note the runner.** `e2e/` runs **Playwright**, despite `e2e/CLAUDE.md` §1 saying Vitest. Follow `playwright.config.ts` and the existing specs.

- [ ] **Step 1: Add the `web` project to the Playwright config**

`testDir: "./tests"` is recursive, so every subdirectory with its own project **must** also be added to the `internal` project's `testIgnore` or its specs run twice — `gateway` and `observability` already establish this.

In `internal`'s `testIgnore`, add `"**/web/**"`:

```ts
      testIgnore: ["**/gateway/**", "**/observability/**", "**/web/**"],
```

Then append a project:

```ts
    {
      // Phase-1 web verification: every route mounts and no console errors.
      // Unlike the other projects this one needs NO backend — the app renders
      // fixtures — but it does need the dev server on WEB_BASE_URL.
      name: "web",
      testDir: "./tests/web",
      use: { baseURL: process.env.WEB_BASE_URL ?? "http://localhost:4200" },
    },
```

- [ ] **Step 2: Write the spec**

```ts
import { expect, test } from "@playwright/test";

/**
 * Phase-1 verification (spec D9): every route mounts and renders clean.
 * There are no component unit tests in phase 1 — they arrive in phase 2 with
 * the logic they would test.
 */
const ROUTES = [
  { path: "/", heading: /products/i },
  { path: "/login", heading: /sign in/i },
  { path: "/login/passwordless", heading: /sign in/i },
  { path: "/verify", heading: /verify/i },
  { path: "/register", heading: /create/i },
  { path: "/register/passwordless", heading: /create/i },
  { path: "/password/new", heading: /password/i },
  { path: "/checkout", heading: /payment/i },
  { path: "/orders", heading: /orders/i },
  { path: "/orders/ord_V1StGXR8Z5", heading: /order/i },
  { path: "/profile", heading: /profile/i },
] as const;

for (const route of ROUTES) {
  test(`${route.path} mounts without console errors`, async ({ page }) => {
    // Collect BEFORE navigating: errors during initial load would be missed
    // by a listener attached afterwards.
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(route.path);

    // Assert on real content, not just a 200: an Angular app returns index.html
    // for every path, so a broken route still "loads".
    await expect(page.getByRole("heading").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: route.heading }).first()).toBeVisible();

    // Print WHAT arrived, not just a count — a bare count cannot distinguish a
    // broken app from a wrong expectation.
    expect(errors, `console errors on ${route.path}:\n${errors.join("\n")}`).toHaveLength(0);
  });
}

test("the unknown-route wildcard redirects home", async ({ page }) => {
  await page.goto("/no-such-page");
  await expect(page).toHaveURL(/\/$/);
});

/**
 * The Stripe flag is BUILD-TIME (Task 2b), so a single running build can only
 * ever show one path. This asserts the build under test is internally
 * consistent — not that both paths work, which needs two builds (step 3b).
 */
test("checkout renders exactly one payment path", async ({ page }) => {
  await page.goto("/checkout");
  const stripe = page.getByTestId("checkout-stripe");
  const plain = page.getByTestId("checkout-plain");

  const stripeVisible = await stripe.isVisible().catch(() => false);
  const plainVisible = await plain.isVisible().catch(() => false);

  // Exactly one — never both, never neither. A flag that shows nothing is the
  // failure mode a "renders without error" assertion would miss entirely.
  expect(
    [stripeVisible, plainVisible].filter(Boolean).length,
    `stripe=${stripeVisible} plain=${plainVisible}`,
  ).toBe(1);
});
```

Add the matching `data-testid="checkout-stripe"` / `data-testid="checkout-plain"`
attributes to the two branches in `CheckoutPayment` (Task 10).

- [ ] **Step 3: Run it against the dev server**

```bash
nvm use
pnpm web:dev &          # serves on :4200
pnpm --filter @3mrai/e2e test -- --project=web
```

Expected: 12 passing. A failure naming a heading means that route's placeholder was never replaced with real layout.

- [ ] **Step 3b: Run the suite against BOTH flag positions**

A build-time flag verified in one position is verified in neither. The spec
above proves internal consistency; this proves both builds are good:

```bash
cd apps/web && nvm use
echo 'NG_APP_STRIPE_ENABLED=false' > .env && pnpm build
cd ../.. && pnpm --filter @3mrai/e2e test -- --project=web

cd apps/web
echo 'NG_APP_STRIPE_ENABLED=true' > .env && pnpm build
cd ../.. && pnpm --filter @3mrai/e2e test -- --project=web
```

Expected: green both times. Note the dev server must be restarted between runs —
the value is compiled in, so a running server keeps serving the old one.

- [ ] **Step 4: Verify the specs did not also run under `internal`**

```bash
pnpm --filter @3mrai/e2e test -- --project=internal --list | grep -c "tests/web/" || echo "OK: not double-counted"
```

Expected: `OK: not double-counted`. A non-zero count means the `testIgnore` edit from step 1 is missing.

- [ ] **Step 5: Add the root script**

In the root `package.json`:

```json
    "e2e:web": "pnpm --filter @3mrai/e2e test -- --project=web",
```

- [ ] **Step 6: Commit**

```
test(web): navigation E2E covering every phase-1 route

Asserts each route mounts real content with no console errors. Added to
internal's testIgnore so the specs do not run twice.
```

---

## Review batches

Per [[phase-c-review-flow]]: chain the issues, do **not** ask for a merge between each, and stop at dependency gates with **one** batch of PRs.

| Batch | Tasks | Gate |
| --- | --- | --- |
| **1 — Foundation** | 1, 2, 2b, 3, 4, 4b, 5 | **STOP.** Tokens and fixtures are the vocabulary every later task consumes; a rename after batch 2 means touching every component. |
| **2 — Shell & primitives** | 6, 7, 8 | **STOP.** Tasks 9–11 all compose these. |
| **3 — Screens** | 9, 10, 11 | Independent of each other; reviewable together. |
| **4 — Tooling & docs** | 12, 13, 14, 15, 16 | Final batch. |

---

## Out of scope (stated so it is not silently dropped)

- **Any gateway call.** No HTTP, no auth wiring, no NgRx effects (spec's phase-1 boundary).
- **Wiring Stripe to anything.** Both checkout paths are BUILT and `NG_APP_STRIPE_ENABLED` selects between them (Tasks 2b, 10), but neither submits: there is no Stripe reference anywhere in the repo today — no service, no Terraform, no env var. The payment integration itself is phase 2, and it needs a backend that holds the secret key, since anything the web app can read is public.
- **Component unit tests.** Spec D9 — they arrive in phase 2 with the logic they would test.
- **Real brand photography.** The Unsplash reference is a design-time placeholder; who supplies real artwork is an open content decision (spec D5b).
- **`e2e/CLAUDE.md`'s stale "Runner: Vitest" line.** Real and worth fixing; a separate one-line change.
- **The Angular 22 / NgRx 22 upgrade.** A single follow-up task once NgRx 22 is stable.

## Related

- [[2026-08-17-web-app-foundation-design]] — the spec this plan implements
- [[web-app-foundation-milestone]] — the milestone-level map: task sequence, phases, dependency graph
- [[email-templates]] — the precedent, and the other half of the shared design system
- [[package-manager]] — pnpm only
- [[env-files]] — generated env files, and why the web's build-time config follows their shape
- [[testing]] — the three-layer rule and why phase 1 applies one layer
- [[phase-c-review-flow]] — batching and dependency gates
- [[doc-propagation]] — how these decisions reach the organised vault
