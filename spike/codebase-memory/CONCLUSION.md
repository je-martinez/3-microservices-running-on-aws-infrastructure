# Conclusion — no code-memory engine for this repo

**Decision (2026-08-08): closed. Nothing adopted, nothing installed.**

This spike evaluated whether to add a structural code-memory engine feeding the Obsidian
vault, per `codebase-memory-obsidian-implementation-proposal.md`. Five measured rounds
say no. This file records what was measured and — more usefully — where the reasoning
was wrong along the way, so the question can be reopened on evidence rather than
re-litigated from scratch.

## What was measured

| Round | Question | Result |
|---|---|---|
| **A1** | Do agents waste context exploring? | **No.** 6 files, **0 source files**, 6/6 correct. An index-first rule gave **0%** improvement. |
| **A2** | And on change-impact questions? | **Yes.** 60 → 26 turns, and the baseline was *confidently wrong*. |
| **A3** | Do written checklists close it? | **No.** Written, verified, and **never read** — the agent stopped early. |
| **B** | Which engine, if any? | codebase-memory over Graphify: **217 vs 27** CALLS edges. |
| **A4** | Does the engine actually save tokens? | **No. It cost 35% more.** |

## The number that decided it

Real billed usage, from the subagent transcripts:

| Arm | Turns | Total input |
|---|---|---|
| Baseline (grep) | 60 | 4,726,249 |
| **Index-first** | **26** | **1,925,211** — **−59.3%** |
| Graph-assisted | 36 | 2,596,744 — **+34.9% vs index-first** |

**92% of all spend is re-paying accumulated context each turn**, not reading files.
Context grew 42k → 82k tokens; at ~74k per turn, the multiplier is **turns**. The graph
added ten of them.

## Four times the reasoning was wrong

Each was caught by checking rather than by arguing, and each is why the conclusion is
trustworthy:

1. **"Agents lack exploration direction."** False. A1's baseline found
   `services/users/CLAUDE.md` on its *second action*, unprompted, and read zero source
   files.
2. **"The checklists were unreachable — missing breadcrumb."** False. The spec is linked
   from `services/tracking/CLAUDE.md` §6, labelled *source of truth*, and the agent
   confirmed it saw the target twice. It stopped because a partial answer *felt*
   complete.
3. **"The engine missed the Orders test."** False. It indexes `e2e/`, contains
   `TrackingContractTests.cs`, and `search_code --pattern "SHIPPED"` finds it in one
   call. The **agent** used the wrong tool.
4. **"Tokens were never measured; 55% is the defensible figure."** False. The data was
   in the transcripts all along, and the real number is **59.3%**.

## Why it is still a no, after all four corrections

- **`search_code` is `grep` with an indexing step.** It found the Orders test by
  literal match — what `grep -r` already does, with no daemon and no index.
- **It fails on non-literal couplings.** `search_code --pattern "users.proto"` did not
  find `order-created.ts` or Orders' `.csproj`; they consume the proto by import and by
  build step, not by naming it.
- **You must know the answer to ask the question.** Searching `"SHIPPED"` presumes you
  know the coupling runs through that literal. The promised value was finding couplings
  you do *not* suspect.
- **Scale.** 398 source files, one repo, per-service `CLAUDE.md` files, and design specs
  that A1 proved are already optimal. The proposal is written for tens of thousands of
  files across many repos.
- **The proposal's own §21** lists vault noise and "no meaningful token reduction" as
  its top risks. Both landed.

## What actually works here, and why

The index-first result (**−59.3%**) came from the repo's own documentation, not from any
tool:

- **5 per-service `CLAUDE.md` files** — agents find them by convention, without being
  told
- **`docs/shared/conventions/`** — answered 3 of A1's 6 questions outright
- **Per-service design specs** — when finally read, *strictly more complete* than an
  agent's own grep reconstruction

That is the asset. It is why the baseline had nothing to improve, and it is what to keep
investing in.

## What was kept from the spike

Two `## Change impact` sections, written during A3 and left in place because they are
correct and useful even though the experiment they served failed:

- `docs/domains/users/specs/users-service-design.md` — the three propagation mechanisms
  for `proto/users.proto` (runtime-loaded, build-compiled, committed stubs)
- `docs/domains/tracking/specs/tracking-service-design.md` — 11 files across 4
  components for a status rename, including the silent email-template failure

A3 also proved these are not enough on their own: **agents stop when an answer feels
complete**, and prose cannot signal its own completeness. That limitation is unsolved and
is the strongest remaining argument for a query interface — just not at this repo's size.

## When to reopen

Concrete triggers, not vibes:

- The repo exceeds roughly **2,000 source files**, or spans **multiple repositories**
- A cross-service contract break reaches production despite the checklists
- `trace_path` is fixed upstream and `search_code` resolves import-level couplings
- Someone needs `get_callers` before changing a signature often enough to feel it

Everything needed to re-run the measurement is in `benchmark/`:
`measure_tokens.py` extracts real usage from subagent transcripts, and `tasks.md` has
the task set.

## Footprint

**None.** `~/.cache/codebase-memory-mcp` deleted, `graphifyy` uninstalled, no MCP client
configuration written, `graphify-out/` removed from `services/users`. Nothing was ever
added to `.mcp.json` or `.ai/settings.json`. Both engines ran as one-shot CLIs.
