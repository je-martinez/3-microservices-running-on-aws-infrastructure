---
title: "A chained script's exit code must reflect its own step, not a downstream readiness check"
type: lesson
area: infra
status: active
created: 2026-07-31
updated: 2026-07-31
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/high
  - issue/JE-112
related:
  - "[[tracking-service-design]]"
  - "[[local-dev]]"
---

# A chained script's exit code must reflect its own step, not a downstream readiness check

## What happened

`bootstrap.py`, one step in `make bootstrap`'s chain, does two things in sequence: attach a
network alias to a container (its actual job, with its own hard failure if Docker rejects the
alias), and then — after that succeeds — check whether *another* container is already
responding, to decide whether to skip redundant work. That second check returned a non-zero
exit code when the other container wasn't yet responding, even though the step's own job (the
alias attach) had completed successfully.

`make` halts a chain on any non-zero exit. Because this step's exit code conflated "did my job
succeed" with "is the whole system ready," it stopped `make bootstrap` after itself, taking
down three subsequent steps that had **no dependency on it** — one of which ran Tracking's
Alembic migrations. The result: Tracking's database existed (an earlier step created it) but
had no tables, because the step that would have run the migrations never got the chance to.
Nothing in the failure pointed at Tracking; the actual fault was one step upstream, reporting
success/failure on the wrong condition.

## Why it was easy to write this way

Readiness checks and step success feel like the same question when you're the one writing the
step — "is this thing that I care about okay?" — but they answer different questions to the
caller. `make` (and any chained-step runner) only asks one question of an exit code: "did this
step complete its own responsibility?" It has no way to distinguish "I failed" from "I
succeeded, but I also noticed something else isn't ready yet" — both come back as the same
non-zero code, and both have the same effect: the chain stops.

## The fix

The step's exit code now reflects only whether **its own** job — attaching the alias —
succeeded. The downstream readiness observation, if still useful, is logged or reported
through a separate channel (a log line, a warning), never folded into the same exit code that
gates the rest of the chain.

## Takeaway

In any script that is one link in a sequential chain (a Makefile target, a CI step, a
bootstrap sequence), the exit code answers exactly one question: **did this step do its own
job?** Not "is the system I depend on, or that depends on me, in a good state overall" — that
is a different question, belongs to a different check, and folding it into the same exit code
means an unrelated observation can silently take down every later step in the chain, with the
failure surfacing far from its actual cause. When writing or reviewing a chained script, ask
specifically what condition its exit code is gating, separately from what else the script
might reasonably want to report.

## Related

- [[tracking-service-design]] — the service whose database ended up created but tableless as a
  downstream effect of this bug; the spec's own content was unaffected, this was purely a
  bootstrap-ordering fault.
- [[local-dev]] — the `make bootstrap` chain this step is part of.
