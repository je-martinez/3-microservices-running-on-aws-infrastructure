---
title: "The spec said the retry was required; the code shipped without it, and review checked the diff, not the spec, against itself"
type: lesson
area: orders
status: active
created: 2026-08-26
updated: 2026-08-26
tags:
  - type/lesson
  - area/orders
  - status/active
  - severity/high
related:
  - "[[2026-08-25-cart-endpoints-design]]"
  - "[[orders-service-design]]"
  - "[[2026-08-25-cart-innodb-generated-column-fk-restriction]]"
  - "[[2026-08-25-route-works-in-process-but-404s-at-gateway]]"
  - "[[2026-08-25-preview-must-mirror-charging-roundings-application-point]]"
  - "[[2026-08-25-reads-are-not-exempt-from-observability]]"
  - "[[testing]]"
---

# The spec said the retry was required; the code shipped without it, and review checked the diff, not the spec, against itself

## Finding

`docs/superpowers/specs/2026-08-25-cart-endpoints-design.md` specified, in its very first
committed version (`500c90a`, Concurrency section): *"Two simultaneous `PUT`s from the same
user could both try to create a cart; the unique index makes one fail with a duplicate-key
violation. Catch that specific violation and retry **once** by reading the cart that won. That
is the correct resolution."*

The implementation shipped **without catching that violation**. A concurrent `PUT` race, which
the spec correctly anticipated and specified a resolution for, produced an unhandled
`DbUpdateException` — a bare `500` for a race the database's unique index was, by design,
already resolving correctly at the data layer. Only the application-level recovery step named
in the spec was missing.

This is different from every other finding in this milestone (see Related below), and worth
naming precisely: **those were documentation wrong about code — a note stated a claim that
didn't match what shipped. This is the inverse: code wrong about documentation — a brief stated
a requirement that the implementation silently did not fulfil.** The inverse case is harder to
catch, and that difficulty is the actual lesson.

## Why every safeguard in the pipeline pointed the wrong way

Four independent checks existed between the spec and production, and none of them was built to
catch this class of gap:

1. **The implementer** had the brief containing the exact paragraph and shipped the unhandled
   exception anyway — not a case of missing information, but of a specified step not making it
   into the code.
2. **The per-task reviewer** read the brief and the diff together and did not flag the
   omission. Reading both is not the same as checking one against the other line by line.
3. **The full test suite passed.** Nothing exercised two genuinely concurrent `PUT`s against
   the same caller, so the missing retry path produced no test failure — there was no signal
   for any automated gate to catch.
4. **It surfaced only in a later whole-branch review**, and even then by someone *reasoning
   about the code's behaviour under concurrency* rather than by any process that checked the
   diff against the spec directly. It was found, not caught by a gate designed to find it.

## The mechanism — why a document that is right offers no warning

A dropped requirement leaves **no trace** in the artifact that ships. The code that results is
internally self-consistent: it compiles, its own logic is coherent, and it passes review on its
own terms because reviewing "is this diff correct" only asks whether the code does what it
claims to do — never whether it does everything the brief asked for. Tests written alongside
the implementation compound this: they naturally cover what was **built**, not what was
**specified**, so a missing feature produces a passing suite rather than a failing one.

Contrast this with the other four lessons from this milestone, where a *document* was wrong:
those are findable by anyone who reads the document carefully enough, because the error is
sitting in something written down, waiting to be reread. This failure mode has no equivalent
surface — the absence is invisible from the diff alone. The only way to see it is to read the
brief and the diff **against each other**, specifically hunting for requirements that have no
corresponding line of code, rather than judging the diff purely on its own merits.

## How to apply

- **Ask two different review questions, not one.** "Is this diff correct?" (does the code do
  what it claims, correctly) is necessary but not sufficient. "Does this diff do everything its
  brief specified?" is a distinct check that must be performed separately — it cannot be
  inferred from the first passing.
- **Concretely: a task review should enumerate the brief's requirements as a checklist and tick
  each one off against the diff**, rather than reading the diff holistically and judging whether
  it "looks right." A requirement with no corresponding code change is invisible to a holistic
  read and only surfaces to an enumerated one.
- **A green test suite is not evidence a requirement was met** — only evidence that the tests
  written happen to pass. Tests are authored by the same process that may have dropped the
  requirement, so they inherit the same blind spot by construction.
- **Concurrency-guard requirements are a specific high-risk case of this pattern**: a race
  condition's resolution is exactly the kind of thing a spec calls out because normal
  single-request testing will never exercise it. If a spec names a race and its resolution,
  treat that paragraph as requiring its own explicit checklist line in review — it is exactly
  the kind of requirement ordinary testing cannot surface as missing.
- **Name this failure mode explicitly when it is found**, the way this note does: distinguishing
  "documentation was wrong" from "code silently didn't do what was specified" matters, because
  the fix for each is different. The first is fixed by correcting a note. The second is fixed by
  changing how review is performed — a process change, not a content change.

## Related

- [[2026-08-25-cart-endpoints-design]] — the spec whose Concurrency section specified the
  retry correctly from its first committed version; the implementation task that dropped it.
- [[orders-service-design]] — the retry mechanism, once implemented, is now documented in the
  "one-active-cart invariant" section.
- [[2026-08-25-cart-innodb-generated-column-fk-restriction]] — a sibling finding from the same
  milestone, but a documentation-wrong-about-code case, not this note's inverse.
- [[2026-08-25-route-works-in-process-but-404s-at-gateway]] — another sibling finding: a gap
  that passed full functional test coverage, though there the gap was a genuinely missing
  routing declaration rather than a specified-but-dropped requirement.
- [[2026-08-25-preview-must-mirror-charging-roundings-application-point]] — another
  documentation-wrong-about-code sibling (a plan's comment asserted the wrong rounding rule).
- [[2026-08-25-reads-are-not-exempt-from-observability]] — the closest sibling in shape: also a
  claim in the design spec that turned out false, but there the spec's own claim was wrong; here
  the spec's claim was right and the implementation was wrong. The two together bracket the
  failure space: a document can mislead, or an implementation can silently ignore a document
  that was correct.
- [[testing]] — the three/four-layer testing convention this finding shows is necessary but not
  sufficient: none of those layers, however complete, is designed to catch a requirement that
  was specified and never implemented, only requirements that were implemented incorrectly.
