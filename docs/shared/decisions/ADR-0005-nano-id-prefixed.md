---
title: "ADR-0005: Prefixed Nano-ID Entity Identifiers"
type: adr
area: shared
status: accepted
id: ADR-0005
created: 2026-06-26
updated: 2026-06-26
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags: [type/adr, area/shared, status/accepted]
related: ["[[nano-id]]"]
---

# ADR-0005: Prefixed Nano-ID Entity Identifiers

## Context

UUIDs are opaque — from the ID alone you cannot tell which entity type it belongs to. Sequential integer IDs leak record counts and are trivially enumerable. We need IDs that are short, URL-safe, unguessable, and self-describing.

## Decision

All entity IDs follow the Stripe-style `prefix_nanoid` format (e.g. `ord_wldA4A0WwZAKUm`). Each entity type has a fixed prefix. Nano-IDs are generated using the `nanoid` library. The same scheme applies to the events pipeline `friendlyId` field.

## Consequences

IDs are immediately recognisable by type in logs, API responses, and the database. There is no collision risk for practical system scales. All services must agree on and document their entity prefixes.

## Related

- [[nano-id]]
