---
title: "Signal Forms' required() accepts whitespace, so it is weaker than the .trim() guard it replaces"
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
  - "[[2026-09-10-formfield-reads-the-raw-dom-value]]"
  - "[[2026-09-10-formfield-owns-its-control-bindings-ng8022]]"
  - "[[angular-component-authoring]]"
  - "[[testing]]"
---

# Signal Forms' required() accepts whitespace, so it is weaker than the .trim() guard it replaces

## Finding

Angular Signal Forms' `required()` validator treats a value of nothing but spaces as **present**.
Verified against the installed Angular **22.1.6** in `apps/web/node_modules` — not from
documentation:

`node_modules/@angular/forms/fesm2022/signals.mjs:78`

```js
function isEmpty(value) {
  if (typeof value === 'number') {
    return isNaN(value);
  }
  return value === '' || value === false || value == null;
}
```

`"   "` is not `''`, not `false`, not `null` and not `undefined`, so `isEmpty` returns `false`
and `required()` is satisfied. (The `number` branch adds `NaN`; it does not apply to text
fields.)

## Why it bites — the migration looks like a faithful translation

The code being migrated to Signal Forms on 2026-09-10 guarded submission with an explicit
whitespace-aware check:

```ts
fullName().trim().length > 0
```

Replacing that with `required(path.fullName)` **compiles, and passes every existing test**. It
also silently allows registering a user whose name is three spaces, or saving a delivery
address whose street is three spaces — an address that ships nowhere.

That is exactly what makes it dangerous in review: the diff reads as a one-for-one swap of a
hand-rolled guard for the framework's canonical validator, which is the whole point of the
migration. Nothing in the diff signals that the framework's notion of "empty" is *narrower*
than the one being removed. `.trim().length > 0` and `required()` look equivalent and are not.

## The fix — pair every gating `required` with a non-whitespace `pattern`

```ts
required(path.fullName, { message: '…' });
pattern(path.fullName, /\S/, { message: '…' });
```

`\S` demands at least one non-whitespace character, restoring what `.trim()` enforced.

Applied in this repo wherever a `required` **gates submission** — as of 2026-09-10 that is
register-password, register-passwordless, set-new-password, profile (`fullName`) and
checkout-payment (`street`, `city`).

## The regression test can pass for the wrong reason

The first attempt at a test for this filled **both** the name and the email with spaces and
asserted the submit was blocked. It passed — and kept passing with the `pattern` removed.

Cause: an `<input type="email">` reports `""` for a value the browser considers invalid, so
`"   "` typed into the email field arrives at the model as the empty string. The submit was
blocked by the **empty email**, never by the blank name. The assertion was true for a reason
that had nothing to do with the code under test.

**The rule this yields:** a regression test for one field's validation must hold **every other
field valid**, so the field under test is the only thing that can block submission. Otherwise
any co-occurring failure satisfies the assertion and the test is inert.

Verified by mutation: with every other field valid, removing the `fullName` pattern now **fails**
the spec. That mutation check is what proves the test tests anything — running it once is
cheap, and it is the only thing that distinguishes this test from the first one.

## How to apply

- **Never replace a `.trim()`-based guard with a bare `required()`.** If the old guard rejected
  whitespace, the new schema needs `pattern(path.x, /\S/)` alongside `required(path.x)`.
- **Audit the direction of the change, not just its shape.** When a migration swaps a hand-rolled
  check for a framework validator, ask what the framework's version accepts that the old one
  rejected — a validator that is merely *different* passes review as if it were *equivalent*.
- **Write the regression test with all other fields valid, then delete the validator and confirm
  the test goes red.** A validation test that has never been seen to fail proves nothing.

## Related

- [[2026-09-10-formfield-reads-the-raw-dom-value]] — sibling trap from the same Signal Forms
  migration: `[formField]` taking the unsanitised DOM value into field state.
- [[2026-09-10-formfield-owns-its-control-bindings-ng8022]] — sibling trap from the same
  migration: constraints must be declared in the schema, not bound on the element.
- [[angular-component-authoring]] — the convention read before writing or migrating an Angular
  component in `apps/web/`; this rule belongs in the same pass.
- [[testing]] — the three-layer testing convention; this failure is invisible at every layer
  unless the unit test isolates the field under test.
