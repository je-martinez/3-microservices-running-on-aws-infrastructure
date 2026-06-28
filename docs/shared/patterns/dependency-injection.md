---
title: Dependency injection
type: pattern
area: shared
status: active
created: 2026-06-26
updated: 2026-06-26
tags: [type/pattern, area/shared, status/active]
related: ["[[cqrs]]"]
---

# Dependency injection

## Pattern

All services use dependency injection (DI) to wire their components together. Collaborators — handlers, repositories, clients — are provided to consumers rather than constructed inline.

## How we apply it

- Handlers receive their repositories and clients via DI instead of instantiating them.
- The same approach wires the [[cqrs]] command/query/event handlers across every service.
- This keeps use-cases (see [[screaming-architecture]]) decoupled from concrete infrastructure, making them easy to test and swap.

## Related

- [[cqrs]] — the handlers wired through DI.
- [[screaming-architecture]] — DI connects use-case folders to infrastructure at the edges.
