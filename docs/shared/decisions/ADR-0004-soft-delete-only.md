---
title: "ADR-0004: Soft-Delete Only — No Hard Deletes"
type: adr
area: shared
status: accepted
id: ADR-0004
created: 2026-06-26
updated: 2026-06-26
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags: [type/adr, area/shared, status/accepted]
related: ["[[soft-delete]]"]
---

# ADR-0004: Soft-Delete Only — No Hard Deletes

## Context

Data loss from accidental or malicious deletes is hard to recover from. Maintaining an audit trail of who deleted what and when is a compliance and debugging requirement across all services.

## Decision

Hard deletes are forbidden system-wide. Every delete operation sets `deletedAt` and `deletedBy` on the record instead. The database write user is granted only `INSERT`, `UPDATE`, and `SELECT` — never `DELETE`. ORM delete methods are overridden to enforce this.

## Consequences

Data is recoverable and the deletion audit trail is always present. Storage grows over time and queries must filter `WHERE deletedAt IS NULL`. The database permission model enforces the rule at the infrastructure level, making accidental hard deletes impossible even via raw SQL.

## Related

- [[soft-delete]]
