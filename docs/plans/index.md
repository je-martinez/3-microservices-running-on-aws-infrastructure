---
title: 3MRAI Plans — Index
type: spec
area: shared
status: active
created: 2026-06-26
updated: 2026-06-28
tags: [type/spec, area/shared, status/active]
related:
  - "[[2026-06-26-implementation-workflow]]"
  - "[[2026-06-26-3mrai-docs-vault]]"
  - "[[documentation-vault-milestone]]"
  - "[[2026-06-28-services-infra-scaffold]]"
  - "[[services-infra-scaffold-milestone]]"
  - "[[2026-06-28-users-service]]"
  - "[[users-service-milestone]]"
---

# 3MRAI Plans — Index

Map of Content for implementation plans in the **3 Microservices Running on AWS Infrastructure (3MRAI)** vault. Plans are produced through `writing-plans` and kept under `docs/superpowers/plans/` (the plugin reads from there); they are normalized to vault conventions and indexed here.

## Plans

- [[2026-06-26-implementation-workflow]] — stand up the implementation-time agent topology (`solutions-architect` planner + five code-only implementers) and document the two-layer flow in the root `CLAUDE.md`.
- [[2026-06-26-3mrai-docs-vault]] — build the Obsidian documentation vault under `docs/` (folder skeleton, templates, cross-cutting notes, ADRs, service specs, infrastructure docs, Bases).
- [[documentation-vault-milestone]] — logical execution plan for the Documentation Vault milestone: task sequence, phases, and blocking dependency graph for JE-5 through JE-15.
- [[2026-06-28-services-infra-scaffold]] — scaffold the four microservices (Users, Orders, Tracking, events-pipeline) and Terraform/AWS infrastructure: folder skeletons, nested `CLAUDE.md` files, per-service `Dockerfile`, root `docker-compose.yml`, and skill discovery.
- [[services-infra-scaffold-milestone]] — logical execution plan for the Services & Infra Scaffold milestone: task sequence, phases, and blocking dependency graph for JE-17 through JE-23.
- [[2026-06-28-users-service]] — implementation plan for the Users Service milestone: pnpm tooling, Prisma schema, Fastify API, Terraform modules, and Playwright E2E suite.
- [[users-service-milestone]] — logical execution plan for the Users Service milestone: task sequence, phases, and blocking dependency graph for JE-25 through JE-37.

## Related

- [[2026-06-26-implementation-workflow]]
- [[2026-06-26-3mrai-docs-vault]]
- [[documentation-vault-milestone]]
- [[2026-06-28-services-infra-scaffold]]
- [[services-infra-scaffold-milestone]]
- [[2026-06-28-users-service]]
- [[users-service-milestone]]
