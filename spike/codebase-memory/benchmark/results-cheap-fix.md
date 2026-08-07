# Part A3 Results — the checklists were never read

Run 2026-08-07, after adding `## Change impact` sections to the Users and Tracking
specs. Design: `cheap-fix-test.md`.

## Verdict

**The test did not measure what it was designed to measure — and the reason is the
finding.** The agent never opened either spec. It read 9 files, none of them under
`docs/domains/`, and fell back to repo-wide grep for both questions.

The checklists are correct. They are also, in practice, **unreachable**.

## What happened

Files read, in order:

```
1. CLAUDE.md (root)
2. proto/users.proto
3. services/users/CLAUDE.md
4. services/orders/CLAUDE.md
5. services/tracking/CLAUDE.md
6. services/tracking/scripts/generate_grpc_stubs.py
7. services/orders/tests/.../TrackingContractTests.cs   (via grep)
8. services/orders/src/Orders.Application/Tracking/TrackingDto.cs
9. functions/events-pipeline/src/handlers/index.ts
```

Step 3 of the index-first prompt — *`docs/domains/<svc>/specs/<svc>-service-design.md`*
— was listed explicitly and **never executed**. The agent stopped at the `CLAUDE.md`
layer, found it insufficient, and went straight to grep.

It then reported that "the docs miss Tracking as a proto consumer" and "no doc names
`email/catalog.ts`". Both statements are true of the files it read and **false of the
repo**: the Users spec names Tracking and its committed stubs in a table; the Tracking
spec names `catalog.ts` in a danger callout about exactly the silent failure it
described independently.

## Why this is the most useful outcome available

A clean pass would have shown checklists work *when read*. This shows something more
actionable: **the vault specs are not in the effective read path for change-impact
questions**, even when a prompt names them.

**The obvious explanation is wrong.** A first pass at this analysis blamed a missing
breadcrumb — nothing pointing from the files agents read to the files holding the
answer. That is false, and checking it mattered:

`services/tracking/CLAUDE.md` §6 "Design reference" links the spec by relative path
and labels it *"source of truth"*. The pointer exists, is prominent, and is one line
long. The agent confirmed it saw the target twice over:

> *"`docs/domains/<svc>/specs/<svc>-service-design.md` was a grep hit in my first
> search AND explicitly named in each `services/<svc>/CLAUDE.md`'s 'Design reference'
> section."*

The actual cause, in its own words:

> *"I stopped at the CLAUDE.md tier once
> `services/tracking/scripts/generate_grpc_stubs.py`'s docstring gave a
> plausible-sounding partial answer, and went to grep instead of climbing one more
> level."*

So the failure is **premature satisfaction**, not missing navigation. A partial answer
that *sounded* complete ended the search. The agent could not tell it had a partial
answer, because a partial answer to "what must change" looks exactly like a complete
one — it is a list, and nothing about a short list announces that it is short.

This is worse news for the documentation-only fix than a missing link would have been.
A missing pointer is a one-line repair. "Agents stop when they feel satisfied" is not
fixable by writing more or linking better, because the agent never learns it should
have kept reading.

It also reframes what a graph engine would provide. Not *knowledge the docs lack* —
the specs turned out to be **strictly more complete** than the agent's own grep
reconstruction, which found 3 of 4 proto consumers and missed `order-created.ts`
entirely. What a query interface provides is a **terminating condition**: `get_callers`
returns the set, and the agent knows it has the set. Prose cannot signal its own
completeness.

## A real gap the run found

Independently of the above, the agent surfaced a consumer that **neither the ground
truth nor the checklist caught**:

`services/orders/tests/Orders.Tests/Infrastructure/TrackingContractTests.cs` hardcodes
`"SHIPPED"` three times. Verified. `TrackingDto.Status` is a plain `string`
(`services/orders/src/Orders.Application/Tracking/TrackingDto.cs`), so a status rename
breaks Orders' contract tests with no compile error.

That makes **four** components coupled to the enum, not three. The checklist written
this afternoon was already incomplete on the day it was written — by a human agent
working carefully, against a repo it had just been told about.

This is the decay argument for a graph engine, arriving faster than expected: not
"checklists go stale over months" but "checklists are born incomplete."

The counter still holds: `TrackingDto.cs`'s own docstring already says *"Mirrors
`TrackingResponse` in schemas.py. Change them together."* The coupling was documented
at the source. It was simply not aggregated anywhere a reader of the Tracking spec
would see.

## Scoring against `cheap-fix-test.md`

The success criteria were: fewer files read, completeness maintained, verification
rather than trust.

| Criterion | Result |
|---|---|
| Fewer files than A2 Arm B's 9 | **9 — identical.** No reduction. |
| Completeness maintained | **Improved** — found a consumer the checklist missed |
| Verified rather than trusted | **Yes**, thoroughly — grep-confirmed every claim |

But these numbers describe an agent that never saw the intervention. The correct
reading is **no result**, not a failed one. The prediction table's "same files, same
completeness → checklist adds nothing" line does not apply, because the checklist was
not in play.

## What this changes for the graph-engine decision

Neither for nor against, but it narrows the question:

- **A1 stands.** For documented knowledge, the index is already optimal.
- **A2 stands.** For change impact, there is a real gap, and the baseline was
  confidently wrong.
- **A3 shows the gap is not closed by writing** — and, on the follow-up, not by
  *placement* either. The pointer was already there and was already seen.

An earlier draft of this file proposed A4: mirror the checklists into
`services/<svc>/CLAUDE.md` and re-measure placement. **That experiment is now
pointless** — placement was never the constraint. The spec was linked, labelled
"source of truth", and independently surfaced by grep. The agent still stopped early
because a partial answer felt sufficient.

What remains untested, and is the only cheap experiment left: whether an explicit
**stop condition** in the docs changes the behavior — e.g. `services/tracking/CLAUDE.md`
§5d saying *"this file does not list status consumers; the complete list is in the
spec's Change impact section, and it is complete"*. That targets premature
satisfaction directly rather than navigation.

It is a weaker hypothesis than the previous two, and worth saying plainly: two
documentation fixes have now failed to close this gap, for two different reasons. That
pattern is itself evidence about what documentation can and cannot do here.

## Threats to validity

- **One run.** A different agent might have followed step 3 and reached the specs.
- **The prompt listed four index layers**; an agent under context pressure reasonably
  truncates. A prompt naming only the specs would likely have reached them — but that
  would test the content while assuming away the discoverability problem this run
  exposed, which is the more real of the two.
- **The agent was told to be skeptical of documentation.** That framing may have
  biased it toward grep and away from reading docs at all. This is a genuine
  confound: the instruction meant to prevent credulity may have suppressed the
  behavior under test.
