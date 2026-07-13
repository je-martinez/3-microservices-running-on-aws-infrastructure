---
title: "ADR-0013: API Versioning Across All Services"
type: adr
area: shared
status: accepted
id: ADR-0013
created: 2026-06-26
updated: 2026-06-26
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
updated: 2026-07-12
tags: [type/adr, area/shared, status/accepted]
related: ["[[versioning]]", "[[ADR-0003-grpc-inter-service]]"]
---

# ADR-0013: API Versioning Across All Services

## Context

APIs evolve over time. Without versioning, any breaking change to an endpoint or gRPC method requires all consumers to update simultaneously, creating tight coupling and coordination risk between services and external clients.

## Decision

All REST endpoints are prefixed with a version segment (e.g. `/v1/users`). All gRPC service definitions include a version in the package name. No unversioned public endpoints are permitted. Version increments are required for any breaking change.

## Consequences

Old and new API versions can coexist during migration windows, enabling consumers to upgrade independently. The codebase carries the overhead of maintaining multiple versions until old ones are retired. The team must agree on a deprecation timeline before removing a version.

> [!warning] Current state (2026-07-12) — gRPC versioning is not yet applicable
> Verified: **no `.proto` file exists anywhere in the repo** — there is no gRPC surface built yet
> (only an unwired gRPC handler stub exists in the Users service; see
> [[ADR-0003-grpc-inter-service]]). The gRPC-versioning half of this decision is therefore
> **intended, not yet in force**. The HTTP half is real and correctly implemented today: all Users
> service routes are versioned under `/v1/...`.

## Related

- [[versioning]]
- [[ADR-0003-grpc-inter-service]]
