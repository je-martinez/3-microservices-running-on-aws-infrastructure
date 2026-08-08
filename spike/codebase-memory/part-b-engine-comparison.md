# Part B — Engine Comparison: codebase-memory-mcp vs Graphify

Both engines run against `services/users` (43 TS source files, 88 code files total),
2026-08-07, commit `062ea6ba`. Everything below is measured, not quoted from a README.

## Scorecard

Weights reflect what Part A established actually matters here: A1 closed the token case,
A2 showed the gap is **change impact**, A3 showed documentation cannot signal its own
completeness. So call-graph completeness and query precision carry the weight; token
savings carry almost none.

| Criterion | Weight | codebase-memory | Graphify | Winner |
|---|---|---|---|---|
| **Call-graph completeness** | 30% | **9/10** — 217 CALLS edges | 3/10 — 27 CALLS edges | **CM** |
| **Query precision** | 20% | **8/10** — Cypher, exact answers | 4/10 — JSON, query it yourself | **CM** |
| **Correctness / no hallucination** | 20% | 7/10 — two phantoms, but filterable to 92% precision / 100% recall | **8/10** — 100% EXTRACTED, confidence-tagged | **GF** |
| **Local & private** | 10% | **10/10** — no network, ever | 5/10 — LLM key for docs & labels | **CM** |
| **Obsidian integration** | 10% | 0/10 — none | **7/10** — native export (needs key) | **GF** |
| **Setup friction** | 5% | 7/10 — npx, but daemon + flag quirks | **8/10** — pip, but writes into the repo | GF |
| **Provenance** | 5% | **9/10** — 38k★, MIT, C, active | 8/10 — 104k★, Apache-2.0, active | CM |
| **Weighted total** | | **7.95** | **5.15** | **codebase-memory** |

Correctness was re-scored from 5 to 7 after the follow-up: the phantoms are a
presentation-layer defect with a one-line mitigation, not a bad extractor. The winner
does not change; the margin widens.

## The measurement that decides it

The whole Part B question is whether an engine answers *"what breaks if I change X"* —
the question A2 proved documentation gets wrong.

```
CALLS edges over the same 43 TypeScript files:
  codebase-memory   217
  Graphify           27      (8× fewer)
```

Graphify's graph is mostly `contains` (231) and `imports` (88). It maps **structure**.
codebase-memory maps **behavior**. For blast radius, only the second helps.

Concretely — every caller of `hashEmail`, via Cypher, verified against source:

```
execute            src/features/users/commands/login.ts
execute            src/features/users/commands/verify-otp-challenge.ts
execute            src/features/users/commands/register.ts
execute            src/features/users/commands/start-otp-challenge.ts
execute            src/features/users/commands/register-passwordless.ts
publishUserCreated src/shared/messaging/event-publisher.ts
+ 2 test files
```

All 8 correct. **This is the terminating condition A3 said prose cannot provide**: the
query returns the set, and the caller knows it is the set.

## codebase-memory: what actually happened

**Works, and well.** 579 nodes / 1169 edges in **1.3 seconds**. Hybrid LSP covers
TypeScript, Python, and C# — all three service languages here. Runs 100% locally with
an explicit no-phone-home guarantee; nothing left the machine. Rich per-function
metrics: cyclomatic and cognitive complexity, signatures, `in_degree`/`out_degree`.
Correctly detected the git worktree, its branch, and HEAD.

**`trace_path` is broken.** It is the flagship caller/callee tool and it returned empty
for every symbol tried, including `hashEmail` — which the same graph reports as having
8 callers, and which `query_graph` then listed correctly. Data is fine; that one tool
is not. On a 418-open-issue project this reads as a bug, not a design limit, but it
means the advertised interface cannot be relied on today. **Cypher via `query_graph` is
the usable path.**

**Two hallucinated routes — and the "missed" route was not missed.** Corrected by a
follow-up investigation; see `hallucination-mitigation.md`.

`get_architecture` reported `/v1/users/login-history`, which exists nowhere: it is a
string literal inside a test assertion, deliberately naming a path that does not exist.
It also reported `/v1/health-probe`, which is a *real* route registration but only on a
throwaway app inside `routes.test.ts`. Two phantoms, two different causes.

The claim that `/v1/users/e2e-identity` was missed was **wrong**. The graph has it, with
`method: GET` and `in_degree: 1`. `get_architecture` rendered it without its method and
I read that as absence. **The extractor is more accurate than this section originally
credited; the presentation tool is the weak point.**

Both phantoms are filterable with metadata the engine already computes
(`method <> '' AND in_degree > 0` gives 0 false negatives and drops the string-literal
phantom). Verification is still required — both were found by reading source, not by
querying.

