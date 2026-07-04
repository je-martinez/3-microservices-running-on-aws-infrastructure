# CLAUDE.md

Project memory for the **3 Microservices Running on AWS Infrastructure (3MRAI)** repo.
These rules take precedence over default agent/skill behavior.

## Working rules

### Git — confirm every write, but the main session may run git
- The **main session may execute git directly** (commit, push, PR) — git is **not** routed exclusively through `github-ops`. `github-ops` remains an **optional** helper for complex git batches.
- **Never commit/push/merge/open a PR without explicit user confirmation.** When a git write is warranted, present the **A/B/C/D/E confirmation menu** (full convention: `docs/shared/conventions/git-workflow.md` → [[git-workflow]]). **ALWAYS render it with the `AskUserQuestion` tool as an arrow-navigable option list — never as a plain-text list of letters in a normal message.** First summarize (in the surrounding text) what is staged and the proposed Conventional-Commits message, then present the menu:
  - **A.** Commit + push + create PR — only when the feature/issue is complete (PR base by branch type; opened, never merged).
  - **B.** Commit + push.  **C.** Commit only.  **D.** Continue without committing (leave the work in the working tree and carry on).  **E.** Write manually.
- Choosing an option IS the confirmation for that write, and authorizes **only** that action (never auto-merge, never standing approval).
- Leave finished work in the working tree until the user picks an option.
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
Custom subagents own their write domains. `linear-pm` (Linear) and `obsidian-vault` (`docs/`) are **single writers** of their tools. `github-ops` is an **optional** git helper (the main session may run git directly — see [[git-workflow]]). The external-write agents **read freely but propose every write and wait for explicit confirmation**.

- **`linear-pm`** (`.claude/agents/linear-pm.md`) — project manager for Linear: milestones, issues, projects, labels, comments, status updates, reporting. Uses the **plugin** Linear MCP server (`mcp__plugin_linear_linear__*`).
- **`github-ops`** (`.claude/agents/github-ops.md`) — **optional** git & GitHub helper for complex batches: commits, branches, pushes, PRs, merges. Uses `git` + `gh`. The main session may also run git directly; conventions live in [[git-workflow]].
- **`obsidian-vault`** (`.claude/agents/obsidian-vault.md`) — **sole writer of the `docs/` vault.** All note creation/edits go through it so structure, frontmatter, tags, and wikilinks stay consistent. Has the Obsidian skills preloaded. **No other agent (including the main session) writes to `docs/` — route vault writes here.**

When `github-ops` is used, it coordinates with `linear-pm`: it needs milestone/issue IDs to name branches/PRs and reports merges back so `linear-pm` can update issue status. Route Linear↔GitHub work through the parent, which relays between them. (The main session, running git directly, does the same coordination inline.)

### Implementation agents & flow

Two layers of agents (see `docs/superpowers/specs/2026-06-26-implementation-workflow-design.md`):

- **Tool layer:** `obsidian-vault` (docs/) and `linear-pm` (Linear) are single writers. `github-ops` (git/GitHub) is **optional** — the main session may run git directly (see [[git-workflow]]).
- **Domain layer:** `solutions-architect` (read-only planner — returns a **Coordination Plan**, writes nothing) and five **code-only** implementers: `users-impl`, `orders-impl`, `tracking-impl`, `events-pipeline-impl`, `infra-impl`.

**Invariant:** implementers write **only source code** — they never run git or touch Linear, and they leave work in the working tree for the **main session** to commit (which may optionally delegate a complex git batch to `github-ops`). The architect writes nothing. A subagent cannot spawn another subagent, so the **parent** routes the architect's Coordination Plan to each hand.

**Flow per milestone:**
- **A — Design:** `brainstorming` → spec; `writing-plans` → plan (both under `docs/superpowers/`).
- **B — Organization:** parent → `solutions-architect` (returns Coordination Plan); parent → `obsidian-vault` (normalize/index per plan); parent → `linear-pm` (propose milestone+issues → user confirms).
- **C — Implementation (per issue):** parent → `linear-pm` (issue → In Progress) → main session creates the task branch → `<svc>-impl` (implement; reads `services/<svc>/CLAUDE.md` + the vault spec note) → main session commits + opens PR task→feature via the A/B/C/D/E menu (or delegates to `github-ops`) → `linear-pm` (issue → Done after merge).
- **D — Milestone close:** the main session (or `github-ops`) proposes PR feature→`main`; the user reviews and merges (no auto-merge).

