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

- Before running the full E2E suite (which includes the four headed specs) or any one-off headed
  probe, ask the user whether to proceed, and wait for an explicit accept.
- On accept, target the built-in display's origin unless the user says otherwise for that
  session — don't default to whichever screen happens to be `0,0` on a machine that hasn't been
  measured.
- Declining means the headed specs are skipped or run headless where a headless run is
  meaningful for what's being checked; per the reverted attempt above, headless is not a
  universal substitute for the four scrollbar/animation specs, so declining may mean deferring the
  check rather than silently downgrading it.

## Related

- [[testing]] — the three-layer E2E convention these headed specs are part of.
- [[2026-09-03-animation-clock-sampling-beats-style-and-class-probes]] — the probe-discipline
  lesson for the same class of browser-rendering specs that require a real, painted frame rather
  than a computed-style stand-in; the same "a shortcut here is unproven, not free" caution applies
  to both.
