---
title: Headed Browser Consent
type: convention
area: shared
status: active
created: 2026-09-04
updated: 2026-09-04
tags: [type/convention, area/shared, status/active]
related:
  - "[[testing]]"
  - "[[2026-09-03-animation-clock-sampling-beats-style-and-class-probes]]"
---

# Headed Browser Consent

## Rule

**Never open a browser window for a frontend check without asking the user first.** This
applies every time — a full E2E suite run and a one-off manual probe are treated identically.
The user must be able to accept or decline **before** any window appears, not after.

When they accept, the window opens on the monitor they chose: the **built-in display**, origin
`0,0`, size 1512x982 points — their main screen, chosen deliberately over the two externals.

## Why the rule exists

Playwright windows steal focus, can land on an unpredictable monitor, and interrupt whatever the
user is doing on their machine. Four specs in this repo launch headed browsers
(`cart-drawer-animation`, `popover-overflow`, `scrollbar-gutter`, `cart-drawer-first-open`), so a
plain suite run pops several windows with no warning.

The user raised this three times over two days (2026-09-02 to 2026-09-04) before it was handled
correctly. Two attempted fixes failed and are recorded here so they are not retried:

1. **`--window-position=-4000,-4000`** — the window is still created and still takes focus.
   Hiding it offscreen is not the same as not opening it.
2. **Converting the specs to headless with injected `::-webkit-scrollbar` CSS** — reverted at the
   user's request. Worth recording the disagreement it surfaced: one measurement found the
   injection restoring a 15px gutter, but a second measurement of the case that actually matters
   (with `scrollbar-gutter` removed from `.app-scroll`) found headless still reading 1440/1440
   where headed reads 1440/1425 — the injection does **not** reproduce the defect it was meant to
   stand in for. Treat "headless can substitute for a window here" as **unproven at best**, not as
   a settled optimization.

The user's chosen solution is **consent, not concealment**: keep the windows, ask first, and let
them pick the screen.

## Monitor geometry

Measured 2026-09-04 (points, via `NSScreen`), specific to that machine:

| Display | Origin | Size |
|---|---|---|
| Built-in (main) | `0,0` | 1512x982 |
| External FHD | `1512,-98` | 1920x1080 |
| External ultrawide | `3432,-98` | 2560x1080 |

Chromium takes this as `--window-position=X,Y` (top-left corner of the target display, in the
same coordinate space `NSScreen` reports). These values are per-machine and WILL differ
elsewhere — re-derive them, don't copy the numbers:

- `system_profiler SPDisplaysDataType` lists the connected displays and their resolutions.
- An AppleScript (or small Swift/ObjC snippet) over `NSScreen.screens()` reports each display's
  `frame.origin` and `frame.size` in points — this is what produced the table above, and it is
  the source to re-run on a different machine rather than hand-guessing coordinates.

## What "ask first" means in practice

Before running the full E2E suite (which includes the four headed specs) or any one-off headed
probe, ask the user and wait for an explicit choice — never open a window on the assumption that
silence or a generic "go ahead" means the built-in display. The consent prompt offers exactly
these four options, presented as a real choice rather than an accept/decline binary:

1. **"Lo pruebo yo y te digo"** — no window opens at all. Rebuild the container (or otherwise
   apply the change) and let the user look at it themselves, e.g. http://localhost:3004, and
   report back. Asked for by name after the first use of this rule, then picked immediately —
   treat it as a common, expected choice, not a rare fallback.
2. Open it on the **built-in display**, `--window-position=0,0` — the user's standing default
   when they do want a window.
3. Open it on another monitor: FHD at `1512,-98`, ultrawide at `3432,-98` (see the geometry table
   below).
4. **Commit without verifying.** State plainly, in the same message, exactly what was left
   unchecked (which spec/behavior, why it wasn't run) — this option trades verification for speed
   and the gap must be visible, not silently absorbed.

Per the reverted attempt above, headless is not a universal substitute for the four
scrollbar/animation specs — so when the user's choice means no headed run happens (options 1 or
4), that is a deferred or skipped check, not a downgrade to an equivalent headless one.

## Related

- [[testing]] — the three-layer E2E convention these headed specs are part of.
- [[2026-09-03-animation-clock-sampling-beats-style-and-class-probes]] — the probe-discipline
  lesson for the same class of browser-rendering specs that require a real, painted frame rather
  than a computed-style stand-in; the same "a shortcut here is unproven, not free" caution applies
  to both.
