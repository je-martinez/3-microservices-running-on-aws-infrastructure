---
title: "A plan that locates tests by filename resemblance silently omits the suites that enforce the contract"
type: lesson
area: shared
status: active
created: 2026-09-11
updated: 2026-09-11
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/critical
related:
  - "[[2026-09-10-in-app-notifications-design]]"
  - "[[2026-09-10-in-app-notifications]]"
  - "[[code-comments]]"
  - "[[testing]]"
  - "[[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]"
  - "[[2026-08-27-a-producer-side-test-proves-nothing-about-what-the-consumer-accepts]]"
  - "[[tightened-schemas-need-producer-first-deploys]]"
---

# A plan that locates tests by filename resemblance silently omits the suites that enforce the contract

## Finding

While implementing Phase 2 of `docs/superpowers/plans/2026-09-10-in-app-notifications.md`
(swapping three producers from SQS `SendMessage` to SNS `Publish`) on 2026-09-11, the same
planning failure reproduced **three independent times, across three services and three
languages**, all with the identical root cause: the plan located "the test file for X" by
matching the source file's name, instead of by searching for who actually references the symbol
being renamed.

1. **Users (Task 2.1).** The plan pointed at
   `services/users/tests/shared/event-publisher.test.ts` and instructed "replace this file with"
   five new tests. That file was real but held a single 15-line `NoopEventPublisher` test — a
   decoy. The suite that actually enforced the wire contract was
   `services/users/tests/shared/messaging/sqs-event-publisher.test.ts`, **680 lines, 39 tests**,
   never mentioned anywhere in the plan. It lived one directory deeper, under `messaging/`, and
   its name did not resemble the file being changed. Following the plan literally would have
   either broken the build (that suite still imports `SqsEventPublisher`) or — if someone had
   "helpfully" deleted it as superseded by the replaced decoy — destroyed the assertions that
   protect the byte-for-byte wire contract: traceparent propagation, `request_id`/`run_id`
   omitted-not-null, `author.cognito_sub` absent when there is no caller, payload key ordering,
   span names, and the log lines emitted inside the span. It was ported instead, preserving all
   88 assertions.
2. **Tracking (Task 2.4).** The plan listed `publisher_test.go` and `cmd/server/main_test.go`. It
   omitted `internal/adapter/sqs/zod_contract_test.go` (307 lines) — the file that reads the
   events-pipeline's own Zod schema off disk and validates the Go envelope against it at test
   time, i.e. exactly the gate that proves the byte-for-byte cross-language contract. That file
   references the renamed fake in three places, so the package would not even compile without
   editing it — the plan's own later steps cite this same file as "the key signal" without
   noticing its own instructions leave it broken. The plan also omitted
   `internal/platform/config/config_test.go`, which references the renamed config field.
3. **Orders (Task 2.3)** showed the same shape: implementation had to touch several files the
   plan never listed, discovered only once the renamed symbol failed to compile everywhere it
   was actually used.

## Why the root cause is naming, not carelessness

In all three cases the omitted file's name did **not** resemble the name of the source file
being changed: `zod_contract_test.go` bears no relation to `publisher.go`; the real
`sqs-event-publisher.test.ts` lived under a `messaging/` subdirectory while a same-named-enough
decoy (`event-publisher.test.ts`) sat exactly where a plan author scanning by filename would
stop looking. A human or agent writing "the test file for the event publisher" pattern-matches
on the noun in the filename, finds the first plausible hit, and moves on — the decoy is not a
trap anyone set, it is just a smaller, older, or differently-scoped file that happens to share
enough of the name to end the search early.

Only an importer-based search — "who actually references this symbol" — finds the real set,
because it doesn't depend on naming convention holding, and it catches suites that are
architecturally *supposed* to be decoupled from the source file's name (a cross-language
contract test, a config test, a suite nested under a topic subdirectory).

## The rule to apply

**When a plan renames a symbol (a class, an interface, a config field), it must locate the
affected tests by grepping for who references the symbol — never by matching a filename to the
source file's name.**

Concretely, before writing the test step of any rename task:

```
grep -rn '<OldSymbol>' <service-dir>
```

Enumerate every hit. The test files to edit are the referencing set, full stop. A test file
whose name happens to match the source file's name is neither necessary nor sufficient evidence
that it is the right one — it must still appear in the grep output to earn a place in the plan.

