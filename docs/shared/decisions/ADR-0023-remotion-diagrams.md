---
title: "ADR-0023: Remotion as the vault diagram tool"
type: adr
area: shared
status: accepted
id: ADR-0023
created: 2026-10-06
updated: 2026-10-12
deciders: [Jose E. Martinez]
supersedes: "ADR-0015-drawio-diagrams"
superseded-by: null
tags:
  - type/adr
  - area/shared
  - status/accepted
related:
  - "[[ADR-0015-drawio-diagrams]]"
  - "[[diagrams]]"
  - "[[diagram-legibility]]"
  - "[[2026-10-06-remotion-diagrams-design]]"
  - "[[2026-10-07-aws-style-diagrams-design]]"
  - "[[2026-10-06-remotion-diagrams]]"
  - "[[package-manager]]"
  - "[[scripting-language]]"
---

# ADR-0023: Remotion as the vault diagram tool

## Context

[[ADR-0015-drawio-diagrams]] made draw.io (`.drawio.svg`) the vault diagram format. In practice:

- **Static and hard to keep current.** A draw.io diagram is edited by hand in a GUI. Flows and AWS resources change with almost every milestone, and nothing tells an author that a diagram has gone stale. Only six diagrams ever existed, and the milestone graph for users-service stopped at JE-37.
- **No sense of order.** A static picture cannot show the steps of a flow in sequence, which is what most of the system's flows are (OTP sign-in, checkout, carrier webhook to WebSocket toast).
- **Not data-driven.** The diagram is the source; there is no structured data to test, diff, or tie to the files it depicts.
- **Tooling weight.** It needed the draw.io MCP server and a bespoke converter script, `drawio-to-svg.mjs`.

## Decision

Vault diagrams are rendered with **Remotion** from data, in a pnpm workspace package `@3mrai/diagrams` (`diagrams/`).

1. **Data-driven, three shared primitives.** `ArchitectureMap`, `FlowSequence` and `DependencyGraph`, fed by a catalog whose entries are validated with zod. A bespoke component per diagram and a textual DSL were both rejected.
2. **Outputs.** (Superseded for format by Style revision: PNG-only when a diagram has no steps.) An animated GIF plus a last-frame PNG, committed in a `diagrams/` subfolder beside the owning vault section and embedded with `![[<id>.gif]]`. Milestone `DependencyGraph` entries are PNG only. No MP4, no web player. "Interactive" means Remotion Studio locally (`make diagrams-studio`).
3. **Drift detection.** Each catalog entry declares `watches` globs; `make diagrams-check` lists diagrams whose watched sources changed against `main`. It warns and never blocks.
4. **AWS icons.** The npm package `@nxavis/aws-icons` (MIT, official AWS Architecture Icons), pinned to an exact version and imported by a single adapter, `diagrams/src/theme/aws-icons.ts`. Non-AWS nodes are labelled boxes coloured by node kind.
5. **A dedicated implementer.** The `diagram-impl` agent writes `diagrams/**` and the rendered `docs/**/diagrams/*.{gif,png}` only.
6. **Scope.** The existing six diagrams are re-created, plus a backfill of the flows the system already has (26 catalog entries at adoption). The `.drawio.svg` files, `drawio-to-svg.mjs` and the `drawio` MCP server are retired.

Rules and procedure live in [[diagrams]]; the generalized legibility lessons in [[diagram-legibility]].

## Style revision (2026-10-07)

Same tool, no new ADR. Design: [[2026-10-07-aws-style-diagrams-design]].

- **Visual style.** Every diagram follows the AWS reference-architecture style: nested group containers, official service icons with names below, thin orthogonal connectors (dashed for async), numbered step badges. This replaces decision 1's three primitives with a single primitive, `AwsDiagram`.
- **Layout engine.** ELK (`elkjs`, layered, orthogonal routing, compound groups). elkjs is dual-licensed EPL-2.0 OR GPL-3.0-or-later; that is acceptable because it is used unmodified in a dev-only tool that never ships in a product.
- **Icons.** Service icons stay on `@nxavis/aws-icons`; group and generic icons come from the official AWS Architecture Icons package, fetched by `make diagrams-icons` and committed. Both sit behind the single adapter, replacing decision 4's labelled boxes for non-AWS nodes.
- **Group endpoints.** An edge may start or end on a group id and is drawn to the group frame, so a shared fan-out is drawn once and no resource is drawn twice.
- **Infra as deployed.** Group kind `ecs-cluster`, Availability Zone `lanes` on a `vpc` group and official `ecs-task`/`ecs-service`/`alb` icons let pre-prod draw its cluster, tasks and AZ placement.
- **Outputs.** Step-less diagrams (architecture maps, milestone graphs) are PNG only; diagrams with steps keep GIF plus PNG.

## Consequences


**Positive:**

- Diagrams animate the order of a flow and are rebuilt from structured data, so a content change is a data edit plus a re-render.
- `watches` plus `diagrams-check` give the keep-current rule a mechanical trigger.
- The vault validator is unaffected: it checks `.md` files and resolves embeds by basename.

**Negative / risks:**

- **Icon-package risk.** `@nxavis/aws-icons` is young (v0.0.5, a single maintainer, low download count). Mitigation: exact pin plus the single adapter, so replacing the source (for example vendoring the official asset zip) touches one file.
- **Binary weight.** Committed GIFs and PNGs add up; each GIF targets at most about 2 MB, and `diagrams-render` takes an optional `ID` (a comma-separated list); when it is omitted, every diagram is rendered.
- **Render dependency.** Remotion needs Chrome Headless Shell, fetched on first render. No Docker is involved.
- **Cannot be hand-edited.** GIF and PNG are generated artifacts; a change goes through the data file.

## Related

- [[ADR-0015-drawio-diagrams]] — superseded by this decision.
- [[diagrams]]
- [[diagram-legibility]]
- [[2026-10-07-aws-style-diagrams-design]] — AWS reference style revision
- [[2026-10-06-remotion-diagrams-design]] — design of the Remotion diagram pipeline behind this note
- [[2026-10-06-remotion-diagrams]]
- [[package-manager]]
- [[scripting-language]]
