---
name: spec-implementation-audit
description: 'Use BEFORE proposing any PR that closes an issue or a milestone, and whenever asked to check whether an implementation matches its plan or spec — "revisa huecos", "esto esta alineado con el spec?", "ya podemos hacer el PR?", "propaga la documentacion". Audits the three-way gap between what the spec decided, what the plan instructed, and what the code actually does. Exists because every milestone in this repo has shipped with gaps in all three directions, and the shipped code is self-consistent, so nothing surfaces them on its own.'
metadata:
  area: shared
  source: docs/lessons/2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec.md + the Stripe milestone audit (2026-09-30)
  verified: 2026-09-30
---

# Spec / plan / implementation audit

Run this before proposing a PR that closes an issue or a milestone. It is a
**gate**, not a suggestion: [[phase-c-review-flow]] requires reviewing the diff
against the brief, and [[doc-propagation]] requires a spec's decisions to reach
the vault. Neither happens by itself.

## Why it exists

The failure mode is not sloppiness, it is **structural invisibility**:

> A requirement silently dropped in implementation leaves NO trace. The shipped
> code is self-consistent, it passes review on its own terms, and the tests
> written alongside it cover what was built rather than what was specified.

That is [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]: the
cart's concurrent-PUT retry was specified in the design's first commit, shipped
as an unhandled 500, passed its per-task review, and was caught only by chance
in a later whole-branch pass.

Reviewing the diff answers *"is this correct?"*. Only this audit answers
*"does this do everything it was asked to do, and do the docs still describe
it?"*

## The three directions — check all of them

Gaps run in three directions, and checking only one is the common mistake:

| Direction | The question | Typical finding |
|---|---|---|
| **spec → code** | Was every decision implemented? | A requirement dropped in implementation |
| **code → docs** | Does the doc still describe what exists? | The doc keeps a value the code has corrected |
| **plan → repo** | Do the plan's paths and names exist? | Files at paths the repo never used |

**`code → docs` is the one most often skipped, and it does active harm.** A doc
that keeps a corrected value is worse than a missing doc: the next person
"aligns the code with the plan" and reintroduces the bug.

## Run it once per stop point, not once per milestone

[[phase-c-review-flow]] has several stop points per milestone. Audit at **each**
batch, not only before the final PR — a gap found after five more tasks have
built on it is a refactor, not a fix.

Re-run after closing gaps. Closing one often reveals another: correcting an env
path in a plan surfaced the same stale path in a runbook.

## The checklist

Work from the spec and plan, never from memory or from the diff alone.

1. **Enumerate the spec's decisions** and tick each against the code. Name the
   file and symbol that implements it. A decision you cannot point at is a gap,
   not an assumption.
2. **Walk every unchecked plan checkbox.** Either it is implemented (tick it) or
   it is not (say so). A box left unticked on finished work makes the plan lie
   to the next reader.
3. **Verify every path the plan names exists.** Plans are written before the
   code and routinely guess a layout.
4. **Grep the docs for values the code has since corrected.** Config strings,
   directives, env var names, ports, file locations. This is where `code → docs`
   gaps hide.
5. **Check every runbook the work touches.** A runbook is instructions someone
   will FOLLOW; a stale one sends them to a file that no longer does anything.
6. **Record manual verification results.** A step whose output lives only in a
   terminal is a step nobody can confirm later.
7. **Re-read `propagates-to:`** and confirm each target actually received the
   decision, per [[doc-propagation]].

## Concurrency requirements are the highest-risk case

Ordinary tests structurally do not exercise them, so a dropped concurrency
requirement passes every gate. When the spec names one, find the test that
reproduces it — not the code that looks like it handles it.

## Gap taxonomy, from the Stripe milestone (2026-09-30)

Seven gaps in one milestone, all found by this audit and none by the per-task
reviews that preceded it. The pattern is worth recognising:

- **Stale config value in docs** — plan and spec specified a CSP wildcard
  (`*.stripe.com`) that cannot work; the code had the correct per-directive
  origins. Highest-harm gap: the docs would have talked someone into reverting
  the fix.
- **A claim about a response shape** — the plan asserted a payload field the DTO
  never exposes.
- **A whole infrastructure layout** — the plan described an env file that no
  longer exists.
- **A runbook pointing at a deliberately-empty file** — following it produced a
  silently disabled feature.
- **Paths that never existed** in the repo's layout.
- **An unrecorded manual verification.**
- **58 unticked boxes** on finished work.

## What to do with what you find

Fix the docs in the same change; that is the point of auditing before the PR.
Route vault writes through `obsidian-vault` ([[doc-propagation]]).

If a gap is a real code defect rather than a doc drift, **say so plainly and do
not fix it silently as part of a propagation pass** — it needs its own change
and its own review.

Leave `node scripts/validate-vault.mjs` green.
