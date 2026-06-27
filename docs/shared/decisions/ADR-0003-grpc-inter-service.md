---
title: "ADR-0003: gRPC for Inter-Service Communication"
type: adr
area: shared
status: accepted
id: ADR-0003
created: 2026-06-26
updated: 2026-06-26
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags: [type/adr, area/shared, status/accepted]
related: ["[[versioning]]"]
---

# ADR-0003: gRPC for Inter-Service Communication

## Context

Services need to call each other synchronously — for example, Orders calling Users to resolve ownership, or Tracking being queried by Orders. REST over HTTP/1.1 works but adds overhead and lacks a contract-first schema. We need a typed, versioned contract between services.

## Decision

All synchronous inter-service calls use gRPC over HTTP/2 with protobuf schemas as the contract. REST endpoints are exposed only for external clients through API Gateway. gRPC contracts are versioned per [[versioning]].

## Consequences

Service-to-service calls are strongly typed and schema-validated at compile time. Latency is reduced versus REST+JSON for internal traffic. Teams must maintain `.proto` files alongside service code and version them according to the shared versioning convention.

## Related

- [[versioning]]
