# CLAUDE.md — Web app

Nested project memory for the **3MRAI web app** (`apps/web`). Source of truth for
this app's stack and conventions. The global `web-impl` agent reads this first,
every time. Cross-cutting rules are **referenced**, never duplicated.

## 1. Stack & versions
- Runtime: Node.js (repo-pinned via `.nvmrc`, currently 24.18.0 — run `nvm use`).
- Framework: **Angular 22.x** (`@angular/core` ^22.1.6, `@angular/cli` ^22.1.7).
- State: **NgRx** (`@ngrx/signals`, `@ngrx/store`) `22.0.0`.
- Build: `@ngx-env/builder` **22.0.0**, which peers `@angular/build ^22`. This is
  the package that inlines `NG_APP_*` env vars at build time — see §2c.
- Styling: **Tailwind 4.3.3**, CSS-first (`@theme` in `src/styles.css`) — see
  §2a. `@tailwindcss/postcss` + `postcss` do the compilation; there is
  deliberately no `tailwind.config.ts`.
- Icons: `@lucide/angular`. Fonts: `@fontsource/inter`.
- Test runner: **Vitest** (not Karma/Jasmine) with `jsdom`.
- Lint: `angular-eslint` + `typescript-eslint` + `@eslint/js`, flat config
  (`eslint.config.js`).
- Do **not** upgrade Angular, NgRx, `@ngx-env/builder`, or `angular-eslint`
  independently of one another — each peers a matching major, so a lone bump
  leaves the tree with unmet peers. Move all four together, as a deliberate
  piece of work rather than a drive-by bump.
- **Every component declares `ChangeDetectionStrategy.OnPush`**, and
  `angular-eslint` fails the build otherwise. The app has no `zone.js` — it is
  zoneless, so rendering is driven by signals and `OnPush` is the correct
  strategy, not an optimisation. Note the trap when running `ng update`: the
  v22 migration writes `ChangeDetectionStrategy.Eager` into every component to
  preserve pre-v22 behaviour, which the lint rule then rejects on all of them.
  Convert those to `OnPush` rather than silencing the rule.

## 2. Commands
All commands assume `nvm use` first and run from `apps/web/` (or via
`pnpm --filter @3mrai/web <script>` from the repo root).
- Install: `nvm use && pnpm install --frozen-lockfile` (repo root)
- **First run: `cp .env.example .env`.** The file is gitignored, so a fresh
  clone has none — and every `NG_APP_*` then reads `undefined`, which the
  parser treats as `false` (see §2c). The visible symptom is a feature that
  is simply absent with no error: `NG_APP_GEOCODE_ENABLED` unset means the
  checkout address autocomplete never offers a suggestion, even though the
  `/geocode/` proxy answers 200 and the Geoapify key is valid. Set the flags
  you want ON before starting the dev server.
- Dev server: `pnpm dev` (`ng serve`) — **restart it after changing any
  `NG_APP_*`**. They are inlined at BUILD time, so a browser reload re-serves
  the bundle compiled with the old value and looks like the flag being
  ignored.
- Build: `pnpm build` (`ng build`) — verifies the app compiles and the Tailwind
  build resolves every utility class actually used.
- Test: `pnpm test` (`ng test`, Vitest) — component/unit specs.
- Lint: `pnpm lint` (`ng lint`) — Angular ESLint rules.
- Typecheck: `pnpm typecheck` (`tsc --noEmit -p tsconfig.app.json`) — catches
  type errors `ng build` may not surface directly.
- Run a workspace binary directly (not via a package script):
  `cd apps/web && pnpm exec <bin>`. `pnpm dlx` downloads a throwaway copy;
  `pnpm --filter <pkg> dlx` is **not valid** — it errors with
  `Unknown option: 'recursive'`.

## 2a. GOLDEN RULE — tokens, never arbitrary values

Every colour, radius, and sizing value in this app comes from a **named Tailwind
token**, generated from `assets/web-app/web-app.pen` into the `@theme` block in
`src/styles.css` (documented in full in `DESIGN.md`). `bg-brand-navy`, never
`bg-[#2D3748]`.

