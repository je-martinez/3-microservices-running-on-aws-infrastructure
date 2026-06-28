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
tags: [type/adr, area/shared, status/accepted]
related: ["[[versioning]]"]
---

# ADR-0013: API Versioning Across All Services

## Context

APIs evolve over time. Without versioning, any breaking change to an endpoint or gRPC method requires all consumers to update simultaneously, creating tight coupling and coordination risk between services and external clients.

## Decision

All REST endpoints are prefixed with a version segment (e.g. `/v1/users`). All gRPC service definitions include a version in the package name. No unversioned public endpoints are permitted. Version increments are required for any breaking change.

## Consequences

Old and new API versions can coexist during migration windows, enabling consumers to upgrade independently. The codebase carries the overhead of maintaining multiple versions until old ones are retired. The team must agree on a deprecation timeline before removing a version.

## Related

- [[versioning]]
- [[ADR-0003-grpc-inter-service]]
