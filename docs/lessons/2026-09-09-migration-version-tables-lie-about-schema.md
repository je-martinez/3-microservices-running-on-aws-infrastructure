---
title: "A migration tool reports \"up to date\" from its version table, not from the schema"
type: lesson
area: infra
status: active
created: 2026-09-09
updated: 2026-09-09
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/critical
related:
  - "[[2026-08-27-accumulated-local-state-degrades-the-stack-silently]]"
  - "[[env-files]]"
  - "[[2026-09-09-makefile-orchestration-invariants]]"
---

# A migration tool reports "up to date" from its version table, not from the schema

## The generalisable lesson

A migration tool's "nothing to do" / "already up to date" answer is a claim about its
**bookkeeping table** (`schema_migrations`, `_prisma_migrations`, an Alembic `alembic_version`
table, …), never a claim it derived by inspecting the actual tables or columns. Bookkeeping that
is current while the schema it describes is missing or behind is a **silent no-op**, and every
layer built on top of that migration step — the service that starts against the database, its
integration tests, a health check — reports healthy, because none of them re-derive the truth
either; they all trust the same version table transitively.

The transferable check: when a migration runner says "nothing to do", ask what it **consulted**.
If the answer is a version table, that is a claim about bookkeeping, not about schema.

## What actually happened in this repo (measured this week)

`make migrate-tracking` needed to handle one specific transition: databases that were originally
built by an earlier Alembic-based migration history and have since been ported to
golang-migrate. Those databases have the `tracking` table (and data) but no
`schema_migrations` table — golang-migrate has never touched them. The correct handling for
**that one case** is to stamp the baseline (`force 1`) rather than replay it, since replaying
would try to `CREATE TABLE tracking` against a table that already exists.

The probe that decided when to stamp got this wrong, in **both directions**, before it was fixed.

### Wrong spelling #1 (shipped): checked for `tracking` alone

The first probe checked only whether the `tracking` table existed, and stamped `force 1`
whenever it did — which is true for *every* previously-bootstrapped local database, not just
the Alembic-built ones golang-migrate had never seen.

Concretely: `000002_add_order_number` was never applied to a local database that already had a
`tracking` table from an earlier bootstrap. `force 1` stamps the version table at 1 and runs
**no SQL** — it does not run `up`. The `order_number` column was simply absent. And because
`schema_migrations` now correctly reported version 1 (the stamped value), everything downstream
that trusted it reported healthy: `make doctor`'s original table-name check, the tracking service
itself (it only fails on the missing column when a query actually touches it), and the test
suite. Nothing said the column was missing until a request hit it.

### Wrong spelling #2 (also wrong, considered and rejected): stamp on every existing-table run

The obvious "fix" — stamp whenever `tracking` exists, on *every* invocation, not just the first —
is also wrong, in the opposite direction. Stamping `force 1` on a database that is **already at
version 2** rewinds `schema_migrations` back to 1. The `up` that golang-migrate then runs tries
to apply `000002_add_order_number` again, and dies on:

```
Error 1060: Duplicate column name 'order_number'
```

— with the version left **dirty**. A dirty version blocks every subsequent `migrate-tracking`
invocation until it is manually repaired with `migrate ... force <real version>`.

### The correct probe

Stamp **only** when both conditions hold: the `tracking` table is present **and**
`schema_migrations` is **absent**. That is exactly the shape of the Alembic-built database the
baseline squash was written for — nothing else. Any database that already has
`schema_migrations` (dirty or not, at any version) skips stamping entirely and goes straight to
`up`, which is a correct no-op when it is already current.

The Makefile's implementation also probes the table's existence and the connection's success
**separately**, rather than folding both into one `grep -q`. Conflating "table absent" with
"could not connect to MySQL at all" was tried and measured to fail: under that conflated form, a
transient TLS failure against Floci's MySQL (see [[env-files]]) read as "table absent," selected
`up`, and `up` died on `Error 1050: Table 'tracking' already exists` after golang-migrate had
already written `(version=1, dirty=1)` — leaving the database dirty from a connectivity blip that
had nothing to do with the schema.

## The same shape exists on the Users/Prisma side

Prisma's "idempotent" `migrate deploy` (used by `make migrate` for the Users Postgres database)
means the same thing structurally: Prisma consults its own `_prisma_migrations` table, not the
application's tables, to decide whether there is anything to apply. Nothing has verified this
fails the identical way in this repo yet — but the mechanism is the same, so current bookkeeping
over missing or partial tables would plausibly no-op silently there too. Treat any "Prisma says
up to date" claim with the same suspicion this lesson establishes for golang-migrate, until it
has been independently checked against `\d` / `information_schema` rather than
`_prisma_migrations`.

## The defence that now exists

`infra/scripts/doctor.py`'s `check_migration_heads` compares migration **versions**, not table
**names**, against what is actually on disk:

- The expected version for tracking is derived from the highest `NNNNNN_` prefix under
  `services/tracking-go/migrations/` on the filesystem — **never hardcoded** — so the check does
  not go stale the moment a new migration lands.
- It queries `tracking.schema_migrations` directly for `(version, dirty)` and fails loudly if the
  row is unreadable (never migrated), dirty (died part-way), or behind the expected head (some
  later migration's columns are missing) — the exact defect this lesson is about.
- The equivalent check exists for Orders/EF Core, comparing the set of applied migration ids
  against the set present in `Orders.Infrastructure/Migrations/` on disk.

This is a **stronger** claim than the check it replaced, which only compared table **names**
(`EXPECTED_TABLES`) against `information_schema.tables`. Table-name comparison is exactly what
let `000002_add_order_number` hide: the `tracking` table was present, so the table-name check
passed, while the column it added was not there. A partially-applied migration set is a real
state that "3 of 4 tables present" or "the table exists" both read as fine when they are not —
compare identifiers (versions, migration ids), never counts or mere presence.

## Related

- [[2026-08-27-accumulated-local-state-degrades-the-stack-silently]] — the broader lesson on
  local state silently degrading the stack and getting misdiagnosed as a code defect; that note
  is the general pattern, this one is the specific migration-bookkeeping instance of it.
- [[env-files]] — `DATABASE_WRITER_URL` in `.env.local.tracking`, which `migrate-tracking` reads
  and reconnects against; the TLS/connectivity probe failure mode above depends on this file
  being current.
- [[2026-09-09-makefile-orchestration-invariants]] — why `migrate-tracking` sits where it does in
  the bootstrap chain; this note covers what can go wrong inside that single step regardless of
  where it runs.
