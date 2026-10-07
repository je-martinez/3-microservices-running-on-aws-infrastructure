---
title: Diagram legibility
type: lesson
area: shared
status: active
created: 2026-06-27
updated: 2026-10-06
tags: [type/lesson, area/shared, status/active, severity/medium]
related:
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[ADR-0015-drawio-diagrams]]"
  - "[[diagrams]]"
  - "[[milestone-plan]]"
---

# Diagram legibility

Originally written for draw.io (`.drawio.svg`); the rules carried over unchanged to the Remotion diagrams that replaced it ([[ADR-0023-remotion-diagrams]]).

## What happened

1. **Illegible text.** Light pastel backgrounds with a white font colour made text nearly invisible; the inverse (dark text on dark saturated fills) also occurred.
2. **Clipped diagram.** Nodes laid out in one long horizontal row exceeded the canvas width and were cut off at the edge.
3. **Valid source, unreadable image.** Both problems were invisible in the source (draw.io XML, later the data files). They only appeared when the diagram was rendered.
4. **A full-canvas fade made GIFs huge.** The first Remotion architecture maps faded the whole map in, so every frame changed nearly every pixel and a GIF cost about 11 KB per frame. To fit the 2 MB budget, authors started dropping real services from the maps, which made the diagram less true.

## Lesson

1. **Explicit, verified contrast.** Dark text on light pastel fills, white text on dark saturated fills. Never rely on a default colour.
2. **A layout that fits the canvas.** Prefer columns, zones or phase layouts over one long row. Keep edge labels short and order zones so edges join adjacent zones.
3. **Verify by reading the rendered PNG.** Passing tests or valid data does not prove legibility; contrast, clipping and overlapping labels only show in the image. Mandatory, not optional.
4. **Budget by changed pixels, not frame count.** GIF size follows what changes per frame. Reveal elements incrementally (architecture maps reveal edges in 12 frames); never fade or animate the whole canvas. Do not delete real content to hit the size target.

## How to apply

Render the entry (`make diagrams-render ID=<id>`), open the PNG, fix any unreadable or clipped element in the data file, and re-render until clean. Check the GIF size against the budget in [[diagrams]].

## Related

- [[ADR-0023-remotion-diagrams]]
- [[ADR-0015-drawio-diagrams]]
- [[diagrams]]
- [[milestone-plan]]
