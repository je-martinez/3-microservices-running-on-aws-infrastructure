---
title: "Phone Input with a Country Flag — Options and Plan"
type: plan
area: shared
status: draft
created: 2026-09-05
updated: 2026-09-05
tags:
  - type/plan
  - area/shared
  - status/draft
propagates-to: none — an options evaluation for a feature not yet approved; it propagates once a decision is taken and implemented.
related:
  - "[[2026-09-04-web-gateway-integration-design]]"
  - "[[angular-component-authoring]]"
  - "[[package-manager]]"
---

# Phone Input with a Country Flag — Options and Plan

## The ask

Phone fields should show the country's flag, derived from the number the user
types. Evaluate whether a third-party package already does this before building
one.

## A correction to the premise

The request says the flag should follow **the postal code**. It should not, and
the distinction matters:

- A **postal code** does not identify a country. `10604` is a valid postal code
  in Santo Domingo, in New York State, and in several other countries. There is
  no function from postal code to country.
- A **phone number in E.164** does identify one, because the calling code plus
  the leading digits resolve to exactly one region.

So the flag is derived from the **phone number itself**, which is also the field
it decorates. The address's `country` field is the fallback seed for which flag
to show before the user has typed anything.

## Current state

Two live phone fields, both plain text through the shared `Field` component:

| Screen | File |
|---|---|
| Checkout — delivery address | `features/checkout/checkout-payment.html` |
| Profile | `features/account/profile.html` |

`Field` (`shared/ui/field.ts`) takes `label`, `placeholder`, `value`, `type`,
`icon`, `trailingIcon`, `help` and emits `valueChange`. It has no slot for a
leading control, which is the one structural change any option requires.

The wire type is `phoneNumber: string | null` on `User` — free-form, with no
format the service enforces.

## The constraint that decides this

**Angular 21.** Per `apps/web/CLAUDE.md` §1, Angular/NgRx/`@ngx-env/builder` are
pinned as a set because NgRx has no stable Angular-22 release. Any Angular-coupled
dependency has to survive inside that pin.

## Options evaluated

All version and date figures below were read from the npm registry on
2026-09-05, and the behavioural claims were run locally against the real
packages.

### A. `ngx-intl-tel-input` — an Angular component, ready-made

- v17.0.0, MIT, peers `@angular/core >= 17.0.0`.
- **Last published 2025-02-24 — over eighteen months stale**, and predates
  Angular 19, 20 and 21 entirely.

The open peer range `>= 17` would install against Angular 21 without complaint,
which is precisely the risk: npm's resolver would be satisfied while nothing
about the package has been tested against this major. It also carries its own
form-control and styling assumptions, which would fight the design tokens rather
than use them.

**Rejected.** Adopting an unmaintained Angular-coupled dependency into a
deliberately pinned stack is the trade this repo has already refused once for
NgRx.

### B. `intl-tel-input` — the framework-agnostic original

- v29.2.3, MIT, published 2026-08-14. Actively maintained, no Angular peer.

Complete and well-tested, but it owns the DOM: it builds its own dropdown,
country list and flag sprites. Wrapping it means an Angular component whose job
is to fight a library that wants to render things itself, and the flags arrive as
a CSS sprite sheet — an image dependency for something Unicode already provides
(see below).

**Rejected for this app.** It solves a bigger problem than we have.

### C. `libphonenumber-js` + our own `Field` variant — RECOMMENDED

- v1.13.12, MIT, published 2026-08-27. No framework coupling, ships ESM and types.

A parsing library, not a UI library. We keep ownership of the markup, so the
control stays inside the design system instead of beside it.

**Verified locally against the real package:**

```
+1 809 555 0142    -> country=DO  valid=true  fmt="+1 809 555 0142"
+1 212 555 0142    -> country=US  valid=true  fmt="+1 212 555 0142"
+34 612 345 678    -> country=ES  valid=true  fmt="+34 612 34 56 78"
809555             -> country=—   valid=false
```

The first two lines are the reason to choose it: **it separates the Dominican
Republic from the United States even though both are `+1`.** NANP area-code
disambiguation is the hard part of this problem, and the app's own placeholder
(`+1 809 000 0000`) sits exactly on it. A naive calling-code lookup would show
the wrong flag for every Dominican number.

**Size, measured rather than estimated.** The `unpackedSize` of ~10 MB is
misleading — it counts four metadata variants plus sources. The package exposes
sub-exports, and importing `libphonenumber-js/min` ships one metadata file:

| Metadata | Raw | Gzipped |
|---|---|---|
| `min` | 82 KB | **19 KB** |
| `mobile` | 97 KB | — |
| `max` / `full` | 153 KB | — |

19 KB gzipped for correct international parsing is a reasonable trade. `min`
covers formatting and country detection; it drops only the fine-grained number
*type* data we do not need.

