---
title: "Diagram-Design Migration — Design"
type: spec
area: shared
status: active
created: 2026-10-13
updated: 2026-10-13
tags:
  - type/spec
  - area/shared
  - status/active
related:
  - "[[2026-10-07-aws-style-diagrams-design]]"
  - "[[2026-10-06-remotion-diagrams-design]]"
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[ADR-0024-diagram-design-diagrams]]"
  - "[[diagrams]]"
  - "[[diagram-legibility]]"
  - "[[git-workflow]]"
propagates-to:
  - "[[diagrams]]"
  - "[[git-workflow]]"
  - "[[diagram-legibility]]"
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[ADR-0024-diagram-design-diagrams]]"
  - "[[architecture]]"
  - "[[system-context]]"
---

# Diagram-Design Migration — Design

## Context

On 2026-10-13 the user decided to replace Remotion with the `diagram-design` Claude Code plugin skill (v2.6.6). Remotion today is the `diagrams/` package: Remotion 4.0.533, ELK layout, a zod schema and 29 catalog entries, shipped in PR #130 on `feature/remotion-diagrams` (not merged).

Facts about the skill that drive the design:

- Each diagram is a hand-authored, self-contained HTML file with inline SVG on a 4px grid. There is no layout engine.
- The style is opinionated and editorial: Instrument Serif / Geist / Geist Mono, with a coral accent on 1-2 nodes.
- Complexity budget is 9 nodes / 12 arrows. `faithful` detail allows up to 24 nodes, zoned above 9. The architecture type allows at most 3 zones.
- Icon primitives include only a generic AWS brand logo, no service icons.
- Motion modes `none` / `reveal` / `step` / `loop` run in the browser with a fixed controller. There is no GIF export.
- PNG/SVG export is a manual static capture (`?motion=static`).
- `scripts/self_check.py` rejects any remote reference (for example `<image href="https://...">`) except the Google Fonts css2 stylesheet.

Current catalog node counts: flows 4-12, request-path architecture views 12-14, `-events` views about 20-21, users-service milestone graph 17. All fit `faithful` (24 nodes); nothing must be split, at worst zoned.

## Decisions (user-confirmed 2026-10-13)

1. **Style.** The skill's own default style wins over the AWS reference-architecture look. A committed repo-root `.diagram-design` marker containing exactly `profile: default` keeps any session from hitting the skill's first-run brand gate.
2. **Icons.** Official AWS Architecture Icons loaded from jsDelivr, package `aws-icons@3.2.0` (MIT; folders `icons/architecture-service/` 307, `icons/resource/` 477, `icons/architecture-group/` 15, `icons/category/` 25), via `<image href="https://cdn.jsdelivr.net/npm/aws-icons@3.2.0/icons/<folder>/<Name>.svg">`. The version is always pinned to 3.2.0. `diagrams/icons.yaml` is the single allowlist mapping a logical key (`ecs`, `lambda`, `sqs`, ...) to its CDN path. This is an accepted deviation from the skill's "no external images" rule.
3. **Dropped from the AWS look.** The official coloured group frames (Cloud/Region/VPC/AZ/subnet) go away. Boundaries become skill zones (max 3 per diagram), for example the VPC as a zone with AZ/subnets named in its label. Kept: icon + label nodes, orthogonal connectors, dashed for async, entry on the left, at most 2000 px wide.
4. **Flows.** HTML in `step` motion mode (interactive, browser-only) plus a static PNG of the complete frame with numbered step badges inside the SVG. No GIF. The 19 existing `.gif` files are deleted and their embeds switched to `.png`.
5. **Branch.** The migration lands on `feature/remotion-diagrams` and replaces Remotion before PR #130 merges.
6. **Tooling: approach A**, a slim Python `diagrams/` package. Rejected:
   - **B** — HTML colocated in `docs/**/diagrams` with `<meta>` watches. It mixes sources into the vault owned by `obsidian-vault`, and Obsidian does not index `.html`.
   - **C** — keep a TS/pnpm package minus Remotion. It violates Python-first for new scripts.

## Architecture

```
.diagram-design                 profile: default
diagrams/
  CLAUDE.md                     rewritten for the new flow
  pyproject.toml                package "diagrams3mrai": playwright, pyyaml (+ pytest dev)
  catalog.yaml                  29 entries: id, title, src, output, watches[]
  icons.yaml                    logical key -> path inside aws-icons@3.2.0
  src/<group>/<id>.html         diagram-design sources (architecture, system-context, flows, milestones)
  diagrams3mrai/
    render.py                   HTML -> PNG (Playwright, ?motion=static, await document.fonts.ready, scale 2)
    gate.py                     filtered self_check + icon allowlist + catalog<->files + viewBox width <=2000
    drift.py                    port of check-drift (watches + src vs DIAGRAMS_BASE)
  tests/                        pytest: catalog, gate allowlist, drift
```