**If a colour in a design frame has no matching token, stop and report it.** Do
not reach for the nearest existing token and do not hardcode the hex. Three real
gaps in the design system were found exactly this way (`text-muted-on-dark`,
`text-subtle-on-dark`, `text-on-orange-light`) — the token was missing, not the
implementer's judgment. The one time a gap was papered over with a substitute
instead of reported, the miss reached review. Fix a real gap in the `.pen` via
the `pencil-design-extraction` skill, then re-emit `styles.css` — never by
hand-editing it.

**This is how a skipped step is detected in review** — run before considering
any UI task done:

```bash
grep -rnE '(bg|text|border)-\[#' apps/web/src/
```

Expected: no matches. Any hit is either a real design-system gap (report it,
don't fix it locally) or a token that should have been used instead.

Tailwind 4 traps that make this rule easy to violate silently:
- **Namespace prefixes are mandatory and fail silently.** `--color-brand-navy`
  yields `bg-brand-navy`; a bare `--brand-navy` yields **no utility and no
  error**. A green build proves nothing — check the compiled CSS if a utility
  seems not to apply.
- **Tailwind scans Markdown and HTML — including this file.** `DESIGN.md` and
  `apps/web/design/` document arbitrary-value class patterns like
  `bg-[url('../img/…')]` as prose examples; Tailwind would otherwise compile
  them for real and break the build. This very file tripped the same trap
  once: the sentence above, written as prose to explain the danger, was itself
  scanned as markup and produced `Could not resolve "../img/…"` at a generated
  line of `styles.css` that does not exist in the source — confusing to
  diagnose precisely because the error points at the wrong file. `DESIGN.md`,
  `apps/web/design/`, and `CLAUDE.md` are excluded via `@source not` in
  `styles.css` — do not remove those lines, and **any new prose file added
  under `apps/web/` that documents a Tailwind class pattern needs the same
  exclusion added**, or it will resurface the same failure the next time
  someone writes an example.

## 2b. GOLDEN RULE — templates in `.html`, sizing in `rem`

Full convention: `../../docs/shared/conventions/angular-component-authoring.md` →
[[angular-component-authoring]]. Two rules, named directly by the user after
reviewing the delivered app, and both currently violated across the whole app —
**this rule does not describe the current codebase.** Nothing is grandfathered:
it governs a component **the moment you touch it** — open a file to change one
line and its template moves to a sibling `.html` and its `px` become `rem` in the
same change. Only the bulk conversion of the untouched remainder is deferred,
tracked as JE-174.

**Current state (measured at time of writing):** 32 components use inline
`template:` backticks; zero use `templateUrl`; zero `.html` files exist under
`apps/web/src/app`. 508 `[...px]` arbitrary-value classes across 29 files, of
which 148 are `text-[Npx]` font sizes.

1. **Templates live in a sibling `.html` file via `templateUrl`** (styles too,
   via `styleUrl`, if the component has any), not an inline `template:` backtick
   string. Exception: a genuinely one-line template (e.g. a `<router-outlet />`
   host) — don't stretch this into a loophole for anything longer. This also
   sidesteps the `${{ expr }}` trap below: outside a TS template literal, `$` is
   just a character.
2. **No `px` in component Tailwind classes — use `rem`.** A `px` font size
   ignores the reader's browser font-size setting; that's an accessibility
   failure, not a style choice. Convert by dividing by 16 (13 divided by 16
   rem, as a worked example — not written as a literal class here since this
   file is scanned by Tailwind, see the trap below). Prefer an existing design
   token or Tailwind scale step over any raw converted value. **Exception:
   borders and hairlines stay in `px`** — a 1-unit border is a device-pixel
   concern, not typographic, and converting it is not applying the rule
   correctly.

**Why the Pencil export can't be copied straight in for either rule:** the
`html-tailwind` export (see `pencil-design-extraction` skill) emits fixed pixel
sizing for every value and has no `.html`/`.ts` split, because it's one static
reference page, not an Angular app. Treat it as a reference for structure and
spacing *relationships* — translate every literal value and the file layout,
never transcribe them. This is the same principle §2a already applies to
colour tokens; these two rules are its other half.

## 2c. GOLDEN RULE — `NG_APP_*` is public

`@ngx-env/builder` inlines every `NG_APP_*` environment variable directly into
the built bundle at compile time. Anything under that prefix is readable by
anyone who opens devtools on the deployed app — **flags and publishable keys
only, never a secret.** A Stripe *publishable* key is fine; a Stripe *secret*
key, an API token, or a signing secret is not.

Application code never reads `import.meta.env` directly. `NG_APP_*` values are
parsed **once**, in `src/app/core/config/app-config.ts`, into the typed
`APP_CONFIG` object — every `NG_APP_*` value arrives as a **string** (`"false"`
is truthy), so parsing it in one place instead of at each call site is what
keeps that from becoming a bug. Every other file reads `APP_CONFIG`.

## 2d. GOLDEN RULE — forms are Signal Forms schemas

Every form in this app is an Angular **Signal Forms** schema: a `model` signal
plus `form(this.model, (path) => { … })` declaring `required()`, `pattern()`,
`maxLength()` and friends. `ReactiveFormsModule`, `FormBuilder` and
`new FormControl` appear nowhere in `src/` and must not come back — a form
written the Reactive way matches nothing else in the codebase.

Three properties of the framework bite hard enough to be rules of their own.
All three are verified against the installed Angular **22.1.6**, not against
its documentation.

**`required()` accepts whitespace.** Its `isEmpty` treats a value as present
unless it is `''`, `false`, `null` or `undefined`, so `"   "` satisfies it. It
is therefore WEAKER than a `.trim().length > 0` guard, and translating one into
the other silently loosens the check. Where blank-but-not-empty must be
rejected, pair it with `pattern(path.field, /\S/)`. See
[[2026-09-10-signal-forms-required-accepts-whitespace]].

**`[formField]` owns its control bindings.** It claims and feeds a fixed set —
`required`, `disabled`, `readonly`, `pattern`, `min`/`max`, `minLength`/
`maxLength`, `name`, and the state flags. Binding any of them by hand on the
same element is a COMPILE error (NG8022), not a warning. Let the schema carry
them. See [[2026-09-10-formfield-owns-its-control-bindings-ng8022]].

**`[formField]` reads the RAW DOM value.** It registers its own `input`
listener and re-reads `element.value` on every event, so it is not a passive
observer of a value the component curates. Any "format as you type" handler
that sanitises by rewriting `element.value` RACES that listener, and the
unsanitised value can win — the request is built from field state, not from the
DOM. Sanitise into the model, never by rewriting the element. See
[[2026-09-10-formfield-reads-the-raw-dom-value]].

## 3. Folder structure
```
apps/web/
├── src/app/
│   ├── core/
│   │   ├── config/   — app-config.ts (parses NG_APP_* once, see §2c)
│   │   ├── layout/   — app-header.ts, shell.ts
│   │   └── overlay/  — overlay-store.ts, scrim.ts (see "Overlays" below)
│   ├── features/
│   │   ├── account/     — account-menu.ts, profile.ts
│   │   ├── auth/         — login/register (password + passwordless), verify-code,
│   │   │                   set-new-password
│   │   ├── cart/         — cart-drawer.ts
│   │   ├── catalogue/    — home.ts
│   │   ├── checkout/     — checkout-payment.ts
│   │   ├── notifications/— notifications-panel.ts
│   │   └── orders/       — order-detail.ts, orders-list.ts
│   ├── fixtures/     — api-types.ts + one .fixture.ts per domain (catalogue,
│   │                   notifications, orders, user) — stand in for the gateway
│   │                   until phase 2 wires real calls (see "Phase 1 boundary")
│   ├── shared/ui/    — presentational components shared across features
│   │                   (button-primary, field, product-card, status-badge, …)
│   ├── app.config.ts, app.routes.ts, app.ts
├── src/styles.css    — Tailwind 4 @theme tokens (generated — see §2a)
├── design/exports/   — committed HTML snapshots of Pencil frames, reference
│                       only, never imported by the app (see design/README.md)
├── DESIGN.md         — design system documentation (see §7)
└── public/
```

## 4. Conventions (referenced, never duplicated)
- Package manager (pnpm only): [../../docs/shared/conventions/package-manager.md](../../docs/shared/conventions/package-manager.md) → [[package-manager]]
- Env files (generated, never hand-edited): [../../docs/shared/conventions/env-files.md](../../docs/shared/conventions/env-files.md) → [[env-files]]
- Testing (three layers per endpoint, once this app calls the gateway in phase 2): [../../docs/shared/conventions/testing.md](../../docs/shared/conventions/testing.md) → [[testing]]
- Scripting language: [../../docs/shared/conventions/scripting-language.md](../../docs/shared/conventions/scripting-language.md) → [[scripting-language]]
- Git workflow & commit conventions: [../../docs/shared/conventions/git-workflow.md](../../docs/shared/conventions/git-workflow.md) → [[git-workflow]]
- Logging & tracing (applies once this app makes real HTTP calls in phase 2): [../../docs/shared/conventions/logging-context.md](../../docs/shared/conventions/logging-context.md) → [[logging-context]]
- Code comments (five tags, ≤6 lines untagged, >12 a hard error): [../../docs/shared/conventions/code-comments.md](../../docs/shared/conventions/code-comments.md) → [[code-comments]]
  - Enforced on this app's `.ts` **and its Angular `.html` templates** by
    `scripts/validate-comments.py` (pre-commit hook). A `<!-- -->` block is held to the same
    tags, the same ≤6-line untagged budget and the same >12-line hard error as code.

## 5. Other hard-won facts from building this app

Discovered while implementing Blocks 1–3; each cost real time. (The tokens
golden rule and its Tailwind traps live in §2a above — not repeated here.)

### Angular template gotcha
`${{ expr }}` is parsed as a JS template literal, not `$` + interpolation, and
breaks the file with cascading parse errors. Write `{{ '$' + expr }}` instead —
`order-detail.ts` uses that form as a live example (four call sites formatting
cents to a dollar string).

### The stale-cache trap
If lint or build fails with an ENOENT pointing at a file that no longer exists,
the Angular cache is stale: `rm -rf apps/web/.angular` and re-run. It is
gitignored (`/.angular/cache`), so nothing is lost.

### Overlays
Cart, account menu and notifications are **UI state over `/`**, not routes —
their design frames wrap a `Page` plus an overlay, while real pages are
`App Header` + `Body`. `OverlayStore` holds one discriminated signal so two
panels open at once is unrepresentable. Every overlay panel needs `z-50`, above
the Scrim's `z-40`, or it renders underneath — silent at build time. The
**toast is deliberately not an `OverlayKind`**: transient, no scrim, and it may
appear while the cart is open.

### Phase 1 boundary
Screens are laid out and navigable; nothing calls the gateway. Forms render but
use `(submit)="$event.preventDefault()"` on purpose. There are no component
unit tests by spec decision (D9) — they arrive in phase 2 with the logic they
test.

## 6. Agent rules
- Converse with the user in **Spanish**; write code and comments in **English**.
- `web-impl` writes **only source code** — never runs git or touches Linear.
- Leave finished work in the working tree for the **main session** to commit
  (`github-ops` is an optional helper for complex git batches — see
  [[git-workflow]]).
- `docs/` is written only by `obsidian-vault` — never edit vault notes directly.
- Stay within the single task handed to you (YAGNI).

## 7. Design reference
- Design system documentation: [DESIGN.md](DESIGN.md) — tokens, shared-with-email
  colours, and the full component → target-path mapping. Read it before
  building or touching any UI component; do not duplicate its tables here.
- Reference HTML snapshots of every Pencil frame: [design/exports/](design/exports/)
  (see `design/README.md`) — reference only, never imported by the app, never
  hand-edited.
- Design & plan (vault): [../../docs/superpowers/specs/2026-08-17-web-app-foundation-design.md](../../docs/superpowers/specs/2026-08-17-web-app-foundation-design.md), [../../docs/superpowers/plans/2026-08-18-web-app-foundation.md](../../docs/superpowers/plans/2026-08-18-web-app-foundation.md)
- Milestone plan (vault): [../../docs/plans/web-app-foundation-milestone.md](../../docs/plans/web-app-foundation-milestone.md)
