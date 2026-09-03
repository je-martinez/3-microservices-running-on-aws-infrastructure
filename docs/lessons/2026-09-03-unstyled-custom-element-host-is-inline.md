---
title: "Unstyled Angular custom elements default to display:inline, collapsing w-full template roots"
type: lesson
area: shared
status: active
created: 2026-09-03
updated: 2026-09-03
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
related:
  - "[[angular-component-authoring]]"
  - "[[2026-08-17-web-app-foundation-design]]"
  - "[[pencil-design-extraction]]"
  - "[[2026-09-03-cart-drawer-scrim-lead-flicker]]"
---

# Unstyled Angular custom elements default to display:inline, collapsing w-full template roots

## Finding

Angular renders every component as a custom element (`<app-cart-line>`, `<app-field>`, …), and
a custom element with no explicit `display` is `display: inline` by default — the same as
`<span>`. An inline element shrink-wraps to its content's intrinsic size and ignores width
rules applied *inside* it. So when a component's template root carries `w-full`, that class
resolves against the box the *host* actually has, not the box the caller intended: as a flex
item, the collapsed inline host takes only as much width as its content needs, and `w-full`
inside it means "100% of that already-too-narrow box," not "100% of the flex row."

This hit three components before the fix location was corrected:

| Component | Symptom | Fixed in |
|---|---|---|
| `app-header` (`apps/web/src/app/core/layout/app-header.ts:24`) | 667px bar on a 1440px viewport | `dca6026` |
| `app-cart-line` (`apps/web/src/app/shared/ui/cart-line.ts:24`) | cart prices not sharing a right edge; also broken in the checkout order summary | `cea812a` |
| `app-field` (`apps/web/src/app/shared/ui/field.ts:18`) | profile's Address input 304px inside a 710px row | `cea812a` |

`app-order-card` and `app-product-card` were audited afterward and found clean.

## Why it is hard to spot

It presents one level in, as a *content alignment* bug, not a layout/sizing bug. In the cart it
looked like prices failing to line up, which sends the eye to `justify-between` and to the
design frames — neither of which was wrong. It was misdiagnosed exactly that way once already:
a fix was briefed against `justify-between` and the frames before the running app was measured
and the real cause — the host element's own `display` — was found instead. The bug is one level
above where the diagnosis instinctively goes, because "things aren't aligned" reads as a
flex/grid problem on the *children*, when the actual defect is the *host's* box.

Measured evidence, cart drawer at 1440x900, before the fix:

```
price      price right    row right
$89.00     1260.94        1260.94
$149.00    1318.70        1318.70
$24.00     1260.76        1260.76

app-cart-line   width 236.94   display: inline   (host)
  parent div    width 440      flex flex-col items-start
```

The rows had different right edges — each host's width was whatever its own content needed,
not the parent's 440px. After the fix, all three prices share one right edge at 1416, and every
host measures 392 of 392.

## The fix, and why it goes on the component, not the call site

`host: { class: 'block w-full' }` in the component's `@Component` decorator — not `w-full` (or
similar) added at each place the component is used.

**Why the host, not the call site:** a call site added later has no way to know the component
needs help. If the fix lives at the call site, every *new* usage silently reproduces the bug
until someone happens to notice the same alignment symptom again and re-derives the same root
cause. If the fix lives on the component, the component is correct everywhere it is used,
including places that don't exist yet. This is also why a comment recording the mechanism
inside one component's source (as `app-header`'s `dca6026` fix did) didn't stop the same defect
recurring in `app-cart-line` and `app-field` — a comment in file A cannot warn the author of
file B. The rule has to live somewhere read *before* writing a new component, which is what
[[angular-component-authoring]] is for.

## How to apply

- **Any Angular component whose template root uses `w-full`, `h-full`, or otherwise expects to
  fill its parent must declare `host: { class: 'block w-full' }`** (or the equivalent block
  display) in its `@Component` decorator, so the fix travels with the component rather than
  needing to be rediscovered at each call site.
- **When a layout/alignment bug looks like a `justify-*` or spacing problem, measure the actual
  rendered box widths of the components involved before touching Tailwind alignment classes.**
  `getBoundingClientRect()` (or the browser inspector) on the custom-element host itself is the
  fast way to confirm whether the host collapsed to `inline` — if the host's width doesn't match
  its parent's, the bug is the host's `display`, not the children's alignment classes.
- **Audit new shared-UI components for this pattern once, not per-incident.** `app-order-card`
  and `app-product-card` were checked and are clean; any new `shared/ui` component should be
  checked at the point it's written, per [[angular-component-authoring]], rather than waiting
  for a visible symptom.

## Related

- [[angular-component-authoring]] — the convention note this lesson feeds; carries the concrete
  rule (`host: { class: 'block w-full' }`) so it is read before a new component is written,
  not only recorded after the third incident.
- [[2026-08-17-web-app-foundation-design]] — the design spec `apps/web/` was built from; the
  frames and `justify-between` layout this bug was initially, incorrectly, blamed on.
- [[pencil-design-extraction]] — the extraction workflow that produces these components from
  Pencil frames; relevant because the misdiagnosis path (frames look right, alignment classes
  look right) starts from its output looking correct on inspection.
- [[2026-09-03-cart-drawer-scrim-lead-flicker]] — a sibling lesson from the same milestone: a
  different cart-drawer animation defect that also presented one level away from its real
  cause (CSS cascade order, not component mount timing).
