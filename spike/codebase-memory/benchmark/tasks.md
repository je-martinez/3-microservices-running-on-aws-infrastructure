# Codebase Memory Benchmark — Task Set

Part A of the codebase-memory spike. Measures whether agents in this repo actually
waste context rediscovering structure, **before** deciding whether a graph engine is
worth building.

Source proposal: `codebase-memory-obsidian-implementation-proposal.md` §16.
The proposal insists token savings be "measured, not assumed" — this is that
measurement, applied to its own premise.

## What is being tested

The hypothesis is **not** "would a graph engine help". It is narrower and cheaper to
falsify:

> Agents in this repo read more source files than necessary because nothing directs
> them to the existing index (`services/<svc>/CLAUDE.md`, `docs/domains/<svc>/specs/`)
> before they start exploring.

If true, the fix is a **rule** — which the multi-provider sync already propagates to
six providers at zero infrastructure cost. If false, the exploration problem is not
real here and a graph engine cannot be justified on token grounds (it may still be
justified on capability grounds — see the Part B note at the bottom).

## Repo facts that shape the test

Measured 2026-08-07:

- 398 source files: 138 TypeScript, 100 Python, 96 C#, 64 Terraform
- 43 files in `services/users/src` alone
- 187 vault notes, including per-service design specs (370 and 296 lines)
- 5 per-service `CLAUDE.md` entrypoints (stack, commands, conventions)
- The Users spec already carries 6 direct source-path references
- **No rule directs exploration order** — this is the gap under test

## Arms

Each task runs twice, in a **fresh agent with no prior context**:

- **Arm A (baseline).** Current state. The agent gets the task and nothing else.
- **Arm B (directed).** Same task, plus the exploration rule below in its context.

Arm B's rule — the candidate fix, deliberately cheap:

```md
Before reading source files, consult the index:
1. `services/<svc>/CLAUDE.md` — stack, commands, conventions for that service
2. `docs/domains/<svc>/specs/<svc>-service-design.md` — design, flows, entities
3. Only then read source, and only the files those two point you to.
Report which files you read and why.
```

Both arms must be run by a **subagent**, not the main session — a main session
carrying this conversation's context would invalidate the baseline.

## Metrics

Per task, per arm:

| Metric | How captured |
|---|---|
| Source files read | Count of distinct files opened via Read/Grep/Glob |
| Input tokens | Reported by the harness for that subagent run |
| Correct answer | Judged against the "expected anchor" column below |
| Time to first correct file | Position in the read sequence of the first file that actually answered the task |

Formula (proposal §16):

```
token_reduction = (tokens_A - tokens_B) / tokens_A
```

## Success thresholds

From the proposal's §16 targets, adapted:

- **≥30% median input-token reduction** → the rule pays for itself; ship it.
- **≥40% reduction in files read** → confirms the exploration hypothesis.
- **<30% reduction** → the problem is not exploration direction. Do **not** build the
  adapter/MCP layers on token grounds.
- **Arm B answers worse than Arm A on any task** → the rule is harmful; investigate
  before shipping.

## Tasks

15 tasks across the four services, weighted toward what this repo actually does.
Each names the anchor file(s) that constitute a correct answer.

### Navigation — "where is X?"

| # | Task | Expected anchor |
|---|---|---|
| 1 | Where are the Users HTTP routes defined? | `services/users/src/features/users/http/routes.ts` |
| 2 | Which file configures Awilix DI for Users, and what scope do use-cases get? | `services/users/src/shared/di/`, SCOPED per `CLAUDE.md` §1 |
| 3 | Where is the gRPC contract between services defined? | `proto/users.proto` |
| 4 | Which file handles an incoming SQS event in the events pipeline? | `functions/events-pipeline/src/handler.ts` |

### Comprehension — "how does X work?"

| # | Task | Expected anchor |
|---|---|---|
| 5 | How does soft-delete work in Users, and where is it applied? | `shared/db/` Prisma extension; `[[soft-delete]]` |
| 6 | What are the five tracking delivery statuses and where is the progression defined? | Tracking spec + service source |
| 7 | How does passwordless email-OTP auth work end to end? | Users spec §OTP + `shared/auth/` |
| 8 | How does a tracking status change reach a connected WebSocket client? | events-pipeline → `functions/realtime-events/` |
| 9 | What must be regenerated when a Users route schema changes, and why? | `openapi.yaml`; `services/users/CLAUDE.md` §2a GOLDEN RULE |

### Change impact — "what breaks if I touch X?"

| # | Task | Expected anchor |
|---|---|---|
| 10 | If I add a field to `users.proto`, what must change? | proto + both gRPC ends |
| 11 | If I add a Users HTTP endpoint, what are all the required steps? | routes + schemas + openapi regen + 3 test layers |
| 12 | If I rename a tracking status enum value, what is affected? | Tracking service + events-pipeline consumer |

### Convention recall — "what is the rule here?"

| # | Task | Expected anchor |
|---|---|---|
| 13 | How are env files managed, and may I hand-edit `.env`? | `[[env-files]]` — generated, never hand-edited |
| 14 | What must never appear in a log line? | `[[logging-context]]` — no PII, no plaintext email |
| 15 | What are the three required test layers for a new endpoint? | `[[testing]]` — unit, internal E2E, gateway E2E with real JWT |

Tasks 13–15 are the control group: they are **pure convention recall**, already fully
documented in the vault. If Arm A burns significant tokens on these, the problem is
squarely discoverability — not code structure — and a graph engine would not address
it at all.

## Protocol

1. Run all 15 tasks in Arm A. Record metrics per task.
2. Run all 15 in Arm B, each in a **fresh** subagent.
3. Compute median reduction for tokens and files read.
4. Compare answer quality; flag any task where B is worse than A.
5. Write `results.md` with the per-task table and the verdict against the thresholds.

Do **not** tune the Arm B rule between runs — that turns a measurement into a fitting
exercise. If the rule looks wrong mid-run, finish the run, then record the objection.

## Interpreting the outcome

| Outcome | Conclusion |
|---|---|
| Big reduction on 1–12, big on 13–15 | Discoverability problem. Ship the rule; no engine needed. |
| Big on 1–12, small on 13–15 | Real code-structure exploration cost. Part B is justified. |
| Small everywhere | No token problem. Any engine must be justified on capability, not savings. |
| B worse anywhere | The rule misdirects. Fix the rule before concluding anything. |

## Note on Part B

A weak result here does **not** by itself kill the graph engine. `get_callers`,
`get_change_impact`, and cross-service flow detection are capabilities no hand-written
doc provides, and this repo's four-language / three-transport topology (gRPC, SQS,
WebSocket) is where they would pay off.

But it does mean the engine cannot be sold on token savings, and it must then be
weighed against the proposal's own §21 admission: structural analyzers degrade on DI,
reflection, and dynamic dispatch. Users runs Awilix DI, Orders uses .NET DI, and the
services talk over the network — all three are blind spots for a single-language
static analyzer, and they are exactly where cross-service impact analysis would be
most wanted.
