---
title: "Dev-only form autofill: three constraints that only surfaced by building it"
type: lesson
area: shared
status: active
created: 2026-09-07
updated: 2026-09-07
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/low
related:
  - "[[package-manager]]"
  - "[[code-comments]]"
  - "[[angular-component-authoring]]"
  - "[[testing]]"
---

# Dev-only form autofill: three constraints that only surfaced by building it

## What it is

A dev-only control (`apps/web/src/app/core/dev/dev-fill.ts`,
`dev-fill-button.ts`) that fills a form with plausible generated data, so
exercising a flow by hand does not mean retyping an email, a password, and an
address every time. Backed by Chance.js. Wired into six forms:
`login-password`, `login-passwordless`, `register-password`,
`register-passwordless`, `reset-password-request`, `checkout-payment`.

`verify-code` and `set-new-password` are **deliberately not wired** — both take
a real emailed code, and a generated one is invalid. Autofilling those two
would make the very thing they test — "does the real code work?" — look like a
broken backend instead of bad test data, which is worse than not helping at
all.

This note exists because two source comments link to it by name
(`[[2026-09-07-dev-form-autofill]]`) — see [Why this note has a dated
filename](#why-this-note-has-a-dated-filename) — so what follows is written as
a lesson (constraints discovered while building the thing), even though it
predates any incident: each constraint below cost a wrong attempt before the
working shape was found.

## Constraint 1 — a 472 kB dependency must not enter the initial bundle

Chance is a UMD monolith with no ESM entry point, so it cannot be tree-shaken.
A static `import Chance from 'chance'` at the top of the file pulls the whole
472 kB into the initial bundle, and this app enforces a 1 MB initial budget
(`ng build` fails the build if it's exceeded).

**Fix:** load it through a **dynamic** `import('chance')` inside the one
function that needs it, gated behind `isDevMode()`. A production build's tree
shaker can prove that call is never reached and drops it into its own
lazy-loaded chunk instead of the initial one.

**Verified in a real production build:** `chance` lands in its own **253.40
kB** chunk; initial bundle total **495.06 kB** (104.96 kB compressed) — well
inside budget.

## Constraint 2 — the gate must be a fact about the build, not a runtime flag

The natural first instinct is an environment flag — this app already has a
mechanism for that, `NG_APP_*` (see `apps/web/CLAUDE.md` §2c). That mechanism
is wrong here on purpose: an `NG_APP_*` flag needs a Dockerfile `ARG` *and*
`ENV`, and nothing stops it from being switched on by accident in a deployed
build. `isDevMode()` is false in any production Angular build **by
construction** — there is no environment variable to mis-set.

**Verified on the running Docker container:** `grep -c 'dev-fill\|devFill'`
over every chunk actually served returns **0**. The code is not merely hidden
behind a runtime check — it is physically absent from the bundle, because the
dynamic import in [Constraint 1](#constraint-1--a-472-kb-dependency-must-not-enter-the-initial-bundle)
is never requested.

**Consequence worth stating plainly, because it looks like a bug and isn't:**
the autofill control never appears on the Docker-served app at
`localhost:3004` — only under `ng serve` at `localhost:4200`. That is the
design working as intended, not a regression.

## Constraint 3 — testing a dev-mode branch needs a token, not a spy on the export

The natural second instinct is to spy on `isDevMode()` directly in a test that
asserts production behaviour (i.e. the control renders nothing). Two attempts
at that failed, and both failed for the same underlying reason — bending the
test to fit the code instead of changing the code to be testable:

- `vi.spyOn(core, 'isDevMode')` — fails with *"Cannot spy on export: module
  namespace is not configurable in ESM"*. `@angular/core`'s exports are
  read-only ESM bindings; nothing can reassign one from outside.
- `vi.mock('@angular/core')` — breaks Angular's own initialization through a
  circular dependency. Mocking the framework module to test one function
  built on it is too blunt an instrument.

**Fix:** introduce `DEV_MODE`, an `InjectionToken<boolean>` whose default
factory calls `isDevMode()`. Production code injects the token and gets
production behaviour unchanged; a test overrides the token with a DI provider,
which Angular supports natively — no spy, no module mock. This generalizes
beyond this feature: **any ESM export a test needs to control from outside is
a candidate for a thin InjectionToken wrapper**, not a spy target.

## A smaller decision made along the way

The generated password is shaped to satisfy **Cognito's** rules, not just the
form's client-side validator: Cognito requires an uppercase letter, a digit,
and a symbol on top of the client's 8-character minimum. A password that
satisfied only the client but not Cognito would surface as a confusing backend
rejection rather than as visibly-bad test data, so the generator prefixes
characters that guarantee all three, pinned by a test.

## Open item — not resolved by this note

`chance` is now a devDependency of `apps/web`, while `e2e/` and
`e2e/load-tests/` already declare it separately for their own Gatling/Chance.js
data generation (see [[testing]]) — three separate declarations of the same
library across one pnpm workspace (see [[package-manager]] on why that's worth
noticing). Nobody has decided whether to unify them under a shared workspace
dependency; this note only records that the duplication exists.

## Why this note has a dated filename

Filed under `docs/lessons/` — the vault's dated-filename convention
(`YYYY-MM-DD-short-title.md`) belongs to `lessons/`/`retros/`, and the two
source comments that reference this note by wikilink were committed with that
exact dated slug already baked in. The vault validator (`scripts/validate-vault.mjs`)
only scans `docs/` — it has no visibility into wikilinks written inside source
code comments — so a broken reference of this kind does not fail CI; it is
only caught by a human noticing, as happened here. Anyone adding a
`[[dated-note-name]]` reference from application source should create the note
in the same change, not after.

## Related

- [[package-manager]] — the pnpm-workspace angle on the three separate `chance`
  declarations noted above.
- [[code-comments]] — the `CONTRACT:`/`WHY:` tags used in `dev-fill.ts` and
  `dev-fill-button.ts` that link to this note.
- [[angular-component-authoring]] — general Angular component conventions this
  feature otherwise follows.
- [[testing]] — `e2e/` and `e2e/load-tests/`'s own Chance.js usage, relevant to
  the open dependency-duplication item above.