- **Catalog.** `catalog.yaml` is ported 1:1 from the 29 `diagrams/src/data/*.catalog.ts` entries, keeping `id`, `output` and `watches`. `source` becomes `src` (the HTML file, an implicit watch).
- **Gate.**
  - Runs the skill's `self_check.py`, located in the installed plugin path; if absent, it fails with a clear install message.
  - Filters only "remote reference" errors whose URL starts exactly with `https://cdn.jsdelivr.net/npm/aws-icons@3.2.0/icons/` and appears in `icons.yaml`. Any other error still fails.
  - Checks every manifest URL answers HTTP 200 (skippable offline).
  - Checks catalog, `src/*.html` and output PNG correspond 1:1, and that viewBox width is at most 2000.
- **Setup.** `make diagrams-setup` runs `pip install -e diagrams` into the repo `.venv` plus `playwright install chromium`. It is idempotent and not a dependency of `scripts-setup`, so apply never needs Chromium.
- **Make targets.**
  - `diagrams-render [ID=...]` — gate, then render.
  - `diagrams-check` — drift; warns, never fails (unchanged contract).
  - `diagrams-gate` — new; fails.
  - `diagrams-studio` — opens the HTML in a browser; `ID=` required.
  - `diagrams-icons` is removed.
- **Outputs.** Always `docs/**/diagrams/<id>.png` beside the owning note.
- **Removed entirely.** Remotion, ELK, zod, the TS under `src/`, `public/aws-icons`, `scripts/fetch_aws_icons.py` and its test, vitest, the package's `package.json` and its pnpm-workspace entry.

## Agents, skills, docs

- **`diagram-impl`** is rewritten around the `diagram-design` skill. It reads `diagrams/CLAUDE.md`, `icons.yaml` and `catalog.yaml`; writes only `diagrams/**` and `docs/**/diagrams/*.png`; still never touches `.md`, git or Linear; still reads real code and Terraform before drawing.
- **Skills.** The 12 Remotion skills are deleted from `.claude/skills/` and `.ai/skills/`; `make ai-sync` retires them from the other providers.
- **Plugin.** `diagram-design` is a user-level plugin (manifests for Claude Code and Codex), documented as a prerequisite (v2.6.6) in `diagrams/CLAUDE.md` and the convention. It is not vendored.
- **Vault** (via `obsidian-vault`):
  - New ADR-0024 `diagram-design-diagrams` superseding ADR-0023 (style, pinned jsDelivr icons, no GIF, dropped AWS frames).
  - Rewrite the `diagrams` convention, keeping the keep-current rule, the coverage rule (every runtime AWS service gets a node, now within 24 faithful nodes or split into views) and the PR `## Diagrams` rule (now attaches the PNG).
  - `git-workflow` PR attachment: GIF to PNG.
  - Revise the `diagram-legibility` lesson, trimming ELK/Remotion-specific parts.
  - Update the roughly 20 notes that mention Remotion or embed `.gif`.
- **Root `CLAUDE.md`.** The Diagrams section changes from "Remotion renders" to "diagram-design HTML + PNG" and says to run `make diagrams-gate` and `make diagrams-check` before a PR; then `make ai-sync` regenerates `AGENTS.md`.

## Migration order

Same branch, one commit per block, each through the git confirmation menu ([[git-workflow]]).

1. **Tooling.** Marker, pyproject, `catalog.yaml`, `icons.yaml`, render/gate/drift, pytest, make targets. Remotion is still in place.
2. **Pilot.** One diagram per kind: `architecture-dev-floci-events` (densest), `orders-checkout-stripe` (step flow), `system-context-l1`, one milestone graph. **Stop point:** the user reviews style and icons before the rest migrates.
3. **Rest of the catalog**, in batches per group (architecture + system-context, flows, milestones). Each batch passes `diagrams-gate` and gets a screenshot review.
4. **Remotion retirement.** Delete TS, deps, skills and local icons; run `ai-sync`; delete `.gif` files; update `.gitignore` and the workspace.
5. **Vault propagation.** ADR-0024, convention, `.gif` to `.png` embeds, `CLAUDE.md`, and mark superseded content in the predecessor specs where referenced.
6. **Close.** `spec-implementation-audit`, `validate-vault`, `diagrams-gate` and `diagrams-check` green; update PR #130's description.

## Verification

- **pytest:** catalog, `src/*.html` and outputs correspond 1:1; the gate tolerates only manifest jsDelivr URLs (any other remote URL fails); drift detects a `watches` change and a `src` change.
- **Per-diagram gate:** filtered `self_check` plus viewBox width at most 2000.
- **Visual review** of the pilot with the user. Passing the gate is not "looks right".
- **Coverage parity:** before deleting each Remotion view, compare its AWS nodes with the new view; no runtime service disappears without an explicit decision.

## Out of scope

- GIF generation of any kind.
- A custom brand profile.
- Vendoring the plugin.
- Redesigning diagram content beyond what the budget forces.

## Related

- [[2026-10-07-aws-style-diagrams-design]]
- [[2026-10-06-remotion-diagrams-design]]
- [[ADR-0023-remotion-diagrams]]
- [[ADR-0024-diagram-design-diagrams]]
- [[ADR-0015-drawio-diagrams]]
- [[diagrams]]
- [[diagram-legibility]]
- [[git-workflow]]
- [[2026-10-13-diagram-design-migration]]
