---
title: Milestone Plan Convention — Design
type: spec
area: shared
status: draft
created: 2026-06-27
updated: 2026-06-27
tags:
  - type/spec
  - area/shared
  - status/draft
related:
  - "[[linear-references]]"
  - "[[2026-06-26-3mrai-docs-vault]]"
  - "[[ADR-0015-drawio-diagrams]]"
---

# Milestone Plan Convention — Design

Design for a reusable vault convention that captures the **logical execution plan** of a milestone — task sequence, phases, and dependency graph — as a first-class vault artifact, distinct from the live issue state that lives in Linear.

## Problem

When a milestone is executed across multiple Linear issues, the logical ordering and blocking relationships between tasks exist only in the heads of the people who planned the work and in the Linear issue list (which does not expose dependency graphs navigably). After execution, that sequencing knowledge is lost. The vault documents architectural decisions and specs, but has no norm for documenting *how a milestone's issues fit together* — which tasks must run before others and why.

The "Documentation Vault" milestone exposed this gap: eleven issues were executed in a deliberate order with explicit dependencies (`JE-5` must complete before `JE-6`; `JE-6` gates all content tasks; etc.), but that knowledge lives only in Linear, not in the vault.

## Goal

Define a **reusable convention** (`shared/conventions/milestone-plan.md`) for milestone plan notes and produce the first instance of it (`plans/documentation-vault-milestone.md`) as a worked example, so that every future milestone enters the vault with its logical plan documented.

## Scope

In scope:
- The convention note that defines what a milestone plan must contain.
- The concrete plan note for the "Documentation Vault" milestone.
- A dependency diagram for that milestone, embedded in the plan note.
- An index entry in `docs/plans/index.md` pointing to the plan note.

Out of scope:
- Changes to how Linear issues are managed or tracked.
- Any modification to existing spec or ADR notes.
- Automation for generating plan notes from Linear data.

## Artefacts

This spec authorizes the creation of three artefacts. They are **not** created by this spec itself — they are the deliverable of the implementation issue that follows.

### 1. Convention — `docs/shared/conventions/milestone-plan.md`

- **Frontmatter:** `type: convention`, `area: shared`, `status: active`.
- **Filename:** `milestone-plan.md` (evergreen, no date).
- **Purpose:** define what every milestone plan note must contain and explain *why* the vault documents this rather than relying on Linear alone.

The convention body covers four required sections for every milestone plan note:

**a) Task sequence** — an ordered table with columns: order rank, task name, key deliverable, and a wikilink to the relevant spec note (if one exists). No status column. The sequence is evergreen design knowledge; live status is fetched from Linear on demand.

**b) Dependency table** — a two-column table (`task` | `blocked by`) listing every blocking relationship. A task with no blockers lists "—".

**c) Dependency diagram** — a `drawio.svg` file embedded with `![[...]]`, generated via the `scripts/drawio-to-svg.mjs` pipeline. The diagram renders the same blocking relationships as the dependency table in graph form. Governed by [[ADR-0015-drawio-diagrams]].

**d) Phase grouping** — tasks grouped into named logical phases (e.g., Foundations, Shared base, Service specs, Overview, Bases). Phases are narrative labels that describe the nature of the work in each batch; they are not strict time boundaries.

The convention also documents the **Linear reference rules** that apply to plan notes:

- Tag the note with `milestone/<slug>` (matching the Linear milestone slug) and any relevant `issue/<ID>` tags.
- Include an inline markdown link to the Linear milestone URL in the plan's prose summary.
- Do **not** copy issue descriptions, state, or comments — that detail lives in Linear and is fetched on demand via the `linear-pm` agent.
- Do **not** add a status column to the sequence table — status is live data and belongs in Linear, not in the vault.

The rationale section of the convention explains the separation of concerns: *logical order and blocking relationships are design knowledge that persists after the milestone closes; Linear does not expose this graph navigably; the vault documents it once as an evergreen plan*.

The convention explicitly extends [[linear-references]]: it inherits all Linear reference rules and adds the milestone-plan-specific structure on top.

### 2. Concrete plan — `docs/plans/documentation-vault-milestone.md`

