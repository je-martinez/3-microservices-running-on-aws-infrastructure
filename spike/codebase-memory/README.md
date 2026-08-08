# Codebase Memory Spike

Evaluating whether this repo needs a structural code-memory engine (Codebase Memory,
Graphify, GitNexus, CodeGraph) feeding the Obsidian vault.

Source proposal: `codebase-memory-obsidian-implementation-proposal.md`.

**Nothing here writes to `docs/` or to any service.** The spike is read-only by
construction; the proposal's own §7 mandates a dry-run before any vault write, and we
have not reached that point.

## Why a spike rather than an implementation

The proposal is well-designed, and its principles line up almost exactly with the
multi-provider sync already shipped in this repo: dry-run first, controlled blocks,
a provider-independent model, never overwrite human-authored content.

But it is written for a problem profile this repo may not have. Measured 2026-08-07:

| | This repo | Where the proposal pays off |
|---|---|---|
| Source files | 398 (138 ts, 100 py, 96 cs, 64 tf) | Tens of thousands |
| Repositories | 1 | Many |
| Vault notes | 187, already organized | Empty or chaotic |
| Per-service design specs | Already exist (370 and 296 lines) | Missing |
| Per-service entrypoints | 5 `CLAUDE.md` files | Missing |

398 files is a codebase that fits in context. The proposal's §21 lists three risks that
land directly here: **vault noise** (187 curated notes plus generated entities degrades
the second brain), **no meaningful token reduction**, and its own §22.13 principle —
*do not add embeddings until graph retrieval proves insufficient* — which applies one
level up: do not add a graph engine until hand-written documentation proves
insufficient.

So: measure first. That is Part A.

## Structure

```
spike/codebase-memory/
├── README.md            # this file
└── benchmark/
    ├── tasks.md         # Part A design: hypothesis, arms, metrics, thresholds
    ├── arm-a-raw.md     # baseline run output
    ├── arm-b-raw.md     # directed run output
    └── results.md       # comparison and verdict
```

## Part A — does the exploration problem exist?

Tests one narrow, falsifiable claim:

> Agents read more source files than necessary because nothing directs them to the
> existing index before they start exploring.

Two arms, same questions, fresh subagents: **A** gets nothing, **B** gets a four-line
index-first rule. If B wins big, the fix is a rule — and the multi-provider sync
already ships rules to six providers for free. No engine required.

The task set deliberately includes three **pure convention-recall** questions already
fully documented in the vault. If the baseline burns tokens on those, the problem is
discoverability, which a code graph would not address at all.

See `benchmark/tasks.md` for the full design.

## Part B — is the graph worth it on capability alone?

Only if Part A justifies it, or if the graph's capabilities are wanted for their own
sake. `get_callers`, `get_change_impact`, and cross-service flow detection are things
no hand-written doc provides.

Scope would be one service (Users, the largest), answering the proposal's
`findings.md` questions — indexing quality, incremental updates, license, performance.
No vault writes, no adapter, no MCP.

The honest caveat, from the proposal's own §21: structural analyzers degrade on DI,
reflection, and dynamic dispatch. Users runs Awilix DI, Orders uses .NET DI, and the
four services communicate over gRPC, SQS, and WebSocket. Those are precisely the
blind spots of a single-language static analyzer — and precisely where cross-service
impact analysis would be most valuable. A spike must confirm the tool clears that bar
before anything is built on it.

## Status

- [x] Part A designed
- [x] Part A1 executed — 6 documented-knowledge questions (2026-08-07)
- [x] Part A2 executed — 3 change-impact questions (2026-08-07)
- [x] Part A3 executed — cheap-fix test: checklists written, re-measured (2026-08-07)
- [x] A3 root cause established (follow-up questioning of the run)
- [x] Part B executed — both engines run against `services/users` (2026-08-07)
- [x] Part B verdict: **codebase-memory, for change-impact queries only**

### Part B in one line

`codebase-memory-mcp` produced **217 CALLS edges** to Graphify's **27** over the same
43 TypeScript files — 8× the call-graph coverage, indexed in 1.3s, entirely offline.
Full scorecard and caveats: `part-b-engine-comparison.md`.

