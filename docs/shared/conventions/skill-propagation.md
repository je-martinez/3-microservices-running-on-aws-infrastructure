---
title: Skill Propagation
type: convention
area: shared
status: active
created: 2026-09-22
updated: 2026-09-22
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[skills-catalog]]"
  - "[[2026-08-06-multi-provider-agent-config-sync-design]]"
  - "[[doc-propagation]]"
  - "[[package-manager]]"
---

# Skill Propagation

## The problem this prevents

A new skill was authored at `.claude/skills/local-env-lifecycle/SKILL.md`, reviewed, and
committed. Nobody propagated it to the other AI providers, and nothing caught that — no gate,
no CI check, no reviewer note. The gap only surfaced because the user asked "did you sync the
skill with lnai?" after the commit had already landed and been pushed. This note exists so
that question never needs asking again.

## Why `make ai-sync` did not catch it

`.claude/skills/` currently has 38 entries; `.ai/skills/` has 15 (as of 2026-09-22, after
`local-env-lifecycle` was propagated). **23 skills living only in `.claude/skills/` is the
normal state, not a bug** — `.ai/skills/` is a curated, git-tracked allowlist (see
[[skills-catalog]] § Multi-provider sync), not generated output that mirrors `.claude/skills/`
wholesale.

The propagation flow is `.claude/` → `.ai/` → providers:

- `make ai-sync` runs `lnai sync`, which exports whatever is **already** in `.ai/skills/` to
  Cursor, Gemini, Windsurf, GitHub, and (via a symlink) Antigravity. It does **not** read from
  `.claude/skills/` directly.
- So adding a skill under `.claude/skills/` and running `make ai-sync` propagates **nothing**
  for that skill — the sync silently succeeds having done zero work on it, because from
  lnai's point of view the skill was never in its input set.
- `make ai-sync-check` does not catch this either. It checks three things only: `lnai validate`
  passes, `.claude/CLAUDE.md` does not exist (the disabled `claudeCode` target must stay off),
  and re-running the sync produces no diff against committed output. A skill that exists only
  in `.claude/skills/` passes all three, because nothing about it is stale from lnai's
  perspective — it was never an input.

> [!warning] A green `ai-sync-check` is not evidence a new skill propagated
> The check verifies the sync is *idempotent and internally consistent* — not that a skill you
> just wrote is *included*. Run the direct comparison in [Checking what is missing](#checking-what-is-missing)
> instead of trusting the gate for this class of mistake.

## Deciding whether a skill propagates — a deliberate choice, not a default

When authoring a skill, decide propagation **at authoring time**, not after. It is one line of
judgment in the author's head then, and an hour of confusion later otherwise.

- **Propagates** — the skill encodes how *this repo* operates: its `make` targets, its infra,
  its services. Codex, Cursor, and Antigravity all do real work in this repo and will hit the
  same traps a Claude-only skill would leave them blind to. Examples already in
  `.ai/skills/`: `floci`, `terraform-skill`, `mysql`, the `golang-*` set, the `prisma-*` set.
- **Does not propagate** — the skill is Claude-Code-specific: it depends on a Claude Code
  tool, an MCP server only Claude has, or a Claude-only subagent. Examples already excluded:
  `advance-tracking`, `defuddle`, the `obsidian-*` set (all depend on Obsidian tooling other
  providers do not have).

Use what is already in `.ai/skills/` vs. excluded as the established line — see
[[skills-catalog]] § Multi-provider sync for the authoritative allowlist and its rationale.

## Mechanical steps, in order

Getting the order or the copy/symlink distinction wrong is exactly what the Makefile's
`ai-sync` target CONTRACT comment warns against — lnai rewrites a real directory on every run,
deleting its tracked files and re-creating them untracked, which then makes `ai-sync-check`
fail looking like corruption.

1. `mkdir -p .ai/skills/<name>` and copy `SKILL.md` there (plus any `references/` or
   `scripts/` subdirectories the skill ships).
2. `ln -s ../../.ai/skills/<name> .agents/skills/<name>` — a **symlink**, never a copy. Every
   entry under `.agents/skills/` that mirrors a `.ai/skills/` entry must be a symlink; only
   the handful of skills with no `.ai/skills/` counterpart are legitimately real directories
   there.
3. `nvm use && make ai-sync` — propagates the new `.ai/skills/` entry out to Cursor, Gemini,
   Windsurf, and GitHub Copilot's skill directories.
4. Commit the generated provider output alongside the new skill: `.cursor/`, `.gemini/`,
   `.windsurf/`, and `.github/` are all tracked, not git-ignored.

## Checking what is missing

`make ai-sync-check` cannot see this class of mistake — do not treat a green run as evidence a
skill propagated (see the warning above). The check that actually answers "is this new skill
missing from the propagated set?" is a direct listing diff:

```bash
comm -13 <(ls .ai/skills | sort) <(ls .claude/skills | sort)
```

This lists every skill present under `.claude/skills/` and absent from `.ai/skills/`. Most
entries in that output are deliberate exclusions (Obsidian-family skills, `advance-tracking`,
etc.) — the question to ask is whether the **newly authored** skill belongs in that list or
not, per the decision rule above.

## Related

- [[skills-catalog]] — the installed-skills inventory and the shared/excluded allowlist this
  note's decision rule points back to; that note documents how skills are *installed*, this
  one documents how they *propagate* once installed.
- [[2026-08-06-multi-provider-agent-config-sync-design]] — design of the `ai-config-sync`
  subagent and the `lnai`-based sync pipeline this convention operates within.
- [[doc-propagation]] — the sibling propagation gate for vault specs/plans; same shape of
  problem (decisions made in one place, not fed into the place that needs them), different
  artifact.
- [[package-manager]] — another "pinned tool, easy to bypass silently" convention in the same
  family (pnpm vs. npm).
