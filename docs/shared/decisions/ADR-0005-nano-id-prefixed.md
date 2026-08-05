---
title: "ADR-0005: Prefixed Nano-ID Entity Identifiers"
type: adr
area: shared
status: accepted
id: ADR-0005
created: 2026-06-26
updated: 2026-08-03
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags: [type/adr, area/shared, status/accepted]
related: ["[[nano-id]]", "[[events-pipeline-design]]"]
---

# ADR-0005: Prefixed Nano-ID Entity Identifiers

## Context

UUIDs are opaque — from the ID alone you cannot tell which entity type it belongs to. Sequential integer IDs leak record counts and are trivially enumerable. We need IDs that are short, URL-safe, unguessable, and self-describing.

## Decision

All entity IDs follow the Stripe-style `prefix_nanoid` format (e.g. `ord_wldA4A0WwZAKUm`). Each entity type has a fixed prefix. Nano-IDs are generated using the `nanoid` library.

> [!warning] Scope correction (2026-08-03) — events-pipeline is not a consumer
> This ADR originally applied the same scheme to the events-pipeline's `friendlyId` field. As
> implemented (commit `5fd6e0d`), that field was removed: the events-pipeline mints no id of
> its own and has no `nanoid` dependency — `event_id`, the producer-generated idempotency key,
> is its only identifier. This is a scope correction to which services consume this ADR's
> decision, **not** a change to the decision or its `accepted` status for the services that do
> (Users and others using `prefix_nanoid` primary keys). See [[nano-id]] and
> [[events-pipeline-design]].

## Consequences

IDs are immediately recognisable by type in logs, API responses, and the database. There is no collision risk for practical system scales. All services must agree on and document their entity prefixes.

## Related

- [[nano-id]]
- [[events-pipeline-design]]
