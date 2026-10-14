---
title: Diagrams Convention
type: convention
area: shared
status: active
created: 2026-10-06
updated: 2026-10-13
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[ADR-0024-diagram-design-diagrams]]"
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[diagram-legibility]]"
  - "[[git-workflow]]"
  - "[[milestone-plan]]"
  - "[[scripting-language]]"
  - "[[2026-10-13-diagram-design-migration-design]]"
---

# Diagrams Convention

Every architecture map, flow and milestone-dependency graph in the vault is a hand-authored `diagram-design` HTML source in `diagrams/src/`, rendered to a PNG beside the note that owns it. Decision: [[ADR-0024-diagram-design-diagrams]]. The detailed authoring contract is `diagrams/CLAUDE.md`; this note is the summary and the rules the rest of the repo relies on.

## Tool and prerequisites

- The `diagram-design` plugin, declared in `.claude/settings.json`. The gate uses the newest installed version and prints it (`diagrams-gate: diagram-design <version>`); `DIAGRAM_DESIGN_SELF_CHECK` overrides the path. The migration was verified with v2.6.6. The skill's default style is pinned by the repo-root `.diagram-design` marker (`profile: default`); never customise the style.
- `make diagrams-setup` once per clone: installs the Python package, Playwright and Chromium into the repo `.venv`. No apply target depends on it. Every `diagrams-*` target needs it: without it `diagrams-check` prints "skipped" and exits 0, while `diagrams-gate`, `diagrams-render` and `diagrams-studio` fail with "run make diagrams-setup".
- The toolchain is a slim Python package (`diagrams/diagrams3mrai/`: catalog, drift, gate, render), per [[scripting-language]].

## Make targets

| Target | Purpose |
|---|---|
| `make diagrams-setup` | Install the toolchain and Chromium (idempotent). |
| `make diagrams-gate [ID=a,b]` | Plugin `self_check`, `verify-geometry` and (flows with a motion root) `verify-motion`, icon allowlist, 2000 px width cap, and catalog / source / PNG parity. Fails. |
| `make diagrams-render [ID=a,b]` | Gate, then the PNG. All diagrams when `ID` is omitted. Fails when any request fails or answers 400 or above (for example an icon from jsDelivr while offline); never writes a PNG with missing icons. |
| `make diagrams-check` | Drift check. Warns, never fails. |
| `make diagrams-studio ID=<id>` | Opens the interactive HTML in the browser. |

## Sources, catalog and outputs

- `diagrams/catalog.yaml`: one entry per diagram (`id`, `title`, `src`, `output`, `watches`). `diagrams/icons.yaml`: the icon allowlist.
- Sources: `diagrams/src/{architecture,system-context,flows,milestones}/<id>.html`.
- Output: `docs/**/diagrams/<id>.png` beside the owning note (for example `docs/domains/orders/specs/diagrams/`, `docs/plans/diagrams/`). Embed by **output basename** with `![[<basename>.png]]`; for milestone graphs the basename differs from the id (id `milestone-<slug>-deps`, embed `![[<slug>-deps.png]]`). PNG is the only output: no GIF, no MP4.
- The PNG is generated and never hand-edited; a change goes through the HTML source and a re-render.
- `watches` are tight globs of the real files the diagram depicts (handlers, Terraform modules, `openapi.yaml`), never whole service trees.

## Approved conventions (summary)

The contract with every detail is `diagrams/CLAUDE.md`; the four pilots there are the reference implementations.

- **Style and icons.** Skill default style; AWS icons only from `aws-icons@3.2.0` on jsDelivr, via `icons.yaml`. Non-AWS things use generic icons or plain nodes.
- **Zones, not AWS frames.** At most 3 zones per diagram, drawn around the boundaries edges point at. VPC, subnets and clusters are named in tags and the legend unless edges target them.
- **Entry on the left** (browser, API Gateway, ALB, ECS, data, events), at most 2000 px wide, viewBox trimmed to the content.
- **Solid is synchronous, dashed is async** (queues, topics, EventBridge, webhooks).
- **Labels** at most 14 characters, uppercase, never a route.
- **Flows** carry numbered step badges and a caption list inside the SVG, so the static PNG holds the whole meaning; at most 8 motion steps in `step` mode.
- **Detail level.** Service and resource names only, never endpoints, request fields or payloads. Content is read from real code and Terraform, never invented.

## Coverage rule

Architecture and system-context views draw **every runtime AWS service the environment deploys** as its own node, with its real connections; no service is drawn twice and none is folded into another node. Deploy-time resources (Terraform state bucket, lock and execution-log tables) appear only in the `terraform-two-phase-apply` flow. The ceiling is **24 nodes at `faithful` detail**; beyond it the view is split (request path / events) so the union still covers every service, never by dropping one. See [[diagram-legibility]].

## Keep-current rule

A change that alters a diagrammed flow (steps, actors, services) or adds or removes an AWS resource (local Floci or pre-prod) updates the HTML source and re-renders the PNG **in the same PR**. A new significant flow gets a new catalog entry with `watches`.

### `diagrams-check`

`make diagrams-check` lists diagrams whose `watches`, `src` or shared render inputs changed against `main` (`DIAGRAMS_BASE` overrides the base) without a re-render, printing `STALE?` for each. It warns and always exits 0. On a task branch set `DIAGRAMS_BASE=feature/<x>`. The pre-PR `spec-implementation-audit` runs it. Each warning is **resolved** (re-render and commit) or **dismissed** with a one-line justification in the PR.

## PR rule

The PR body carries a `## Diagrams` section that attaches the **PNG** (not a GIF); the exact wording is in [[git-workflow]]. Mandatory when `diagrams-check` flagged something, optional otherwise.

## Write boundary

Work goes through the `diagram-impl` agent. It writes only `diagrams/**` and `docs/**/diagrams/*.png`; it never edits a `.md` note, never runs git and never touches Linear. Embeds and prose go through `obsidian-vault`, from the embed needs `diagram-impl` reports in its handoff.

## Related

- [[ADR-0024-diagram-design-diagrams]]
- [[ADR-0023-remotion-diagrams]] — superseded predecessor
- [[diagram-legibility]]
- [[git-workflow]]
- [[milestone-plan]]
- [[scripting-language]]
- [[2026-10-13-diagram-design-migration-design]]
