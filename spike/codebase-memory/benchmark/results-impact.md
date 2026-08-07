# Part A2 Results — change-impact questions

Run 2026-08-07. Three change-impact questions, two arms, fresh subagents on the same
model. Scored against `ground-truth.md`, which was written **before** either arm's
answers were read.

## Verdict

**Opposite of the first run.** On change-impact questions the index does *not*
suffice, the arms diverge sharply, and the baseline shipped a **factual error** that
would break CI.

| Metric | Arm A (baseline) | Arm B (index-first) |
|---|---|---|
| Distinct files read | **20** | **9** |
| Q1 correctness | **WRONG** — missed a whole consumer | Partial — found it, hedged on Orders |
| Q3 completeness | Partial | **Complete** — found every consumer plus one the ground truth missed |
| Index answered Q3? | — | **No — not at all** |

Files read dropped **55%** (20 → 9) while accuracy went *up*. That is the reduction
the first run failed to find, and it appears exactly where documentation stops
describing architecture and a question starts asking about blast radius.

## The baseline's factual error

Arm A concluded that Tracking does not reference `users.proto`:

> *"Did not verify whether any other service (Tracking) references `users.proto` at
> all — grep suggests no."*

It does. `services/tracking/tests/test_grpc_stubs.py` exists precisely because of it,
and its own docstring states the case:

> *"`users.proto` is OWNED BY USERS and consumed by both Orders and Tracking… the
> contract can change in a service that has no way to know these stubs exist."*

Tracking commits **generated** stubs and guards them with a byte-for-byte test. An
engineer following Arm A's answer would add a proto field, ship it, and break
Tracking's test suite — the exact failure the test was written to catch.

Note the confidence label: Arm A rated Q1 **medium-high**. Miscalibrated confidence on
a wrong answer is worse than a low-confidence right one, because it suppresses the
double-check that would have caught it.

## Where the index helped, and where it did not

Arm B's own gap analysis is the most useful output of this run:

| Q | Index coverage | Fallback |
|---|---|---|
| 1 (proto field) | **Partial** — named the consumers and the hand-sync rule, but no "what to change" checklist | Read the `.proto`'s own comments |
| 2 (new endpoint) | **Full** for the app layer — `users/CLAUDE.md` §2a/§2b is an explicit checklist | Read nginx.conf for the infra angle |
| 3 (enum rename) | **None** | Repo-wide grep for the literal `OUT_FOR_DELIVERY` |

Arm B's diagnosis, verbatim:

> *"No CLAUDE.md or spec gives a 'if you rename a tracking status, update X, Y, Z'
> checklist. `services/tracking/CLAUDE.md` §5d explains the event **mechanism** but not
> a change-impact list. The index only explains architecture, not blast radius."*

Confirmed directly: §5d says events-pipeline consumes the event and emails the user.
It does not say that `email/catalog.ts` maps status values to templates, so renaming
one silently breaks notification selection.

**This is the distinction that matters for the whole proposal.** Documentation
describes *what talks to what*. Change impact needs *which lines change together*.
The first is authored; the second is derived — and derivation is what a graph engine
does.

## A finding that cuts against the graph

The trap was designed as the case only a graph would catch. It is **already
documented**: `docs/domains/events-pipeline/specs/events-pipeline-design.md:287`
names `src/email/catalog.ts` and its five status entries explicitly.

So the ceiling on a graph here is lower than the Q3 result alone suggests. The
information exists; it is not *indexed as impact*. A cheaper fix than a graph engine
is to write the blast-radius checklists into the specs that already describe these
couplings.

The honest counter: that fix is manual, and it decays. Every new coupling needs
someone to notice and write it down. A graph derives it. This is a maintenance-cost
argument, not a capability argument — and it is the real question for Part B.

## Scoring against ground truth

**Q1 — proto field.** Ground truth: 4 components, 3 languages, 3 propagation
mechanisms (runtime-loaded, build-compiled, committed-and-generated).
- Arm A: **incomplete + wrong** — missed Tracking entirely.
- Arm B: **partial** — found Tracking and the stub-regeneration requirement; did not
  open Orders' C# source, and said so.

**Q2 — new endpoint.** Control question, fully documented.
- Both **complete** on the app layer. Both flagged the same real gap: no doc covers
  whether API Gateway Terraform needs a matching route. Two independent arms finding
  the same hole is good evidence it is a genuine documentation gap, not a miss.

**Q3 — enum rename.** Ground truth: 10 files, 3 components, crossing SQS.
- Arm A: **partial** — did not open the WebSocket handler or `audit_actor.py`.
- Arm B: **complete** — found every consumer, plus
  `functions/events-pipeline/emails/tracking-status-changed.tsx`, which the ground
  truth missed. The controller's own grep was less complete than Arm B's.

## What this changes

The first run closed the token case. This run **reopens it, narrowly**:

- For **documented** questions (structure, conventions, procedures), the index is
  already optimal — 0% improvement available, confirmed.
- For **change-impact** questions, there is a real 55% file-read reduction and,
  more importantly, a correctness difference: the baseline was confidently wrong.

Change impact is a minority of engineering questions but a high-stakes one: being
wrong means shipping a break, not just reading extra files.

## Threats to validity

- **One sample per arm per question.** Arm A's Q1 error could be run variance rather
  than a systematic baseline weakness. It would need repeating to claim otherwise.
- **Arm B's advantage may be prompt-driven, not index-driven.** Its prompt named the
  index and implied thoroughness; some of the 55% gap may be that framing rather than
  the documents themselves.
- **The controller's ground truth was itself incomplete** (Arm B found a file it
  missed). Scoring "completeness" against a fallible reference has limits, and it is
  recorded here rather than quietly corrected.
- **Three questions.** Two of the three favored the index by construction, since I
  chose couplings I already knew existed.

## Recommendation

1. **The token case for a graph engine remains closed** for the general case; the
   first run stands.
2. **A narrow gap is real and demonstrated**: no artifact in this repo answers "what
   is the blast radius of changing X". Both arms hit it independently.
3. **Try the cheap fix first.** Add a "Change impact" section to the specs of the two
   couplings measured here — `proto/users.proto` consumers, and tracking-status
   consumers. Then re-run Q1 and Q3. If a written checklist closes the gap, a graph
   engine is not needed for this repo at this size.
4. **Part B is justified only if step 3 fails** — or as a maintenance-cost argument:
   checklists decay, derived graphs do not. That is a legitimate reason, but it should
   be stated as such rather than dressed up as capability the docs cannot provide.
