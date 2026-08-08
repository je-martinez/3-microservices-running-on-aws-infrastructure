# Real token measurement — and why the graph made it worse

Measured 2026-08-08 from Claude Code subagent transcripts (`~/.claude/projects/…/subagents/*.jsonl`),
which record the usage the API actually billed. No estimation, no re-running: the
transcripts for every arm already existed.

## The numbers

| Arm | Turns | Fresh input | Cache read | Cache write | Output | **Total input** |
|---|---|---|---|---|---|---|
| A1 baseline (6 documented Qs) | 16 | 32 | 833,619 | 129,051 | 3,231 | **962,702** |
| A1 directed | 17 | 34 | 933,472 | 147,305 | 1,782 | **1,080,811** |
| A2 baseline (3 impact Qs) | 60 | 120 | 4,509,825 | 216,304 | 8,955 | **4,726,249** |
| A2 index-first | 26 | 52 | 1,772,954 | 152,205 | 11,164 | **1,925,211** |
| **A4 graph-assisted** | **36** | **72** | **2,329,968** | **266,704** | **12,777** | **2,596,744** |

| Comparison | Input change |
|---|---|
| A1: directed vs baseline | **−12.3%** (costs more) |
| A2: index-first vs baseline | **+59.3% saved** |
| A4: graph vs baseline | +45.1% saved |
| **A4: graph vs index-first** | **−34.9% (graph is worse)** |

## Correction to an earlier claim

I previously told the user I had never measured tokens and that 55% (a file-count
proxy) was the defensible number. Both were wrong: the data existed in the transcripts,
and the real figure for the index-first arm is **59.3%**, slightly better than the
proxy suggested.

## Where the tokens actually go

Decomposing A2 index-first's 1.9M:

| Component | Tokens | Share |
|---|---|---|
| Fresh input | 52 | **0.003%** |
| Cache read | 1,772,954 | **92.1%** |
| Cache write | 152,205 | 7.9% |

**Reading files is not the cost. Re-paying accumulated context every turn is.**
Context grew 42,208 → 82,342 tokens across the run; at ~74k per turn over 26 turns,
the multiplier is *turn count*, not *file count*.

That reframes the MVP result: A2's 59.3% saving came from cutting turns 60 → 26. Cutting
file reads was the mechanism, but turns were the variable that mattered.

## The hypothesis this run tested, and falsified

> If turns are the multiplier, replacing exploration with a few precise Cypher queries
> should beat the index-first arm by a wide margin.

**It did not. The graph arm used 35% more input than the index-first arm** (2.6M vs
1.9M) across **36 turns vs 26**.

Three compounding reasons, all visible in the transcript:

**1. Failed queries cost a full turn each.** Of 8 Cypher queries, 2 returned 0 rows:
- `GetUserById` was indexed as a `Method`, not a `Function`. Querying the wrong label
  returned **0 rows rather than an error** — indistinguishable from "this function has
  no callers".
- Python module-to-module `IMPORTS` did not resolve for `domain/status.py`, despite
  grep confirming two real importers. The agent fell back to grep anyway.

**2. The graph answers *which files*, not *what is in them*.** The agent still opened
`proto/users.proto`, `UserDirectoryGrpcClient.cs`, `get-user-by-id.ts`, and
`status.py` — because it needed message fields, mapping logic, and enum values, none of
which are graph node properties. The queries were **additive to** file reads, not a
replacement for them.

**3. Verification is mandatory, and it costs turns.** The known false-positive rate
means every surprising result needs checking against source. That is the tax documented
in `hallucination-mitigation.md`, now visible in tokens.

## The finding that matters more than the cost — with a correction

The graph arm missed both hard consumers that the grep-based arms found:

- `services/orders/tests/Orders.Tests/Infrastructure/TrackingContractTests.cs` — hardcodes `"SHIPPED"`
- `functions/events-pipeline/src/handlers/order-created.ts` — a `users.proto` consumer

**Correction (verified after the run): this was the agent's fault, not the tool's.**

A first draft of this document blamed the engine. Checking directly:

```
MATCH (f:File) WHERE f.file_path CONTAINS 'e2e/' RETURN count(f)      → 21
MATCH (f:File) WHERE f.file_path CONTAINS 'TrackingContract' …        → found
search_code --pattern "SHIPPED"    → 10 hits in 6 files, INCLUDING TrackingContractTests.cs
```

The engine indexes `e2e/`, contains the Orders test, and finds it in **one call**. The
agent used `query_graph` (the call graph) where it should have used `search_code`
(literal search). Wrong tool, not missing data.

That correction matters, because it is fixable with better instructions — and it means
the earlier framing ("a call graph cannot model string couplings") was too strong.

**What survives the correction, and still sinks the case:**

1. **`search_code` is `grep` with an indexing step.** It found the Orders test by
   searching for the literal `"SHIPPED"` — exactly what `grep -r` does, already
   available, with no daemon and no index.
2. **It also fails on the couplings that are not literal.** `search_code --pattern
   "users.proto"` returned 10 files, mostly this spike's own documents, and did **not**
   find `order-created.ts` or Orders' `.csproj`. Those consume the proto by import and
   by build step, not by mentioning its name.
3. **You must already know the answer to ask the question.** Searching `"SHIPPED"`
   requires knowing the coupling runs through that literal. If you know that, `grep`
   serves equally. The promised value was discovering couplings you do *not* suspect,
   and neither tool delivered that here.

So the cost finding stands on its own: **35% more tokens and 10 more turns**, even if
the completeness gap was self-inflicted.

## Revised conclusion

Part B recommended codebase-memory for change-impact queries. **That recommendation is
withdrawn on this evidence.** For this repo, at this size:

- The index-first arm is **cheaper (−35%)** and **more complete**.
- The graph's strength (call edges within a language) does not address the failure mode
  (string couplings across languages).
- Its weaknesses — wrong-label silent zeros, unresolved Python imports, no content in
  nodes — each cost a turn, and turns are the entire cost model.

The engine is not bad; 217 CALLS edges in 1.3s is real. It is aimed at a question this
repo does not have.

### Where the remaining headroom actually is

Turns are the multiplier, and the largest single lever is the **fixed context** every
turn re-pays: `CLAUDE.md` (16.7 KB) + `AGENTS.md` (11 KB) + `services/users/CLAUDE.md`
(10 KB) ≈ 9,600 tokens before any work begins, multiplied by every turn of every agent
in every session.

But A1 proved those files are *why* the baseline was already optimal — the agent found
`services/users/CLAUDE.md` on its second action and needed nothing else. Trimming them
risks destroying the thing that works. That is a measurement to run, not an edit to
make.

## Threats to validity

- **One run per arm.** No variance estimate. The A4 gap (35%) is large enough to be
  unlikely to be noise, but it is a single sample.
- **The graph arm had a harder brief.** It was told about two engine quirks and asked to
  verify surprising results — instructions the other arms did not carry, which plausibly
  added turns. Some of the 35% is prompt overhead, not engine overhead.
- **A4 indexed the whole repo (7,673 nodes); Part B indexed only `services/users`.** The
  cross-service questions were finally testable, which is why the missing consumers
  surfaced — but it also means A4 is not directly comparable to Part B's timings.
- **Cache-read tokens are billed at a discount.** The percentages here are honest as
  *token* ratios; the dollar difference is smaller and is not computed, since the
  applicable rate is not known here.
