---
title: "The animation shorthand resets animation-play-state, so a pause rule's effect depends on declaration order"
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
  - "[[2026-09-03-animation-clock-sampling-beats-style-and-class-probes]]"
  - "[[2026-09-03-unstyled-custom-element-host-is-inline]]"
  - "[[2026-09-03-cart-drawer-first-open-flicker]]"
---

# The animation shorthand resets animation-play-state, so a pause rule's effect depends on declaration order

## Finding

The `animation` **shorthand resets every longhand property it covers**, including
`animation-play-state`, back to its initial value of `running`. Combined with equal selector
specificity, that makes a separate "stay paused until the first frame is presented" rule work
or silently not work purely based on where it sits in the stylesheet relative to the classes it
is meant to pause.

In `apps/web/src/styles.css`, the declaration order was:

| line | rule |
|---|---|
| 339 | `.drawer-enter { animation: 180ms … }` |
| 360 | `[data-deferred-enter] { animation-play-state: paused }` |
| 368 | `.scrim-enter { animation: 180ms … }` |

All three selectors have the same specificity (0,1,0), so CSS cascade order — later wins —
decides the outcome. `.drawer-enter` is declared *above* the pause rule, so the pause rule's
`animation-play-state: paused` is the last word for it and it stays paused as intended.
`.scrim-enter` is declared *below* the pause rule: its `animation` shorthand runs after the
pause rule and resets `animation-play-state` back to `running`, silently un-pausing itself.

Proven in isolation, outside the app, with two identical `<div>`s carrying the same
`data-deferred-enter` attribute and differing only in whether their class rule is declared
before or after the pause rule:

```json
{ "beforeDeclared": "paused", "afterDeclared": "running" }
```

## The symptom, and why it took three attempts

The user reported a flicker opening the cart drawer: the dark backdrop (scrim) visibly arrived
before the white drawer panel covered it. Measured per presented frame — see
[[2026-09-03-animation-clock-sampling-beats-style-and-class-probes]] for why frame-gated
sampling was the probe that could show this at all — the scrim led the drawer by roughly 12
points of opacity for the entire 180ms:

```
+  0ms  scrim=0.07  host=0.00
+ 17ms  scrim=0.21  host=0.07
+ 43ms  scrim=0.42  host=0.29
```

Two earlier fixes in this same area of `styles.css` were real but addressed different defects
(a first-open deferred-start issue, and a transformed host growing the document). The leading
hypothesis for *this* symptom — that the scrim and the drawer panel simply mount at different
instants, since the scrim mounts in `shell.html` and the drawer mounts in `home.html` — was
**refuted by measurement**: the two elements mounted 2.3ms apart, in the same frame, and both
received the `data-deferred-enter` attribute at mount. Unifying where they mount would have
fixed nothing. Nothing about the component tree was involved; the defect was purely CSS
declaration order interacting with a shorthand property reset, on two selectors of identical
specificity.

## The fix

`animation-play-state: paused !important` on the `[data-deferred-enter]` rule. `!important` is
required, not cosmetic: without it the pause only binds on classes declared *above* the rule,
and reordering the stylesheet is not a durable fix either — the next `*-enter` class added
below the pause rule reintroduces the exact same bug, silently, with no test or linter able to
catch a declaration-order regression in a plain CSS file.

After the fix, the opacity gap between scrim and drawer is 0.000 on every sampled frame.

## How to apply

- **Any shared "pause until ready" rule that targets classes setting the `animation` shorthand
  must use `!important` on the longhand it needs to survive** (here,
  `animation-play-state`) — the shorthand silently resets every longhand it covers, including
  ones the shorthand declaration never mentions by name.
- **Do not rely on declaration order to make a CSS pause/override rule apply to same-specificity
  selectors.** It happens to work for whichever selectors are declared above it and happens to
  silently fail for whichever are declared below — and a new selector added later, above or
  below, changes the outcome without touching the rule itself.
- **When two elements meant to animate in lockstep visibly drift, check for a shorthand
  resetting a longhand before investigating mount timing or component structure.** The natural
  first hypothesis — two elements mounting from different places in the component tree — was
  measured and ruled out here; the actual cause was one CSS rule undoing another via the
  cascade, not anything about *when* or *where* the elements appeared in the DOM.

## Related

- [[angular-component-authoring]] — the frontend component conventions `apps/web/` follows;
  the animation classes involved here are the shared, globally-declared enter/leave classes
  this note's Rule 3 discussion sits beside.
- [[2026-09-03-animation-clock-sampling-beats-style-and-class-probes]] — the probe discipline
  from the same milestone that produced the frame-by-frame opacity measurement above; without
  it, the 12-point lead would not have been visible as a defect at all.
- [[2026-09-03-unstyled-custom-element-host-is-inline]] — a sibling lesson from the same
  milestone: another animation-adjacent bug that presented one level away from its real cause,
  the same shape of trap as blaming mount timing here instead of the CSS cascade.
- [[2026-09-03-cart-drawer-first-open-flicker]] — the sibling defect that motivated the same
  `[data-deferred-enter]` descendant-pause rule this note's fix lives on; that note covers why
  the pause exists at all, this one covers why it didn't reliably apply.
