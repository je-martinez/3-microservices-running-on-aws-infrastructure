---
title: "AWS-Style Diagrams — Reference-Architecture Visual Language Design"
type: spec
area: shared
status: accepted
created: 2026-10-07
updated: 2026-10-12
tags:
  - type/spec
  - area/shared
  - status/accepted
propagates-to:
  - "[[diagrams]]"
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[diagram-legibility]]"
  - "[[2026-10-06-remotion-diagrams-design]]"
  - "[[architecture]]"
  - "[[system-context]]"
  - "[[users-service-milestone]]"
  - "[[services-infra-scaffold-milestone]]"
  - "[[documentation-vault-milestone]]"
related:
  - "[[2026-10-06-remotion-diagrams-design]]"
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[diagrams]]"
  - "[[diagram-legibility]]"
---

# AWS-style diagrams — reference-architecture visual language for every diagram

## Goal

The Remotion diagrams shipped by [[2026-10-06-remotion-diagrams-design]] work but do not look like AWS reference architecture diagrams (https://docs.aws.amazon.com/reference-architecture-diagrams/). Restyle EVERY diagram — architecture maps, system context, the 19 flows and the 3 milestone graphs — to that visual language, and update the `diagram-impl` agent so all future diagrams follow it.

## Decisions (agreed with the user, 2026-10-07)

1. Scope: all 26 diagrams, including flows and milestone graphs.
2. Group and generic icons come from the official AWS Architecture Icons asset package (fetched by a Python script); service icons stay on `@nxavis/aws-icons`; both behind the single adapter `diagrams/src/theme/aws-icons.ts`.
3. Animation stays: the static diagram is visible from frame 0 and numbered step badges light up in order.
4. Layout engine: ELK (`elkjs`, layered algorithm, orthogonal edge routing, hierarchical/compound groups). License: elkjs is dual-licensed EPL-2.0 OR GPL-3.0-or-later (not MIT); acceptable here because it is a dev-only tooling package (never shipped in a product) and ELK is used unmodified. Rejected: B — a grid declared in data (authors hand-place 26 diagrams; crossings and box-crossing edges remain the author's problem); C — keep the home-grown layout and only restyle (cannot produce nested groups or orthogonal routing that avoids boxes).

## Visual style (per AWS Architecture Icons guidelines)

- White canvas; font Arimo (free, metric-compatible with Arial — AWS uses Amazon Ember, not redistributable, with Arial as fallback), loaded via `@remotion/google-fonts` for deterministic renders.
- Service nodes: official icon ~48px, no surrounding box, name below (≤2 lines, black), optional italic sublabel (e.g. "service 1").
- Group containers with the official group icon in the top-left corner and label beside it, colours per AWS guidelines: AWS Cloud (dark grey border), Region and Availability Zone (dashed teal), VPC (purple), public subnet (green), private subnet (teal), AWS account (pink), generic group (dashed grey), corporate data center (for what runs outside AWS, e.g. browser, Stripe), plus a `local (Floci)` group for the local environment.
- Non-AWS externals (browser, users, Stripe, OpenObserve, Geoapify): official generic resource icons (Users, Client, Internet, Generic application) with their name below.
- Connectors: thin black orthogonal lines, solid = synchronous, dashed = asynchronous (queue/topic/webhook), small arrowhead, short label beside the segment.
- Numbered step badges: rounded blue squares with a white number, placed on the step's arrow.
- Milestone graphs: each phase is a generic group, each task a small card with id + name (tasks have no AWS icon); same connectors and aesthetics.

## Data model and layout

- One primitive `AwsDiagram` replaces `ArchitectureMap`, `FlowSequence` and `DependencyGraph`. Shared zod schema:
  `{ title, subtitle?, direction: "RIGHT"|"DOWN", groups: [{ id, kind, label, parent? }], nodes: [{ id, label, sublabel?, icon, group? }], edges: [{ id, from, to, label?, async? }] (from/to may be a node id or a group id: a group endpoint is drawn to the group frame), steps?: [{ edges: [edgeId...], caption }] }` — group kind ∈ aws-cloud | region | az | vpc | public-subnet | private-subnet | account | generic | corporate | phase (+ local-floci); icon ∈ AwsService | GenericIcon | "task".
- Flows: actors become nodes inside their groups; each connection drawn once; steps reference the edges they traverse with a caption (≤90 chars); a flow that repeats a connection shares the edge and shows two badges.
- Architecture: same structure, usually without steps (may tell a request path with steps).
- Milestones: phases are `phase` groups, tasks are `task` nodes, no steps.
- Layout: Remotion `calculateMetadata` runs ELK (`elkjs`, EPL-2.0 OR GPL-3.0-or-later, used unmodified in dev-only tooling) (layered, orthogonal routing, compound groups) once per composition and passes positions, edge routes and canvas size as props. Canvas size follows the layout; if wider than 1200px the GIF is scaled to 1200, the PNG renders at full resolution. ELK reserves space for edge labels, then a post-pass (`placeLabels`) moves a label nearer its own route when needed.
- A layout test with real ELK (no mocks) asserts every node lies inside its group and no edge crosses a node it does not connect.
- Removed: ArchitectureMap, FlowSequence, DependencyGraph, the home-grown `layout.ts`, and the authoring rules that compensated for it (≤10-char cross-zone labels, adjacent zones, left sub-column, self-step clipping, etc.).

## Animation and output

- Frame 0: complete diagram (groups, nodes, neutral-grey edges), no fade — keeps GIFs small.
- Step i: its edges highlight (accent colour, slightly thicker), its numbered badge appears, a bottom bar shows "i. caption"; earlier badges stay.
- Last frame (the PNG): all badges, no highlight, plus a step-list panel below the diagram ("1. …", "2. …") so the PNG stands alone, like AWS reference diagrams that explain numbered steps beside the drawing.
- Diagrams without steps (step-less architecture, milestones) render PNG only — no GIF.
- Unchanged: ≤ ~2 MB per GIF, never animate the whole canvas, ~12 fps via `everyNthFrame`, render by ID.

## Icons, migration, scope

- `diagrams/scripts/fetch_aws_icons.py` (Python per [[scripting-language]]) downloads the AWS Architecture Icons asset package and extracts only the group and generic SVGs in use into `diagrams/public/aws-icons/` with a `manifest.json` (package version + key→file). The SVGs are committed (AWS terms permit use in architecture diagrams).
- Migration: all 26 data files rewritten to the new schema and re-rendered (parallel by group). Catalog, `source`, `watches`, `diagrams-check` and output paths unchanged; vault embeds stay valid EXCEPT step-less architecture and milestone entries, which become PNG-only — their embeds switch `.gif` → `.png` ([[architecture]] and [[system-context]] change; the three milestone plans [[users-service-milestone]], [[services-infra-scaffold-milestone]] and [[documentation-vault-milestone]] already embed `.png`) and the stale GIFs are deleted.
- Agent and docs: `diagrams/CLAUDE.md` and `diagram-impl.md` carry the AWS-style rules (which group kind when, icons, sync vs async, steps); [[ADR-0023-remotion-diagrams]] gains a `## Style revision` entry (same tool, no new ADR); convention [[diagrams]] and lesson [[diagram-legibility]] updated.
- Out of scope: manual position editing, third-party brand logos (Stripe, OpenObserve), export to draw.io/SVG.

## Verification

Package tests (incl. real-ELK layout tests and the catalog quality gate `aws-catalog-quality.test.ts`) and typecheck; full re-render, every PNG visually inspected against the AWS reference style; GIFs ≤ ~2 MB; validate-vault, lint-comments, ai-sync-check, diagrams-check green.

## Implementation deviations

The shipped implementation differs from the design above in these ways.

- **Per-edge ports.** A first pass computes the side each port faces (the side toward the edge's other end) and the ports are pinned (`FIXED_SIDE`/`FIXED_POS`), not left to ELK `FREE`, instead of fixed west/east ports. ELK ignores `FIXED_POS` on ports of nested compound groups, so a post-layout pass (`settleFramePorts`) slides group-frame ports into the gaps between member icons.
- **Edge labels.** ELK reserves the space, then a post-pass (`placeLabels`, `src/aws/labels.ts`) moves a label nearer its own route when needed.
- **Group endpoints.** An edge `from`/`to` may be a group id and is drawn to the group frame, so shared fan-out is drawn once.
- **No resource drawn twice.** One real resource is one node.
- **Catalog quality gate.** `diagrams/test/aws-catalog-quality.test.ts` lays out every catalog entry and fails on defects; fix data or layout, never weaken it.
- **Milestones lay out DOWN.** Milestone graphs use `direction: "DOWN"`.
- **Drift watches.** Implicit watches are the entry's source module, `diagrams/src/aws/**`, `diagrams/src/theme/**`, `diagrams/public/aws-icons/**`, `diagrams/src/schema.ts`, `diagrams/src/Root.tsx`, `diagrams/src/scripts/render.ts` and `diagrams/package.json`.
- **Canvas width.** The canvas is widened for the title and captions and rounded to whole 20 px multiples (non-integer sizes made GIF encoders store whole frames).
- **Caption bar.** The step caption sits in a reserved band of the canvas rather than overlaying the drawing.
- **Badge placement.** Step badges sit along the edge in step order, clear of edge labels.
- **`AwsService` location.** The `AwsService` type lives in `diagrams/src/aws/schema.ts`, not in the theme adapter.
- **Wide architecture PNGs.** The architecture maps render 1800 to 2020 px wide and that is accepted; the vault notes tell the reader to open them full size.

## Related


- [[2026-10-06-remotion-diagrams-design]]
- [[ADR-0023-remotion-diagrams]]
- [[diagrams]]
- [[diagram-legibility]]
- [[scripting-language]]
- [[architecture]]
- [[system-context]]
- [[users-service-milestone]]
- [[services-infra-scaffold-milestone]]
- [[documentation-vault-milestone]]