- **Frontmatter:** `type: plan`, `area: shared`, `status: active`, tags include `milestone/documentation-vault` and `issue/JE-5` through `issue/JE-15`.
- **Filename:** `documentation-vault-milestone.md` (evergreen — it describes a milestone, not a dated event).

The plan note contains five sections:

**i) Summary** — one paragraph describing the milestone goal (build the 3MRAI Obsidian documentation vault) with an inline markdown link to the Linear milestone.

**ii) Logical phases** — a brief description of each phase and which issues belong to it:

| Phase | Issues | Description |
|---|---|---|
| Foundations | JE-5, JE-6 | Skeleton + validator; note templates |
| Shared base | JE-7, JE-8 | Cross-cutting conventions/patterns; ADRs |
| Service specs | JE-9, JE-10, JE-11, JE-12, JE-13 | Four service specs + infrastructure |
| Overview | JE-14 | Root MOC, architecture, context, glossary |
| Bases | JE-15 | Obsidian Bases (.base files) |

**iii) Task sequence table** — ordered by execution, with columns: rank, issue reference (linked), task name, key deliverable, related spec wikilink. No status column. The issue references are inline markdown links to the Linear issue URLs (e.g. `[JE-5](https://linear.app/...)`), consistent with [[linear-references]].

Full sequence:

| # | Issue | Task | Deliverable | Spec note |
|---|---|---|---|---|
| 1 | JE-5 | Folder skeleton + validator | Folder tree + `validate-vault.mjs` | [[2026-06-26-3mrai-docs-vault]] |
| 2 | JE-6 | Note templates | 8 template files in `docs/templates/` | [[2026-06-26-3mrai-docs-vault]] |
| 3 | JE-7 | Shared conventions, patterns & observability | 9 notes in `docs/shared/` | [[2026-06-26-3mrai-docs-vault]] |
| 4 | JE-8 | ADRs (ADR-0001 – ADR-0015) | 15 ADR files in `docs/shared/decisions/` | [[2026-06-26-3mrai-docs-vault]] |
| 5 | JE-9 | Users service spec | `docs/domains/users/specs/users-service-design.md` | [[2026-06-26-3mrai-docs-vault]] |
| 6 | JE-10 | Orders service spec | `docs/domains/orders/specs/orders-service-design.md` | [[2026-06-26-3mrai-docs-vault]] |
| 7 | JE-11 | Tracking service spec | `docs/domains/tracking/specs/tracking-service-design.md` | [[2026-06-26-3mrai-docs-vault]] |
| 8 | JE-12 | Events pipeline spec | `docs/domains/events-pipeline/specs/events-pipeline-design.md` | [[2026-06-26-3mrai-docs-vault]] |
| 9 | JE-13 | Infrastructure specs & runbooks | 5 files in `docs/infrastructure/` | [[2026-06-26-3mrai-docs-vault]] |
| 10 | JE-14 | Overview MOC (index, architecture, context, glossary) | 4 files in `docs/00-overview/` | [[2026-06-26-3mrai-docs-vault]] |
| 11 | JE-15 | Obsidian Bases | 3 `.base` files in `docs/00-overview/` | [[2026-06-26-3mrai-docs-vault]] |

**iv) Dependency table and diagram** — the full blocking graph:

| Task | Blocked by |
|---|---|
| JE-5 | — |
| JE-6 | JE-5 |
| JE-7 | JE-6 |
| JE-8 | JE-7 |
| JE-9 | JE-6 |
| JE-10 | JE-6 |
| JE-11 | JE-6 |
| JE-12 | JE-6 |
| JE-13 | JE-6 |
| JE-14 | JE-9, JE-10, JE-11, JE-12, JE-13 |
| JE-15 | JE-14 |

The diagram file `docs/plans/diagrams/documentation-vault-deps.drawio.svg` is embedded immediately after the table:

```
![[documentation-vault-deps.drawio.svg]]
```

**v) Related** — wikilinks to [[linear-references]], [[milestone-plan]], [[2026-06-26-3mrai-docs-vault]], and [[ADR-0015-drawio-diagrams]].

This plan note is indexed from `docs/plans/index.md`.

### 3. Dependency diagram — `docs/plans/diagrams/documentation-vault-deps.drawio.svg`