### D. `awesome-phonenumber` — a smaller alternative

- v7.8.0, MIT, published 2026-02-18. A thin wrapper over Google's libphonenumber.

Verified to resolve `DO` and `ES` correctly, same as option C. Six months
staler and a smaller ecosystem, with no advantage that matters here.

**Viable fallback**, not the first choice.

## Flags need no dependency at all

Every option above is separable from the flag itself. An ISO-3166 alpha-2 code
maps to its flag emoji by offsetting each letter into the Unicode regional
indicator block:

```ts
const flag = (cc: string) =>
  cc.toUpperCase().replace(/./g, (c) =>
    String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65));
```

Verified: `DO → 🇩🇴`, `US → 🇺🇸`, `ES → 🇪🇸`, `MX → 🇲🇽`, `FR → 🇫🇷`, `JP → 🇯🇵`.

Two lines, zero bytes of dependency, no sprite sheet, no image requests, and it
scales with the font. **This is why option B's main asset is not an advantage.**

### The one real caveat

Flag emoji do not render as flags on **Windows**, which ships no flag glyphs —
Chrome and Edge there show the two letters (`DO`) instead. That is legible rather
than broken, and it is the reason the design should show the ISO code beside the
flag rather than relying on the glyph alone. If pixel-identical flags across
every platform become a requirement, that is the moment to add an SVG set
(e.g. `flag-icons`), not before.

## Recommendation

**Option C**, with emoji flags and no flag dependency:

- `pnpm add libphonenumber-js` in `apps/web` (pnpm only — see [[package-manager]]).
- Import from `libphonenumber-js/min`, never the package root, or the bundle
  silently gains the 153 KB metadata.
- Build `shared/ui/phone-field.ts` as a sibling of `Field`, not a rewrite of it.
  `Field` is used by every auth screen; widening it for one field type would put
  phone-specific concerns in a component that mostly does not need them.

## Implementation plan

### 1. Add the dependency
`pnpm add libphonenumber-js` in `apps/web`. Confirm `pnpm-lock.yaml` changes and
no stray `package-lock.json` appears.

### 2. `shared/ui/phone-field.ts` + `.html`
Per [[angular-component-authoring]]: template in a sibling `.html` via
`templateUrl`, sizing in `rem`, colours from `@theme` tokens only — no arbitrary
Tailwind values.

Inputs `label`, `value`, `placeholder`, `help`, plus `defaultCountry` (seeded
from the address's `country`). Outputs `valueChange` and `countryChange`.

Internals: an `AsYouType` formatter per keystroke, a `country` signal, and a
leading slot rendering the flag and ISO code. State lives in signals, matching
the app's existing style.

### 3. Behaviour rules worth pinning as `CONTRACT:` comments
- **Store E.164, display formatted.** The service takes free-form text, so the
  app decides; E.164 is the interoperable form and the one Cognito and any future
  SMS path would expect.
- **Never block on invalid.** A partially typed number is invalid by definition;
  validity gates *submission*, never *typing*.
- **No country yet is a real state.** Before enough digits arrive, show a neutral
  placeholder — not a guessed flag.
- **Import from `/min`.** Note the size consequence in the comment so nobody
  "simplifies" it to the root import.

### 4. Adopt it in the two call sites
Checkout and profile switch from `Field` to `PhoneField`, seeding
`defaultCountry` from `address.country`.

### 5. Tests (Vitest)
- `+1 809…` yields `DO`, `+1 212…` yields `US` — the NANP case, and the one that
  would regress silently
- `+34…` yields `ES`
- A partial number reports no country and does not error
- The emitted value is E.164 while the rendered value is formatted
- `defaultCountry` seeds the flag before any input
- Clearing the field clears the country

Then mutate: replace the parser with a plain calling-code lookup and confirm the
`DO` vs `US` test goes red. A test suite that passes under that substitution is
not testing the thing worth testing.

### 6. Verify
`pnpm test`, `pnpm typecheck`, `pnpm exec tsc --noEmit -p tsconfig.spec.json`,
`pnpm lint`, `pnpm build`, plus `grep -rnE '(bg|text|border)-\[#' apps/web/src/`
returning nothing. Then a browser check on :3004 for the two screens.

## Open questions for the user

1. **Should the country be pickable, or only derived?** This plan derives it from
   what is typed. A dropdown is a larger surface and the design has no frame for
   it.
2. **Is Windows' missing flag glyph acceptable?** The ISO code beside the flag
   covers it. If not, `flag-icons` adds SVGs at real cost.
3. **Should an invalid number block submission?** Currently nothing validates
   phone format at all, so this would be new behaviour.

## Related

- [[2026-09-04-web-gateway-integration-design]]
- [[angular-component-authoring]]
- [[package-manager]]
