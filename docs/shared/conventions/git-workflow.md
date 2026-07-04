---
title: Git Workflow
type: convention
area: shared
status: active
created: 2026-07-03
updated: 2026-07-03
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[phase-c-review-flow]]"
  - "[[linear-references]]"
  - "[[milestone-plan]]"
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
  confirmation before every write via the [confirmation menu](#confirmation-menu-abcde).
  Git is **not** a single-writer domain.
- **`github-ops` is an optional helper.** Delegate a complex git batch to it (e.g.
  sequentially merging a batch of sibling PRs) when convenient. It keeps its own
  "propose every write, wait for confirmation" contract.
- **Implementer agents (`*-impl`) stay code-only** — they never run git; they leave
  their work in the working tree for the main session to commit.

## Confirmation menu (A/B/C/D/E)

When the main session reaches a git write point, it presents these options as an
**interactive, arrow-navigable list via the `AskUserQuestion` tool** — NOT as plain
text the user has to read and answer by typing a letter. The user selects an option
with the arrow keys. First the session summarizes what is staged and the proposed
Conventional-Commits message (in the surrounding text), then presents the menu:

- **A. Commit + push + create PR** — offered **only when the feature/issue is
  complete**. When the work is not complete, A is omitted from the menu. PR base
  follows the branch type: a **task branch** → PR into its **feature branch**; a
  **feature branch** → PR into **`main`**. The PR is **opened, never merged** — it
  stays open for the user's review.
- **B. Commit + push**
- **C. Commit only**
- **D. Continue without committing** — run no git; leave the work in the working
  tree and carry on (an explicit skip of the commit at this point).
- **E. Write manually** — free-text; the user describes the exact git action to run.

Rules:

- **Always render this menu with the `AskUserQuestion` tool** as an arrow-navigable
  option list — never as a plain-text list of letters in a normal message. Each
  option (A–E, minus A when the work is not complete) is one selectable choice; the
  free-text "E. Write manually" maps to the tool's native "Other" input. Presenting
  these options as prose is a mistake — the whole point of the menu is the selectable
  list.
- **Choosing an option IS the confirmation** for that write. The push bundled into B
  is not re-confirmed separately.
- A choice authorizes **only that action** — never auto-merge, never a standing
  approval for future writes.
- The commit message always follows [Conventional Commits](#commit-messages--conventional-commits-v100).

## Commit messages — Conventional Commits v1.0.0

All commits and PR titles follow Conventional Commits v1.0.0
(https://www.conventionalcommits.org/en/v1.0.0/): `<type>(<scope>): <description>`.

- **Types:** `feat|fix|build|chore|ci|docs|style|refactor|perf|test`.
- **Scope** = vault area: `users`, `orders`, `tracking`, `events-pipeline`, `infra`,
  `vault`, `agents`.
- **Breaking changes:** `!` before the `:` and/or a `BREAKING CHANGE:` footer.
- **Reference footers** (see the "Commit & PR references" section below for the full lookup):
  `Refs: JE-NN` / `Closes: JE-NN` for the Linear issue (optional — many commits have no issue),
  plus context footers where they exist: `Plan:`, `Spec:`, `Design:` pointing at the vault notes
  the work came from.
- **Repo trailer** in the footer block:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **PR bodies** end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
  and hyperlink every Linear issue ID (`[JE-NN](https://linear.app/je-martinez/issue/JE-NN)`),
  never bare `JE-NN` text.

## Commit & PR references (context lookup)

Before proposing a commit or PR, do a **best-effort lookup** of where the work came from and
attach those references. This enriches the history so a reader can trace a change back to its
origin. **It is a lookup, never a gate** — if a reference does not exist or does not apply, skip
it and proceed. Missing references NEVER block a commit.

What to look for (include the ones that exist):

- **Linear issue** — *optional*; many changes (like this repo's own convention work) have no
  issue. If one applies: `Refs: JE-NN` (or `Closes: JE-NN` when the commit completes it).
- **Vault plan** — the milestone-plan note under `docs/plans/`, if the work maps to a milestone.
- **Superpowers plan** — the implementation plan under `docs/superpowers/plans/` this work executes.
- **Superpowers spec** — the design spec under `docs/superpowers/specs/` the plan came from.
- **Other useful refs** — related ADRs/conventions/runbooks, an upstream PR, or external docs.

Where they go:

- **Commit footers** (Conventional-Commits footer block, `Token: value`): `Refs:` / `Closes:` for
  Linear; and path footers for the rest, e.g.
  `Plan: docs/superpowers/plans/2026-07-03-git-workflow-decentralization.md`,
  `Spec: docs/superpowers/specs/2026-07-03-git-workflow-decentralization-design.md`,
  `Design: docs/shared/conventions/git-workflow.md`. Footers are plain text — use repo-relative
  paths, not wikilinks.
- **PR body** — a short `## References` section with **clickable** links: hyperlink every Linear
  issue (`[JE-NN](https://linear.app/je-martinez/issue/JE-NN)`, never bare `JE-NN`), and link the
  vault notes as wikilinks (`[[git-workflow]]`) or repo-relative markdown links so a reviewer can
  click straight through.

Keep it proportionate: a one-line chore does not need five footers. Attach the references that
genuinely help someone understand or trace the change.

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
