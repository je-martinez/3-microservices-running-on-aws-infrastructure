---
title: Angular Component Authoring
type: convention
area: shared
status: active
created: 2026-08-19
updated: 2026-09-03
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[pencil-design-extraction]]"
  - "[[2026-08-17-web-app-foundation-design]]"
  - "[[2026-09-03-unstyled-custom-element-host-is-inline]]"
---

# Angular Component Authoring

Two rules for every Angular component in `apps/web/`, both named directly by the user after
reviewing the just-delivered web app, and both currently violated across the whole app. Neither
is a style preference: the first is a maintainability rule with a concrete recurring failure
mode attached, the second is an accessibility rule. This note is the durable record so the next
component — and `web-impl` and the `pencil-design-extraction` skill that feeds it — do not
reproduce either.

## Current state — the app does not comply yet

Measured on `apps/web/src/app` at the time this note was written:

- **32** components use inline `template:` backticks; **zero** use `templateUrl`; **zero**
  `.html` files exist under `apps/web/src/app`. The largest inline templates are
  `order-detail.ts` (236 lines), `cart-drawer.ts` (232 lines), `checkout-payment.ts`
  (226 lines) — markup and component logic interleaved in one file.
- **508** `[...px]` arbitrary-value Tailwind classes across **29** files: 148
  `text-[Npx]`, 144 padding, 107 `gap-`, 96 `h-`, 82 `w-`.

Nothing here is grandfathered. **This convention governs a component the moment anyone
touches it** — open a file to change one line, and its template moves to a sibling `.html`
and its `px` become `rem` in the same change. What is deferred is only the *bulk*
conversion of the untouched remainder, tracked as its own reviewable piece of work in
JE-174. This note changes no code by itself.

The distinction matters: "exempt until someone does the big refactor" means the debt grows
with every edit, while "convert what you touch" means it shrinks. A first reader of this
note took the earlier wording to mean the existing components were exempt, which is why it
is spelled out here.

## Rule 1 — templates live in their own `.html` file

A component's template belongs in a sibling `.html` file referenced by `templateUrl`, and its
styles likewise if it has any (`styleUrl` / `styleUrls`), instead of an inline `template:`
backtick string.

**Why:**

- Markup and class logic stop competing for the same file. A 236-line `.ts` becomes a short
  class plus a template that can be read on its own.
- Editors give real HTML tooling — formatting, folding, the Angular language service — inside
  a `.html` file, which a TS template literal does not get.
- A diff of a layout change stops touching the file that holds the component's logic.
- **The `${{ }}` trap disappears.** Inside an inline template, `${{ expr }}` is parsed as a JS
  template literal and breaks the file with cascading parse errors — this already bit the
  project once: `order-detail.ts` had to work around it with `{{ '$' + expr }}` instead of the
  more natural `${{ expr }}`. In a `.html` file, `$` is just a character; the trap does not
  exist there.

**Exception:** a component whose template is genuinely one line (a `<router-outlet />` host,
for example) may keep it inline. Do not stretch this into a loophole for anything longer than
that.

## Rule 2 — no `px` in component classes; use `rem`

Sizing values in component Tailwind classes — font sizes, padding, gap, width, height, radius —
are expressed in `rem`, not `px`.

**Why this is not a style preference:** a font size set in `px` ignores the reader's browser
font-size setting, so a user who has enlarged their default text sees no change. That is an
accessibility failure. A size in `rem` scales with the browser setting.

**The design is not on a 4px grid.** The most common measured values are 13, 19, 17, 15, 18,
14, 10, and 6 px — mostly odd numbers. "Use Tailwind's spacing scale" is therefore not a usable
instruction on its own; the conversion has to preserve the value the design actually specifies,
not round it to the nearest scale step.

The concrete rule:

- **Convert by dividing by 16.** `13px` → `0.8125rem`, `19px` → `1.1875rem`, `56px` → `3.5rem`.
- **Prefer a design token** where one already exists (`rounded-md`, `h-field`) over any raw
  value, converted or not.
- **Prefer Tailwind's own scale** where a value happens to land on it (`p-4` = `1rem`).
- **Borders and hairlines stay in `px`.** A 1px border is a device-pixel concern, not a
  typographic one, and `1px` is correct there — naming this exception explicitly so nobody
  converts `border-[1px]` to `rem` thinking they applied the rule correctly.
- The two metric tokens in `styles.css` (`--radius-md: 10px`, `--spacing-field: 56px`) should
  be expressed as `0.625rem` and `3.5rem` respectively.

## Rule 3 — a component whose template fills its parent needs `host: { class: 'block w-full' }`

An Angular custom element defaults to `display: inline` when unstyled — the same as `<span>` —
so it shrink-wraps to its content and ignores width/height rules applied *inside* its template.
If a component's template root uses `w-full` (or `h-full`) expecting to fill the space its
caller gives it, that expectation silently fails as a flex/grid item unless the component
itself declares a block-level host:

```ts
@Component({
  // ...
  host: { class: 'block w-full' },
})
```

Put this on the **component**, not at each call site — a call site added later has no way to
know the component needs it, so the fix must travel with the component. This hit `app-header`,
`app-cart-line`, and `app-field` before landing here; full incident detail, the measured
evidence, and why it reads as a content-alignment bug rather than a sizing bug:
[[2026-09-03-unstyled-custom-element-host-is-inline]].

## Where this bites — the extraction workflow, not just the component

The Pencil `html-tailwind` export emits fixed `px` for every value and has no `.html`/`.ts`
split to preserve, because it is one static reference page with no Angular structure of its
own. **The extraction workflow must translate the export, not transcribe it** — the export is a
reference for structure, spacing *relationships*, and hierarchy, never a source of literal
values or file layout to copy.

This is the same principle [[pencil-design-extraction]] already records for colours: the export
does not know the design's tokens, so its arbitrary hex classes must never be copied verbatim.
Units are that rule's second half, covering `px` sizing the same way that note covers hex
colours — and it was the half that got missed when the app was first built.

## Related

- [[pencil-design-extraction]] — the sibling convention this note completes: colours must come
  from `GetVariables()` tokens, never an export's hex classes; this note applies the same
  translate-don't-transcribe principle to sizing units and to the export's single-file
  structure.
- `apps/web/CLAUDE.md` — the app's stack, the tokens golden rule (§2a), and the `${{ }}`
  template gotcha this note's Rule 1 references.
- [[2026-08-17-web-app-foundation-design]] — the design spec `apps/web/` was built from.
- [[2026-09-03-unstyled-custom-element-host-is-inline]] — the lesson behind Rule 3: the
  incident detail, measured evidence, and why the bug reads as content misalignment rather
  than a sizing defect.
