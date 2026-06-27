---
title: API and contract versioning
type: convention
area: shared
status: active
created: 2026-06-26
updated: 2026-06-26
tags: [type/convention, area/shared, status/active]
related: []
---

# API and contract versioning

## Rule

- Every service exposes **versioned APIs**, with the version in the path (e.g. `/v1/...`).
- gRPC contracts used for inter-service communication are **versioned too**.
- A new version is introduced for breaking changes; older versions stay available until consumers migrate.

## Rationale

Explicit versioning lets each service evolve its public surface without breaking existing consumers. Versioning both the HTTP APIs and the gRPC contracts means every integration point — external and internal — has a stable, negotiable contract.

## Related

- [[cqrs]] — versioned APIs front the command/query handlers behind each service.
