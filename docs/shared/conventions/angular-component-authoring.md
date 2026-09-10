---
title: Angular Component Authoring
type: convention
area: shared
status: active
created: 2026-08-19
updated: 2026-09-10
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[pencil-design-extraction]]"
  - "[[2026-08-17-web-app-foundation-design]]"
  - "[[2026-09-03-unstyled-custom-element-host-is-inline]]"
  - "[[2026-09-03-cart-drawer-scrim-lead-flicker]]"
  - "[[2026-09-03-cart-drawer-first-open-flicker]]"
  - "[[2026-09-04-web-gateway-integration-design]]"
  - "[[web-gateway-integration-milestone]]"
  - "[[2026-09-10-signal-forms-required-accepts-whitespace]]"
  - "[[2026-09-10-formfield-reads-the-raw-dom-value]]"
  - "[[2026-09-10-formfield-owns-its-control-bindings-ng8022]]"
---

# Angular Component Authoring

The rules every Angular component in `apps/web/` follows. None is a style preference: Rules 1–2
are a maintainability rule and an accessibility rule the user named directly after reviewing the
web app; Rules 3–6 each carry a concrete failure this repo hit; Rules 7–10 govern forms, which
are Signal Forms schemas here. This note is the durable record so the next component — and
`web-impl` and the `pencil-design-extraction` skill that feeds it — reproduce none of them.

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

## Rule 4 — `ApiClient` paths never include the `/v1` prefix

`core/http/api-client.ts` (introduced in [[2026-09-04-web-gateway-integration-design]]) reads
its base URL from `APP_CONFIG.apiGatewayUrl`, which **already supplies** the `/v1` prefix.
Every caller passes a path relative to that prefix — `products`, `cart`, `users/me` — never
`v1/products`. Passing a path that starts with `/v1/...` produces a doubled prefix,
`/v1/v1/...`, which 404s at the gateway. This is easy to get wrong by habit, since the
service's own OpenAPI paths are documented with the `/v1` prefix included — the prefix belongs
to `APP_CONFIG`, not to the call site.

## Rule 5 — interceptor order matters: refresh before auth

The refresh interceptor MUST be registered **before** the auth interceptor in
`provideHttpClient(withInterceptors([...]))`. Angular's HTTP interceptor chain runs in
registration order for the outbound request and in reverse for the response, so refresh-before-
auth is what makes a retried request **re-enter** the auth interceptor and pick up the freshly
refreshed token, rather than replaying the same stale `Authorization` header that just produced
the 401. Reversing the order produces a retry loop that fails identically every time, because
the retried request never sees the new token.

## Rule 6 — a guard must AWAIT async rehydration, never read a synchronous flag

`authGuard` and `guestGuard` read session state that is rehydrated from the encrypted IndexedDB
token store on boot — an inherently asynchronous read. A guard that checks a synchronous
`isAuthenticated` flag before that rehydration resolves will see the pre-rehydration default
(unauthenticated) and evict a genuinely logged-in user on a page reload. The guard function
must `await` the rehydration before making its allow/deny decision — this is not an edge case,
it is the default path every reload of `/orders`, `/checkout`, or `/profile` takes.

## Rule 7 — a form is a Signal Forms schema; validation lives in the schema, not the component

Every form in `apps/web/` is a Signal Forms `form()` over a `signal()` model, with its
constraints declared in the schema callback. The component holds the model and the form; it does
not hand-roll validity.

```ts
protected readonly model = signal<ProfileForm>(EMPTY_PROFILE_FORM);

protected readonly profileForm = form(this.model, (path) => {
  required(path.fullName, { message: 'Enter your full name' });
  pattern(path.fullName, /\S/, { message: 'Enter your full name' });
  maxLength(path.postalCode, 5);
});
```

Three consequences follow, and each is a rule of its own:

- **Submission is gated by the schema's own verdict**, `form().valid()`, never by a hand-written
  predicate over the model's fields. A component that keeps its own `trim().length > 0` check
  beside a schema has two sources of truth, and they drift.

  ```ts
  protected readonly canSave = computed(() => this.profileForm().valid() && !this.saving());
  ```

- **A rejected submit calls `form().markAsTouched()`**, so every field's error becomes visible at
  once. Errors stay hidden until touched (see `Field.visibleError`), so without this a user who
  presses a disabled-looking button gets no explanation.
- **A constraint is declared once, in the schema**, and reaches both the native attribute and any
  custom control's own formatting — see Rule 9, which makes this mandatory rather than merely
  tidy.

## Rule 8 — a gating `required` is paired with `pattern(path.x, /\S/)`

`required()` counts a value of nothing but spaces as **present**: its `isEmpty()` rejects only
`''`, `false`, `null`/`undefined` (and `NaN` for numbers). So `required()` alone is **weaker**
than a `fullName().trim().length > 0` guard — it compiles, it passes the existing tests, and it
lets a user register with a name of three spaces or save a delivery address that ships nowhere.

Whenever a `required` is what **gates submission**, pair it:

```ts
required(path.fullName, { message: 'Enter your full name' });
pattern(path.fullName, /\S/, { message: 'Enter your full name' });
```

