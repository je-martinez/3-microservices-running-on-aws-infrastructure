---
title: Multi-Provider Agent Config Sync — Design
type: spec
area: shared
status: draft
created: 2026-08-06
updated: 2026-08-06
tags: [type/spec, area/shared, status/draft]
related: ["[[2026-06-26-implementation-workflow-design]]", "[[git-workflow]]", "[[doc-propagation]]"]
propagates-to:
  - "[[skills-catalog]]"
  - "[[index]]"
---

# Multi-Provider Agent Config Sync — Design

## Summary

This spec designs **`ai-config-sync`**, a subagent that keeps this repo's agent configuration
consistent across multiple AI coding providers — Claude Code, Codex, Cursor, Gemini CLI,
OpenCode, Windsurf, and GitHub Copilot — so that the same conventions, lessons learned, and
technical decisions apply regardless of which provider runs an agent.

The motivating use case is **[Orca](https://github.com/stablyai/orca)**, which launches many
CLI agents in parallel across worktrees. Orca defines **no configuration format of its own**:
it starts each agent with a permission-bypass flag and each agent reads its own native config
files. Consistency across an Orca fleet must therefore come from **this repo**, not from Orca.

The design adopts **[lnai](https://lnai.sh/)** (`@lnai/core`) as the propagation engine rather
than reimplementing multi-format export, and adds a thin layer for what lnai does not model —
chiefly subagents, which are projected into `AGENTS.md` as a roles appendix.

## Goals

- One source of truth for instructions, rules, skills, and MCP servers.
- Claude Code remains the **primary provider** and the source of truth.
- Subagent knowledge survives the trip to providers that have no subagent concept.
- Every non-portable element is **reported explicitly**, never silently dropped.
- Repeated runs are **idempotent** — a requirement, not a preference, because Orca runs
  agents in parallel across worktrees and a non-deterministic config step would make
  worktrees diverge.

## Non-Goals

- Replacing lnai or contributing plugins upstream (evaluated and rejected — see
  [Alternatives considered](#alternatives-considered)).
- Achieving feature parity across providers. Parity is impossible; the goal is
  **fidelity of knowledge**, plus honesty about what did not travel.
- Syncing Claude Code plugins. They are proprietary and have no equivalent elsewhere.

## Engine selection

Five candidates were evaluated. Two were tested empirically against this repo's real
subagents; the rest were assessed from source and repository metadata.

| | **lnai** | **AgentSync** | **agents** (amtiYo) | **ai-rules-sync** | **agentlink** |
|---|---|---|---|---|---|
| Providers | 7 | 13 | 11 | 11 | N (aliases) |
| Subagents | ❌ not modeled | ✅ first-class | ❌ | ✅ 5 providers | ❌ |
| Antigravity | ❌ | ✅ | ✅ | ❌ | ➖ |
| Skills | ✅ symlink | ✅ + index fallback | ✅ symlink | ✅ | ❌ |
| MCP | ✅ 4 formats | ✅ | ✅ 11 targets | ❌ | ❌ |
| Reverse ingest | ❌ `import()` is a stub | ✅ `adopt` | ➖ | ✅ | ➖ |
| Drift detection | manifest | ✅ SHA-256 + `check` | `status` | ❌ | ❌ |
| Stars / commits | **242** / 110 | 14 / 364 | 85 / — | 35 / — | 1 |
| Last push | 2026-07-31 | 2026-07-30 | 2026-05-30 | 2026-03-16 ⚠️ | 2026-07-25 |
| Language / license | **TS / MIT** | Bash / GPL-3.0 | TS / Apache-2.0 | TS / Unlicense | Go / MIT |

**lnai is chosen for provenance and maintainability, not for feature count.** AgentSync covers
more surface — subagents as a real target, Antigravity, `adopt`, a CI `check` — and testing
confirmed those work. It was rejected anyway:

- Its installer clones `yelmuratoff/agent.git` — a **different repository** from the
  `yelmuratoff/agent_sync` that was audited. An install path that does not match the audited
  source is disqualifying on its own.
- Single maintainer, 14 stars, no independent review surface.
- YAML parsed by Bash regex. A verified defect: `read_frontmatter_field`
  (`lib/helpers/format_conversion.sh:117`) captures only what follows `key:` on the same line,
  so a block scalar yields the literal `>-`. All nine of this repo's subagents use
  `description: >-`, so every one would arrive with an empty description. The bug is generic —
  it affects any multi-line field.
- GPL-3.0, which attaches obligations to modified distribution.

lnai is TypeScript with Zod validation, MIT-licensed, 242 stars, five contributors. Its gaps
are real but *known and bounded*, and this design handles them explicitly below.

### What lnai actually provides

Verified against `@lnai/core@0.6.92` by reading `dist/index.d.ts` and `dist/index.js`, not from
documentation. `UnifiedState` has exactly five fields:

```ts
interface UnifiedState {
  config:   { tools?: Partial<Record<ToolId, ToolConfig>> };
  settings: { permissions?: Permissions; mcpServers?: Record<string, McpServer> } | null;
  agents:   string | null;                      // the AGENTS.md body — NOT subagents
  rules:    MarkdownFile<RuleFrontmatter>[];
  skills:   MarkdownFile<SkillFrontmatter>[];
}
```

**Covered:** `AGENTS.md` as a single instruction source; rules translated to each native format
(`.mdc` for Cursor, `.github/instructions/*.instructions.md` for Copilot); skills exported as
symlinks; MCP servers rendered to `.mcp.json`, `.codex/config.toml`, `.vscode/mcp.json`,
`.gemini/settings.json`; allow/ask/deny permissions; and a manifest that cleans up orphaned
files.

**Two gaps that matter here:**

1. **Subagents are not modeled.** `UnifiedState.agents` is the *`AGENTS.md` string*, not a
   collection of agent definitions. This repo's nine subagents have no representation.
2. **Antigravity and Cursor CLI are not supported tools.** Orca launches both.

**A finding that shaped the design:** every plugin's `import()` returns `null` and every
`detect()` returns `false` — unimplemented stubs. lnai is **export-only** in practice, so the
`.claude/` → `.ai/` direction is built here. This *removes* a risk rather than adding one: we
depend on no upstream behavior that does not yet exist.

## Architecture

One rule, stated in a single line: **`.claude/` is source and always real; `.ai/` is derived
and always regenerable; the arrow points one way.**

```
.claude/  ──[distill: subagent]──▶  .ai/  ──[lnai sync]──▶  6 providers
(source,                           (derived,               .cursor/  .github/
 real files,                        disposable,            .gemini/  .windsurf/
 version-controlled)                gitignored)            .codex/   .agents/
                                                           opencode.json
```

### Stage 1 — Distillation and normalization (LLM; the subagent)

Reads `CLAUDE.md`, `.claude/agents/*.md`, `.claude/skills/`, `.mcp.json`, and
`.claude/settings.json`. Writes `.ai/AGENTS.md`, `.ai/rules/`, `.ai/skills/`, and
`.ai/settings.json`.

**Classification (needs judgment).** This repo's `CLAUDE.md` is ~200 dense lines, much of it
Claude-specific: the A/B/C/D/E menu rendered via `AskUserQuestion` (a tool that exists only in
Claude Code), `superpowers` skills, plugin paths. Copying it verbatim to Cursor or Copilot
produces a document instructing agents about tools that do not exist — noise that degrades
output rather than improving it.

| Universal → `AGENTS.md`                          | Claude-specific → stays in `.claude/`     |
|--------------------------------------------------|-------------------------------------------|
| Conventional Commits v1.0.0                       | A/B/C/D/E menu via `AskUserQuestion`      |
| Python-first scripting                            | `superpowers` skill invocations           |
| Env files are generated, never hand-edited        | Plugin-provided MCP servers               |
| Logging context; never log PII or plaintext email | `.claude/settings.json` `enabledPlugins`  |
| Three test layers per endpoint                    |                                           |
| Converse in Spanish; write docs in English        |                                           |
| Never commit/push without explicit confirmation   | (the *menu mechanism* is Claude-specific) |

Note the last row: the **policy** is universal, the **mechanism** is not. The distiller splits
at that seam rather than dropping the whole rule.

**Normalization (mechanical, must be deterministic).** Subagent frontmatter is emitted with
single-line quoted scalars rather than block scalars (`>-`, `>`, `|`). This is defensive
normalization at the boundary: it means the pipeline never depends on a downstream parser
supporting block scalars. Because output must be byte-identical across parallel Orca
worktrees, this is a **Python script** (`scripts/normalize_agent_frontmatter.py`), not model
output — consistent with the repo's Python-first convention ([[scripting-language]]). Verified
on all nine subagents: 9/9 semantically identical under `yaml.safe_load`, `tools:` preserved.

### Stage 2 — Propagation (deterministic; lnai)

`lnai sync` runs with **`claudeCode.enabled: false`** in `.ai/config.json`.

That flag is not a config detail — it is the mechanism that protects the source. Verified
experimentally in a scratch repo: with the Claude Code plugin **enabled**, `lnai sync` replaces
`.claude/CLAUDE.md` with a symlink to `../.ai/AGENTS.md`, destroying the original file with no
warning.

A detail specific to this repo, confirmed during implementation: our `CLAUDE.md` lives at the
**repo root**, not at `.claude/CLAUDE.md`, so lnai's Claude Code plugin never targets it
directly. The guard stays required regardless — it is what keeps `.claude/` out of the write
path entirely, and a future move of the file must not silently become destructive. Verified
with the guard in place: a full sync left `CLAUDE.md` byte-identical (checksum unchanged),
`.claude/` clean, and all six other providers correctly populated.

Also verified in the same run: `.claude/agents/*.md` and hand-authored `.claude/skills/<name>/`
survive a sync untouched, and lnai-managed symlinks coexist beside them in the same directory.

### The classification manifest

`.ai/.lnai-projection.yml` records classification decisions so successive runs are stable:

```yaml
rules:
  conventional-commits: universal
  git-confirmation-menu: claude-only   # AskUserQuestion has no equivalent
  python-first-scripting: universal
skills:
  floci: share                          # AWS emulator knowledge; portable
  terraform-skill: share
  obsidian-bases: exclude               # depends on Obsidian tooling
subagents:
  users-impl: role                      # projected as a passive role
  obsidian-vault: prohibition           # single-writer; see below
```

Without it, each run reclassifies from scratch and produces drift — precisely the problem this
design exists to solve. The manifest is **version-controlled**; `.ai/` is not.

## Subagent projection

Subagent definitions carry two kinds of information, and only one survives:

| In `.claude/agents/*.md`               | Travels? | Why                                              |
|----------------------------------------|----------|--------------------------------------------------|
| `name`, `description`                  | ✅       | Prose; every provider reads it                   |
| Body (role, responsibilities)          | ✅       | The actual knowledge                             |
| `tools:` allowlist                     | ❌       | **Enforceable restriction**; no equivalent       |
| Context isolation                      | ❌       | A subagent owns a context window; a section does not |

Projection emits a `## Roles` section inside `.ai/AGENTS.md`, one entry per agent, naming what
it does, what it must not touch, and what the loss is:

> **users-impl** — implementer for the Users service (Fastify, Aurora Postgres).
> Writes **source code only**. Never runs git, never touches Linear. Leaves work in the
> working tree for the main session to commit.
> *In Claude Code this is a subagent whose tools are restricted to Read/Write/Edit/Bash/Glob/Grep.
> In this environment the restriction is not tool-enforceable — treat it as a norm.*

The italic line is deliberate. Without it, an agent in Cursor reads "never runs git" as a
suggestion. With it, the agent knows it is a repo rule the tool cannot enforce but must still
respect. **Naming the loss is what makes it partially recoverable.**

### External-write agents become prohibitions, not roles

`linear-pm`, `obsidian-vault`, and `github-ops` are **single writers** of their resource.
Projecting them as "available roles" to a provider without subagents is actively dangerous — it
invites the main agent to believe it may write to `docs/` or Linear itself. They are therefore
projected as **prohibitions**:

> Writes to `docs/` go through the `obsidian-vault` agent. If that agent does not exist in this
> environment, propose the change and wait for explicit confirmation — never write directly.

### Roles are not skills

Subagents are **not** projected into `.ai/skills/`, though they would technically fit. A skill
auto-invokes on description match; a role invoked as a skill would make an agent in Cursor
"become `users-impl`" in the middle of an unrelated task. Roles belong in `AGENTS.md` as
**passive context**, not in skills as **active behavior**.

## Skills

`.claude/skills/` holds 24 third-party skills governed by `skills-lock.json` with source
hashes. That creates a two-owner conflict: lnai wants to symlink `.ai/skills/<name>` →
`.claude/skills/<name>`, but `skills-lock.json` already governs that directory.

Resolution: `.ai/skills/` holds **copies** of the shared subset, not symlinks back into
`.claude/skills/`. This gives up the elegance of lnai's symlink model, but prevents a
`skills update` from rewriting a directory another provider is reading mid-run — which matters
specifically because Orca runs agents in parallel.

Selection is explicit, not wholesale. `floci` (the local AWS emulator) and `terraform-skill`
are portable and valuable elsewhere. `obsidian-bases`, `json-canvas`, and `defuddle` depend on
tooling other providers lack. The manifest carries the list.

## MCP servers

This is where lnai delivers direct value. A single declaration in `.ai/settings.json` renders
`.mcp.json`, `.codex/config.toml`, `.vscode/mcp.json`, and `.gemini/settings.json` in their
native formats. The schema supports `${VAR}` interpolation, so `$APIDOG_PROJECT_ID` travels
without hardcoding a token.

Plugin-provided MCP servers (Linear, `aws-dev-toolkit`, `context7`) do **not** live in
`.mcp.json` — they come from `enabledPlugins` in `.claude/settings.json` and are proprietary to
Claude Code. They are not projectable and appear in the loss report.

## Loss report

Every run ends with an explicit summary of what did not travel:

```
Not portable (Claude Code only):
  · tools: allowlist on 9 subagents → prose norm, not enforceable
  · Context isolation per subagent → no equivalent anywhere
  · A/B/C/D/E menu via AskUserQuestion → described as a convention
  · Plugins (superpowers, linear, aws-dev-toolkit) → no equivalent
  · 6 skills depending on Obsidian tooling → excluded by decision
```

This is not cosmetic. It prevents assuming parity where none exists — an assumption that
becomes expensive when Orca is running agents across several providers at once.

## Verification

1. `lnai validate` passes.
2. **`.claude/CLAUDE.md` is still a regular file, not a symlink**, and `.claude/agents/` is
   unchanged. This is the check that catches the failure reproduced during design. On detecting
   a symlink or a modified source: abort and report.
3. Every normalized subagent is semantically identical to its source under `yaml.safe_load`.
4. A second consecutive `lnai sync` reports only `=` (unchanged) — proving idempotence.

## Alternatives considered

**AgentSync.** Feature-superior and empirically verified to work, but rejected: its installer
clones a **different repository** than the one audited, it has a single maintainer and 14
stars, it parses YAML with Bash regex (one confirmed data-loss defect), and it is GPL-3.0.
Provenance and reviewability outweigh feature count for something that rewrites agent
configuration across a fleet.

**Build the whole thing ourselves.** Rejected: lnai already solves the tedious, valuable half —
seven native formats, manifest tracking, orphan cleanup.

**Write and maintain lnai plugins for Antigravity and Cursor CLI.** Rejected for now: it makes
this repo a maintainer of plugins for a project still at `0.6.x`. Reconsider if Antigravity
becomes a primary provider.

**`.ai/` as source, `.claude/` symlinked (lnai's canonical model).** Rejected: it would leave
`.claude/` half symlinks and half real files — `.claude/agents/` can never be symlinked since
lnai does not model it — which is exactly the confusing state that invites drift.

## Operational findings from the first end-to-end run

Four things surfaced only once the pipeline ran against this repo. They are recorded
here because each is a trap the next person would otherwise re-discover.

**Rule globs must never name a root directory literally.** lnai's Codex and Gemini
plugins turn a glob's first literal segment into a directory and write an `AGENTS.md`
/ `GEMINI.md` inside it. A `docs/**` glob therefore wrote a file **into the Obsidian
vault**, and `scripts/validate-vault.mjs` failed on it — the validator walks the
filesystem with `readdirSync`, so `.gitignore` does not hide anything from it. Use
`**/`-prefixed patterns (`**/*.md`, `**/*.py`) or extension globs instead. A
`**/.env*` glob likewise created a root `.env/` **directory**, which would have broken
`make env-file`.

**lnai's rule schema requires `paths`, not `name`/`description`.** `paths` must be a
non-empty glob array; a rule without it fails validation outright.

**Windsurf exports every rule as `trigger: manual`.** They are present but not
ambient, so a rule that only lives in `.ai/rules/` is effectively inert there. This
is why safety-critical policy — chiefly "never commit without explicit confirmation" —
must also appear in the body of `AGENTS.md`, which Windsurf reads ambiently. Treat
`.ai/rules/` as reference material and `AGENTS.md` as the load-bearing surface.

**Frontmatter that Claude Code tolerates can be invalid to stricter parsers.** The
`floci` skill's description contains an unquoted `": "` (in `:4566` and
`Knowledge layer:`), which lnai's js-yaml rejects. Fix the **copy** under `.ai/skills/`
and never the source under `.claude/skills/`; the projection manifest records that the
fix must be re-applied after each re-copy.

## Risks

- **Subagents reach other providers as prose only.** This is the largest fidelity loss and it
  is inherent to lnai. If it proves costly in practice, revisit AgentSync (with a vendored,
  audited copy rather than its installer) or write an lnai plugin.
- **lnai is at `0.6.x`.** The export surface may change. Mitigated because `.ai/` is fully
  regenerable and `import()` — the unstable-looking half — is unused.

## Open questions

- **Antigravity and Cursor CLI** are unsupported by lnai but launchable by Orca. Deferred: ship
  for the seven supported providers first, measure whether the gap hurts in practice.
- **`.ai/` in `.gitignore`** assumes every environment can run `lnai sync`. If an Orca worker
  starts without it, that worker gets no config. Revisit if it occurs.

## Related

- [[2026-06-26-implementation-workflow-design]]
- [[git-workflow]]
- [[doc-propagation]]
- [[scripting-language]]
- [[skills-catalog]]
