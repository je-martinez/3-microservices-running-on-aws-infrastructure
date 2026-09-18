---
title: "A correct rule in the vault didn't stop the violation, because the file an agent reads first held a narrower version of it"
type: lesson
area: orders
status: active
created: 2026-09-18
updated: 2026-09-18
tags:
  - type/lesson
  - area/orders
  - status/active
  - severity/medium
related:
  - "[[cqrs]]"
  - "[[orders-service-design]]"
  - "[[clean-architecture-divergence]]"
  - "[[doc-propagation]]"
---

# A correct rule in the vault didn't stop the violation, because the file an agent reads first held a narrower version of it

## Finding

`POST /v1/orders/{orderId}/cache-invalidation`, an internal Orders endpoint, was written
with all of its application logic inline in the Minimal API endpoint delegate: it injected
`OrdersReadDbContext` directly, ran an EF query to resolve the order's owner, branched on
not-found, and called the cache invalidator — no handler in `Orders.Application` (or the
Infrastructure use-case layer Orders actually uses, per [[clean-architecture-divergence]])
at all. Review rejected it: *"violaste la regla de usar CQRS para el internal endpoint
teniendo toda la lógica en el route... en lugar de tener un handler."*

The rule the endpoint broke was not missing from the vault. [[cqrs]] stated it, and had
stated it since the vault's first commit: *"Each command type and each event type maps to
its own dedicated handler, rather than sharing a monolithic service class,"* and handlers
"live as first-class use-cases," wired through DI — not inlined in transport code.

What the rule was missing from was `services/orders/CLAUDE.md` — the file the `orders-impl`
agent reads **first, every time**, and the operative instruction for implementation. That
file's only mention of CQRS was the read/write `DbContext` split
(`OrdersReadDbContext`/`OrdersWriteDbContext`), a real and correct fact about Orders, but a
narrower claim than the vault's rule. Nothing in the CLAUDE.md said a route must stay thin
or that domain logic belongs in a handler. An agent could satisfy every sentence in the file
it was told to read and still put an EF query in an endpoint delegate — not because it
ignored an instruction, but because the instruction it was given never carried the
constraint that mattered.

## Contributing factor: a bad precedent was copy-able

The sibling internal route in the same file, `MapDelete("/v1/orders/by-user", ...)`
(`InternalEndpoints.cs`), has the identical shape: the delegate takes `OrdersWriteDbContext`
directly and runs its cascade inline, no handler. The new endpoint was written next to it
and took the same shape. "Follow the neighbouring code" is ordinarily sound advice for
matching a codebase's conventions — the mechanism failed *because* it worked as designed:
it propagated an existing violation as if it were the convention, precisely because nothing
distinguished "this is how we do it" from "this is a bug that predates review catching it."

A second, sharper detail: an `InvalidateOrderCacheService` class already existed in
`Orders.Infrastructure/Orders/` — right shape, right layer, unused. The endpoint reimplemented
its query inline instead of injecting and calling it. A handler existing but not being wired
in is the same violation as never writing one, and it is easier to miss on review than a
handler's total absence, because the endpoint file alone looks self-contained.

## The mechanism — why a correct vault rule offered no protection

This is a **rule-propagation failure**, the same class of gap the repo's own GOLDEN RULE
("the vault is the source of truth, never a private memory file") and [[doc-propagation]]
exist to prevent — except inverted. Doc-propagation is about decisions made in
`docs/superpowers/` failing to reach the organized vault. Here the vault already had the
organized, correct rule; the gap was one hop further downstream: from the organized vault
into the nested `CLAUDE.md` that an implementing agent actually opens. A rule can be written
once, correctly, in the right place, and still fail to govern behaviour if the file that
functions as the agent's working instructions restates only part of it.

"The vault says X" is not the same claim as "the file the agent reads before writing code
says X." Both need saying, and the second one is the one that binds moment-to-moment
implementation choices — the vault note is authoritative, but it is not what gets loaded
into context at the moment a route gets written.

## How to apply

- **When a nested `CLAUDE.md` references a cross-cutting vault pattern, check that it carries
  the constraint that actually governs behaviour, not just a fact the pattern happens to also
  be true about.** Orders' CLAUDE.md was correct about the DbContext split and silent about
  the handler rule — both are part of [[cqrs]], but only one of them is what stops an endpoint
  delegate from querying a DbContext directly.
- **A `[[wikilink]]` pointer is not a substitute for stating the operative constraint inline**,
  when the constraint is one an agent must obey while writing code it will never re-derive from
  the linked note mid-task. Point at the vault for the full pattern; state the actionable
  prohibition where the agent is actually looking.
- **Treat a neighbouring file's shape as evidence of "this is how it's done," never as proof
  it's correct.** A precedent that violates a pattern note is the pattern note's job to catch,
  not the neighbouring file's job to have already gotten right. When copying a route's shape,
  check it against [[cqrs]] the same way a new route would be checked, not against what already
  compiled.
- **An unused handler class sitting next to a route that reimplements its logic is a specific,
  checkable review smell**: if a properly-shaped service class exists for exactly this
  operation, the endpoint should be calling it, not duplicating it. Grep for the class name in
  the endpoint file before approving a route change.

## Related

- [[cqrs]] — the pattern strengthened after this incident: the handler-only-holds-logic rule is
  now stated as an explicit prohibition with a detectable symptom, not just a description.
- [[orders-service-design]] — the service spec this endpoint concerns; the endpoint's
  corrected implementation is being tracked separately from this lesson.
- [[clean-architecture-divergence]] — where a "handler" lives in Orders' Clean-Architecture
  project split, relevant to how the fix should be shaped.
- [[doc-propagation]] — the sibling propagation convention (superpowers → organized vault);
  this lesson is about the next hop downstream (organized vault → nested CLAUDE.md) that
  convention does not yet cover.
