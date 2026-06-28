---
title: Nano ID entity identifiers
type: convention
area: shared
status: active
created: 2026-06-26
updated: 2026-06-26
tags: [type/convention, area/shared, status/active]
related: ["[[db-naming]]"]
---

# Nano ID entity identifiers

## Rule

Entity identifiers use a Stripe-style `prefix_nanoid` format: a short per-entity prefix, an underscore, then a Nano ID. For example an order is `ord_wldA4A0WwZAKUm`.

- The prefix is fixed per entity type (e.g. `ord_` for orders, `usr_` for users) so an ID is self-describing.
- This format is the primary key in our relational databases.
- The same scheme is reused for the events pipeline `friendlyId`.

## Rationale

Prefixed Nano IDs are URL-safe, collision-resistant, and human-readable: you can tell at a glance what an ID refers to, which helps when debugging across service boundaries and logs. Reusing the same scheme for the events `friendlyId` keeps identifiers consistent end to end.

## Related

- [[db-naming]] — how these IDs and other columns are named in the database.
