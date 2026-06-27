---
title: "ADR-0014: Environment Variable Validation with Zod-Style Schema"
type: adr
area: shared
status: accepted
id: ADR-0014
created: 2026-06-26
updated: 2026-06-26
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags: [type/adr, area/shared, status/accepted]
related: []
---

# ADR-0014: Environment Variable Validation with Zod-Style Schema

## Context

Missing or malformed environment variables cause runtime failures that are hard to diagnose — the error surfaces far from the missing value. Services loaded in production with incomplete configuration can behave unpredictably or expose partial functionality.

## Decision

Every service defines a Zod-style schema (or equivalent library for its runtime: Zod for Node, a typed settings validator for .NET, Pydantic for Python) that validates all required environment variables at startup. The service refuses to start if validation fails, printing a clear error listing the missing or invalid variables.

## Consequences

Configuration errors are caught immediately at startup, not during request handling. The schema serves as living documentation of the service's required environment. Each service must keep its schema up to date when adding new environment variables.

## Related

- [[ADR-0007-secrets-parameter-store]]
