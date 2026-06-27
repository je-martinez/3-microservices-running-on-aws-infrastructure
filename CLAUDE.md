# CLAUDE.md

Project memory for the **3 Microservices Running on AWS Infrastructure (3MRAI)** repo.
These rules take precedence over default agent/skill behavior.

## Working rules

### Git — never commit on your own initiative
- Do **not** run `git commit`, `git push`, `git merge`, or open PRs on your own judgment.
- When you think a commit is warranted, **propose the commit message and wait for explicit confirmation** before running it.
- Leave finished work in the working tree and tell the user it's ready to commit.
- This overrides any skill (brainstorming, writing-plans, etc.) that commits automatically.

### Node.js
- This repo pins Node via [`.nvmrc`](.nvmrc) (currently **24.18.0**).
- Before running ANY Node.js command (`node`, `npm`, `npx`, global installs, `scripts/validate-vault.mjs`), run `nvm use` first so the pinned version is active. Example: `nvm use && node scripts/validate-vault.mjs`.

### Language
- **Converse with the user in Spanish.**
- **Vault / documentation content is written in English** (technical terms, filenames, frontmatter).

### Scope
- Stay within what was asked. No unrequested features, files, or refactors (YAGNI).

### Subagents
Three custom subagents own their domains. The external-write agents (`linear-pm`, `github-ops`) **read freely but propose every write and wait for explicit confirmation**.

- **`linear-pm`** (`.claude/agents/linear-pm.md`) — project manager for Linear: milestones, issues, projects, labels, comments, status updates, reporting. Uses the **plugin** Linear MCP server (`mcp__plugin_linear_linear__*`).
- **`github-ops`** (`.claude/agents/github-ops.md`) — git & GitHub operator: commits, branches, pushes, PRs, merges. Uses `git` + `gh`.
- **`obsidian-vault`** (`.claude/agents/obsidian-vault.md`) — **sole writer of the `docs/` vault.** All note creation/edits go through it so structure, frontmatter, tags, and wikilinks stay consistent. Has the Obsidian skills preloaded. **No other agent (including the main session) writes to `docs/` — route vault writes here.**

`linear-pm` and `github-ops` coordinate: `github-ops` needs milestone/issue IDs from `linear-pm` to name branches/PRs, and reports merges back so `linear-pm` can update issue status. Route Linear↔GitHub work through the parent, which relays between them.

### Implementation agents & flow

Two layers of agents (see `docs/superpowers/specs/2026-06-26-implementation-workflow-design.md`):

- **Tool layer (one writer per tool):** `obsidian-vault` (docs/), `linear-pm` (Linear), `github-ops` (git/GitHub).
- **Domain layer:** `solutions-architect` (read-only planner — returns a **Coordination Plan**, writes nothing) and five **code-only** implementers: `users-impl`, `orders-impl`, `tracking-impl`, `events-pipeline-impl`, `infra-impl`.

**Invariant:** implementers write **only source code** — they never run git or touch Linear, and they leave work in the working tree for `github-ops`. The architect writes nothing. A subagent cannot spawn another subagent, so the **parent** routes the architect's Coordination Plan to each hand.

**Flow per milestone:**
- **A — Design:** `brainstorming` → spec; `writing-plans` → plan (both under `docs/superpowers/`).
- **B — Organization:** parent → `solutions-architect` (returns Coordination Plan); parent → `obsidian-vault` (normalize/index per plan); parent → `linear-pm` (propose milestone+issues → user confirms).
- **C — Implementation (per issue):** parent → `linear-pm` (issue → In Progress) → `github-ops` (task branch) → `<svc>-impl` (implement; reads `services/<svc>/CLAUDE.md` + the vault spec note) → `github-ops` (commit + PR task→feature) → `linear-pm` (issue → Done after merge).
- **D — Milestone close:** `github-ops` proposes PR feature→`main`; the user reviews and merges (no auto-merge).

