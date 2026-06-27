---
title: "ADR-0008: Screaming Architecture and Dependency Injection"
type: adr
area: shared
status: accepted
id: ADR-0008
created: 2026-06-26
updated: 2026-06-26
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags: [type/adr, area/shared, status/accepted]
related: ["[[screaming-architecture]]", "[[dependency-injection]]"]
---

# ADR-0008: Screaming Architecture and Dependency Injection

## Context

Framework-first folder structures bury business intent inside generic directories (`controllers/`, `models/`, `utils/`). This makes it hard to navigate the codebase by use case and introduces tight coupling between business logic and infrastructure concerns.

## Decision

All services follow Screaming Architecture: the top-level folder structure is organised by domain use case, not by framework role. All dependencies (repositories, gRPC clients, event publishers) are injected through constructors or DI containers — never instantiated inline in handlers.

## Consequences

A new engineer can read the folder tree and immediately understand what the service does. Swapping an infrastructure dependency (e.g. changing the DB driver) requires changing only the injection binding, not the business logic. Each service must set up a DI wiring layer at startup.

## Related

- [[screaming-architecture]]
- [[dependency-injection]]