**Rough edges.** JSON args are deprecated in favor of flags with unhelpful errors
(`repo_path is required` after passing `path`); `search_graph --name` was ignored and
returned all 579 nodes; `detect_changes` diffed the whole branch rather than the
indexed subtree.

## Graphify: what actually happened

**Works, is honest, and is aimed elsewhere.** 416 nodes / 474 edges in 7 seconds. Every
edge carries a **confidence tag** — 472 `EXTRACTED`, 2 `INFERRED`, 0 `AMBIGUOUS` — plus
`source_file` and `source_location` provenance. The report states its build commit and
its token cost (0). That discipline is exactly what the proposal's §6 asked for, and
codebase-memory does not offer it.

**It maps structure, not calls.** 27 `calls` edges against 231 `contains` and 88
`imports`. For "what is this codebase shaped like" it is strong; for "who calls this"
it is not.

**The Obsidian export needs an API key.** This was its headline advantage — native
vault export, the thing the proposal wanted built by hand. Without `GOOGLE_API_KEY` or
similar, `--code-only` is required, no `obsidian/` directory is produced, and all 64
communities stay unnamed as "Community N". Two separate LLM dependencies: semantic
extraction for non-code files, and community labeling.

For this repo that is close to disqualifying on its own terms: sending source structure
to a third-party LLM to name clusters is a different privacy posture than
codebase-memory's local-only guarantee, and the vault already has hand-written names
that are better than generated ones.

**It writes into the target repo.** Output lands in `services/users/graphify-out/`, not
a scratch directory. Removed after the test; would need gitignoring.

## Against the proposal's `findings.md` questions

| Question | codebase-memory | Graphify |
|---|---|---|
| Indexes the repo correctly? | Yes — 579/1169 in 1.3s | Yes — 416/474 in 7s |
| Languages recognized? | TS, Python, C# semantically (158 syntactically) | TS + 25 more; **no SQL** without an extra |
| Relationships detected accurately? | Calls, imports, routes; **217 CALLS** | Structure only; **27 calls** |
| Relationships missed? | 1 route missed, 1 phantom | Most call edges |
| Incremental updates? | Yes, watcher + committed artifact | Yes, `graphify update` |
| Query interface? | **Cypher (read-only) + 15 MCP tools** | JSON file; query it yourself |
| Indexing time? | **1.3s** | 7s |
| Storage? | 5.0 MB SQLite in `~/.cache` | ~1 MB in-repo |
| License? | **MIT** | Apache-2.0 |
| Viable for MVP? | **Yes, via Cypher** — not via `trace_path` | Not for change impact |

## Recommendation

**codebase-memory, and only for change-impact queries.**

It wins the criterion Part A proved is the real gap, by 8×, and it wins it locally with
no network calls. Graphify is the better-engineered artifact in one specific respect —
confidence tagging and provenance are things codebase-memory should copy — but it
answers a question this repo does not have. The vault already describes structure, and
describes it better than 64 unnamed communities would.

Three conditions on that recommendation, from what the testing showed:

1. **Use `query_graph` (Cypher), not `trace_path`.** The flagship tool is broken today;
   the Cypher path returns correct, complete answers.
2. **Treat output as a lead, not a fact.** One phantom route and one missed route out of
   eleven. That rate is fine for "where do I look", not for "what must I change" — which
   is ironic given that change impact is the use case. Verify against source before
   acting.
3. **Do not build the Obsidian adapter.** Part A3 showed the failure is agents stopping
   early, not knowledge missing from the vault. Generating notes adds the vault noise
   the proposal itself warns about in §21, and fixes nothing A3 identified.

### What this means for the proposal as written

The proposal's MVP is: engine → intermediate model → Obsidian adapter → MCP → measure.
The measured evidence supports **only the first and fourth of those**, and inverts their
justification:

- Engine: yes, for change impact.
- Intermediate model: premature — one engine, no second provider in play.
- **Obsidian adapter: no.** A3 falsified its premise.
- MCP: yes, and it already exists — `codebase-memory-mcp` *is* an MCP server; nothing
  needs building.
- Measure: already done. That is Part A.

So the honest version of Part B is much smaller than the proposal: point an existing MCP
server at the repo, query it with Cypher for blast radius, and skip the pipeline
entirely.

## Caveats

- **One service, one language.** Users is TypeScript. The cross-service, cross-language
  impact question A2 cared about (`proto/users.proto` across TS/C#/Python) was **not**
  tested here — the index was scoped to `services/users`. That is the case most likely
  to expose weaknesses in either tool, and it remains untested.
- **DI was not isolated.** Users runs Awilix, and whether the 217 CALLS edges survive
  container-mediated dispatch was not measured directly. The `hashEmail` result is a
  direct-call chain.
- **One run each.** No variance estimate; timings are single samples on a warm machine.
- **`detect_changes` untested in anger** — it diffed the whole branch, so its risk
  classification was never actually exercised.
