---
title: API and contract versioning
type: convention
area: shared
status: active
created: 2026-06-26
updated: 2026-07-12
tags: [type/convention, area/shared, status/active]
related:
  - "[[ADR-0003-grpc-inter-service]]"
---

# API and contract versioning

## Rule

- Every service exposes **versioned APIs**, with the version in the path (e.g. `/v1/...`).
- gRPC contracts used for inter-service communication are **versioned too**.
- A new version is introduced for breaking changes; older versions stay available until consumers migrate.

## Rationale

Explicit versioning lets each service evolve its public surface without breaking existing consumers. Versioning both the HTTP APIs and the gRPC contracts means every integration point — external and internal — has a stable, negotiable contract.

> [!warning] Current state (2026-07-12) — gRPC versioning not yet applicable
> Verified: no `.proto` file exists in the repo yet, so there is no gRPC surface to version today
> (see [[ADR-0003-grpc-inter-service]]). The gRPC-versioning rule above is the intended contract for
> when that surface is built. HTTP versioning is real and correctly implemented: all Users service
> routes are under `/v1/...`.

## Related

- [[cqrs]] — versioned APIs front the command/query handlers behind each service.
- [[ADR-0003-grpc-inter-service]] — the gRPC decision this convention's gRPC half applies to.
