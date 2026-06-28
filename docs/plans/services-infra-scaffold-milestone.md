---
title: "Services & Infra Scaffold — Milestone Plan"
type: plan
area: shared
status: active
created: 2026-06-28
updated: 2026-06-28
tags:
  - type/plan
  - area/shared
  - status/active
  - milestone/services-infra-scaffold
  - issue/JE-17
  - issue/JE-18
  - issue/JE-19
  - issue/JE-20
  - issue/JE-21
  - issue/JE-22
  - issue/JE-23
  - issue/JE-24
related:
  - "[[milestone-plan]]"
  - "[[linear-references]]"
  - "[[2026-06-28-services-infra-scaffold]]"
  - "[[2026-06-28-services-infra-scaffold-design]]"
  - "[[ADR-0015-drawio-diagrams]]"
---

# Services & Infra Scaffold — Milestone Plan

This plan documents the logical execution order and blocking relationships for the **Services & Infra Scaffold** milestone: creating the physical scaffold of the four microservices (Users, Orders, Tracking, events-pipeline) and the Terraform/AWS infrastructure layer. The milestone covers screaming-architecture folder skeletons, a nested `CLAUDE.md` per service and infra, a per-service skeleton `Dockerfile`, a root `docker-compose.yml` orchestrator that wires all services on a shared network with docker-watch, a skill-discovery/install proposal for the tooling needed by implementer agents, and the install and preloading of those skills (Tier-2 via npx) into each implementer agent. No application code is written in this milestone — only structure. Live issue state is the source of truth in Linear — see the [Services & Infra Scaffold milestone](https://linear.app/je-martinez/milestone/43a18a43-eec4-4b72-b204-b94ae007728f) for current status. This note documents only structural design knowledge: task order and blocking relationships.

This plan follows the [[milestone-plan]] convention. Detailed task content lives in the implementation plan [[2026-06-28-services-infra-scaffold]] and the design spec [[2026-06-28-services-infra-scaffold-design]].

## Logical phases

| Phase | Issues | Description |
|---|---|---|
| Service scaffolds | JE-17, JE-18, JE-19, JE-20 | Folder skeletons + nested CLAUDE.md + skeleton Dockerfile for the four microservices (Users, Orders, Tracking, events-pipeline) |
| Infrastructure | JE-21 | Terraform module + environment skeleton + nested CLAUDE.md |
| Orchestration | JE-22 | Root docker-compose.yml wiring the four services on one network with docker-watch |
| Tooling | JE-23, JE-24 | JE-23: validate the candidate-skills catalog and propose installs (user-confirmed); JE-24: install & normalize service skills (Tier-2 via npx) and preload them per implementer agent |

## Task sequence

| # | Issue | Task | Deliverable | Spec note |
|---|---|---|---|---|
| 1 | [JE-17](https://linear.app/je-martinez/issue/JE-17) | Users service scaffold + nested CLAUDE.md | `services/users/` skeleton, `CLAUDE.md`, `Dockerfile` | [[2026-06-28-services-infra-scaffold-design]] |
| 2 | [JE-18](https://linear.app/je-martinez/issue/JE-18) | Orders service scaffold + nested CLAUDE.md | `services/orders/` skeleton, `CLAUDE.md`, `Dockerfile` | [[2026-06-28-services-infra-scaffold-design]] |
| 3 | [JE-19](https://linear.app/je-martinez/issue/JE-19) | Tracking service scaffold + nested CLAUDE.md | `services/tracking/` skeleton, `CLAUDE.md`, `Dockerfile` | [[2026-06-28-services-infra-scaffold-design]] |
| 4 | [JE-20](https://linear.app/je-martinez/issue/JE-20) | events-pipeline scaffold + nested CLAUDE.md | `services/events-pipeline/` skeleton, `CLAUDE.md`, `Dockerfile` | [[2026-06-28-services-infra-scaffold-design]] |
| 5 | [JE-21](https://linear.app/je-martinez/issue/JE-21) | Terraform infra scaffold + nested CLAUDE.md | `infra/` modules + environments, `CLAUDE.md`, `README.md` | [[2026-06-28-services-infra-scaffold-design]] |
| 6 | [JE-22](https://linear.app/je-martinez/issue/JE-22) | Root docker-compose orchestrator | `docker-compose.yml` (repo root) | [[2026-06-28-services-infra-scaffold-design]] |
| 7 | [JE-23](https://linear.app/je-martinez/issue/JE-23) | Skill discovery & install proposal | Prioritized install proposal (user-confirmed); optional `docs/shared/conventions/skills-catalog.md` | [[2026-06-28-services-infra-scaffold-design]] |
| 8 | [JE-24](https://linear.app/je-martinez/issue/JE-24) | Install & normalize service skills (Tier-2 via npx) + preload per implementer | 8 npx skills in `.claude/skills/` + `skills-lock.json`; 5 implementers get `skills: preload`; `skills-catalog.md` updated | [[2026-06-28-services-infra-scaffold-design]] |

## Dependencies

### Dependency table

| Task | Blocked by |
|---|---|
| JE-17 | — |
| JE-18 | — |
| JE-19 | — |
| JE-20 | — |
| JE-21 | — |
| JE-22 | JE-17, JE-18, JE-19, JE-20 |
| JE-23 | — |
| JE-24 | JE-23 |

### Dependency diagram

![[services-infra-scaffold-deps.drawio.svg]]

The five scaffold tasks (JE-17 through JE-21) have no blockers and can run in parallel. JE-22 (root docker-compose) is blocked by the four service scaffolds JE-17–JE-20 because its `build:` contexts reference each service's `Dockerfile`; those files must exist before the compose file can reference them. JE-23 (skill discovery) is independent and can run at any time during the milestone. JE-24 (skill install & preload) is blocked by JE-23 — skills must be cataloged and the install proposal confirmed before they can be installed via npx and preloaded into each implementer agent. Note that infra (JE-21) does not block docker-compose since the compose file only wires the four application services — Terraform is a separate deployment concern.

## Related

- [[milestone-plan]] — convention this plan follows.
- [[linear-references]] — Linear reference convention.
- [[2026-06-28-services-infra-scaffold]] — the implementation plan with detailed task steps.
- [[2026-06-28-services-infra-scaffold-design]] — the design spec specifying each deliverable.
- [[ADR-0015-drawio-diagrams]] — governs the `.drawio.svg` diagram format.
