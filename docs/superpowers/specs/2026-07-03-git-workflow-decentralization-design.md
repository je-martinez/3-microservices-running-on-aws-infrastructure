---
title: Git Workflow Decentralization — Design
type: spec
area: shared
status: draft
created: 2026-07-03
updated: 2026-07-03
tags: [type/spec, area/shared, status/draft]
related: ["[[2026-06-26-implementation-workflow-design]]", "[[phase-c-review-flow]]", "[[linear-references]]"]
---

# Git Workflow Decentralization — Design

## Summary

Today the repo forces **all** git and GitHub writes through a single agent, `github-ops`. The
implementer agents (`users-impl`, `orders-impl`, …) are code-only and leave their work in the
working tree for `github-ops` to commit; `CLAUDE.md` frames git as a "one writer per tool"
domain. This is a point of friction: the main session cannot commit its own work directly and
must always route through a subagent.

This design **removes the `github-ops` bottleneck** so the **main session can run git directly**
(still asking for confirmation before every write), and **extracts the commit/branch conventions
out of `CLAUDE.md` into a single vault note** (`docs/shared/conventions/git-workflow.md`) that
`CLAUDE.md` references by wikilink instead of duplicating. It also **replaces the free-text
confirmation prompt with a structured A/B/C/D/E action menu**.

The confirmation policy itself does **not** change: nothing is committed, pushed, or merged
without the user's explicit approval. What changes is (a) *who* may execute git (the main session,
not only `github-ops`) and (b) *how* approval is requested (a structured menu, not open text).

