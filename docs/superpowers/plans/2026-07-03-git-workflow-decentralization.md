---
title: Git Workflow Decentralization — Plan
type: plan
area: shared
status: draft
created: 2026-07-03
updated: 2026-07-03
tags: [type/plan, area/shared, status/draft]
related: ["[[2026-07-03-git-workflow-decentralization-design]]", "[[2026-06-26-implementation-workflow-design]]", "[[phase-c-review-flow]]"]
---

# Git Workflow Decentralization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the mandatory `github-ops` git bottleneck (main session may run git directly, with confirmation), extract commit/branch conventions into one vault note, and replace the free-text git-confirmation prompt with a structured A/B/C/D/E action menu.

**Architecture:** A process/documentation change only — no service code. A new vault convention note (`docs/shared/conventions/git-workflow.md`) becomes the single source of truth for git conventions and the confirmation menu; `CLAUDE.md` and the workflow spec are rewritten to reference it and to describe `github-ops` as optional. Writes under `docs/` go through the `obsidian-vault` agent (repo rule); `CLAUDE.md` and the `github-ops` agent file are edited by the main session.

**Tech Stack:** Markdown (Obsidian-flavored), YAML frontmatter, `scripts/validate-vault.mjs` (Node, run under `nvm use`).

## Global Constraints

- **Confirmation policy is preserved.** Every git write (commit / push / PR / merge) still needs explicit user approval. No auto-approval, no auto-merge. (spec: Non-goals, Invariants)
- **Implementers stay code-only.** The five `*-impl` agent files are NOT modified and get no git tools. (spec: Non-goals)
- **`github-ops` is NOT deleted** — only made optional. (spec: Non-goals)
- **`linear-pm` / `obsidian-vault` remain single writers** of Linear / `docs/`. Only git loses its single-writer requirement. (spec: Non-goals)
- **No Linear issue/milestone** for this work. (spec: Summary, Non-goals)
- **Writes under `docs/` go through the `obsidian-vault` agent** — the main session never edits `docs/` directly. (repo rule; spec: Write ownership)
- **Vault content is written in English.** (repo rule)
- **Node commands run under `nvm use` first** (pinned 24.18.0). (repo rule)
- **The vault note is the single source of truth** for the A/B/C/D/E menu; `CLAUDE.md` summarizes and links, never restates it divergently. (spec: Testing/validation)
- **Everything on one branch** off `feature/users-service`, one PR. No commits without user confirmation (propose message, wait). (spec: Summary; repo rule)

---

## File Structure

| File | Action | Writer | Responsibility |
| --- | --- | --- | --- |
| `docs/shared/conventions/git-workflow.md` | Create | `obsidian-vault` | Single source of truth: Conventional Commits, branch naming, PR flow, A/B/C/D/E menu, who-may-run-git. |
| `docs/00-overview/index.md` | Modify | `obsidian-vault` | Link the new convention note from the overview MOC. |
| `docs/superpowers/specs/2026-06-26-implementation-workflow-design.md` | Modify | `obsidian-vault` | Update the "sole writer" table, the code-only paragraph, the mermaid diagram, and Phase C/D steps so `github-ops` reads as optional. |
| `CLAUDE.md` | Modify | main session | Rewrite Git Working rule, Subagents, Implementation flow, Commit messages, Branch flow sections to drop the mandatory bottleneck and reference `[[git-workflow]]`. |
| `.claude/agents/github-ops.md` | Modify | main session | `description` frontmatter reflects "optional helper", not mandatory gate. |

**Task ordering rationale:** The vault note (Task 1) is created first because `CLAUDE.md` and the spec reference it — writing the referent before the references keeps wikilinks resolvable at validation. Tasks 1–3 (all `docs/`) are dispatched to `obsidian-vault`. Tasks 4–5 are main-session edits. Task 6 validates and hands off for commit.

---

### Task 1: Create the `git-workflow.md` convention note

**Files:**
- Create: `docs/shared/conventions/git-workflow.md`

**Writer:** `obsidian-vault` agent (main session must NOT write this file directly).

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a note at `docs/shared/conventions/git-workflow.md` whose vault link name is `git-workflow`, referenced later as `[[git-workflow]]` by Tasks 2, 4, 5. It contains an anchored section describing the A/B/C/D/E confirmation menu that Task 4 summarizes.

- [ ] **Step 1: Dispatch `obsidian-vault` to create the note**

Dispatch the `obsidian-vault` agent with this content to write verbatim (it will normalize frontmatter/tags/wikilinks to vault rules). The note body:

