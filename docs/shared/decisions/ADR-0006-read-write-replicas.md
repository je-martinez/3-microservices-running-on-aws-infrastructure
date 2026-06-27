---
title: "ADR-0006: One Read Replica and One Write Replica per Database"
type: adr
area: shared
status: accepted
id: ADR-0006
created: 2026-06-26
updated: 2026-06-26
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags: [type/adr, area/shared, status/accepted]
related: []
---

# ADR-0006: One Read Replica and One Write Replica per Database

## Context

Running all database traffic through a single instance creates a performance bottleneck and a single point of failure. Read-heavy workloads (list queries, reporting) compete with write operations for the same resources.

## Decision

Every Aurora database cluster is provisioned with exactly one writer instance and one reader instance. Application code directs all write operations (INSERT, UPDATE) to the writer endpoint and all read operations (SELECT) to the reader endpoint. This applies to both Aurora Postgres (Users) and Aurora MySQL (Orders, Tracking).

## Consequences

Read and write loads are isolated, improving throughput for both. Failover is faster because a reader is already in sync. Connection string management must distinguish writer vs. reader endpoints; this is enforced per service via Parameter Store configuration.

## Related

- [[ADR-0007-secrets-parameter-store]]
