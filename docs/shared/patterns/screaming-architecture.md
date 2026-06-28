---
title: Screaming architecture
type: pattern
area: shared
status: active
created: 2026-06-26
updated: 2026-06-26
tags: [type/pattern, area/shared, status/active]
related: ["[[cqrs]]"]
---

# Screaming architecture

## Pattern

The folder structure "screams" the domain, not the framework. Use-cases are first-class, top-level folders, so opening a project tells you what the system *does* before it tells you what tools it uses.

## How we apply it

- Use-cases (commands, queries, events) are organized as named folders, not buried under framework-driven directories like `controllers/` or `services/`.
- Framework and infrastructure wiring stays at the edges, out of the way of the domain.
- This pairs naturally with [[cqrs]]: each command/query/event handler is a use-case folder.

## Related

- [[cqrs]] — the command/query/event handlers that become these use-case folders.
- [[dependency-injection]] — wires the use-cases to their infrastructure at the edges.