This generalizes past this milestone: any plan step of the shape "replace this test file" for a
rename/refactor should be treated as unverified until the grep has been run and its output
diffed against the plan's file list. A plan is not "thorough" because it names a test file that
sounds right — it is thorough only if that file is corroborated by a reference search.

## A related finding — comment density and block length are file-scoped, not block-scoped

The same implementation session surfaced a second, structurally different but related planning
gap, reproducing twice in the milestone's own work (Users' `env.ts`, Tracking's package doc
comment) and once in this session's own Phase 1 work (`infra/modules/api-gateway/main.tf`):
**comment-density and block-length limits (see [[code-comments]]) are properties of the FILE,
not of the individual comment block a plan step adds.**

A plan that dictates several individually-correct `CONTRACT:` blocks, each fine in isolation,
can push the file as a whole past its ceiling:

- `env.ts` hit 55% comment density against TypeScript's 50% limit once all the plan's
  individually-reasonable blocks landed in the same file.
- Go's linter treats consecutive `//` lines separated only by a bare `//` as **one** block —
  appending a fourth `CONTRACT:` to a package-level doc comment produced a 17-line block against
  a 12-line hard maximum, even though each of the four contracts, read alone, looked
  appropriately terse.

**The rule to apply:** after applying the comments a plan step dictates, run the comment linter
on that file before calling the step done — don't infer compliance from having checked each
block individually. Prefer attaching a new `CONTRACT:` to the specific identifier it governs
(the field, the function, the type) rather than accumulating it in a package- or file-level doc
comment, since the latter is exactly the shared surface where independently-fine additions
compound into a file-level violation.

## How to apply — for anyone writing an implementation plan

- **Never cite a test file in a plan by filename resemblance alone.** Run `grep -rn
  '<SymbolBeingRenamed>' <dir>` first, and let the hit list be the file list.
- **A decoy is not malicious, just smaller or older or differently placed** — the failure mode
  doesn't require anyone to have tried to mislead the plan author, which is exactly why it is
  easy to reproduce by accident and did so three times in one session.
- **The strongest test suites are often the ones with the least filename resemblance to the
  source** — a cross-language contract test, a schema-conformance test, a config test — because
  they are testing the *seam*, not the file. A plan optimizing for filename match systematically
  deprioritizes exactly these.
- **Treat a rename task's compile step as a partial safety net, not a substitute for the grep.**
  Tracking's contract test would have failed to compile and forced discovery — but only after
  the plan had already told an implementer to consider the rename task complete without it, and
  a suite that merely fails to compile is a worse discovery mechanism than one identified before
  the edit.
- **After a plan-dictated comment edit, run the linter on the whole file, not just the new
  block.** Compliance is scoped to the file's aggregate density and each block's own length, and
  a plan cannot know either in advance because both depend on what else already lives in that
  file.

## Related

- [[2026-09-10-in-app-notifications-design]] — the design spec whose Phase 2 (SQS
  `SendMessage` → SNS `Publish`) implementation surfaced all three reproductions.
- [[2026-09-10-in-app-notifications]] — the implementation plan whose Task 2.1 (Users), Task 2.3
  (Orders), and Task 2.4 (Tracking) each independently exhibited this failure mode.
- [[code-comments]] — the density/block-length convention whose file-scoped (not block-scoped)
  nature is this note's second finding.
- [[testing]] — the three-layer testing convention this finding threatens from underneath: a
  plan that omits a contract test from its rename step can silently delete layer coverage that
  the convention assumes is intact.
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] — the closest sibling in
  shape: both are failures where the artifact that ships is internally self-consistent and
  passes review on its own terms, because nothing in the normal review path checks the diff
  against what a design or plan actually required, only against what the diff itself claims to
  do.
- [[2026-08-27-a-producer-side-test-proves-nothing-about-what-the-consumer-accepts]] — a sibling
  finding about the same class of test (a cross-language/cross-service contract suite) being the
  one most load-bearing and least protected by convention-based discovery.
- [[tightened-schemas-need-producer-first-deploys]] — another finding centered on the same
  contract-test mechanism (Zod schema conformance) that Tracking's omitted
  `zod_contract_test.go` implements.
