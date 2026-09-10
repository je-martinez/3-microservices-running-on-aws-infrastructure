---
title: "[formField] owns a fixed set of control bindings; binding one by hand is a compile error (NG8022)"
type: lesson
area: shared
status: active
created: 2026-09-10
updated: 2026-09-10
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
related:
  - "[[2026-09-10-signal-forms-required-accepts-whitespace]]"
  - "[[2026-09-10-formfield-reads-the-raw-dom-value]]"
  - "[[angular-component-authoring]]"
---

# [formField] owns a fixed set of control bindings; binding one by hand is a compile error (NG8022)

## Finding

`[formField]` claims a fixed set of control bindings and feeds them itself. Verified against the
installed Angular **22.1.6** in `apps/web/node_modules`:

`node_modules/@angular/forms/fesm2022/signals.mjs:774` — `FIELD_STATE_KEY_TO_CONTROL_BINDING`

```js
const FIELD_STATE_KEY_TO_CONTROL_BINDING = {
  disabled: 'disabled',
  disabledReasons: 'disabledReasons',
  dirty: 'dirty',
  errors: 'errors',
  hidden: 'hidden',
  invalid: 'invalid',
  max: 'max',
  maxLength: 'maxLength',
  min: 'min',
  minLength: 'minLength',
  name: 'name',
  pattern: 'pattern',
  pending: 'pending',
  readonly: 'readonly',
  required: 'required',
  touched: 'touched'
};
```

Binding any of those by hand on the same element is a **compile error, not a warning**:

```
NG8022: Binding to '[maxLength]' is not allowed on nodes using the '[formField]' directive
```

## Consequence 1 — constraints are declared in the schema, not on the element

The constraint moves into the schema, and the directive carries it back down:

```ts
maxLength(path.postalCode, 5);
```

From there `[formField]` feeds it into the control, where it reaches the input's `maxlength`
attribute **and** our numeric `Field`'s digit truncation — so one declaration drives both the
native constraint and the component's own formatting. Nothing is lost by not binding it by hand;
the schema is simply the single place it is stated.

Because this is a compile error rather than a warning, it is a cheap trap: it cannot ship. The
cost is only the surprise of a template that was correct before the migration failing to build
after it.

## Consequence 2 — a custom control cannot have its own unrelated `invalid` member

`invalid` is in the owned set above, so a `FormValueControl` custom control may not define an
`invalid` input of its own meaning something else.

`PhoneField` (`apps/web/src/app/shared/ui/phone-field.ts`) had exactly that: an advisory
"this number looks incomplete" warning, unrelated to schema validity. It had to be renamed to
`incomplete`.

This is the sharper half of the lesson, because it is a **naming collision with a framework
concept**, not a duplicate binding — the member was legitimate and had nothing to do with form
validity. Any custom control carrying a member named after one of those sixteen keys will
collide the same way.

## How to apply

- **Never bind `disabled`, `disabledReasons`, `dirty`, `errors`, `hidden`, `invalid`, `max`,
  `maxLength`, `min`, `minLength`, `name`, `pattern`, `pending`, `readonly`, `required` or
  `touched` on an element that also has `[formField]`.** Declare the constraint in the schema.
- **Check a custom control's public members against that list before adding `[formField]`
  support.** A member that merely shares a name with an owned binding collides, regardless of
  what it means; rename it (as `PhoneField.invalid` → `incomplete`).
- **Re-read the list from the installed source rather than from memory** — it lives at
  `node_modules/@angular/forms/fesm2022/signals.mjs:774` and is version-specific.

## Related

- [[2026-09-10-signal-forms-required-accepts-whitespace]] — sibling trap from the same Signal
  Forms migration, and the only one of the three that shipped a real regression.
- [[2026-09-10-formfield-reads-the-raw-dom-value]] — sibling trap: the same directive's own DOM
  listener racing a sanitising `(input)` handler on a native element.
- [[angular-component-authoring]] — the convention read before writing or migrating an Angular
  component in `apps/web/`, including the `shared/ui` custom controls this constrains.
