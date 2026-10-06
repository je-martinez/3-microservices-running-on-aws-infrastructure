---
title: Diagrams Convention
type: convention
area: shared
status: active
created: 2026-10-06
updated: 2026-10-06
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[diagram-legibility]]"
  - "[[git-workflow]]"
  - "[[milestone-plan]]"
  - "[[2026-10-06-remotion-diagrams-design]]"
  - "[[2026-10-06-remotion-diagrams]]"
  - "[[package-manager]]"
  - "[[scripting-language]]"
---

# Diagrams Convention

Every animated flow, architecture map and milestone-dependency graph in the vault is rendered by Remotion from data. Decision: [[ADR-0023-remotion-diagrams]]. The agent guide for the package is `diagrams/CLAUDE.md`.

## Tool and package

- Package `@3mrai/diagrams` in `diagrams/` (pnpm workspace; see [[package-manager]]). `remotion` and every `@remotion/*` package share one exact version.
- Make targets: `make diagrams-studio` (live preview), `make diagrams-render [ID=a,b]` (all when `ID` is omitted), `make diagrams-check`.
- Scripts under `diagrams/src/scripts/*.ts` are TypeScript because they live in the Node ecosystem, the exception [[scripting-language]] allows.

## Outputs and location

- An animated **GIF** plus a **last-frame PNG**, rendered by Remotion and **never hand-edited**.
- Milestone `DependencyGraph` entries are PNG only (`animated: false`).
- Committed in a `diagrams/` subfolder beside the vault section that owns the diagram (for example `docs/domains/orders/specs/diagrams/`, `docs/plans/diagrams/`). Embed by **output basename**, `![[<basename>.gif]]` (Obsidian resolves by basename). For most diagrams the basename equals the id; for milestone graphs it differs (id `milestone-<slug>-deps`, embed `![[<slug>-deps.png]]`).
- About 12 fps, at most about 1200 px wide, at most about 2 MB per GIF. No MP4, no web player.

## Catalog and `watches`

- `diagrams/src/catalog.ts` is the source of truth, aggregating `diagrams/src/data/*.catalog.ts`. Each entry holds `id`, `title`, `primitive`, `data`, `output` (vault path without extension), `watches` and a required `source` (the path of the data module that defines the diagram).
- `watches` are globs of the real files the diagram depicts (Terraform modules, handlers, `openapi.yaml`). A glob that matches nothing fails the catalog test; keep them tight and real, because a typo silently disables drift detection.
- Pick the primitive by what the diagram says: `ArchitectureMap` for topology, `FlowSequence` for one ordered interaction, `DependencyGraph` for milestone plans.

## Detail level

- Service and resource names only, never endpoints, request fields or payloads. Content is read from real code and Terraform, never invented.
- Any diagram: about 12 nodes at most; more than that is two diagrams.
- At most 7 actors and 10 steps per flow, one-line captions of at most 90 characters.
- Architecture maps are the exception: at most 18 nodes, grouped by zone (at most 5 zones). The exception covers every `ArchitectureMap` entry, including `system-context`.
- `DependencyGraph`: dependency arrows are drawn over the task boxes, so order tasks within each phase to minimise crossings.
- Cross-zone edge labels: at most 10 characters.

## Authoring and legibility rules

- Order zones so edges join **adjacent** zones; an edge crossing a zone passes behind its nodes. Avoid edges leaving a crowded zone's left sub-column.
- A single long word next to an AWS icon wraps mid-word; prefer short names.
- A self-step on the right-most actor clips its label; move the step or reorder the actors.
- Dark text on pastel fills, layouts that fit the canvas, and reading the rendered PNG before sign-off: see [[diagram-legibility]].

## GIF budget

GIF size is driven by **changed pixels per frame**, not by frame count. Never fade or animate the whole canvas. Architecture maps reveal their edges in 12 frames. Dropping real services to fit the budget is the wrong fix; reduce what changes per frame instead.

## Keep-current rule

A change that alters a diagrammed flow (steps, actors, services) or adds or removes an AWS resource (local Floci or pre-prod) updates the data file and re-renders **in the same PR**. A new significant flow gets a new catalog entry with `watches`.

### `diagrams-check`

`make diagrams-check` lists diagrams whose watched sources changed against `main` (`DIAGRAMS_BASE` overrides the base) and prints `STALE?` for each. It warns and always exits 0, including when the base cannot be resolved. Each entry's `source` module plus the shared primitives, theme, schema and timing are implicit watches, and test files are ignored. On a task branch (task → feature flow, see [[git-workflow]]) set `DIAGRAMS_BASE=feature/<x>` so the diff is taken against the feature branch. The pre-PR gap audit runs it. Each warning is either **resolved** (re-render and commit the new GIF/PNG) or **dismissed** with a one-line justification in the PR (for example "Terraform tag change only; the flow is unchanged").

## PR rule

The PR body carries a `## Diagrams` section; the exact wording is in [[git-workflow]]. Mandatory when `diagrams-check` flagged something, optional otherwise.

## Write boundary

`diagram-impl` writes only `diagrams/**` and `docs/**/diagrams/*.{gif,png}`. It never edits a `.md` note, never runs git and never touches Linear. Embeds and prose go through `obsidian-vault`, from the embed needs `diagram-impl` reports in its handoff.

## Icon adapter rule

Only `diagrams/src/theme/aws-icons.ts` imports `@nxavis/aws-icons`. Everything else asks the adapter for a service, so replacing the icon source touches one file. The package version stays pinned exactly.

## Related

- [[ADR-0023-remotion-diagrams]]
- [[diagram-legibility]]
- [[git-workflow]]
- [[milestone-plan]]
- [[package-manager]]
- [[scripting-language]]
- [[2026-10-06-remotion-diagrams-design]] — design of the Remotion diagram pipeline behind this note
- [[2026-10-06-remotion-diagrams]]
