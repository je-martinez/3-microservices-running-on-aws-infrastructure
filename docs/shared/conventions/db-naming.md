---
title: Database naming
type: convention
area: shared
status: active
created: 2026-06-26
updated: 2026-06-26
tags: [type/convention, area/shared, status/active]
related: ["[[nano-id]]", "[[audit-fields]]"]
---

# Database naming

## Rule

- Database columns are named in `snake_case` (e.g. `created_at`, `deleted_by`).
- Application and domain attributes are `PascalCase`, mapped to their columns via ORM aliases.
- Indexes are added where they improve query performance (lookup columns, foreign keys, frequent filters).

## Rationale

`snake_case` is the idiomatic, portable convention for relational schemas, while `PascalCase` keeps domain models clean in code; aliasing bridges the two without leaking persistence naming into the domain. Targeted indexes keep queries fast as data grows. Audit columns such as `created_at`/`deleted_at` (see [[audit-fields]]) and the `prefix_nanoid` primary keys (see [[nano-id]]) follow this same naming.

## Related

- [[nano-id]] — the `prefix_nanoid` primary-key format these columns store.
- [[audit-fields]] — audit columns mapped under this naming convention.
