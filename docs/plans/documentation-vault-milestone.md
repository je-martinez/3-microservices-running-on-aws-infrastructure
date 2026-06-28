---
title: Documentation Vault — Milestone Plan
type: plan
area: shared
status: active
created: 2026-06-27
updated: 2026-06-27
tags:
  - type/plan
  - area/shared
  - status/active
  - milestone/documentation-vault
  - issue/JE-5
  - issue/JE-6
  - issue/JE-7
  - issue/JE-8
  - issue/JE-9
  - issue/JE-10
  - issue/JE-11
  - issue/JE-12
  - issue/JE-13
  - issue/JE-14
  - issue/JE-15
related:
  - "[[milestone-plan]]"
  - "[[linear-references]]"
  - "[[2026-06-26-3mrai-docs-vault]]"
  - "[[ADR-0015-drawio-diagrams]]"
---

# Documentation Vault — Milestone Plan

This plan documents the logical execution order and blocking relationships for the **Documentation Vault** milestone: building the Obsidian vault under `docs/` for the 3 Microservices Running on AWS Infrastructure (3MRAI) project. The milestone covers folder skeleton, validator, note templates, cross-cutting shared notes, ADRs, four service specs, infrastructure documentation, root overview notes, and Obsidian Bases. Live issue state is the source of truth in Linear — see the [Documentation Vault milestone](https://linear.app/je-martinez/milestone/6f1ef0eb-a507-4a2d-a35e-c084412a6185) for current status. This note documents only the structural design knowledge: task order and blocking relationships.

> [!note] Meta-task
> [JE-16](https://linear.app/je-martinez/issue/JE-16) (this convention + plan note) is a meta-documentation task that runs alongside the main sequence. It is not a blocker for any core task and is not listed in the sequence below.

This plan follows the [[milestone-plan]] convention.

## Logical phases

| Phase | Issues | Description |
|---|---|---|
| Foundations | JE-5, JE-6 | Folder skeleton, vault validator, and note templates — the structural prerequisite for all content work |
| Shared base | JE-7, JE-8 | Cross-cutting conventions, patterns, and observability notes; then all 15 global ADRs |
| Service specs | JE-9, JE-10, JE-11, JE-12, JE-13 | Four service design specs (Users, Orders, Tracking, Events pipeline) and infrastructure specs/runbooks |
| Overview | JE-14 | Root Map of Content: index, architecture diagram, system context, glossary |
| Bases | JE-15 | Three Obsidian Bases (`.base` files) enabling queryable views over the vault |

## Task sequence

| # | Issue | Task | Deliverable | Spec note |
|---|---|---|---|---|
| 1 | [JE-5](https://linear.app/je-martinez/issue/JE-5) | Folder skeleton + vault validator | Folder tree under `docs/`; `scripts/validate-vault.mjs` | [[2026-06-26-3mrai-docs-vault]] |
| 2 | [JE-6](https://linear.app/je-martinez/issue/JE-6) | Note templates | 8 template files in `docs/templates/` | [[2026-06-26-3mrai-docs-vault]] |
| 3 | [JE-7](https://linear.app/je-martinez/issue/JE-7) | Shared conventions, patterns & observability | 9 notes across `docs/shared/` | [[2026-06-26-3mrai-docs-vault]] |
| 4 | [JE-8](https://linear.app/je-martinez/issue/JE-8) | ADRs (ADR-0001 – ADR-0015) | 15 ADR files in `docs/shared/decisions/` | [[2026-06-26-3mrai-docs-vault]] |
| 5 | [JE-9](https://linear.app/je-martinez/issue/JE-9) | Users service spec | `docs/domains/users/specs/users-service-design.md` | [[users-service-design]] |
| 6 | [JE-10](https://linear.app/je-martinez/issue/JE-10) | Orders service spec | `docs/domains/orders/specs/orders-service-design.md` | [[orders-service-design]] |
| 7 | [JE-11](https://linear.app/je-martinez/issue/JE-11) | Tracking service spec | `docs/domains/tracking/specs/tracking-service-design.md` | [[tracking-service-design]] |
| 8 | [JE-12](https://linear.app/je-martinez/issue/JE-12) | Events pipeline spec | `docs/domains/events-pipeline/specs/events-pipeline-design.md` | [[events-pipeline-design]] |
| 9 | [JE-13](https://linear.app/je-martinez/issue/JE-13) | Infrastructure specs & runbooks | 5 files in `docs/infrastructure/` | [[terraform-modules]], [[networking]], [[aws-resources]] |
| 10 | [JE-14](https://linear.app/je-martinez/issue/JE-14) | Overview MOC | 4 files in `docs/00-overview/`: index, architecture, system-context, glossary | [[index]], [[architecture]], [[system-context]], [[glossary]] |
| 11 | [JE-15](https://linear.app/je-martinez/issue/JE-15) | Obsidian Bases | 3 `.base` files in `docs/00-overview/`: `specs.base`, `adrs.base`, `runbooks.base` | [[2026-06-26-3mrai-docs-vault]] |

## Dependencies

### Dependency table

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

### Dependency diagram

![[documentation-vault-deps.drawio.svg]]

The diagram shows the DAG of blocking relationships. JE-6 (Templates) is the main gate: it unblocks all five service-spec tasks in parallel (JE-9 through JE-13). JE-14 (Overview MOC) cannot start until all five service specs complete, since the overview links to each of them. JE-15 (Bases) depends on JE-14 because the Base views query frontmatter fields that only exist after all content notes are in place. JE-7 and JE-8 (Shared base) are sequential with each other but run independently from the service specs once JE-6 is done.

## Related

- [[milestone-plan]] — convention this plan follows; defines table structure and Linear reference rules.
- [[linear-references]] — general Linear reference convention; tags and inline links.
- [[2026-06-26-3mrai-docs-vault]] — the vault build plan that specifies each deliverable in detail.
- [[ADR-0015-drawio-diagrams]] — governs the `.drawio.svg` diagram format.
