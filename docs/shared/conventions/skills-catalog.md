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
  - issue/JE-24
related:
  - "[[2026-06-28-services-infra-scaffold-design]]"
  - "[[2026-06-28-services-infra-scaffold]]"
  - "[[linear-references]]"
---

# Skills Catalog

This note records the Claude Code skills **actually installed** in the 3MRAI repo and the method used to install each one. It is the deliverable of [JE-23](https://linear.app/je-martinez/issue/JE-23) ("Skill discovery & install") and [JE-24](https://linear.app/je-martinez/issue/JE-24) ("Services & infra scaffold"), and supersedes the candidate-skills catalog produced during design spec [[2026-06-28-services-infra-scaffold-design]].

---

## Install mechanisms

Two distinct install mechanisms exist in Claude Code. Knowing which one applies determines where a skill ends up and how it is versioned:

**npx Agent Skills**
Installed via `npx skills add <repo> --skill <name>`. The skill file lands in `.claude/skills/` and the version is pinned in `skills-lock.json`. This is the preferred mechanism for plain Agent Skills because it is version-controlled per skill, auditable in git, and requires no server running.

**Claude Code plugins**
Installed via `/plugin install`. Registration is written into `.claude/settings.json`. Use this mechanism **only** when the package bundles an MCP server (live tool access) or embedded sub-agents that `npx` cannot carry — installing such a package with `npx` would deliver only the `SKILL.md` text file and miss the runtime components entirely.

**Decision rule:** prefer `npx` when the package is a plain Agent Skill. Use `/plugin` only when the package bundles an MCP server or agents.

> [!tip] Why terraform moved from plugin to npx
> The `terraform-skill` from Anton Babenko was initially evaluated as a plugin candidate. Because it is a plain Agent Skill (no MCP server, no embedded agents), it was converted to npx install — version-controlled in `.claude/skills/` and pinned in `skills-lock.json`. The `mongodb` and `aws-dev-toolkit` packages stayed as plugins because they bundle runtime components that npx cannot install.

---

## Installed — npx Agent Skills

These skills are installed in `.claude/skills/` and pinned in `skills-lock.json`.

| Skill | Source repo | Used by |
|---|---|---|
| `fastify-best-practices` | mcollina/skills | Users service |
| `prisma-postgres` | prisma/skills (official) | Users service |
| `prisma-postgres-setup` | prisma/skills (official) | Users service |
| `efcore-patterns` | Aaronontheweb/dotnet-skills | Orders service |
| `database-performance` | Aaronontheweb/dotnet-skills | Orders service |
| `fastapi-expert` | Jeffallan/claude-skills | Tracking service |
| `mysql` | planetscale/database-skills | Orders + Tracking |
| `database-designer` | alirezarezvani/claude-skills | Cross-cutting DB design |
| `terraform-skill` | antonbabenko/terraform-skill | Infrastructure (converted from plugin evaluation → npx) |

---

## Installed — Claude Code plugins

These skills are registered in `.claude/settings.json` via `/plugin install`. They bundle MCP servers or embedded sub-agents that npx cannot carry.

| Skill | Source | Why plugin (not npx) |
|---|---|---|
| `mongodb` | claude-plugins-official | Bundles an MCP server that provides live database access; `npx` would install `SKILL.md` only — no runtime |
| `aws-dev-toolkit` | aws-samples marketplace | 40+ skills plus sub-agents embedded in the plugin; not exposed as standalone `SKILL.md` files |

> [!warning] DocumentDB scope for the MongoDB plugin
> For Amazon DocumentDB, use **only** the MongoDB plugin's **Schema Design** and **Query Optimizer** skills. Atlas-specific skills (Stream Processing, Atlas Search, Atlas Vector Search) do NOT apply to Amazon DocumentDB and must not be used in the events-pipeline service.

---

## Already available (no install needed)

The following skills ship with the Claude Code harness or are already registered in this repo and are available to all agents without any additional install step:

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

## Where to find more skills

See the appendix "Where to search for skills" in [[2026-06-28-services-infra-scaffold-design]] for the full source list: official vendor registries, marketplace aggregators (including skillsmp.com), and community awesome lists.

---

## Caveat — SkillsMP signal-to-noise

SkillsMP is a massive aggregator (~1.8 M entries) with low signal-to-noise ratio and significant duplicate content. One entry (`mysql-patterns`, shown as "219.4k★") is almost certainly a page error — this figure is not credible for a skills repository. That entry is treated as **UNVERIFIED** and is not recommended for use in this project.

---

## Related

- [[2026-06-28-services-infra-scaffold-design]] — the design spec whose candidate-skills catalog this note supersedes after validation and install.
- [[2026-06-28-services-infra-scaffold]] — the implementation plan that includes this catalog as Task 7.
- [[linear-references]] — Linear reference convention (tags + inline links, no mirroring).
