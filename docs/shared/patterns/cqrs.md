---
title: CQRS
type: pattern
area: shared
status: active
created: 2026-06-26
updated: 2026-06-26
tags: [type/pattern, area/shared, status/active]
related: ["[[dependency-injection]]", "[[screaming-architecture]]"]
---

# CQRS

## Pattern

Commands (writes) and queries (reads) are separated. Each command type and each event type maps to its own dedicated handler, rather than sharing a monolithic service class.

## How we apply it

- Services model their write operations as commands and their reads as queries, each routed to a single handler.
- The events pipeline applies the same shape: a `TYPE => TypeHandler` mapping dispatches each event type to its handler.
- Handlers are wired through [[dependency-injection]] and live as first-class use-cases under our [[screaming-architecture]] folder layout.

## Related

- [[dependency-injection]] — how command/query/event handlers get their collaborators wired.
- [[screaming-architecture]] — handlers surface as use-case folders in the structure.
- [[versioning]] — versioned APIs front these handlers.
