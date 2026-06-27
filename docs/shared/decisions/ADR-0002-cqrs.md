---
title: "ADR-0002: CQRS Across Services and Events Pipeline"
type: adr
area: shared
status: accepted
id: ADR-0002
created: 2026-06-26
updated: 2026-06-26
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags: [type/adr, area/shared, status/accepted]
related: ["[[cqrs]]"]
---

# ADR-0002: CQRS Across Services and Events Pipeline

## Context

Each service handles both reads (queries) and writes (commands), and the events pipeline must dispatch incoming SQS messages to the correct handler. A single handler approach mixes concerns and complicates testing and extension.

## Decision

All services adopt the Command Query Responsibility Segregation pattern. Commands and queries have dedicated handlers. The events pipeline uses a CQRS dispatch map keyed on event `type` (e.g. `ORDER_CREATED => OrderCreatedHandler`), all running inside a single Lambda.

## Consequences

Each command/event type is independently testable and replaceable. Adding a new event type requires only registering a new handler — no changes to the dispatch core. The team must maintain the discipline of not mixing read and write concerns in the same handler.

## Related

- [[cqrs]]
