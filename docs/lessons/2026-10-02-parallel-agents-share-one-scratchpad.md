---
title: "Parallel agents share one scratchpad"
type: lesson
area: shared
status: active
created: 2026-10-02
updated: 2026-10-02
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
related:
  - "[[2026-10-02-a-migration-dropped-the-poller-its-plan-specified]]"
  - "[[2026-10-02-nvm-cannot-be-sourced-in-isolated-worktrees]]"
---

# Parallel agents share one scratchpad

## Finding

When several subagents run in parallel — **even each in its own isolated git worktree** — they
receive the **same** session scratchpad directory. Worktree isolation covers the repo checkout,
not the scratchpad.

On 2026-10-02 two agents both wrote a mutation-testing script named `mutate.py` into it. One
overwrote the other's, and an agent then executed the other agent's script against the **other**
agent's worktree. The script restored the files it touched in a `finally` block, and a later
`git diff` confirmed that worktree was intact — but that was luck in the script's design, not a
property of the setup.

## Rule

- **Scratch files carry a unique name** (agent or worktree id), e.g. `mutate-<worktree-id>.py`.
  A generic name in a shared directory is a collision waiting for a second agent.
- **A script that mutates source takes its target path explicitly** (argument, never a hardcoded
  or inferred default) **and verifies it before writing** — for example that the path sits inside
  the current worktree's root.
- After running any scratch script that edits source, check `git diff` in the worktree it was
  meant for.

## Related

- [[2026-10-02-a-migration-dropped-the-poller-its-plan-specified]] — the work that day's mutation checks were verifying.
- [[2026-10-02-nvm-cannot-be-sourced-in-isolated-worktrees]] — another isolated-worktree gotcha from the same day.
