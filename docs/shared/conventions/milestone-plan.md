---
title: Milestone Plan Convention
type: convention
area: shared
status: active
created: 2026-06-27
updated: 2026-06-27
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[linear-references]]"
  - "[[2026-06-26-3mrai-docs-vault]]"
  - "[[ADR-0015-drawio-diagrams]]"
---

# Milestone Plan Convention

Every milestone executed in this project has a **plan note** in `docs/plans/` that captures the logical execution order and blocking relationships between its tasks. This note defines what such a plan must contain and why the vault documents it rather than relying on Linear alone.

## Rule

A milestone plan note is an **evergreen note** in `docs/plans/` with `type: plan`. Its filename is `<milestone-slug>.md` in kebab-case (no date prefix — it describes a structural artifact, not a time-bound event). Every milestone plan note MUST contain the following four sections:

### a) Task sequence table

An ordered table listing every task in the milestone, ranked by execution order. Required columns:

| # | Issue | Task | Deliverable | Spec note |
|---|---|---|---|---|

- `#` — rank by execution order (1 = first).
- `Issue` — inline markdown link to the Linear issue URL, displayed as `[JE-N](url)`. Consistent with [[linear-references]] rule 2.
- `Task` — one-line description of the work.
- `Deliverable` — the concrete output (file path, folder, or artifact name).
- `Spec note` — `[[wikilink]]` to the vault note that specifies the work, if one exists. If no dedicated spec exists, describe the deliverable in prose in the Deliverable column.

**No status column.** Issue status is live data that belongs in Linear. Copying it into the vault creates stale information with no sync mechanism. See [[linear-references]] rule 3: "Detail is fetched, never copied."

### b) Dependency table

A two-column table listing blocking relationships:

| Task | Blocked by |
|---|---|
| JE-N | JE-M, JE-K |
| JE-N | — |

A task with no blockers lists `—`. The table covers every task in the milestone. A task must not appear as "blocked by" a task that is not itself listed in the sequence table.

### c) Dependency diagram

A `drawio.svg` file embedded with the standard Obsidian embed syntax:

```
![[<milestone-slug>-deps.drawio.svg]]
```

The diagram is placed immediately after the dependency table. It renders the same blocking relationships in directed acyclic graph (DAG) form, with edges pointing from blocker to blocked (e.g., JE-5 → JE-6). Node labels include the issue ID plus a short task name (e.g., "JE-5 / Skeleton").

The file lives in `docs/plans/diagrams/` so it is co-located with the plans that reference it. It is generated via `scripts/drawio-to-svg.mjs` and stored as a `.drawio.svg` dual-format file (static SVG + embedded draw.io XML). Governed by [[ADR-0015-drawio-diagrams]].

### d) Phase grouping

Tasks are grouped into named logical phases before the sequence table. A phase is a narrative label describing the nature of the work in each batch — it is not a strict time boundary. Example structure:

| Phase | Issues | Description |
|---|---|---|
| Foundations | JE-5, JE-6 | Skeleton, tooling, templates |
| Shared base | JE-7, JE-8 | Cross-cutting notes, ADRs |

Phases serve as a navigational aid: they let a reader understand the shape of the milestone at a glance before drilling into the detailed sequence and dependency tables.

## Linear reference rules for plan notes

Plan notes extend [[linear-references]]. In addition to the general rules, a milestone plan note MUST:

- Include `milestone/<slug>` in frontmatter tags, where `<slug>` matches the kebab-case slug of the Linear milestone name.
- Include `issue/<ID>` tags for every issue in the milestone (e.g., `issue/JE-5`).
- Include an inline markdown link to the Linear milestone URL in the Summary section prose. This is the single click-through point for live state.
- NOT copy issue descriptions, state (Todo / In Progress / Done), or comments from Linear into the plan note. Those details are fetched on demand via the `linear-pm` agent.

## Rationale

Linear tracks who is working on what and at what state. The vault tracks *design knowledge* — decisions, structures, and relationships that persist after the milestone closes. The logical execution order and blocking graph of a milestone are **design knowledge**, not state: they represent deliberate choices made during planning (task A must precede task B because its output is an input to B). Linear issue lists do not expose this dependency graph navigably; after the milestone closes, the knowledge is effectively lost.

By documenting the sequence and dependency graph in the vault as an evergreen plan note, we preserve:

1. **Onboarding context** — a new team member can understand how a milestone was executed without reading every issue.
2. **Post-mortem material** — retros and lessons can reference the plan note to compare intended sequence with actual execution.
3. **Pattern reuse** — future milestones with similar structure (e.g., "build another service's docs") can copy the phase grouping and dependency template.

The separation between the convention (defined once here in `shared/`) and each concrete plan note (`docs/plans/<slug>.md`) follows the same pattern used by all cross-cutting conventions in this vault: define once, reference by wikilink, never duplicate.

## Related

- [[linear-references]] — general Linear reference rules; this convention extends them.
- [[2026-06-26-3mrai-docs-vault]] — the vault build plan; the first milestone that exposed the need for this convention.
- [[ADR-0015-drawio-diagrams]] — governs the `.drawio.svg` diagram format used in plan notes.
