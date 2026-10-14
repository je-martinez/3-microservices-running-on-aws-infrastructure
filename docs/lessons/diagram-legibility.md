---
title: Diagram legibility
type: lesson
area: shared
status: active
created: 2026-06-27
updated: 2026-10-13
tags: [type/lesson, area/shared, status/active, severity/medium]
related:
  - "[[ADR-0024-diagram-design-diagrams]]"
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[ADR-0015-drawio-diagrams]]"
  - "[[diagrams]]"
  - "[[milestone-plan]]"
---

# Diagram legibility

Written for draw.io, kept through the Remotion/ELK era ([[ADR-0023-remotion-diagrams]]) and now applied to the `diagram-design` HTML diagrams ([[ADR-0024-diagram-design-diagrams]]). The lessons below are tool-agnostic; the tool-specific mechanics of earlier generators were dropped with them.

## What happened

1. **Illegible text.** Light pastel backgrounds with a white font colour made text nearly invisible; the inverse (dark text on dark saturated fills) also occurred.
2. **Clipped diagram.** Nodes laid out in one long horizontal row exceeded the canvas width and were cut off at the edge.
3. **Valid source, unreadable image.** Both problems were invisible in the source. They only appeared when the diagram was rendered.
4. **Merged services hid real resources.** Folding a service into another node's sublabel (Cognito into API Gateway, DynamoDB into the WebSocket API) to save nodes hid resources Terraform deploys. Raising the caps fixed the budget, not the diagram.
5. **Dropping content to hit a size target.** An earlier animated-output budget pushed authors to delete real services, which made the diagram less true.

## Lesson

1. **Explicit, verified contrast.** Dark text on light fills, white text on dark saturated fills. Never rely on a default colour.
2. **A layout that fits the canvas.** Prefer columns and zones over one long row, with the entry on the left and a width of at most 2000 px. Keep edge labels short.
3. **Verify by reading the rendered PNG.** Passing the gate or valid source does not prove legibility; contrast, clipping and overlapping labels only show in the image. Mandatory, not optional.
4. **A shared connection is drawn once.** When many members of a group share one connection, draw a single edge to the group instead of repeating it. Never draw one resource twice.
5. **One node per runtime service; audit Terraform against the views.** Draw every runtime AWS service as its own node and compare the Terraform modules with each view before proposing a PR. Deploy-time resources belong in the `terraform-two-phase-apply` flow. Rule: [[diagrams]].
6. **Split instead of dropping.** When a view outgrows its node ceiling, split it into views (request path / events) whose union still covers every service.
7. **Never delete real content to hit a size or budget target.** Reduce what the picture carries per element, not what it says.

## Lessons from the diagram-design migration

- Put a zone label where no connector crosses it; a line through a label makes the zone unreadable.
- Trim the viewBox to the content, so the PNG has no empty band.
- A group that edges target may be a zone, even if it is a cluster; a group no edge targets is named in a tag and the legend instead.
- Keep routes out of labels (`API VIA WEB`, not `/v1 via web`); labels stay short and uppercase.
- Dense views of about 20 nodes stay legible with tags and a legend rather than nested frames.

## How to apply

Render the entry (`make diagrams-render ID=<id>`), open the PNG, fix any unreadable or clipped element in the HTML source, and re-render until clean.

## Related

- [[ADR-0024-diagram-design-diagrams]]
- [[ADR-0023-remotion-diagrams]]
- [[ADR-0015-drawio-diagrams]]
- [[diagrams]]
- [[milestone-plan]]
