---
name: git-and-commits
description: Never commit, push, merge, or open a PR without explicit user confirmation. All commits and PR titles follow Conventional Commits v1.0.0. Review every diff against the brief it was written from, not on its own merits.
paths:
  - "**"
---

# Git and commit messages

## Never write to git without explicit confirmation

**Never commit, push, merge, or open a pull request without explicit user
confirmation.** Leave finished work in the working tree and ask.

When a git write is warranted:

1. Summarize what is staged.
2. Propose the Conventional-Commits message.
3. Ask the user to choose an action, and wait for their answer.

The available actions are always the same five:

- **A.** Commit + push + create PR — only when the feature/issue is complete
  (PR base by branch type; opened, never merged).
- **B.** Commit + push.
- **C.** Commit only.
- **D.** Continue without committing (leave the work in the working tree and
  carry on).
- **E.** The user writes the commit manually.

Choosing an option **is** the confirmation for that write, and authorizes
**only** that action. It is never standing approval, and never authorizes a
merge.

This rule overrides any tool, skill, or workflow that commits automatically.

**Never auto-merge.** The user merges (or explicitly authorizes the merge of)
every PR; one approval authorizes only that PR or batch.

## If you are a dispatched agent, you NEVER run git — no exceptions

This applies to **every agent, of every vendor** — Claude, Codex, Cursor,
Antigravity, Gemini, or any other — and whether you were dispatched through Orca
orchestration, a subagent tool, or a prompt pasted into your terminal.

**You do not run `git commit`, `git push`, `git merge`, `git rebase`, `git tag`,
`gh pr create`, or `gh pr merge`. Ever.** You finish your work, leave it in the
working tree, and report what you changed. The main session — the one actually
talking to the user — is the only place a git write is proposed and confirmed.

The confirmation flow above is a conversation with the **user**. You are not in
that conversation, so you cannot satisfy it. These do NOT authorize you:

- The task brief did not say "do not commit". Silence is not permission; this
  rule is the default and it is always on.
- Your change is small, obviously correct, self-contained, or fully tested.
  Correctness was never the question — authorization is.
- You are finishing, and committing feels like the tidy way to hand work over.
  Leaving it uncommitted **is** the handover.
- Someone else's uncommitted work is in the tree and you want to isolate yours.
  Say so in your report instead.
- A skill, template, or habit of yours ends a task with a commit. This rule
  overrides it.

This is not a formality. A dispatched agent that commits on its own:

- **pushes work the user never reviewed**, and if it also pushes, puts it on a
  shared branch and into an open PR where it cannot be quietly undone;
- **can sweep up other agents' in-flight edits** when several workers share a
  worktree — `git add -A` or a broad pathspec does not know which changes are
  yours;
- **breaks the batch review the repo is built around**, where the user sees one
  coherent set of changes and one proposed message per logical unit.

Observed on 2026-08-31: a dispatched worker fixing a single spec ended its task
by committing AND pushing to the shared feature branch. The change itself was
good; it still bypassed review, and the commit could not be undone without
rewriting a pushed branch. Hence this section.

**What to do instead, always:** leave every file edited and uncommitted, then
report which files you touched and why. If you believe a commit is genuinely
needed before you can continue, stop and say so in your report — the parent will
decide and, if appropriate, ask the user.

The only actor that may run git is the main session, and only after the user
picks one of the five options above. (`github-ops` is an optional helper the main
session may delegate a git batch to — it is not a dispatched implementer, and it
asks for the same confirmation.)

**Read-only git is fine** and often useful: `git status`, `git diff`, `git log`,
`git show`. The prohibition is on writes.

## Conventional Commits v1.0.0

All commits and PR titles follow <https://www.conventionalcommits.org/en/v1.0.0/>:

```
<type>(<scope>): <description>
```

- **types:** `feat`, `fix`, `build`, `chore`, `ci`, `docs`, `style`, `refactor`,
  `perf`, `test`
- **scope:** the area of the repo — `users`, `orders`, `tracking`,
  `events-pipeline`, `infra`, `vault`, `agents`
- **breaking changes:** use `!` after the scope and/or a `BREAKING CHANGE:` footer

Before proposing a commit or PR, do a **best-effort** lookup of context
references — the tracker issue (if any), the plan, the design spec — and attach
them as footers (`Refs:`, `Closes:`, `Plan:`, `Spec:`, `Design:`) and as a
`## References` section in the PR body. This is enrichment, **never a blocker**:
absence of a reference never stops the commit.

## Branch flow

- Milestone → `feature/<milestone-slug>`, branched off `main`.
- Issue/task → `<type>/<ISSUE-ID>-<slug>`, branched off its feature branch.
- Task PR targets the feature branch (squash-merge; merged branches are
  auto-deleted).
- On milestone completion, **propose** a PR from the feature branch to `main`
  and stop. The user merges after review.

## Batch review and dependency gates

- **Chain issues without per-merge prompts.** Work issues one after another. Do
  not ask for merge confirmation between each issue, and do not self-merge task
  PRs during the chain — leave them open.
- **Batch PRs for review.** At each stop point, present **one list** of open PRs
  to review and merge, never one at a time.
- **Dependency gates are stop points.** If issue B is blocked by A, B must build
  on A's **merged** work. Implement everything independent first, open those
  PRs, then stop and hand over the batch. Continue after the user merges it. A
  milestone may have several stop points.

## Review the diff against the brief, not on its own merits

*"Is this correct?"* and *"does this do everything it was asked to do?"* are
different questions, and **only the first gets asked by default.**

When reviewing, **enumerate the brief's requirements** — the spec, the plan, the
issue, the task description — and tick each one off against the diff. Do not judge
the diff holistically.

A requirement silently dropped during implementation leaves **no trace**. The
shipped code is self-consistent, it passes review on its own terms, and the tests
written alongside it cover **what was built rather than what was specified**. There
is nothing in the diff to notice, which is exactly why a holistic read cannot
catch it.

This is not hypothetical. The cart's concurrent-`PUT` retry was specified in the
design spec from its **first commit**, shipped as an unhandled `500`, passed its
per-task review, and was caught only by chance in a later whole-branch pass.

**Concurrency requirements are the highest-risk case**, since ordinary tests
structurally do not exercise them: a race needs two callers interleaved at a
precise point, so a suite can be complete by its own measure and still never
execute the path the spec was written about.

Full lesson: `docs/lessons/2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec.md`.
