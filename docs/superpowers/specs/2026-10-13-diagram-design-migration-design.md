---
title: "Diagram-Design Migration — Handoff (Draft)"
type: spec
area: shared
status: draft
created: 2026-10-13
updated: 2026-10-13
tags:
  - type/spec
  - area/shared
  - status/draft
related:
  - "[[2026-10-07-aws-style-diagrams-design]]"
  - "[[2026-10-06-remotion-diagrams-design]]"
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[diagrams]]"
  - "[[diagram-legibility]]"
propagates-to: none — draft handoff; targets decided when the migration is designed
---

# Diagram-design migration — handoff (draft)

## Intent (user, 2026-10-13)

Replace Remotion as the diagram tool with the `diagram-design` skill (Claude Code plugin skill `diagram-design:diagram-design`, with helpers `diagram-design:export-diagram`, `diagram-design:import-drawio`, `diagram-design:import-mermaid`, `diagram-design:profile`, `diagram-design:doctor`). It produces architecture/flow/sequence/etc. diagrams as standalone HTML/SVG/PNG with brand tokens and optional accessible motion. The migration has NOT been designed yet: the next session starts with `superpowers:brainstorming`.

## Current state to migrate from (branch feature/remotion-diagrams, PR #130 open, not merged)

- Package `diagrams/` (Remotion 4.0.533, ELK `elkjs` layered layout, one `AwsDiagram` primitive; zod schema with groups/nodes/edges/steps, group endpoints, `ecs-cluster` group, VPC AZ `lanes`, `compact` layout option). Official AWS group/generic/resource icons are fetched by `make diagrams-icons` (`diagrams/scripts/fetch_aws_icons.py`) into `diagrams/public/aws-icons`; service icons come from `@nxavis/aws-icons` behind `diagrams/src/theme/aws-icons.ts`.
- 29 catalog entries (`diagrams/src/catalog.ts` aggregating `diagrams/src/data/*.catalog.ts`, each with `source` + `watches`): architecture dev-floci + preprod and system-context L2, each split into a request-path view and an `-events` view; system-context L1; 19 flows (GIF + PNG with numbered steps); 3 milestone dependency graphs (PNG, DOWN). Renders live beside their owning notes in `docs/**/diagrams/` and are embedded there.
- Tooling: `make diagrams-render [ID=…]`, `make diagrams-studio`, `make diagrams-check` (non-blocking drift check vs `watches`, `source` and shared render code; run by spec-implementation-audit). Tests include real-ELK layout tests, a catalog quality gate (`aws-catalog-quality.test.ts`) and a split-views coverage test (`split-views.test.ts`).
- Agent `diagram-impl` (`.claude/agents/diagram-impl.md`, `diagrams/CLAUDE.md`); Remotion skills in `.ai/skills` propagated to all providers.
- Conventions and decisions: [[diagrams]] (including the PR `## Diagrams` rule in [[git-workflow]], the keep-current rule, and the coverage rule: every runtime AWS service gets a node; deploy-time resources only in the terraform-two-phase-apply flow), [[ADR-0023-remotion-diagrams]] (supersedes ADR-0015 draw.io; style revision 2026-10-07), lesson [[diagram-legibility]].

## Requirements that must survive the tool change (user-confirmed)

- AWS reference-architecture look (https://docs.aws.amazon.com/reference-architecture-diagrams/): nested groups (AWS Cloud, Region, VPC with AZ lanes, subnets), ECS cluster frame with Fargate tasks, official icons with labels below, orthogonal connectors (dashed for async).
- Entry on the left: Browser, API Gateway, ALB, ECS, data, events. At most ~2000 px wide.
- Every runtime AWS resource represented; no resource drawn twice.
- Flows with numbered steps (animated, exportable to GIF, was the original ask).
- Keep-current drift detection and the PR attachment rule.

## Open questions for the design session

- Does diagram-design cover animation/GIF export for flows, or do flows stay animated some other way (or become static step-numbered diagrams)?
- Can diagram-design reproduce the AWS look (official AWS icons, nested group frames, AZ lanes), or does it need a brand profile / custom tokens?
- What happens to the `diagrams/` package, the catalog/`watches` drift check, the quality gates, `diagram-impl`, the Remotion skills, and ADR-0023 (supersede with a new ADR?).
- Which source format is committed (HTML/SVG source plus exported PNG/GIF?) and how do embeds in the vault change?
- Does PR #130 merge first (Remotion) with the migration following on a new branch, or does the migration land on the same branch before merge?

## Related

- [[2026-10-07-aws-style-diagrams-design]]
- [[2026-10-06-remotion-diagrams-design]]
- [[ADR-0023-remotion-diagrams]]
- [[diagrams]]
- [[diagram-legibility]]
- [[git-workflow]]