Same message on both, so which validator fired is invisible to the user.

**Scope:** this applies to a `required` that gates submission. A `required` used purely to mark
a field visually does not carry the same risk.

**The regression test must hold every other field valid**, so the field under test is the only
thing that can block submission. A test that blanks several fields at once can pass for an
unrelated reason and be inert — an `<input type="email">` reports `""` for an invalid value, so
a blank email blocks submission on its own and masks a missing name check entirely.

Full incident, the `file:line` evidence in the installed Angular, and the mutation check that
proves the test is not inert: [[2026-09-10-signal-forms-required-accepts-whitespace]].

## Rule 9 — `[formField]` owns its control bindings; declare the constraint in the schema

`[formField]` claims a fixed set of control bindings and feeds them itself: `disabled`,
`disabledReasons`, `dirty`, `errors`, `hidden`, `invalid`, `max`, `maxLength`, `min`,
`minLength`, `name`, `pattern`, `pending`, `readonly`, `required`, `touched`. Binding any of them
by hand on the same element is a **compile error**, not a warning:

```
NG8022: Binding to '[maxLength]' is not allowed on nodes using the '[formField]' directive
```

So `maxLength(path.postalCode, 5)` goes in the schema, and the directive carries it down to the
input's `maxlength` attribute **and** to the numeric `Field`'s digit truncation — one declaration
driving both.

**A custom control may not have a public member named after any of those sixteen keys**, even
meaning something unrelated. This is the sharper half: `PhoneField`'s advisory "this number looks
incomplete" flag cannot be called `invalid`, because `invalid` is owned, and it carries the name
`incomplete` instead. Check a control's public members against the list before adding
`[formField]` support, and re-read the list from
`apps/web/node_modules/@angular/forms/fesm2022/signals.mjs` rather than from memory — it is
version-specific. Full detail: [[2026-09-10-formfield-owns-its-control-bindings-ng8022]].

## Rule 10 — a field that formats as you type is a `FormValueControl`, not a raw `<input>`

`[formField]` registers **its own** DOM `input` listener and re-reads the element's raw value on
every event. An `<input>` whose `(input)` handler sanitises by rewriting `element.value` is
therefore in a race with that listener, and the **unsanitised** value can win — the handler runs,
but field state may already hold the pre-rewrite value, and the request is built from field
state.

A custom control implementing `FormValueControl` is safe by construction: it sanitises **before**
setting its own `value` model, so there is no raw DOM read to race. `Field`, `PhoneField`, and
`StreetAutocomplete` (`apps/web/src/app/shared/ui/`) are all this shape — `value` is a `model()`,
never an `input()`, and re-typing it breaks every `[formField]` binding silently.

- **Prefer a `FormValueControl`** for any field needing as-you-type formatting.
- **When a formatted field must stay a raw `<input>`, make its handler the single writer** and
  let the schema validate what the handler has already written — never add a second sanitisation
  point.

This is specifically a native-element problem; it does not generalise into "Signal Forms fights
sanitisation". Full detail, including the OTP and card-number cases:
[[2026-09-10-formfield-reads-the-raw-dom-value]].

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
- [[2026-09-04-web-gateway-integration-design]] — phase 2, whose new `core/` code (HTTP client,
  auth interceptors, session store, API services) follows this convention, and the source of
  Rules 4–6 above (`ApiClient` path prefix, interceptor order, guard rehydration).
- [[web-gateway-integration-milestone]] — the milestone that established Rules 4–6.
- [[2026-09-03-unstyled-custom-element-host-is-inline]] — the lesson behind Rule 3: the
  incident detail, measured evidence, and why the bug reads as content misalignment rather
  than a sizing defect.
- [[2026-09-03-cart-drawer-scrim-lead-flicker]] — a lesson from the shared enter/leave
  animation classes in `styles.css` (the ones this app's components apply from outside, per
  `[data-deferred-enter]`): the `animation` shorthand resets `animation-play-state`, so a pause
  rule's effect on same-specificity selectors depends on declaration order unless it uses
  `!important`.
- [[2026-09-03-cart-drawer-first-open-flicker]] — the `DeferEnterAnimation` host directive
  (`apps/web/src/app/core/overlay/defer-enter-animation.ts`) this app uses to hold an overlay's
  enter animation until its first frame is actually presented, and why its deferred flag must
  be a `signal` rather than a plain field.
- [[2026-09-10-signal-forms-required-accepts-whitespace]] — the lesson behind Rule 8: the
  incident, the `isEmpty()` source evidence in the installed Angular, and the mutation check
  that distinguishes a real regression test from an inert one.
- [[2026-09-10-formfield-reads-the-raw-dom-value]] — the lesson behind Rule 10: `[formField]`
  registers its own `input` listener and takes the element's raw value, so a sanitising
  `(input)` handler races it rather than filtering it, and a `FormValueControl` removes the race
  by construction.
- [[2026-09-10-formfield-owns-its-control-bindings-ng8022]] — the lesson behind Rule 9: the
  sixteen owned control bindings, the NG8022 compile error, and the custom-control member that
  collides on name alone.