```markdown
---
title: Git Workflow
type: convention
area: shared
status: active
created: 2026-07-03
updated: 2026-07-03
tags: [type/convention, area/shared, status/active]
related: ["[[phase-c-review-flow]]", "[[linear-references]]", "[[milestone-plan]]"]
---

# Git Workflow

How git and GitHub work in this repo: who may run git, how commits and branches
are named, the PR flow, and how the main session asks for confirmation.

The **confirmation policy** (never commit/push/merge without explicit user
approval) is defined in the `CLAUDE.md` Working rules — that file is the source of
truth for the *policy*. This note documents the *convention*: the mechanics and the
menu the main session uses to request that approval.

## Who may run git

- **The main session may execute git directly** (commit, push, PR), asking for
  confirmation before every write via the [confirmation menu](#confirmation-menu-abcd).
  Git is **not** a single-writer domain.
- **`github-ops` is an optional helper.** Delegate a complex git batch to it (e.g.
  sequentially merging a batch of sibling PRs) when convenient. It keeps its own
  "propose every write, wait for confirmation" contract.
- **Implementer agents (`*-impl`) stay code-only** — they never run git; they leave
  their work in the working tree for the main session to commit.

## Confirmation menu (A/B/C/D/E)

When the main session reaches a git write point, it presents a **structured menu**
instead of a free-text question. First it summarizes what is staged and the proposed
Conventional-Commits message, then offers:

- **A. Commit + push + create PR** — offered **only when the feature/issue is
  complete**. When the work is not complete, A is omitted from the menu. PR base
  follows the branch type: a **task branch** → PR into its **feature branch**; a
  **feature branch** → PR into **`main`**. The PR is **opened, never merged** — it
  stays open for the user's review.
- **B. Commit + push**
- **C. Commit only**
- **D. Write manually** — free-text; the user describes the exact git action to run.

Rules:

- **Choosing an option IS the confirmation** for that write. The push bundled into B
  is not re-confirmed separately.
- A choice authorizes **only that action** — never auto-merge, never a standing
  approval for future writes.
- The commit message always follows [Conventional Commits](#commit-messages).

## Commit messages — Conventional Commits v1.0.0

All commits and PR titles follow Conventional Commits v1.0.0
(https://www.conventionalcommits.org/en/v1.0.0/): `<type>(<scope>): <description>`.

- **Types:** `feat|fix|build|chore|ci|docs|style|refactor|perf|test`.
- **Scope** = vault area: `users`, `orders`, `tracking`, `events-pipeline`, `infra`,
  `vault`, `agents`.
- **Breaking changes:** `!` before the `:` and/or a `BREAKING CHANGE:` footer.
- **Link Linear issues** in footers: `Refs: JE-NN` (or `Closes: JE-NN`).
- **Repo trailer** in the footer block:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **PR bodies** end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
  and hyperlink every Linear issue ID (`[JE-NN](https://linear.app/je-martinez/issue/JE-NN)`),
  never bare `JE-NN` text.

## Branch flow (Linear-driven)

- **Milestone → feature branch** `feature/<milestone-slug>` (off `main`).
- **Issue/task → task branch** `<type>/<ISSUE-ID>-<slug>` (off its feature branch).
- **Task integration:** PR task branch → feature branch; on approval, **squash-merge**.
  The repo auto-deletes merged head branches; pull the base after each merge.
- **Milestone completion:** when all task PRs are merged, **propose** a PR feature →
  `main` and stop — the user merges it after review (no auto-merge).

The Phase C chaining and batch-review rules (dependency gates, batching PRs, no
per-merge prompts) are defined in [[phase-c-review-flow]] — this note does not
restate them.

## Related

- [[phase-c-review-flow]]
- [[linear-references]]
- [[milestone-plan]]
```

- [ ] **Step 2: Verify the file exists and vault-validates**

Run:
```bash
nvm use && node scripts/validate-vault.mjs
```
Expected: PASS (no broken-wikilink or frontmatter errors). `[[git-workflow]]` targets, `[[phase-c-review-flow]]`, `[[linear-references]]`, `[[milestone-plan]]` all resolve. If validation reports a broken link, fix the referenced note name and re-run.

- [ ] **Step 3: Commit** (propose to user via the menu — do NOT commit unprompted)

Proposed message:
```
docs(vault): add git-workflow convention note
```
Leave staged/ready; the user confirms per the confirmation policy.

---

### Task 2: Link the note from the overview MOC

**Files:**
- Modify: `docs/00-overview/index.md`

**Writer:** `obsidian-vault` agent.

**Interfaces:**
- Consumes: `[[git-workflow]]` (created in Task 1).
- Produces: a link entry so the note is reachable from the vault MOC (per repo rule that conventions index from `docs/00-overview/index.md`).

- [ ] **Step 1: Read the current MOC to find the conventions grouping**

Dispatch `obsidian-vault` to read `docs/00-overview/index.md` and locate where the other shared conventions (`phase-c-review-flow`, `linear-references`, etc.) are listed.

- [ ] **Step 2: Add the wikilink to `git-workflow` in that same grouping**

Add a list item alongside the sibling conventions, e.g.:
```markdown
- [[git-workflow]] — who may run git, commit/branch conventions, the A/B/C/D/E confirmation menu
```
Match the exact list style already used in that section (the agent normalizes to it).

- [ ] **Step 3: Validate**

Run:
```bash
nvm use && node scripts/validate-vault.mjs
```
Expected: PASS. The new `[[git-workflow]]` link in the MOC resolves.

- [ ] **Step 4: Commit** (propose via menu)

Proposed message:
```
docs(vault): index git-workflow from the overview MOC
```

---

### Task 3: Update the workflow spec so `github-ops` reads as optional

**Files:**
- Modify: `docs/superpowers/specs/2026-06-26-implementation-workflow-design.md`

**Writer:** `obsidian-vault` agent.

**Interfaces:**
- Consumes: nothing new.
- Produces: an internally-consistent spec where git is no longer described as a mandatory single-writer domain and Phase C/D no longer routes through `github-ops` by requirement.

- [ ] **Step 1: Update the "sole writer" table row for `github-ops`**

Dispatch `obsidian-vault` to change (line ~33):
```markdown
| `github-ops` | git / GitHub | Branches, commits, PRs, merges, branch cleanup. |
```
to:
```markdown
| `github-ops` | git / GitHub (optional) | Optional helper for complex git batches — branches, commits, PRs, merges, cleanup. The main session may also run git directly (see [[git-workflow]]). |
```

- [ ] **Step 2: Update the code-only paragraph (line ~46)**

Change:
```markdown
The five implementers write **only source code** — they never touch git or Linear. When their work is done they leave it in the working tree for `github-ops` to commit. The architect writes nothing at all; it only reasons and returns a plan.
```
to:
```markdown
The five implementers write **only source code** — they never touch git or Linear. When their work is done they leave it in the working tree for the **main session** to commit (optionally delegating a complex git batch to `github-ops`). The architect writes nothing at all; it only reasons and returns a plan.
```

- [ ] **Step 3: Update the mermaid tool-layer label (line ~58)**

Change:
```
    subgraph Tool["Tool layer (horizontal — one writer per tool)"]
```
to:
```
    subgraph Tool["Tool layer (horizontal — docs/ + Linear single-writer; git optional via github-ops)"]
```
And change the `github-ops` node (line ~61):
```
        GO[github-ops → git/GitHub]
```
to:
```
        GO[github-ops → git/GitHub (optional)]
```

- [ ] **Step 4: Update Phase C steps (lines ~100, ~102)**

Change step 2:
```markdown
2. **parent → `github-ops`** — create the task branch off the milestone's feature branch.
```
to:
```markdown
2. **main session (or, optionally, `github-ops`)** — create the task branch off the milestone's feature branch, confirming via the A/B/C/D/E menu (see [[git-workflow]]).
```
Change step 4:
```markdown
4. **parent → `github-ops`** — commit and open a PR (task → feature).
```
to:
```markdown
4. **main session (or, optionally, `github-ops`)** — commit and open a PR (task → feature), confirming via the A/B/C/D/E menu.
```

- [ ] **Step 5: Update Phase D (line ~107)**

Change:
```markdown
When all task PRs for the milestone are merged, **`github-ops` proposes a PR feature → `main`**. The **user reviews and merges** it — no auto-merge.
```
to:
```markdown
When all task PRs for the milestone are merged, the **main session (or, optionally, `github-ops`) proposes a PR feature → `main`**. The **user reviews and merges** it — no auto-merge.
```

- [ ] **Step 6: Validate**

Run:
```bash
nvm use && node scripts/validate-vault.mjs
```
Expected: PASS. The new `[[git-workflow]]` references resolve; frontmatter still valid.

- [ ] **Step 7: Commit** (propose via menu)

Proposed message:
```
docs(vault): mark github-ops optional in the workflow spec
```

---

### Task 4: Rewrite the affected `CLAUDE.md` sections

**Files:**
- Modify: `CLAUDE.md` (Working rules → Git; Subagents; Implementation agents & flow; Commit messages; Branch flow)

**Writer:** main session (NOT `docs/`, so not `obsidian-vault`).

**Interfaces:**
- Consumes: `[[git-workflow]]` (Task 1) — referenced by wikilink and by path.
- Produces: `CLAUDE.md` that keeps the confirmation policy, drops the mandatory-bottleneck framing, and references the vault note as the source of truth for git conventions + the A/B/C/D/E menu.

- [ ] **Step 1: Rewrite the Git Working rule (lines 8–12)**

Replace:
```markdown
### Git — never commit on your own initiative
- Do **not** run `git commit`, `git push`, `git merge`, or open PRs on your own judgment.
- When you think a commit is warranted, **propose the commit message and wait for explicit confirmation** before running it.
- Leave finished work in the working tree and tell the user it's ready to commit.
- This overrides any skill (brainstorming, writing-plans, etc.) that commits automatically.
```
with:
```markdown
### Git — confirm every write, but the main session may run git
- The **main session may execute git directly** (commit, push, PR) — git is **not** routed exclusively through `github-ops`. `github-ops` remains an **optional** helper for complex git batches.
- **Never commit/push/merge/open a PR without explicit user confirmation.** When a git write is warranted, present the **A/B/C/D/E confirmation menu** (see `docs/shared/conventions/git-workflow.md` → [[git-workflow]]) after summarizing what is staged and the proposed Conventional-Commits message:
  - **A.** Commit + push + create PR — only when the feature/issue is complete (PR base by branch type; opened, never merged).
  - **B.** Commit + push.  **C.** Commit only.  **D.** Continue without committing (leave the work in the working tree and carry on).  **E.** Write manually.
- Choosing an option IS the confirmation for that write, and authorizes **only** that action (never auto-merge, never standing approval).
- Leave finished work in the working tree until the user picks an option.
- This overrides any skill (brainstorming, writing-plans, etc.) that commits automatically.
```

- [ ] **Step 2: Update the Subagents intro + `github-ops` line (lines 25–32)**

Replace line 26:
```markdown
Three custom subagents own their domains. The external-write agents (`linear-pm`, `github-ops`) **read freely but propose every write and wait for explicit confirmation**.
```
with:
```markdown
Custom subagents own their write domains. `linear-pm` (Linear) and `obsidian-vault` (`docs/`) are **single writers** of their tools. `github-ops` is an **optional** git helper (the main session may run git directly — see [[git-workflow]]). The external-write agents **read freely but propose every write and wait for explicit confirmation**.
```

Replace line 29:
```markdown
- **`github-ops`** (`.claude/agents/github-ops.md`) — git & GitHub operator: commits, branches, pushes, PRs, merges. Uses `git` + `gh`.
```
with:
```markdown
- **`github-ops`** (`.claude/agents/github-ops.md`) — **optional** git & GitHub helper for complex batches: commits, branches, pushes, PRs, merges. Uses `git` + `gh`. The main session may also run git directly; conventions live in [[git-workflow]].
```

Replace line 32:
```markdown
`linear-pm` and `github-ops` coordinate: `github-ops` needs milestone/issue IDs from `linear-pm` to name branches/PRs, and reports merges back so `linear-pm` can update issue status. Route Linear↔GitHub work through the parent, which relays between them.
```
with:
```markdown
When `github-ops` is used, it coordinates with `linear-pm`: it needs milestone/issue IDs to name branches/PRs and reports merges back so `linear-pm` can update issue status. Route Linear↔GitHub work through the parent, which relays between them. (The main session, running git directly, does the same coordination inline.)
```

- [ ] **Step 3: Update "one writer per tool" + implementer invariant (lines 38, 41)**

Replace line 38:
```markdown
- **Tool layer (one writer per tool):** `obsidian-vault` (docs/), `linear-pm` (Linear), `github-ops` (git/GitHub).
```
with:
```markdown
- **Tool layer:** `obsidian-vault` (docs/) and `linear-pm` (Linear) are single writers. `github-ops` (git/GitHub) is **optional** — the main session may run git directly (see [[git-workflow]]).
```

Replace line 41:
```markdown
**Invariant:** implementers write **only source code** — they never run git or touch Linear, and they leave work in the working tree for `github-ops`. The architect writes nothing. A subagent cannot spawn another subagent, so the **parent** routes the architect's Coordination Plan to each hand.
```
with:
```markdown
**Invariant:** implementers write **only source code** — they never run git or touch Linear, and they leave work in the working tree for the **main session** to commit (which may optionally delegate a complex git batch to `github-ops`). The architect writes nothing. A subagent cannot spawn another subagent, so the **parent** routes the architect's Coordination Plan to each hand.
```

- [ ] **Step 4: Update Phase C/D flow lines (lines 46–47)**

Replace line 46:
```markdown
- **C — Implementation (per issue):** parent → `linear-pm` (issue → In Progress) → `github-ops` (task branch) → `<svc>-impl` (implement; reads `services/<svc>/CLAUDE.md` + the vault spec note) → `github-ops` (commit + PR task→feature) → `linear-pm` (issue → Done after merge).
```
with:
```markdown
- **C — Implementation (per issue):** parent → `linear-pm` (issue → In Progress) → main session creates the task branch → `<svc>-impl` (implement; reads `services/<svc>/CLAUDE.md` + the vault spec note) → main session commits + opens PR task→feature via the A/B/C/D/E menu (or delegates to `github-ops`) → `linear-pm` (issue → Done after merge).
```

Replace line 47:
```markdown
- **D — Milestone close:** `github-ops` proposes PR feature→`main`; the user reviews and merges (no auto-merge).
```
with:
```markdown
- **D — Milestone close:** the main session (or `github-ops`) proposes PR feature→`main`; the user reviews and merges (no auto-merge).
```

- [ ] **Step 5: Update the Commit messages section (line 58)**

Replace the trailing sentence of line 58:
```markdown
Breaking changes use `!` and/or a `BREAKING CHANGE:` footer. Link Linear issues via `Refs:`/`Closes:` footers. Enforced by `github-ops`.
```
with:
```markdown
Breaking changes use `!` and/or a `BREAKING CHANGE:` footer. Link Linear issues via `Refs:`/`Closes:` footers. Full convention (with the A/B/C/D/E confirmation menu): [[git-workflow]].
```

- [ ] **Step 6: Replace the Branch flow section detail with a pointer (lines 60–64)**

Replace:
```markdown
### Branch flow (Linear-driven)
- **Linear milestone → feature branch** `feature/<milestone-slug>` (off `main`).
- **Linear issue/task → task branch** `<type>/<ISSUE-ID>-<slug>` (off its feature branch).
- **Task integration:** PR task branch → feature branch; on approval, **squash-merge + delete branch**.
- **Milestone completion:** when all task PRs are merged, **propose** a PR feature → `main` and stop — the user merges it after review (no auto-merge).
```
with:
```markdown
### Branch flow (Linear-driven)
Full convention: `docs/shared/conventions/git-workflow.md` → [[git-workflow]]. In short: milestone → `feature/<milestone-slug>` (off `main`); issue/task → `<type>/<ISSUE-ID>-<slug>` (off its feature branch); task PR → feature (squash-merge, auto-delete); on milestone completion, **propose** a PR feature → `main` and stop — the user merges after review (no auto-merge).
```

- [ ] **Step 7: Grep for leftover mandatory-`github-ops` framing**

Run:
```bash
grep -n "for \`github-ops\`\|one writer per tool\|Enforced by \`github-ops\`\|→ \`github-ops\`" CLAUDE.md
```
Expected: no matches (all rewritten). If any remain, reconcile them with the edits above.

- [ ] **Step 8: Commit** (propose via menu)

Proposed message:
```
docs(agents): decentralize git — main session runs git, github-ops optional
```

---

### Task 5: Make `github-ops`'s description reflect "optional"

**Files:**
- Modify: `.claude/agents/github-ops.md` (frontmatter `description`, lines 4–9)

**Writer:** main session.

**Interfaces:**
- Consumes: nothing.
- Produces: an agent whose description no longer implies it is the mandatory git gate. Its internal "propose every write, wait" contract (body) is unchanged.

- [ ] **Step 1: Edit the `description` frontmatter**

Replace (lines 4–9):
```yaml
description: >-
  Git & GitHub operator for the 3MRAI repo. Use for commits, branches, pushes,
  pull requests, and merges. Implements the Linear-driven branch flow (milestone =
  feature branch, issue = task branch → PR into feature branch). ALWAYS asks for
  explicit confirmation before any write (commit, push, branch create/delete,
  PR open/merge). Coordinates with the linear-pm agent for milestone/issue context.
```
with:
```yaml
description: >-
  OPTIONAL git & GitHub helper for the 3MRAI repo — the main session may run git
  directly (see docs/shared/conventions/git-workflow.md); delegate here for complex
  git batches (e.g. sequentially merging sibling PRs). Handles commits, branches,
  pushes, pull requests, and merges per the Linear-driven branch flow (milestone =
  feature branch, issue = task branch → PR into feature branch). ALWAYS asks for
  explicit confirmation before any write (commit, push, branch create/delete,
  PR open/merge). Coordinates with the linear-pm agent for milestone/issue context.
```

- [ ] **Step 2: Verify only the description changed**

Run:
```bash
git diff .claude/agents/github-ops.md
```
Expected: only the `description` block differs; the body (Hard rule, Branch flow, Standard procedures, Commit messages) is untouched.

- [ ] **Step 3: Commit** (propose via menu)

Proposed message:
```
docs(agents): mark github-ops as an optional git helper
```

---

### Task 6: Final validation and integration handoff

**Files:** none (verification only).

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a validated working tree ready for a single PR.

- [ ] **Step 1: Vault validation**

Run:
```bash
nvm use && node scripts/validate-vault.mjs
```
Expected: PASS — no broken wikilinks (`[[git-workflow]]` resolves from `CLAUDE.md`'s referenced note, the MOC, and the workflow spec), frontmatter valid.

- [ ] **Step 2: Consistency read-through**

Confirm the A/B/C/D/E menu text in `CLAUDE.md` (Task 4, Step 1) is a faithful summary of the authoritative version in `git-workflow.md` (Task 1) — same options, same "A only when complete", same "opened never merged". They must not diverge.

Run:
```bash
grep -rn "A/B/C/D/E\|Commit + push + create PR\|Commit only" CLAUDE.md docs/shared/conventions/git-workflow.md
```
Expected: both files describe the same menu; the vault note is the fuller source, `CLAUDE.md` the summary.

- [ ] **Step 3: Confirm no `*-impl` files were touched**

Run:
```bash
git status --porcelain | grep -E "impl\.md" || echo "no impl files changed — correct"
```
Expected: `no impl files changed — correct`.

- [ ] **Step 4: Integration handoff**

All changes are on the single branch off `feature/users-service`. Per the confirmation policy, propose to the user opening one PR for the whole change (option A only if they judge it complete). Do NOT open or merge it unprompted.

Proposed PR title:
```
docs: decentralize git workflow (main session runs git; github-ops optional)
```

---

## Self-Review

**Spec coverage** (each spec section → task):
- *Goals — main session runs git* → Tasks 4 (CLAUDE.md), 5 (github-ops desc), 3 (spec).
- *Goals — conventions in one vault note* → Task 1.
- *Goals — A/B/C/D/E menu* → Task 1 (authoritative), Task 4 Step 1 (summary), Task 6 Step 2 (consistency).
- *Goals — github-ops optional* → Tasks 3, 4, 5.
- *Components to change #1 (new note)* → Task 1 + Task 2 (indexing).
- *Components #2 (CLAUDE.md sections)* → Task 4 (all five subsections).
- *Components #3 (github-ops.md)* → Task 5.
- *Components #4 (workflow spec)* → Task 3.
- *Write ownership table* → per-task **Writer** lines; `docs/` → `obsidian-vault`, root files → main session.
- *Testing/validation* → Task 6 (validate, consistency, no-impl-touched).
- *Non-goals* → Global Constraints (policy preserved, impl code-only, github-ops kept, single writers intact, no Linear, one note).

No gaps found.

**Placeholder scan:** No TBD/TODO. Every edit step shows exact old→new text. Commit messages are concrete.

**Type/name consistency:** The vault link name `git-workflow` is used identically in Tasks 1, 2, 3, 4, 5. The menu options (A/B/C/D/E with the same labels) match between Task 1 and Task 4 Step 1, and Task 6 Step 2 explicitly checks that. Intra-note anchors in the created note (`#confirmation-menu-abcde`, `#commit-messages--conventional-commits-v100`) match the exact GitHub-style slugs of their headings — note the full slug for the punctuated Commit-messages heading (a naive `#commit-messages` does NOT resolve; `validate-vault.mjs` does not check intra-note anchors, so this is verified by hand).

## Related

- [[2026-07-03-git-workflow-decentralization-design]]
- [[2026-06-26-implementation-workflow-design]]
- [[phase-c-review-flow]]
