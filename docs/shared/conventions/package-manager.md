---
title: Package Manager
type: convention
area: shared
status: active
created: 2026-08-13
updated: 2026-08-13
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[local-dev]]"
  - "[[scripting-language]]"
---

# Package Manager

## Rule

**pnpm is the default and only package manager for every Node package in this repo.**
Never `npm install`, never `yarn`. This applies to **new** sub-projects too, not just the ones
already listed in `pnpm-workspace.yaml` — a new Node package under this repo joins the pnpm
workspace, it does not bring its own lockfile.

## Why this rule exists (the evidence)

Two concrete incidents anchor this, one documented and one caught in review:

- `services/users/CLAUDE.md` states plainly that a bare `npm install` corrupts the pnpm tree.
  Mixing managers produces a stray `package-lock.json` beside `pnpm-lock.yaml`, a duplicated
  `node_modules` layout (npm and pnpm structure the dependency tree differently — pnpm's is a
  content-addressable store with symlinks, npm's is flat), and two lockfiles that disagree
  about the same dependency's resolved version. That disagreement doesn't fail loudly — it
  shows up later as "works on my machine."
- Scaffolding `e2e/load-tests/` from the Gatling JS quickstart initially used `npm`, because the
  Gatling docs and demo repo use `npm` throughout. It had to be caught and redone with pnpm.
  The vendor's own instructions were not a valid reason to deviate — see the rule below.

## Rules for new sub-projects

- **A new Node package under this repo is added to the pnpm workspace, not installed
  standalone.** `pnpm-workspace.yaml` is the registry of packages — currently:
  `services/users`, `functions/events-pipeline`, `functions/realtime-events`, `e2e`, and
  `e2e/load-tests`. Add the new path there before running any install in it.
- **A vendor's own docs are not a reason to deviate.** When a tool's quickstart, demo repo, or
  official docs show `npm`/`npx` commands (the Gatling JS demo is the concrete example),
  translate them to the pnpm equivalent rather than copying them verbatim.
- **Node itself is pinned by [`.nvmrc`](../../../.nvmrc)** (currently 24.18.0). Run `nvm use`
  before any pnpm command — see the Node.js rule in the root `CLAUDE.md` and [[scripting-language]]
  for the same pattern applied to script languages.

## Command mapping

| Instead of | Use |
|---|---|
| `npm install` | `pnpm install` |
| `npm install <pkg>` | `pnpm add <pkg>` |
| `npm run <script>` | `pnpm run <script>` (or just `pnpm <script>`) |
| `npx <bin>` | `pnpm exec <bin>` (for a binary already a dependency) or `pnpm dlx <pkg>` (for a one-off, not installed) |
| `npm run <script> --workspace=<pkg>` | `pnpm --filter <package> <script>` |

`pnpm --filter <package> <script>` runs a script scoped to one workspace package — the repo
already relies on this, e.g. `pnpm --filter @3mrai/e2e test` for the gateway E2E suite (see
[[local-dev]]).

## Related

- [[local-dev]] — Makefile and local dev flow this workspace supports.
- [[scripting-language]] — sibling convention: same "why this exists" evidence-first shape,
  covering the Python/JavaScript/Bash decision for scripts rather than the JS package manager.
