---
title: Screaming architecture
type: pattern
area: shared
status: active
created: 2026-06-26
updated: 2026-07-02
tags: [type/pattern, area/shared, status/active, area/users]
related: ["[[cqrs]]"]
---

# Screaming architecture

## Pattern

The folder structure "screams" the domain, not the framework. Use-cases are first-class, top-level folders, so opening a project tells you what the system *does* before it tells you what tools it uses.

## How we apply it

- Use-cases (commands, queries, events) are organized as named folders, not buried under framework-driven directories like `controllers/` or `services/`.
- Framework and infrastructure wiring stays at the edges, out of the way of the domain.
- This pairs naturally with [[cqrs]]: each command/query/event handler is a use-case folder.
- In the Users service ([issue JE-39](https://linear.app/issue/JE-39)), the artifact inside each `commands/`/`queries/` use-case folder moved from a free function to a service-class with a single `execute` method (or grouped read methods, e.g. a `UserQueryService` exposing `getMe`/`getUserById`), constructor-injected from the [[dependency-injection]] Awilix cradle — the folder still screams the domain, only the artifact changed (function → DI-resolved service-class).

## Related

- [[cqrs]] — the command/query/event handlers that become these use-case folders.
- [[dependency-injection]] — wires the use-cases to their infrastructure at the edges.
