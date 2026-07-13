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
updated: 2026-07-12
tags: [type/adr, area/shared, status/accepted]
related:
  - "[[ADR-0007-secrets-parameter-store]]"
  - "[[ADR-0014-env-validation-zod]]"
  - "[[ADR-0017-floci-local]]"
---

# ADR-0006: One Read Replica and One Write Replica per Database

## Context

Running all database traffic through a single instance creates a performance bottleneck and a single point of failure. Read-heavy workloads (list queries, reporting) compete with write operations for the same resources.

## Decision

Every Aurora database cluster is provisioned with exactly one writer instance and one reader instance. Application code directs all write operations (INSERT, UPDATE) to the writer endpoint and all read operations (SELECT) to the reader endpoint. This applies to both Aurora Postgres (Users) and Aurora MySQL (Orders, Tracking).

## Consequences

Read and write loads are isolated, improving throughput for both. Failover is faster because a reader is already in sync. Connection string management must distinguish writer vs. reader endpoints; this is enforced per service via environment variables validated at startup (see [[ADR-0014-env-validation-zod]]) — not via Parameter Store, which is not implemented yet (see [[ADR-0007-secrets-parameter-store]]).

> [!warning] Local deviation (2026-07-12) — Floci does not emulate a read replica
> Verified: on the local Floci-based environment, `docker-compose.yml` explicitly documents that
> the writer and reader endpoints are **the same Aurora endpoint** — Floci does not emulate a
> distinct Aurora read replica. The application-side split described in this ADR is still real: two
> separate database URLs are configured (writer/reader), and the Users service actually routes
> reads vs. writes between them via `@prisma/extension-read-replicas`. Only the *infrastructure-level*
> replica topology is collapsed locally; the code-level replica routing is implemented as designed.

## Related

- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0014-env-validation-zod]]
- [[ADR-0017-floci-local]]
