---
title: OpenAPI spec generated from Fastify routes (@fastify/swagger + Zod)
type: adr
area: users
status: accepted
id: users-openapi-autogen
deciders: ["Jose E. Martinez"]
supersedes: null
superseded-by: null
created: 2026-07-28
updated: 2026-07-28
tags: [type/adr, area/users, status/accepted]
related:
  - "[[users-service-design]]"
  - "[[mcp-servers]]"
  - "[[versioning]]"
  - "[[2026-07-10-users-openapi-autogen-design]]"
  - "[[2026-07-10-users-openapi-autogen]]"
---

# OpenAPI spec generated from Fastify routes (@fastify/swagger + Zod)

## Context

`services/users/openapi.yaml` — the contract imported into Apidog (see
[[mcp-servers]]) — was hand-written, so it drifted from the real routes the moment
`routes.ts` changed. Handlers also cast `req.body as {...}` with no runtime validation.

## Decision

- Generate `services/users/openapi.yaml` from the live Fastify route definitions instead
  of hand-maintaining it. Per-route **Zod schemas** (`http/schemas.ts`) drive three things
  at once: AJV request validation, response serialization, and the OpenAPI document (via
  `@fastify/swagger` + `fastify-type-provider-zod`).
- **`pnpm generate:openapi`** is the single, deterministic writer. The production server
  does no disk I/O — generation only happens on demand via the command.
- **Version pin, load-bearing:** `fastify-type-provider-zod@^5.0.2` (not v6/v7, which
  require Zod ≥4.1.5) while the repo stays on Zod 3. Zod imports for this feature use the
  `zod/v4` subpath — the same installed Zod 3.25.76 package ships a v4-compatible API at
  that entrypoint, which the v5 provider requires; this **supersedes** an earlier "never
  `zod/v4`" note. Component `$ref`s register via `z.globalRegistry`, which exists only on
  `zod/v4`.
- **The Cognito webhook's 401/422 contract is invariant.** Its payload is documented in
  the spec but validated **inside the handler** via the existing manual `safeParse` — it
  is deliberately kept out of `schema.body`, which would turn a 422 into Fastify's
  default 400.
- Reuses `cognitoWebhookPayloadSchema` from `webhooks/cognito-payload.ts` rather than
  redefining it — one source of truth for that shape.
- No Swagger UI — only the file is needed, not a served docs page (YAGNI).

## Consequences

- The spec can no longer drift silently: a route change without a matching schema update
  fails the spec-integrity test (`app.swagger()` must expose all routes + the `User`
  component) before it fails in Apidog.
- Endpoints gained real runtime input validation (400 on malformed bodies) as a
  side-effect of the same schemas, closing a pre-existing gap.
- Any later Users route or schema change must regenerate and commit `openapi.yaml` in
  the same change — the generated file is a committed build artifact, not a
  hand-maintained one.

## Related

- [[users-service-design]]
- [[mcp-servers]]
- [[versioning]]
- [[2026-07-10-users-openapi-autogen-design]]
- [[2026-07-10-users-openapi-autogen]]
