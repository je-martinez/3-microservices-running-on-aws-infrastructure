---
title: "nvm cannot be sourced in isolated worktrees"
type: lesson
area: shared
status: active
created: 2026-10-02
updated: 2026-10-02
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/low
related:
  - "[[package-manager]]"
  - "[[scripting-language]]"
  - "[[2026-10-02-parallel-agents-share-one-scratchpad]]"
---

# nvm cannot be sourced in isolated worktrees

## Finding

In a Claude Code isolated worktree the sandbox blocks `source ~/.nvm/nvm.sh` and therefore
`nvm use`. `node` then resolves to whatever is on `PATH` — observed on 2026-10-02: **Node 22.23.3
instead of the 24.18.0** pinned in `.nvmrc`. Nothing fails loudly; commands simply run on the
wrong runtime.

## Workaround

Prepend the pinned version's `bin` directory to `PATH` instead of sourcing nvm:

```bash
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
node --version   # expect v24.18.0 (the .nvmrc version)
```

Every agent that day used this. Keep the version in the path in step with `.nvmrc`; run
`pnpm install` first if `node_modules` is missing in the fresh worktree.

## Related

- [[package-manager]] — documents the `.nvmrc` pin and the `nvm use` rule.
- [[scripting-language]] — the same Node-pin rule applied to scripts.
- [[2026-10-02-parallel-agents-share-one-scratchpad]] — another isolated-worktree gotcha from the same day.
