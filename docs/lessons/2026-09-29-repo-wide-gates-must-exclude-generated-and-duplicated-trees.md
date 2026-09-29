---
title: "A repo-wide gate must exclude generated, vendored and duplicated trees from the start"
type: lesson
area: shared
status: active
created: 2026-09-29
updated: 2026-09-29
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
related:
  - "[[code-comments]]"
  - "[[scripting-language]]"
  - "[[doc-propagation]]"
---

# A repo-wide gate must exclude generated, vendored and duplicated trees from the start

## The failure

During the Stripe payments milestone (2026-09-29), `make lint-comments` failed with **221 new
violations** while every file the milestone actually touched was clean. The gate was unusable: it
reported hundreds of violations in code nobody on the project wrote.

Measured breakdown:

| Source | Violations |
|---|---|
| `.claude/worktrees/` | 181 |
| `e2e/load-tests/target/` (Gatling run output: bundled `highstock.js`, `gatling.js`) | 40 |
| The milestone's own 38 touched files | 0 new (linter run on just that file list) |

## Root cause

The two sources are not the same kind of noise, and the worse one is the non-obvious one.

- **Gatling's `target/`** is ordinary third-party build output: minified vendor JS. Each load-test
  run writes a fresh *timestamped* directory, so the violation count grows with load-test usage
  alone, without anyone editing code.
- **`.claude/worktrees/`** is different in kind. Those are **full git worktrees, i.e. checkouts of
  this same repository**. Every violation in our own source is counted **once per worktree**. With
  5 worktrees active, one bad line is reported 6 times. This is not foreign code polluting the
  report; it is our own code duplicated. "It is all vendored noise" is therefore the wrong mental
  model, and the count scales with the number of active agent worktrees rather than with the
  codebase.

## The fix

Both trees went into `EXCLUDE_PATH_PREFIXES` in `scripts/validate-comments.py`, not into
`EXCLUDE_DIR_NAMES`. The distinction is load-bearing:

- `EXCLUDE_DIR_NAMES` matches a bare directory *name* anywhere in the tree. Adding `"target"` there
  was tried and **rejected**: it would silently exclude any future legitimate `target/` directory
  elsewhere in the repo.
- A path prefix excludes exactly the one known-generated location. **Prefer a path prefix whenever
  the leaf name is generic** (`target`, `build`, `out`, `tmp`).

Result: 221 new violations became 0, and `make lint-comments` reports `OK — no new violations`
across 1156 files.

## The verification that mattered

An over-broad exclusion is worse than the noise, because it turns a green gate into a lie. Two
checks ran before the fix was accepted:

1. The milestone's 38 touched files still scan and report `OK — no new violations`, so the
   exclusion did not swallow real source.
2. A canary file containing a 7-line untagged block and the word `became` was fed to the linter and
   was still caught on **both** rules (`length` and `narrative-marker`). The gate still bites; it
   only stopped counting artifacts.

> [!important] Reusable practice
> After widening an exclusion on any gate, **prove the gate still fails on a deliberately bad
> input.** Verifying only that the gate went green cannot distinguish "noise removed" from "gate
> disabled".

## The generalization

This is the third recurrence of one pattern, which is what makes it a lesson rather than a one-off
fix. [[code-comments]] already records that Vite's `.angular/cache/` reported **2142** violations
before exclusion, and `node_modules`, `dist`, `.venv`, `.terraform` and `generated` were excluded
earlier for the same reason.

> Any repo-wide gate (`--all`-style) must exclude generated, vendored and duplicated trees from the
> start. A useful heuristic: **if it is gitignored, a repo-wide gate should not be reading it.**

Both trees here were gitignored (`e2e/load-tests/.gitignore` and `.git/info/exclude`); the gate's
exclusion list had simply drifted behind the ignore rules.

The real cost is social, not technical: a gate that always fails stops being run, and then it is
not a gate at all.

## Observation, not a change

The linter reports `1 baseline violation(s) fixed — run --update-baseline`. The baseline was
deliberately left untouched, so that regenerating the ratchet stays a separate, explicit decision
rather than a side effect of an exclusion change.

## How to apply

- Adding or widening an exclusion in a gate: choose a path prefix over a bare directory name when
  the leaf name is generic, then run the canary check above.
- Adding a new gate that scans repo-wide: seed its exclusions from the gitignore rules on day one.

## Related

- [[code-comments]] — the convention whose linter (`scripts/validate-comments.py`) this lesson
  concerns; records the exclusion lists and the earlier `.angular/cache/` precedent.
- [[scripting-language]] — the linter is a Python script under the repo's scripting conventions.
- [[doc-propagation]] — the same "gate that must stay meaningful" idea: a validator that can be
  silently bypassed stops being a gate.