### The three conditions on that verdict

1. **Use `query_graph` (Cypher), not `trace_path`.** The flagship caller/callee tool
   returned empty for every symbol tried — including `hashEmail`, which the same graph
   correctly reports as having 8 callers and which Cypher then listed exactly.
2. **Treat output as a lead, not a fact** — but a filterable one. There were **two**
   phantom routes, not one, from two different causes. A one-line predicate
   (`method <> '' AND in_degree > 0`) drops the string-literal phantom with **zero
   false negatives**, using metadata the engine already computes but
   `get_architecture` ignores. See `hallucination-mitigation.md`.
3. **Do not build the Obsidian adapter.** A3 falsified its premise: the failure is
   agents stopping early, not knowledge missing from the vault. Generating notes would
   add exactly the vault noise the proposal warns about in its own §21.

### What survives of the original proposal

Its MVP was engine → intermediate model → Obsidian adapter → MCP → measure. The
evidence supports the engine and the MCP — and the MCP **already exists**, since
`codebase-memory-mcp` is itself an MCP server. The intermediate model is premature with
one provider, the adapter is falsified, and the measuring is what Part A already did.

The honest version is far smaller than the document: point an existing MCP server at
the repo, query it with Cypher for blast radius, build nothing.

### A3 in one line

The checklists were written, verified, and **never read** — not because they were
hard to find, but because a partial answer felt complete and the agent stopped.

### Why that matters more than it sounds

The first diagnosis was "missing breadcrumb" and it was **wrong**. Checked directly:
`services/tracking/CLAUDE.md` §6 links the spec by relative path, labelled *"source of
truth"*, and the agent confirmed the spec also appeared in its own grep results. It saw
the target twice and did not open it, because
`services/tracking/scripts/generate_grpc_stubs.py`'s docstring had already given a
plausible partial answer.

A missing link is a one-line fix. **"Agents stop when satisfied" is not fixable by
writing more or linking better** — a partial answer to "what must change" looks exactly
like a complete one. It is a list, and nothing about a short list announces its
shortness.

This also reframes the graph engine's value. Not knowledge the docs lack — when finally
read, the specs were **strictly more complete** than the agent's grep reconstruction,
which found 3 of 4 proto consumers and missed `order-created.ts` entirely. What a query
interface adds is a **terminating condition**: `get_callers` returns *the set*, and the
caller knows it is the set. Prose cannot signal its own completeness.

### The two runs disagree, and the disagreement is the finding

**A1 — documented knowledge** (`benchmark/results.md`). Both arms read **6 files, zero
source files**, answered 6/6 correctly. The index-first rule gave **0% reduction** —
the baseline found `services/users/CLAUDE.md` on its second action, unprompted. There
was nothing to improve.

**A2 — change impact** (`benchmark/results-impact.md`). Arm A read **20** files, Arm B
read **9** — a 55% reduction *with better accuracy*. The baseline shipped a factual
error: it concluded Tracking does not consume `proto/users.proto`, when Tracking
commits generated stubs guarded by a byte-for-byte test. Following that answer breaks
CI.

The line between the two runs is sharp, and Arm B named it:

> *"The index only explains architecture, not blast radius."*

Documentation says **what talks to what**. Change impact needs **which lines change
together**. The first is authored; the second is derived.

### Why this does not automatically justify a graph engine

The coupling used as the hard case — `email/catalog.ts` mapping tracking statuses to
email templates — turned out to be **already documented**, by filename, at
`docs/domains/events-pipeline/specs/events-pipeline-design.md:287`. The information
exists; it is not indexed *as impact*.

So the cheaper experiment comes first: write "Change impact" sections into the two
specs measured here, then re-run Q1 and Q3. If a written checklist closes the gap, a
graph engine is unjustified at this repo's size.

The counter-argument, which is real: checklists are manual and decay — every new
coupling needs a human to notice and record it. A graph derives them. That is a
**maintenance-cost** argument, not a capability one, and Part B should be argued on
those terms rather than on capability the docs supposedly cannot provide.