A directed acyclic graph showing the blocking relationships in the documentation-vault milestone. Node labels use the issue ID plus a short task name (e.g., "JE-5 / Skeleton"). Edges point from blocker to blocked (e.g., JE-5 → JE-6). The graph is organized top-to-bottom following the phase grouping.

Dependency edges to encode:

```
JE-5 → JE-6
JE-6 → JE-7
JE-6 → JE-9
JE-6 → JE-10
JE-6 → JE-11
JE-6 → JE-12
JE-6 → JE-13
JE-7 → JE-8
JE-9 → JE-14
JE-10 → JE-14
JE-11 → JE-14
JE-12 → JE-14
JE-13 → JE-14
JE-14 → JE-15
```

The file is generated via `scripts/drawio-to-svg.mjs` and stored as a `.drawio.svg` dual-format file (static SVG + embedded draw.io XML), consistent with [[ADR-0015-drawio-diagrams]]. It lives in `docs/plans/diagrams/` so it is co-located with the plan that references it.

## Key Decisions

### Separation: convention vs. instance

The rule lives once in `docs/shared/conventions/milestone-plan.md`; each concrete plan is a separate note in `docs/plans/`. Service specs and plan notes reference the convention by wikilink, never duplicate it. This is the same pattern used by [[linear-references]] and all other cross-cutting conventions.

### No status column in plan notes

Issue status (Done / In Progress / Todo) is live data. Copying it into the vault creates stale information with no mechanism for sync. The vault documents *structure* — order and dependencies — and points to Linear for *state*. This is a direct application of rule 3 in [[linear-references]]: "Detail is fetched, never copied."

### Linear references in plan notes

Plan notes carry `milestone/<slug>` and `issue/<ID>` tags so they are queryable in Obsidian Bases (e.g., filter all notes tagged `milestone/documentation-vault`). The inline link to the Linear milestone URL is the only place live state is one click away. No issue descriptions or comments are stored.

### Diagram format: draw.io SVG

The dependency graph is stored as `.drawio.svg` rather than as a Mermaid block. This is consistent with [[ADR-0015-drawio-diagrams]]: static SVG renders on GitHub without a plugin; the draw.io XML embedded in the file remains editable; the Obsidian Diagrams plugin renders it interactively.

### Implementation as a new Linear issue

The work described by this spec (writing the convention, the plan note, and the diagram) is scoped as a new Linear issue in the "Documentation Vault" milestone. It follows the standard branch → implementation → PR flow. The `obsidian-vault` agent is the sole writer of the resulting vault notes.

### Filename of the concrete plan

`documentation-vault-milestone.md` — evergreen kebab-case, no date prefix. The plan describes a milestone (a structural artifact), not a time-bound event like a retro. Date-prefixed filenames are reserved for lessons, retros, and archived plans.

## Self-Review

- No TBD or TODO placeholders. Every artefact section specifies exact filenames, frontmatter values, section structure, table columns, and content. The implementer can work from this spec without further design decisions.
- Scope is tight: three files plus one index entry. Nothing else is created by the implementation issue.
- The convention and the plan are consistent: the convention defines "no status column" and "milestone/issue tags"; the plan note description follows both rules exactly.
- The diagram edges listed are consistent with the phase grouping and the dependency table. The set `{JE-9, JE-10, JE-11, JE-12, JE-13}` appears in both the "Service specs" phase and as the five blockers of JE-14.
- Wikilinks reference notes that exist in the vault: [[linear-references]] (`docs/shared/conventions/linear-references.md`), [[ADR-0015-drawio-diagrams]] (`docs/shared/decisions/ADR-0015-drawio-diagrams.md`), [[2026-06-26-3mrai-docs-vault]] (`docs/superpowers/plans/2026-06-26-3mrai-docs-vault.md`). The not-yet-created notes ([[milestone-plan]], [[documentation-vault-milestone]]) are intentional forward references — they are the deliverable of the implementation issue.
- The spec does not touch git, Linear, or any existing vault note.

## Related

- [[linear-references]] — convention this work extends; defines the "no status copy" rule and issue/milestone tag syntax.
- [[2026-06-26-3mrai-docs-vault]] — the vault implementation plan; the "Documentation Vault" milestone this spec refers to.
- [[ADR-0015-drawio-diagrams]] — diagram format decision; governs the `.drawio.svg` artefact specified here.