This is a **process/documentation change** — no service code is touched. It is done on a single
branch off `feature/users-service` with **no Linear issue** (per the user's explicit request).

## Goals

- The **main session may execute git directly** (commit, push, PR), respecting the confirmation
  policy — git stops being a single-writer domain routed exclusively through `github-ops`.
- **Commit/branch conventions live in one vault note** (`git-workflow.md`); `CLAUDE.md` references
  it rather than restating it.
- **Confirmation is a structured menu** (A/B/C/D/E) instead of an open-ended question.
- `github-ops` **survives as an optional helper** for complex git batches — no longer mandatory.

## Non-goals (YAGNI)

- **Not** relaxing the confirmation policy. Every commit / push / PR / merge still needs explicit
  user approval. No standing auto-approval, no auto-merge.
- **Not** changing the implementer agents (`*-impl`). They stay **code-only** — they still write
  only source and leave the working tree for the main session to commit. Their five agent files
  are **not** modified, and they get **no** git tools.
- **Not** deleting `github-ops`.
- **Not** touching `linear-pm` or `obsidian-vault` — they remain the sole writers of their domains
  (Linear and `docs/`). Only **git** loses its single-writer requirement.
- **Not** creating a Linear issue or milestone for this work.
- **Not** splitting the conventions into two notes — one consolidated `git-workflow.md`.

## Invariants preserved

- **Confirmation before every git write** (now via the menu). Still defined in the `CLAUDE.md`
  Working rules as the source of truth for *policy*; the vault note documents the *convention*.
- **Implementers stay code-only**, leaving the working tree.
- **`linear-pm` / `obsidian-vault`** remain single writers of Linear / `docs/`.
- **Conventional Commits v1.0.0**, branch naming (`feature/<milestone-slug>`,
  `<type>/<ISSUE-ID>-<slug>`), the task→feature→main PR flow, and the Phase C batch-review flow
  are **unchanged in content** — only relocated/referenced.
- **The user merges** every PR (no auto-merge), including feature→`main`.

## The confirmation menu (A/B/C/D/E)

When the main session reaches a git write point, instead of asking in free text it presents a
**structured menu** rendered by the `AskUserQuestion` tool as an **arrow-navigable option list**
— never a plain-text list of letters the user answers by typing. Before showing it, the session gives a
short summary of what is staged and the proposed Conventional-Commits message, so the choice is
informed.

Options:

- **A. Commit + push + create PR** — offered **only when the session judges the feature/issue is
  complete**. When the work is not complete, option A is **omitted** from the menu (it does not
  appear grayed out — it simply is not there). The PR base follows the branch type:
  - on a **task branch** → PR into its **feature branch**;
  - on a **feature branch** → PR into **`main`**.
  The PR is **opened, never merged** — it stays open for the user's review (no auto-merge).
- **B. Commit + push**
- **C. Commit only**
- **D. Continue without committing** — run no git; leave the work in the working tree and carry on
  (an explicit skip of the commit at this point).
- **E. Write manually** — the native "Other" free-text option; the user describes the exact
  git action to run.

Menu rules:

- **Choosing an option IS the confirmation** for that specific write. The push bundled with a
  commit (B) is not re-confirmed separately — one choice authorizes the whole option.
- A choice authorizes **only that action** — never auto-merge, never a standing approval for
  future writes.
- The commit message always follows Conventional Commits v1.0.0 (type/scope/description, footers
  `Refs:`/`Closes:`, the repo `Co-Authored-By` trailer).
- This menu is the **default** confirmation path for the main session. If the user delegates a
  git batch to `github-ops`, that agent keeps its own "propose then wait" behavior — the menu is a
  main-session convenience, not a replacement for `github-ops`'s internal contract.

## Components to change

### 1. New vault note — `docs/shared/conventions/git-workflow.md`

- **Type** `convention`, **area** `shared`. Written by the **`obsidian-vault`** agent (repo rule:
  only it writes under `docs/`).
- Consolidates, without duplicating what already lives in sibling notes:
  - **Conventional Commits v1.0.0**: types (`feat|fix|build|chore|ci|docs|style|refactor|perf|test`),
    scope = vault area, `!` / `BREAKING CHANGE:` for breaking changes, `Refs:`/`Closes:` footers,
    the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
  - **Commit & PR references (context lookup)**: a best-effort, non-blocking lookup of where the
    work came from — Linear issue (optional), vault plan, superpowers plan/spec, other useful refs —
    attached as commit footers (`Refs:`/`Closes:`/`Plan:`/`Spec:`/`Design:`) and a `## References`
    section in the PR body. Never blocks a commit.
  - **Branch naming**: `feature/<milestone-slug>`, `<type>/<ISSUE-ID>-<slug>`.
  - **PR flow**: task→feature (squash-merge), feature→`main` (user merges); auto-delete of merged
    branches; pull base after merge.
  - **The confirmation menu (A/B/C/D/E)** as described above.
  - **Who may run git**: the main session may execute git directly (with confirmation);
    `github-ops` is an optional helper for complex batches. Implementers stay code-only.
- **References** (wikilinks), does not restate: `[[phase-c-review-flow]]` (batch-review + dependency
  gates), `[[linear-references]]` (how the vault references Linear), `[[milestone-plan]]`.
- **Points to** the `CLAUDE.md` Working rules as the source of truth for the *confirmation policy*
  (the note documents the convention; the policy lives in `CLAUDE.md`).
- **Indexed** from the overview MOC (`docs/00-overview/index.md`), where the other shared
  conventions are linked (there is no separate `conventions/index.md`).

### 2. `CLAUDE.md` — surgical rewrite of the affected sections

- **"Git — never commit on your own initiative"** (Working rules): keep the confirmation policy,
  but drop the requirement to route all git through `github-ops`. State that the **main session may
  execute git directly** following `[[git-workflow]]`, confirming via the A/B/C/D/E menu.
- **Subagents section / "one writer per tool"**: git is no longer a single-writer domain.
  `github-ops` is described as **optional** (delegate complex git batches to it), not mandatory.
- **Implementer invariant**: implementers still leave the working tree, but the commit is done by
  the **main session** (not necessarily `github-ops`).
- **Phase C / D flow**: steps that read `→ github-ops (task branch / commit / PR)` become
  "the main session (or, optionally, `github-ops`)".
- **Commit messages section**: remove "Enforced by `github-ops`"; point to `[[git-workflow]]`.
- **Branch flow section**: replace the inline detail with a pointer to the vault note, keeping only
  a short summary.

### 3. `.claude/agents/github-ops.md`

- Minimal edit to the `description`: reflect that it is an **optional** helper (delegation for
  complex git batches), no longer the mandatory gate for all git.
- Its internal "propose every write, wait for confirmation" contract is **kept as-is**.

### 4. Workflow spec — `docs/superpowers/specs/2026-06-26-implementation-workflow-design.md`

- Update the lines that describe `github-ops` as the mandatory single writer of git and the
  implementers-leave-work-for-`github-ops` framing, so the spec stays consistent with the new model.
- Written by the **`obsidian-vault`** agent (under `docs/`).

## Write ownership (respects repo rules)

| Target | Writer |
| --- | --- |
| `docs/shared/conventions/git-workflow.md` (new) | `obsidian-vault` |
| `docs/superpowers/specs/2026-06-26-implementation-workflow-design.md` (update) | `obsidian-vault` |
| `docs/00-overview/index.md` (link the new note) | `obsidian-vault` |
| `CLAUDE.md` | main session |
| `.claude/agents/github-ops.md` | main session |

No Linear writes. No service code. One branch off `feature/users-service`, one PR.

## Testing / validation

- `node scripts/validate-vault.mjs` (after the `nvm use` the repo requires) must pass — validates
  frontmatter and catches broken wikilinks for the new `git-workflow.md` and its references.
- Manual read-through of the rewritten `CLAUDE.md` sections for internal consistency (no dangling
  "Enforced by `github-ops`", no contradictory "one writer per tool" for git).
- Confirm the A/B/C/D/E menu is described identically in both `git-workflow.md` and the `CLAUDE.md`
  reference (single source of truth = the vault note; `CLAUDE.md` summarizes and links).

## Related

- [[2026-06-26-implementation-workflow-design]]
- [[phase-c-review-flow]]
- [[linear-references]]