Each service's stack/conventions live in its nested `services/<svc>/CLAUDE.md` (or `infra/CLAUDE.md`), created at the start of that service's milestone — the implementer agents are thin and defer to it.

### Superpowers output is part of the vault
Anything brainstorming/writing-plans produces is a first-class vault note:
- Specs stay in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/` (don't relocate — the plugin reads from there), but the **`obsidian-vault` agent normalizes them** to our rules: required frontmatter, folder-style tags, `## Related` wikilinks.
- Index them from the vault: plans linked from `docs/plans/index.md`, design specs from `docs/00-overview/index.md`.
- User instructions (this file) take precedence over a skill's default paths/behavior.

### Commit messages
- All commits and PR titles follow **Conventional Commits v1.0.0** (https://www.conventionalcommits.org/en/v1.0.0/): `<type>(<scope>): <description>`, types `feat|fix|build|chore|ci|docs|style|refactor|perf|test`, scope = vault area (`users`, `orders`, `tracking`, `events-pipeline`, `infra`, `vault`, `agents`). Breaking changes use `!` and/or a `BREAKING CHANGE:` footer. Link Linear issues via `Refs:`/`Closes:` footers (optional — many commits have no issue). **Before proposing a commit/PR, do a best-effort lookup of context references** — Linear issue (if any), vault plan, superpowers plan/spec, and other useful refs — and attach them as commit footers (`Refs:`, `Plan:`, `Spec:`, `Design:`) and a `## References` section in the PR body. This is enrichment, **never a blocker**. Full convention (confirmation menu + reference lookup): [[git-workflow]].

### Branch flow (Linear-driven)
Full convention: `docs/shared/conventions/git-workflow.md` → [[git-workflow]]. In short: milestone → `feature/<milestone-slug>` (off `main`); issue/task → `<type>/<ISSUE-ID>-<slug>` (off its feature branch); task PR → feature (squash-merge; the repo auto-deletes merged branches); on milestone completion, **propose** a PR feature → `main` and stop — the user merges after review (no auto-merge).

### Phase C review flow (batch review + dependency gates)
How Phase C issues are chained and reviewed (full convention: `docs/shared/conventions/phase-c-review-flow.md`):
- **Chain issues without per-merge prompts.** Work issues one after another (issue → In Progress → task branch → implement → PR task→feature). Do **not** ask for merge confirmation between each issue, and do **not** self-merge the task→feature PRs during the chain — leave them open.
- **Batch PRs for review.** At each stop point, present the user **one list** of open PRs to review/merge — never one-by-one.
- **Dependency gates are stop points.** If issue B is blocked by A, B must build on A's **merged** work: implement everything independent first, open those PRs, then **stop** at the first blocked issue and hand the user the batch so far. After the user merges that batch, continue with the previously-blocked issues. A milestone may have several stop points.
- **Never auto-merge.** The user merges (or explicitly authorizes the merge of) every PR; one approval authorizes only that PR/batch, never standing auto-merge.

## Project decisions & memory

Project decisions and memory live in the **vault** (versioned, navigable) — **not** in any external `~/.claude/` memory file. There is no separate memory store; this repo is the source of truth. At session start, consult:

- `docs/shared/conventions/linear-references.md` — the vault references Linear (tags + links), never mirrors it.
- `docs/superpowers/specs/2026-06-26-implementation-workflow-design.md` — the two-layer agent topology (tool-layer + domain-layer) and the implementation flow (Phases A–D).
- `docs/shared/decisions/` — global ADRs (once the vault-build plan runs and seeds them).

How we work (git policy, language, Node, scope) is defined in the **Working rules** above — that is the source of truth, not a separate memory file.

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
- The validator does **not** check **intra-note anchor links** (`[text](#heading)`). Verify these by hand: GitHub-style slugs lowercase, strip punctuation, hyphenate spaces, and an em-dash yields a double hyphen — e.g. `## Commit messages — Conventional Commits v1.0.0` → `#commit-messages--conventional-commits-v100`, **not** `#commit-messages`.
