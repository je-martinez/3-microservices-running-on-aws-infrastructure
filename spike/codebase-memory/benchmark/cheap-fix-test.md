# Cheap-Fix Test — do written checklists close the blast-radius gap?

Part A3. Tests whether the gap found in A2 can be closed with **documentation** rather
than a graph engine.

## The claim under test

A2 established that the index explains architecture but not blast radius, and that the
baseline got a proto-change question factually wrong as a result. But it also found
that the hard coupling was *already documented* — just not indexed **as impact**.

So:

> Writing explicit "Change impact" checklists into the two specs closes the gap, making
> a graph engine unnecessary at this repo's size.

If true, the proposal's whole build — adapter, MCP, incremental indexer — is
unjustified here, and the fix cost one afternoon of writing.

If false, Part B has a concrete, measured reason to exist.

## The intervention

Two sections added (2026-08-07):

- `docs/domains/users/specs/users-service-design.md` → `## Change impact — editing proto/users.proto`
- `docs/domains/tracking/specs/tracking-service-design.md` → `## Change impact — renaming a delivery status`

Each names every affected file, the mechanism of propagation, and the silent-failure
trap.

## Protocol

Re-run **Q1 and Q3 only** — the two questions the index failed. Q2 was already answered
fully and is not re-tested.

One arm, index-first prompt, **fresh subagent**. Compare against A2's Arm B, which is
the strongest prior result:

| | A2 Arm B (before) | A3 (after) |
|---|---|---|
| Files read | 9 | ? |
| Q1 completeness | Partial — missed Orders' C# side | ? |
| Q3 completeness | Complete, via repo-wide grep | ? |
| Fell back to grep? | Yes, for Q3 entirely | ? |

## What counts as success

The metric is **not** file count alone. The checklist could reduce reads while making
the agent *credulous* — accepting the list without verifying it still matches the code.
That would be worse than the grep it replaces, because a stale checklist is confidently
wrong.

Success requires all three:

1. **Fewer files read** than A2 Arm B's 9 — the checklist replaces the grep sweep.
2. **Completeness at least as good** — every ground-truth consumer still named.
3. **The agent verifies rather than trusts** — it should spot-check that the cited paths
   exist, not recite the checklist blindly.

Failure modes to watch for, each meaning something different:

| Observation | Meaning |
|---|---|
| Fewer files, same completeness, verified | **Checklists work.** No engine needed. |
| Fewer files, worse completeness | Checklist is incomplete and the agent trusted it. Dangerous. |
| Same files, same completeness | Checklist adds nothing; agents grep anyway. |
| Agent finds a consumer the checklist missed | Checklist already decaying — the maintenance argument for a graph. |

## The decay question this cannot answer

Even a clean pass leaves the real objection standing: **checklists are manual and go
stale.** Every new coupling needs a human to notice and record it; a graph derives it.

A one-shot measurement cannot test decay — that needs months of drift. What it *can*
establish is whether the gap is closable in principle by writing. If yes, Part B has to
be argued on maintenance cost, which is a weaker and more honest case than "capability
the docs cannot provide."

Record that framing in the result regardless of outcome.
