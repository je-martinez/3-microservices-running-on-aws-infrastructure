---
title: "Only requestAnimationFrame-sampled animation.currentTime exposes a dropped frame; class and computed-style probes both miss it"
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
  - "[[2026-09-03-unstyled-custom-element-host-is-inline]]"
  - "[[2026-09-03-cart-drawer-scrim-lead-flicker]]"
  - "[[testing]]"
  - "[[2026-08-14-counter-metrics-need-a-clock-and-a-window]]"
---

# Only requestAnimationFrame-sampled animation.currentTime exposes a dropped frame; class and computed-style probes both miss it

## Finding

A user reported a flicker on the first reveal of the cart drawer. Diagnosing it took three
probes; two were misleading and pointed the investigation at the wrong element, and only the
third — sampling the running animation's own clock inside `requestAnimationFrame` — showed the
real defect.

### Misleading probe 1 — `MutationObserver` on the host's `class` attribute

```
0: cls="block drawer-enter"  op=0  transform=matrix(1,0,0,1,24,0)
1: cls="block drawer-enter"  op=1  transform=none
2: cls="block"               op=1  transform=none
```

Read naively, this looks like the transform snapping from `24px` to `none` mid-flight — two
adjacent log rows a frame apart. It is not that. The `class` attribute changes exactly twice in
the element's life: once when the `drawer-enter` class lands at mount, once when Angular removes
it on `animationend`. So the three rows are *mount, cleanup, cleanup*, roughly 180ms apart — row
1 is the animation legitimately **at its end**, not mid-transition. A mutation-sampled probe
structurally cannot observe interpolation, because the attribute being mutated (`class`) is not
the property being animated (`transform`/`opacity`). Reading two adjacent log rows as two
adjacent moments in time is the trap — the rows are adjacent in the log, not in the animation.

### Misleading probe 2 — computed style sampled per frame

Sampling `getComputedStyle()` every frame showed the transform interpolating smoothly
(15.6px → 1.04px) and opacity sweeping cleanly — i.e., it reported nothing was wrong. Computed
style reflects where the animation's clock currently says it should be, and interpolates
correctly whether or not that frame was ever actually composited and presented to the screen. It
cannot see a dropped frame, because a dropped frame is a presentation failure, not a value
computation failure.

### Decisive probe — `animation.currentTime` sampled inside `requestAnimationFrame`

`requestAnimationFrame` only fires for frames the compositor actually presents. Sampling the
Web Animations API's `animation.currentTime` from inside it means a missed frame leaves a visible
hole in the samples, and the clock jumps across it:

```
open #1: first=0    maxJump=25.0   head=[0, 25, 33, 41.6, 49.9]
open #2: first=7.7  maxJump=9.0    head=[7.7, 16.7, 25, 33.4, 41.7]
```

This exposed the real defect: on the **first** open of a page load, the animation's own clock had
already burned 25-33ms of its 180ms duration before anything reached the screen — the motion
visibly begins a third of the way in, which reads as a flicker/jump-cut rather than a clean
reveal. Later opens (#2 onward) started at ~8ms, close enough to zero to look correct. The
mechanism was a dropped/delayed first frame, not a broken transform or a wrong `justify-*`/timing
value — nothing an attribute or a computed-style probe could have shown, because both only report
what the animation's math says, never whether the browser painted it.

## Why this generalizes

Each probe answers a different question, and only one of the three answers "did the user's eye
actually see a discontinuity":

| Probe | What it observes | Can it see a dropped frame? |
|---|---|---|
| `MutationObserver` on `class`/attributes | Discrete state changes (mount, cleanup) | No — samples a different property than the one animating, and only twice total |
| `getComputedStyle()` per frame | The animation's computed value at sample time | No — the value is always mathematically correct even when the frame never painted |
| `animation.currentTime` inside `requestAnimationFrame` | The animation's clock, sampled only on frames the compositor presented | Yes — a missed frame shows up as a jump in the clock between two `rAF` calls |

The general rule: **to verify a browser animation renders smoothly, sample the thing whose
job is to run once per presented frame (`requestAnimationFrame`), reading the animation's own
clock (`Animation.currentTime`) — not a proxy signal (a DOM mutation) and not a value that is
correct independent of whether it was ever painted (computed style).** A probe that is
technically watching "the animation" can still be structurally blind to the one failure mode
that matters (a dropped or delayed frame) if it doesn't gate on presentation.

## Second lesson — a before/after animation comparison needs a fresh page per sample

The first-open vs. second-open numbers above came from measuring **within the same page load**:
open #1 is the drawer's first reveal since navigation, open #2 is a later reveal in that same
session. Comparing "before the fix" and "after the fix" only ever by reopening the drawer on an
already-loaded page compares warm state to warm state and hides exactly the defect that only
shows up on a cold first paint — any fix looks like it worked, because the comparison never
exercises the condition that was broken. Each sample needs its own fresh page load (a real
navigation or reload, not a second open in the same session), or the measurement is an artifact
of which open you happened to compare, not evidence the fix works.

This is the same family of mistake as
[[2026-08-14-counter-metrics-need-a-clock-and-a-window#Finding 3 — OpenObserve has no dashboard time-range variable|measuring inside too narrow or too convenient a window]]:
a measurement taken at a moment chosen for convenience rather than for what it needs to cover
reports a number that looks like a result while actually describing an artifact of when the
sample was taken.

## How to apply

- **When a suspected animation defect needs verification, sample `animation.currentTime` inside
  `requestAnimationFrame`**, not `MutationObserver` on class/attributes and not per-frame
  `getComputedStyle()`. Look for jumps in the clock between consecutive `rAF` calls — a jump
  larger than the expected frame interval (~16.7ms at 60fps) means a frame was dropped or
  delayed, and a jump early in the sequence explains a visible flicker/jump-cut on reveal.
- **Treat a `class`/attribute-mutation probe as a probe of discrete lifecycle events only**
  (mount, cleanup) — never read two adjacent rows in such a log as two adjacent moments in a
  continuous transition.
- **Treat a clean computed-style sweep as inconclusive, not as a pass.** It rules out a broken
  transform/opacity definition; it does not rule out a dropped frame.
- **Test a first-paint-only defect across a fresh page load per sample**, not by reopening the
  same element twice in one already-warm session — a page reload/navigation between "before" and
  "after" samples, or the comparison silently only measures the warm case.

## Related

- [[angular-component-authoring]] — the frontend component conventions this animation belongs to
  (`apps/web/`); a natural place to point future animation work at this lesson.
- [[2026-09-03-unstyled-custom-element-host-is-inline]] — a sibling frontend misdiagnosis lesson
  from the same milestone: a bug that presented one level away from its real cause (host
  `display`, not children's alignment classes), the same shape of trap as reading the wrong
  probe here.
- [[2026-09-03-cart-drawer-scrim-lead-flicker]] — the defect this probe discipline uncovered:
  the frame-by-frame opacity measurement in that note is what made the scrim/drawer lead
  visible as a real defect rather than noise.
- [[testing]] — this repo's testing-method conventions; the measurement-window pitfall below
  is the same family as this note's "verify across a full cycle" guidance for metrics.
- [[2026-08-14-counter-metrics-need-a-clock-and-a-window]] — an unrelated system (OpenObserve
  counter metrics) hitting the same underlying mistake: a measurement window chosen for
  convenience instead of for what it needs to cover.