Each service's stack/conventions live in its nested `services/<svc>/CLAUDE.md` (or `infra/CLAUDE.md`), created at the start of that service's milestone — the implementer agents are thin and defer to it.

### Superpowers output is part of the vault
Anything brainstorming/writing-plans produces is a first-class vault note:
- Specs stay in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/` (don't relocate — the plugin reads from there), but the **`obsidian-vault` agent normalizes them** to our rules: required frontmatter, folder-style tags, `## Related` wikilinks.
- Index them from the vault: plans linked from `docs/plans/index.md`, design specs from `docs/00-overview/index.md`.
- User instructions (this file) take precedence over a skill's default paths/behavior.

### Commit messages
- All commits and PR titles follow **Conventional Commits v1.0.0** (https://www.conventionalcommits.org/en/v1.0.0/): `<type>(<scope>): <description>`, types `feat|fix|build|chore|ci|docs|style|refactor|perf|test`, scope = vault area (`users`, `orders`, `tracking`, `events-pipeline`, `infra`, `vault`, `agents`). Breaking changes use `!` and/or a `BREAKING CHANGE:` footer. Link Linear issues via `Refs:`/`Closes:` footers. Enforced by `github-ops`.

### Branch flow (Linear-driven)
- **Linear milestone → feature branch** `feature/<milestone-slug>` (off `main`).
- **Linear issue/task → task branch** `<type>/<ISSUE-ID>-<slug>` (off its feature branch).
- **Task integration:** PR task branch → feature branch; on approval, **squash-merge + delete branch**.
- **Milestone completion:** when all task PRs are merged, **propose** a PR feature → `main` and stop — the user merges it after review (no auto-merge).

## Documentation vault conventions

The Obsidian vault lives in [`docs/`](docs/). Design and plan for it:
- Spec: `docs/superpowers/specs/2026-06-26-3mrai-docs-vault-design.md`
- Plan: `docs/superpowers/plans/2026-06-26-3mrai-docs-vault.md`

### Structure — hybrid domain + type
- `docs/00-overview/` — root MOC (`index.md`), `architecture.md`, `system-context.md`, `glossary.md`.
- `docs/domains/<service>/{specs,decisions,runbooks,testing}/` — one folder per service: `users`, `orders`, `tracking`, `events-pipeline`.
- `docs/infrastructure/{specs,decisions,runbooks}/`.
- `docs/shared/{decisions,patterns,conventions,observability}/` — **all global ADRs live in `shared/decisions/`**.
- Global note types at root: `docs/{lessons,retros,ideas,plans,templates}/`.

### Conventions
- **Cross-cutting rules are defined once in `shared/` and referenced by `[[wikilink]]`** — never duplicated in service specs.
- Every note has YAML frontmatter: `title`, `type`, `area`, `status`, `created`, `updated`, `tags`, and `related` where applicable.
  - `type` ∈ {spec, adr, runbook, convention, pattern, lesson, retro, plan, reference}
    - `reference` is raw source/origin material (e.g. the original prompt, early notes) kept under `docs/00-overview/sources/` — a starting point, **not** the source of truth.
  - `area` ∈ {users, orders, tracking, events-pipeline, infra, shared}
  - `status` ∈ {draft, active, accepted, superseded}
- Tags are folder-style: `area/<x>`, `type/<x>`, `status/<x>` (plus `severity/<x>` for lessons, `phase/<n>` for phases).
- Filenames: evergreen notes `kebab-case.md`; ADRs `ADR-NNNN-title-kebab.md` (continuous global numbering); dated notes `YYYY-MM-DD-short-title.md`.
- Every note ends with a `## Related` section listing outgoing wikilinks.
- Source of truth for technical content is the **organized vault** (specs, ADRs, conventions). The original prompt [`first-prompt-en.md`](docs/00-overview/sources/first-prompt-en.md) is only the **starting point** that planning grew from — it lives under `docs/00-overview/sources/` as reference material, not as the source of truth.

### Validation
- `node scripts/validate-vault.mjs` checks frontmatter and broken wikilinks (run after editing vault notes).
