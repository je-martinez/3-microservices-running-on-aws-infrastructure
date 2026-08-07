# Part A Results — the exploration problem does not exist here

Run 2026-08-07. Six questions, two arms, fresh subagents on the same model.

## Verdict

**The hypothesis is falsified.** Agents in this repo do not waste context
rediscovering structure, because the existing index already prevents it — without
anyone telling them to use it.

| Metric | Arm A (baseline) | Arm B (directed) | Reduction |
|---|---|---|---|
| Distinct files read | **6** | **6** | **0%** |
| Source files read | **0** | **0** | — |
| Questions answered correctly | 6/6 | 6/6 | — |
| Index gaps | — | **none** | — |

Against the thresholds in `tasks.md`: the ≥30% token and ≥40% file-read targets were
not merely missed, they were **inapplicable** — there was nothing to reduce.

## What actually happened

Both arms read the same six files and **never opened a single source file**:

| Arm A (no direction) | Arm B (index-first rule) |
|---|---|
| `services/` (dir listing) | `CLAUDE.md` (root) |
| `services/users/CLAUDE.md` | `services/users/CLAUDE.md` |
| `docs/shared/conventions/soft-delete.md` | `docs/shared/conventions/soft-delete.md` |
| `docs/shared/conventions/env-files.md` | `docs/shared/conventions/testing.md` |
| `docs/shared/conventions/logging-context.md` | `docs/shared/conventions/env-files.md` |
| `http/` listing (path confirmation only) | `docs/shared/conventions/logging-context.md` |

The baseline agent found `services/users/CLAUDE.md` on its **second** action,
unprompted. The two directory listings in each arm were path confirmation, not
exploration — neither derived an answer from source.

Arm B reported: *"The index fully answered all six questions without needing to open
any source `.ts` files."*

## Why the rule made no difference

The rule was designed to fix a gap that is already closed by three things this repo
did before the benchmark existed:

1. **Per-service `CLAUDE.md` entrypoints** (5 of them) that state stack, commands, and
   conventions — and that agents find by convention, without instruction.
2. **`docs/shared/conventions/`** carrying cross-cutting rules as first-class notes,
   which answered 3 of the 6 questions outright.
3. **A root `CLAUDE.md`** that names both of the above.

The "index-first" behavior the rule tries to install is **already the emergent
behavior**. Naming it changed the reading order slightly and nothing else.

## Answer quality

Both arms answered all six correctly. Arm B was marginally more specific on two
answers — it named `generate_env_files.py` and the credential-rejection test — but
this is a difference in thoroughness, not correctness, and well inside run-to-run
variance for a single sample per arm.

No task showed Arm B performing worse. The rule is harmless; it is simply unnecessary.

## What this rules out

**A code-memory engine cannot be justified on token savings in this repo.** The
proposal's §16 makes measurement the gate for expansion, and the measurement returns
zero. Building the adapter, MCP layer, and incremental indexer to reduce an
exploration cost of *zero source files read* would be work against a problem that is
not present.

The three convention-recall questions (5, 6, and the testing half of 4) are the
sharpest evidence: they were answered entirely from the vault. A code graph indexes
symbols and call edges — it would not have contributed to any of them.

## What this does not rule out

Part B's capability argument stands on its own and is untouched by this result:

- `get_callers` before changing a function signature
- `get_change_impact` across the four services
- Cross-service flow detection over gRPC, SQS, and WebSocket

No hand-written document provides these, and this benchmark did not test them. The
six questions were all answerable from documentation **because they were questions
documentation answers well**. A question like *"what breaks if I change this proto
field"* is a different shape, and the index does not answer it.

That argument now has to carry the whole cost on its own, and it must clear the
proposal's own §21 caveat: structural analyzers degrade on DI, reflection, and dynamic
dispatch. Users runs Awilix DI, Orders uses .NET DI, and the services communicate over
the network — the three blind spots sit exactly where cross-service impact analysis
would be most wanted.

## Threats to validity

Stated plainly, because a clean negative result invites over-reading:

- **One sample per arm.** No variance estimate. A second run could shift file counts
  by one or two; it could not plausibly turn 0 source files into a token problem.
- **Six questions, not fifteen.** The full set in `tasks.md` includes three
  change-impact questions (10–12) that were **not run**. Those are the ones most
  likely to favor a graph, and their absence is the biggest gap in this result.
- **Questions were chosen by someone who knew the repo.** They map onto documentation
  that exists. A genuinely novel question — one nobody has written up — would be
  harder, and neither arm was tested on one.
- **Subagents were told they were being measured**, which may have made them more
  disciplined than a subagent doing real work under time pressure.

The first three all point the same way: the result is strong for *documented*
questions and says little about *undocumented* ones. That is precisely the boundary
Part B would probe.

## Recommendation

1. **Do not build the code-memory pipeline for token savings.** Measured reduction is
   zero because the baseline is already optimal.
2. **Do not ship the index-first rule.** It changed nothing, and every rule added to
   `AGENTS.md` costs context on every provider, forever. Adding one that demonstrably
   does not change behavior is a net negative.
3. **Keep investing in what caused this result** — per-service `CLAUDE.md` files and
   `docs/shared/conventions/`. They are why the baseline had nothing to improve.
4. **If Part B proceeds, scope it to change-impact only** — tasks 10–12, the questions
   this run did not cover and that documentation genuinely does not answer.
