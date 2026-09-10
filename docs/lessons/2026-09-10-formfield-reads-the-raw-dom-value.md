---
title: "[formField] on a native input reads the RAW DOM value, racing any sanitising (input) handler"
type: lesson
area: shared
status: active
created: 2026-09-10
updated: 2026-09-10
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/high
related:
  - "[[2026-09-10-signal-forms-required-accepts-whitespace]]"
  - "[[2026-09-10-formfield-owns-its-control-bindings-ng8022]]"
  - "[[angular-component-authoring]]"
---

# [formField] on a native input reads the RAW DOM value, racing any sanitising (input) handler

## Finding

Angular Signal Forms' `[formField]` directive registers **its own** DOM `input` listener and
takes the element's raw value into the field state. Verified against the installed Angular
**22.1.6** in `apps/web/node_modules`:

`node_modules/@angular/forms/fesm2022/signals.mjs:1097`

```js
host.listenToDom('input', () => parser.setRawValue(undefined));
```

So the directive is not a passive observer of a value the component curates — on every `input`
event it goes back to the element and re-reads what is actually in the DOM.

## Why it bites

Any `<input>` whose own `(input)` handler sanitises by **rewriting `element.value`** is now in a
race with that listener, and the **unsanitised** value can win.

Concretely, in this repo's OTP field: typing `12a34b` could reach the request even though the
component's handler strips letters. The handler does run and does rewrite `element.value`, but
`[formField]`'s listener may already have read the pre-rewrite value into field state, and the
request is built from field state.

The affected shapes are all the "format as you type" ones:

- OTP digit-stripping (`apps/web/src/app/features/auth/verify-code.ts`)
- card-number grouping, expiry and CVC (`apps/web/src/app/features/checkout/checkout-payment.ts`)
- digits-only numeric fields

## IMPORTANT — this is only a raw `<input>` + `[formField]` problem

A **custom control implementing `FormValueControl`** is safe. Our `Field`
(`apps/web/src/app/shared/ui/field.ts`), `PhoneField` (`…/phone-field.ts`) and
`StreetAutocomplete` (`…/street-autocomplete.ts`) all sanitise **before** setting their own
`value` model, so there is no raw DOM read to race — the control publishes an already-clean
value and the directive takes that.

Do not generalise this lesson into "Signal Forms fights sanitisation". It is specifically the
combination of a **native element**, `[formField]` on that element, and a handler that mutates
`element.value` after the fact.

## Resolution used in this repo

Keep those raw `<input>` elements and their formatting handlers as the **only** path into the
model, and let the schema validate what the handler has already written. Submission gating moves
from a hand-rolled check to the schema's own verdict — e.g. `canSubmit` became:

```ts
codeForm().valid()
```

Applies to verify-code's OTP and checkout-payment's card number, expiry and CVC.

## How to apply

- **Before putting `[formField]` on a native `<input>`, check whether that input has an `(input)`
  handler that writes back to `element.value`.** If it does, do not let both own the value.
- **Prefer a `FormValueControl` custom control** when a field needs as-you-type formatting — it
  sanitises before publishing its `value`, which removes the race by construction.
- **When a formatted field must stay a raw `<input>`, make the handler the single writer** and
  let the schema validate the result rather than adding a second sanitisation point.

## Related

- [[2026-09-10-signal-forms-required-accepts-whitespace]] — sibling trap from the same Signal
  Forms migration, and the one that shipped a real regression.
- [[2026-09-10-formfield-owns-its-control-bindings-ng8022]] — sibling trap: the same directive's
  ownership of control bindings, which is why constraints move into the schema.
- [[angular-component-authoring]] — the convention read before writing or migrating an Angular
  component in `apps/web/`, including the `FormValueControl` custom controls in `shared/ui`.
