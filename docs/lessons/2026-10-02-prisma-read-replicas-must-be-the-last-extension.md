---
title: "Prisma read replicas must be the last extension"
type: lesson
area: users
status: active
created: 2026-10-02
updated: 2026-10-02
tags:
  - type/lesson
  - area/users
  - status/active
  - severity/high
related:
  - "[[users-service-design]]"
  - "[[soft-delete]]"
---

# Prisma read replicas must be the last extension

## Symptom

With the extension order reversed, a read served by the replica returned soft-deleted users. The
soft-delete filter existed and passed its own tests; it simply never ran for replica reads.

## Cause

Prisma runs query-extension hooks in `$extends` order. `@prisma/extension-read-replicas` answers
a read by calling `replica[model][op](args)` on the bare replica client rather than `query(args)`.
It never hands the call down the chain, so any extension applied AFTER it does not run for reads.
Verified with a negative control: reversing the order returns soft-deleted users.

## Current state

Users applies the read-replica extension last, which is correct. `composeDbClients()` and
`tests/shared/db/read-replica-soft-delete.test.ts` pin the order, and the test proves soft-delete
filtering reaches replica reads (branch `test/users-read-replica-soft-delete`).

## Floci's RDS ignores the read-only option

`options=-c default_transaction_read_only=on` in the connection URL has no effect on Floci's RDS:
`SHOW default_transaction_read_only` returned `off`. A read-only probe cannot rely on it and must
rely on query discipline, issuing only reads.

## Rules

- **Apply `@prisma/extension-read-replicas` last.** Every extension that must affect reads
  (soft-delete filtering, auditing, tracing) goes before it.
- **Pin the order with a test that has a negative control:** a read through the replica must
  exclude a soft-deleted row, and reversing the order must make that test fail.
- **Do NOT trust a read-only URL option on Floci's RDS.**

## Related

- [[soft-delete]] — the rule the replica path must honour.
- [[users-service-design]] — the Users data layer that composes the clients.
