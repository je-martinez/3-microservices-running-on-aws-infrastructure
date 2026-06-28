---
title: draw.io diagram legibility
type: lesson
area: shared
status: active
created: 2026-06-27
updated: 2026-06-27
tags: [type/lesson, area/shared, status/active, severity/medium]
related:
  - "[[ADR-0015-drawio-diagrams]]"
  - "[[milestone-plan]]"
---

# draw.io diagram legibility

## What happened

While generating draw.io diagrams for the vault (`.drawio.svg` via `scripts/drawio-to-svg.mjs`), two recurring problems were only detected after rendering the SVG to an image — not in the XML source:

1. **Illegible text:** light pastel backgrounds (light blue / yellow / purple) combined with a white `fontColor` made text nearly invisible. The inverse also occurred: dark text on dark saturated fills.
2. **Clipped diagram:** nodes arranged in a long horizontal row (e.g., the five service-spec nodes side by side) exceeded the canvas width and were cut off at the viewport edge.

Both issues are invisible in the raw XML — they only appear when the diagram is actually rendered.

## Lesson

Rules for every draw.io diagram in the vault (they reinforce [[ADR-0015-drawio-diagrams]]):

1. **Explicit, verified text contrast:** choose a `fontColor` that strongly contrasts with the `fillColor`. For LIGHT pastel fills use DARK text (e.g., fill `#BBDEFB` → fontColor `#0D2B57`); for DARK saturated fills use white text. Never leave the color at its default and assume it will be readable.
2. **Layout that fits the canvas:** prefer vertical arrangements or phase-column layouts over a single long horizontal row. Group many nodes (e.g., a list of N items) in a column, not a row, so width does not overflow the canvas.
3. **Always render and inspect the result before signing off:** convert the `.drawio.svg` to a PNG (`qlmanage -t -s <width> -o <dir> <file.svg>`) and review it visually. Valid XML does **not** guarantee a legible render — contrast and clipping problems only surface in the image. This step is mandatory, not optional.

## How to apply

After running `drawio-to-svg.mjs`, render a PNG and inspect it. If text is unreadable or anything is clipped, adjust `fontColor` and/or the layout, then re-render until the output is clean.

## Related

- [[ADR-0015-drawio-diagrams]]
- [[milestone-plan]]
