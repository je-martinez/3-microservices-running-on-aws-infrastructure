---
title: 3MRAI — Early Vault Notes
type: reference
area: shared
status: active
created: 2026-06-26
updated: 2026-06-26
tags: [type/reference, area/shared, status/active]
---

## Folder map

| Folder | Purpose |
|---|---|
| [`specs/`](specs/) | Design specs — the "what & why" output of brainstorming/planning sessions. Pairs with a plan: **spec = design, plan = execution**. Use `spec-template.md`. |
| [`plans/`](plans/) | Active plans for in-flight work. Use `plan-template.md`. |
| [`plans/archive/`](plans/archive/) | Completed/abandoned plans, named `YYYY-MM-DD-short-title.md`. |
| [`lessons/`](lessons/) | Durable lessons from past iterations (one lesson per file). |
| [`decisions/`](decisions/) | Architecture Decision Records (ADRs), numbered `ADR-NNNN`. |
| [`retros/`](retros/) | Iteration / sprint retrospectives. |
| [`ideas/`](ideas/) | Loose notes on things worth exploring later. |
| [`testing/`](testing/) | Manual smoke-test playbooks per phase. |
| [`onboarding/`](onboarding/) | End-user / new-dev setup guides — start with [`new-contributor-quickstart.md`](onboarding/new-contributor-quickstart.md). Evergreen, no date prefix. |
| [`runbooks/`](runbooks/) | Owner-run manual procedures — OAuth flows, external dashboards, permission grants. Evergreen (no date prefix). Use `runbook-template.md`. Integration runbooks carry `integration` tag + `integration-status` / `verified-on` / `verified-by` fields (see below). |
| [`templates/`](templates/) | Frontmatter + skeleton for each note type. |

## Conventions

- **Wiki links:** `[[note-name]]` for cross-references inside the vault.
- **Tags:** `#lesson`, `#decision`, `#area/<subsystem>`, `#severity/<low|medium|high>`, `#phase/<n>`. Use folder-style tags for facets.
- **Filenames:** `YYYY-MM-DD-short-title.md` for dated notes (lessons, retros, archived plans). ADRs use `ADR-NNNN-title.md`.
- **Frontmatter:** every note has YAML frontmatter (start from a [template](templates/)). See the per-type field set below.

## Related

- [[00-overview/index|Vault Index]]