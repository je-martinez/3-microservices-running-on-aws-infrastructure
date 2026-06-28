---
title: "Skills Catalog"
type: convention
area: shared
status: active
created: 2026-06-28
updated: 2026-06-28
tags:
  - type/convention
  - area/shared
  - status/active
  - issue/JE-23
related:
  - "[[2026-06-28-services-infra-scaffold-design]]"
  - "[[2026-06-28-services-infra-scaffold]]"
  - "[[linear-references]]"
---

# Skills Catalog

This note records the Claude Code skills evaluated and approved for the 3MRAI services and infrastructure agents. It is the deliverable of [JE-23](https://linear.app/je-martinez/issue/JE-23) ("Skill discovery & install") and is the durable record of the candidate-skills catalog produced in the design spec [[2026-06-28-services-infra-scaffold-design]] after validation.

**Important constraints:**

- Skills are installed by the user via `/plugin install` — agents cannot self-install.
- Nothing is installed without explicit user confirmation.
- Reliability legend: 🟢 official (vendor or Anthropic, license verified) — ⚪ community (third-party, vet before install).

---

## Already available (no install)

The following skills ship with the Claude Code harness or are already installed in this repo and are available to all agents immediately:

- **context7** — live documentation for every stack in this project: Fastify, Prisma, EF Core, SQLAlchemy, Terraform.
- **superpowers** — brainstorming, writing-plans, executing-plans, subagent-driven-development, systematic-debugging, test-driven-development, code-review, verification-before-completion, and companion skills.
- **obsidian-\*** — obsidian-markdown, obsidian-bases, obsidian-cli, json-canvas, defuddle (vault authoring).
- **code-review** — inline PR review and fix application.
- **simplify** — reuse, simplification, and efficiency cleanup.
- **skill-creator** — author new skills.
- **commit-commands** — commit, push, and PR automation.
- **claude-md-management** — CLAUDE.md revision and improvement.
- **linear** — Linear PM agent skill (via `linear-pm`).
- **github** — GitHub operations skill (via `github-ops`).
- **codex** — Codex CLI runtime, rescue, and setup.

---

## Tier 1 — Approved for install (official, license verified)

🟢 These skills come from official vendor repositories or AWS samples. Licenses have been verified.

| Skill | Install command | License | Used by |
|---|---|---|---|
| terraform-skill (Anton Babenko, AWS Hero) | `/plugin marketplace add antonbabenko/agent-plugins` then `/plugin install terraform-skill@antonbabenko` | Apache-2.0 | infra |
| mongodb (official MongoDB) | `/plugin install mongodb` | Apache-2.0 | events-pipeline (DocumentDB) |
| aws-dev-toolkit (AWS samples) | `/plugin marketplace add aws-samples/sample-claude-code-plugins-for-startups` then `/plugin install aws-dev-toolkit@aws-samples` | AWS samples repo (verify before install) | infra + events-pipeline |

> [!warning] DocumentDB scope for the MongoDB skill
> For DocumentDB, use ONLY the MongoDB plugin's **Schema Design** and **Query Optimizer** skills. Atlas-specific skills (Stream Processing, Atlas Search) do NOT apply to Amazon DocumentDB and must not be used.

---

## Tier 2 — Candidates (community — vet before install)

⚪ These skills come from community authors. Review the source repository, license, and contents before installing.

| Service | Skill | Source |
|---|---|---|
| Users | fastify-best-practices (mcollina — Fastify author) + prisma-postgres (prisma/skills, official) | mcollina/skills · prisma/skills |
| Orders | .NET Claude Kit or dotnet-skills (EF Core) | codewithmukesh / Aaronontheweb |
| Tracking | fastapi-pro (SQLAlchemy 2.0 + Pydantic v2) | community |
| Orders + Tracking (MySQL) | planetscale/database-skills `--skill mysql` | PlanetScale |
| Cross-cutting DB | database-designer (indexes, soft-delete, replicas) | alirezarezvani |

---

## Where to find more skills

See the appendix "Where to search for skills" in [[2026-06-28-services-infra-scaffold-design]] for the full source list: official vendor registries, marketplace aggregators (including skillsmp.com), and community awesome lists.

---

## Caveat

SkillsMP is a massive aggregator (~1.8M entries) with low signal-to-noise ratio and significant duplicate content. One entry (`mysql-patterns`, shown as "219.4k★") is almost certainly a page error — this figure is not credible for a skills repository. That entry is treated as **UNVERIFIED** and is not recommended for use in this project.

---

## Related

- [[2026-06-28-services-infra-scaffold-design]] — the design spec whose candidate-skills catalog this note records after validation.
- [[2026-06-28-services-infra-scaffold]] — the implementation plan that includes this catalog as Task 7.
- [[linear-references]] — Linear reference convention (tags + inline links, no mirroring).
