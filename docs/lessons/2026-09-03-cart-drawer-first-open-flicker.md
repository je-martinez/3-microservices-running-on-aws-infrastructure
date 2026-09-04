---
title: "A freshly mounted element's first animation frame can miss its deadline, and the fix must resume from a zone-tracked signal"
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
  - "[[2026-09-03-cart-drawer-scrim-lead-flicker]]"
---

# A freshly mounted element's first animation frame can miss its deadline, and the fix must resume from a zone-tracked signal

## Finding

The first time the cart drawer opened on a page load, it flickered: the panel appeared to jump
a fifth of the way through its motion instead of starting cleanly from its rest pose. Later
opens in the same session looked correct.

An animation's clock (`animation.currentTime`) starts counting the instant the CSS class that
triggers it lands on the element — not the instant the element is actually presented on screen.
For a freshly mounted element the browser still has to do one-time work (styling, layout,
rasterizing new compositor layers) before the first frame reaches the screen, and that work can
take longer than one frame interval. By the time anything is actually painted, the animation
clock has already advanced 25-33ms of its 180ms duration — the motion visibly begins a third of
the way in, which reads as a flicker/jump-cut rather than a clean reveal. Later opens reuse
already-established layers, so the same mount-to-present gap shrinks to ~8ms, close enough to
zero to look correct — which is why the defect is a **first-open-only** bug and easy to miss if
testing always starts from an already-warm page.

## The fix

A host directive (`DeferEnterAnimation`, `apps/web/src/app/core/overlay/defer-enter-animation.ts`)
holds the element's enter animation paused via a `[data-deferred-enter]` attribute, waits for
**two** `requestAnimationFrame` callbacks (the first callback runs before the frame it belongs to
is actually composited; only the second lands after the element has genuinely reached the
screen), then clears the attribute and resets `animation.currentTime = 0` in that same callback
before resuming. Resetting the clock is required in addition to resuming: resuming alone
continues an animation whose `currentTime` already advanced through the missed frame, which is
the very jump the fix is meant to remove.

The pause rule has to target the animating **descendant** too, not only the element carrying the
`data-deferred-enter` attribute — the drawer host fades while its panel child slides, and
pausing only the host leaves the slide running, reaching a fifth of its distance before the fade
even starts. (This descendant-pause CSS rule is also the rule at the center of a sibling defect,
[[2026-09-03-cart-drawer-scrim-lead-flicker]]: the `animation` shorthand resets
`animation-play-state`, so the pause only reliably binds above it in the cascade unless it
carries `!important`.)

## The subtlety that broke the fix once: a signal, not a plain field

The deferred flag driving `[data-deferred-enter]` must be an Angular `signal`, not a plain class
field. The unpause runs inside a raw `requestAnimationFrame` callback, which executes **outside
Angular's zone**. Setting a plain field from outside the zone schedules no change detection, so
the template binding driven by that field never re-evaluates: the `data-deferred-enter` attribute
never actually clears, the animation stays paused forever, `animationend` never fires (Angular
relies on it to remove the enter class), and the scrim is left permanently covering the page,
silently swallowing every click underneath it. A `signal` write, by contrast, notifies its
consumers directly regardless of which zone the write happened in, so the binding updates
correctly even from inside a raw `rAF` callback.

## Why the obvious probes miss it

- **`getComputedStyle()` sampled per frame** interpolates correctly whether or not a given frame
  was ever actually painted — it reports the animation's mathematically correct value at sample
  time, which is smooth even during the stall. It cannot see a dropped/delayed frame, because a
  dropped frame is a presentation failure, not a value-computation failure.
- **`MutationObserver` on the `class` attribute** fires only twice in the element's life (mount,
  cleanup on `animationend`), roughly 180ms apart. Reading two adjacent log rows as two adjacent
  moments in a continuous transition is the trap: the rows are adjacent in the log, not in the
  animation.

The measurement that does discriminate — `animation.currentTime` sampled inside
`requestAnimationFrame`, so only frames the compositor actually presented are ever seen — and the
general principle behind it are recorded in
[[2026-09-03-animation-clock-sampling-beats-style-and-class-probes]]; this note covers the
specific defect that probe uncovered, not the probe technique itself.

## How to apply

- **An element's first animation after mount needs a presentation-gated start**, not a
  class-triggered one, if the mount does one-time layout/rasterization work — pause, wait for a
  genuinely presented frame (two `requestAnimationFrame` callbacks, not one), reset the clock,
  then resume.
- **Any state driving a template binding that is written from outside Angular's zone (a raw
  `requestAnimationFrame` callback, a native event listener added imperatively, etc.) must be a
  `signal`, not a plain field** — a plain field's write schedules no change detection and the
  binding silently goes stale, which for an overlay's dismiss condition means the overlay gets
  stuck open, permanently intercepting clicks.
- **Test a first-open-only defect against a cold, freshly mounted element**, not a
  previously-opened one in the same session — the mount-to-present gap that causes this defect
  shrinks dramatically on later opens once layers are already established, so a warm-page test
  passes even when the fix is broken or absent.

## Related

- [[angular-component-authoring]] — the frontend component conventions this animation belongs to
  (`apps/web/`), including the global enter/leave animation classes this fix's CSS lives beside.
- [[2026-09-03-animation-clock-sampling-beats-style-and-class-probes]] — the probe discipline
  (sample `animation.currentTime` inside `requestAnimationFrame`) that exposed this defect; that
  note covers the general measurement technique, this one covers the specific mount-timing
  defect and its fix.
- [[2026-09-03-cart-drawer-scrim-lead-flicker]] — a sibling cart-drawer animation lesson from the
  same milestone: the descendant pause rule this defect's fix relies on is also the rule whose
  `animation-play-state` gets silently reset by the `animation` shorthand, addressed there.
