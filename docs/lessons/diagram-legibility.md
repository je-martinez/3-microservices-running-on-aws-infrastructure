---
title: Diagram legibility
type: lesson
area: shared
status: active
created: 2026-06-27
updated: 2026-10-12
tags: [type/lesson, area/shared, status/active, severity/medium]
related:
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[ADR-0015-drawio-diagrams]]"
  - "[[diagrams]]"
  - "[[2026-10-07-aws-style-diagrams-design]]"
  - "[[milestone-plan]]"
---

# Diagram legibility

Originally written for draw.io (`.drawio.svg`); the contrast and verify-the-image rules carried over to the Remotion diagrams that replaced it ([[ADR-0023-remotion-diagrams]]), and the layout lessons were rewritten when the AWS reference style adopted ELK ([[2026-10-07-aws-style-diagrams-design]]).

## What happened

1. **Illegible text.** Light pastel backgrounds with a white font colour made text nearly invisible; the inverse (dark text on dark saturated fills) also occurred.
2. **Clipped diagram.** Nodes laid out in one long horizontal row exceeded the canvas width and were cut off at the edge.
3. **Valid source, unreadable image.** Both problems were invisible in the source (draw.io XML, later the data files). They only appeared when the diagram was rendered.
4. **A hand-rolled layout kept failing.** The home-grown layout needed a growing list of authoring rules (adjacent zones, short cross-zone labels, avoiding sub-columns, self-step clipping) and edges still crossed boxes.
5. **Non-integer canvas sizes made GIFs huge.** With fractional canvas dimensions the GIF encoder stored whole frames, giving 17 to 25 MB GIFs.
6. **A full-canvas fade made GIFs huge.** The first Remotion architecture maps faded the whole map in, so every frame changed nearly every pixel and a GIF cost about 11 KB per frame. To fit the 2 MB budget, authors started dropping real services from the maps, which made the diagram less true.
7. **Wide maps that would not narrow.** ELK's wrapping and per-group direction have no effect on hierarchical (INCLUDE_CHILDREN) layouts and are ignored silently, so the pre-prod map stayed about 3200 px wide whatever was configured.

8. **Merged services hid real resources.** Folding a service into another node's sublabel (Cognito into API Gateway, DynamoDB into the WebSocket API) to save nodes hid resources Terraform deploys. Raising the caps to 30 nodes and 40 edges fixed the budget, not the diagram.

## Lesson

1. **Explicit, verified contrast.** Dark text on light pastel fills, white text on dark saturated fills. Never rely on a default colour.
2. **A layout that fits the canvas.** Prefer columns, zones or phase layouts over one long row. Keep edge labels short.
3. **Verify by reading the rendered PNG.** Passing tests or valid data does not prove legibility; contrast, clipping and overlapping labels only show in the image. Mandatory, not optional.
4. **Use a real layout engine (ELK) instead of a hand-rolled layout.** Declare groups, nodes and edges and let the engine route; do not patch a home-grown layout with authoring rules.
5. **Group endpoints solve shared fan-out.** When many members of a group share one connection, draw a single edge to the group frame instead of splitting the group or repeating edges. Never draw one resource twice. A group whose members sit on both sides of another group along the flow may be drawn as two adjacent frames of the same kind, each holding different resources and labelled distinctly (e.g. orders-checkout-stripe's "Floci — data" / "Floci — events"); that is not drawing a resource twice. Shared fan-out still uses a group endpoint.
6. **ELK's reserved label spot is not enough.** ELK leaves room for a label but not always next to its own route; a post-pass keeps each label nearest its own route.
7. **Keep the canvas size an integer** (whole 20 px multiples) so the GIF encoder stores only changed pixels.
8. **Budget by changed pixels, not frame count.** GIF size follows what changes per frame. Reveal elements incrementally; never fade or animate the whole canvas. Do not delete real content to hit the size target.
9. **Do not rely on ELK wrapping or per-group direction with INCLUDE_CHILDREN; they are silently ignored.** Drive the flow with declaration order (`compact: true`: entry -> compute -> data -> events/externals, back edges add no column) and keep maps at most 2000 px wide.
10. **One node per runtime service; audit Terraform against the maps.** Draw every runtime AWS service as its own node (instances in the sublabel) and compare the Terraform modules with each map before proposing a PR. Deploy-time resources belong in the `terraform-two-phase-apply` flow. Rule: [[diagrams]].

## How to apply

Render the entry (`make diagrams-render ID=<id>`), open the PNG, fix any unreadable or clipped element in the data file, and re-render until clean. Check the GIF size against the budget in [[diagrams]].

## Related

- [[ADR-0023-remotion-diagrams]]
- [[ADR-0015-drawio-diagrams]]
- [[diagrams]]
- [[milestone-plan]]
- [[2026-10-07-aws-style-diagrams-design]]
