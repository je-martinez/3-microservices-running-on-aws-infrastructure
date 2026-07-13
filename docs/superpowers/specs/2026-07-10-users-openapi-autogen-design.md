---
title: Users OpenAPI auto-generation (@fastify/swagger + Zod)
type: spec
area: users
status: draft
created: 2026-07-10
updated: 2026-07-10
tags:
  - type/spec
  - area/users
  - status/draft
related:
  - "[[users-service-design]]"
  - "[[mcp-servers]]"
  - "[[versioning]]"
---

# Users OpenAPI auto-generation (@fastify/swagger + Zod)

## Problem

The Users service exposes its API contract to Apidog via an OpenAPI file at
`services/users/openapi.yaml`. That file is currently **hand-written**, so it
drifts from the real routes the moment anyone edits `routes.ts`. The Apidog MCP
server is read-only (it only reads whatever spec the project holds — see
[[mcp-servers]]), so the spec's fidelity is entirely on us.

We want the spec **generated from the real Fastify routes** so it cannot drift,
and — as a direct benefit of the same schemas — **runtime request validation and
response serialization** that the service does not have today (handlers cast
`req.body as {...}` with no validation).

## Goals

- Generate `services/users/openapi.yaml` from the live route definitions.
- Add per-route Zod schemas that drive validation, serialization, AND the spec.
- Expose a **command** (`pnpm generate:openapi`) as the single, deterministic
  trigger that writes the file. The production server never writes to disk.
- Keep the existing route contracts intact (notably the Cognito webhook's
  401/422 status codes).

## Non-goals (YAGNI)

- **No** Swagger UI (`@fastify/swagger-ui`) — we only need the file, not a served
  docs page.
- **No** writing the spec at server boot (rejected in design: adds boot I/O and
  can dirty the working tree). The command is the only writer.
- No changes to other services — Users only, on the `feature/users-service` line.
- No API behavior changes beyond adding validation that rejects malformed input
  with 400 (and preserving the webhook's existing 401/422).

## Dependencies & version constraints

The repo runs **Zod 3.25.76** (installed; `package.json` pins `^3.23.0`). This
pins the toolchain:

| Package | Version | Why |
|---|---|---|
| `@fastify/swagger` | `^9.5.1` | Runtime plugin; exposes `app.swagger()` / `app.swagger({ yaml: true })`. |
| `fastify-type-provider-zod` | `^5.0.2` | **Critical:** v6+ requires `zod >=4.1.5`. v5.0.2 supports `zod >=3.25.67` + `fastify ^5.0.0` + `@fastify/swagger >=9.5.1`. Do NOT bump to v6/v7 while the repo is on Zod 3. |
| `tsx` | already present (`dev` script) | Runs the TS generation script without a build step. |

Because we stay on the v5 provider + Zod 3, import Zod the normal way
(`import { z } from "zod"`), **not** `zod/v4` as the newest provider docs show.

## Architecture

Zod schemas defined per route serve three purposes at once:

```
Zod schemas (schemas.ts)
        │
        ├─> routes.ts `schema: {...}`
        │        ├─> runtime: validatorCompiler (reject 400) + serializerCompiler
        │        └─> @fastify/swagger (transform: jsonSchemaTransform)
        │                      │
        │             app.swagger({ yaml: true })
        │                      │
        └────────  pnpm generate:openapi ──> writeFileSync ──> services/users/openapi.yaml ──> import into Apidog
```

The production `server.ts` is unchanged and does no disk I/O. Only the
generation script materializes the file.

## Components

### 1. `src/features/users/http/schemas.ts` (new)

Reusable Zod schemas, registered with global IDs so they surface as reusable
`components/schemas` (`$ref`) in the OpenAPI output via `jsonSchemaTransformObject`:

- `UserSchema` (id `User`), `AuthTokensSchema` (id `AuthTokens`),
  `RegisterInputSchema`, `LoginInputSchema`, `UpdateProfileInputSchema`,
  `ErrorSchema` (id `Error`).
- Header schemas: `UserIdHeader = z.object({ "x-user-id": z.string() })`,
  `WebhookSecretHeader = z.object({ "x-webhook-secret": z.string() })`.
- Field-level `.describe(...)` where it improves the generated docs.
- **Reuse** the existing `cognitoWebhookPayloadSchema` from
  `webhooks/cognito-payload.ts` — do NOT duplicate it. It is referenced for the
  webhook's spec/example; see the webhook note below for why it is not wired as
  `schema.body`.

The `User`/`AuthTokens` response schemas must match the real returned shape
(`User` domain type with `usr_`-prefixed id, `isDeleted`, audit fields;
`AuthTokens` = `{ idToken, accessToken, refreshToken }`) so the
`serializerCompiler` does not strip real fields.

### 2. `src/features/users/http/routes.ts` (modified)

- Set compilers once on the app:
  `app.setValidatorCompiler(validatorCompiler)` and
  `app.setSerializerCompiler(serializerCompiler)`.
- Register `@fastify/swagger` with:
  - `openapi.openapi: "3.1.0"` (match the current file's version),
  - `openapi.info: { title: "Users Service API", version: "1.0.0", description: ... }`,
  - `openapi.servers: [{ url: "http://localhost:3000", description: "Local (docker compose / Floci)" }]`,
  - `openapi.tags` for `health`, `users`, `webhooks`, `e2e`,
  - `transform: jsonSchemaTransform`,
  - `transformObject: jsonSchemaTransformObject`.
- Add `schema: { body|params|headers|response, tags, operationId, summary }` to
  each of the 8 routes.
- Route handlers switch to `app.withTypeProvider<ZodTypeProvider>()`, which
  **removes the `req.body as {...}` / `req.query as {...}` casts** — types are
  inferred from the schema.
- The two `e2e` routes stay guarded by `env.E2E_TESTING_ENABLED`; they appear in
  the spec only when that flag is set at generation time (the script sets it —
  see below).

Registration order matters: set compilers → register swagger plugin → declare
routes. Because `buildApp()` already registers plugins synchronously and returns
the instance, keep the swagger registration before the route declarations (use
`app.after(...)` only if a `.ready()` ordering issue appears in practice).

### 3. `src/features/users/http/generate-openapi.ts` (new)

Generation script:

1. Force `process.env.E2E_TESTING_ENABLED = "true"` **before** importing/env
   parse so the e2e routes are registered and appear in the spec (the file is
   the full contract; the flag gates only the live server).
2. `const app = buildApp()`.
3. `await app.ready()` (required before `app.swagger()` — route discovery must
   complete).
4. `const yamlSpec = app.swagger({ yaml: true })`.
5. `fs.writeFileSync(<repo>/services/users/openapi.yaml, yamlSpec)`.
6. `await app.close()`.

Resolve the output path relative to the file (or `process.cwd()` when run from
the service dir) so it works from `pnpm --filter`/service-local invocation.

### 4. `package.json` (modified)

```json
"scripts": {
  "generate:openapi": "tsx src/features/users/http/generate-openapi.ts"
}
```

Run as `nvm use && pnpm generate:openapi` from `services/users/`.

## Data flow / behavior changes

- **Input validation (new):** `validatorCompiler` makes Fastify reject invalid
  bodies/headers with **400** before the handler runs. This is the intended new
  behavior for `register`, `login`, `me` (headers), and profile update.
- **Response serialization (new):** `serializerCompiler` serializes responses
  against their Zod schema and **strips undeclared fields** — so response schemas
  must be faithful to the real shape (see schemas.ts note).
- **Cognito webhook — preserve existing contract:** today it returns **401** on a
  bad/missing `x-webhook-secret` and **422** on an invalid payload (manual
  `.safeParse`). To keep these exact codes:
  - Put `x-webhook-secret` in `schema.headers` only if a missing header should be
    a 400; since the current contract is **401**, keep the secret check **inside
    the handler** (do not let schema validation own it).
  - Keep the payload validated **inside the handler** via the existing
    `cognitoWebhookPayloadSchema.safeParse(...)` returning **422** — do NOT move
    the payload into `schema.body` (which would make it a 400). The webhook's
    `schema` for the spec still references the payload schema for documentation
    (via a documented request-body schema that is not used as the AJV validator),
    or is described in `schema` with validation disabled for that body.
  - Net: the webhook keeps 401/422; only its headers/response are documented.

## Testing

- All existing `app.inject` tests must stay green: run `pnpm test`.
- Add one spec-integrity test: `buildApp()` → `await app.ready()` →
  `app.swagger()` returns an object whose `paths` includes the 8 expected routes
  and whose `components.schemas` includes `User`. This fails loudly if a future
  edit silently degrades the generated spec.
- Manually verify: `pnpm generate:openapi` writes a valid `openapi.yaml` that
  round-trips (parse it; assert 7 paths / 8 operations, `servers[0].url ==
  http://localhost:3000`).

## Delivery

- The hand-written `services/users/openapi.yaml` is **replaced** by the generated
  file at the same path — now a build artifact, still committed and imported into
  Apidog (Import Data → OpenAPI). See [[mcp-servers]] for the Apidog import flow.
- The generated spec is pinned to OpenAPI `3.1.0` to match the current file.

## Open questions / risks

- **Webhook body documentation vs. validation split.** The cleanest way to keep
  422 while still documenting the payload in the spec is provider-version
  dependent. Implementation must confirm whether v5.0.2 lets a route document a
  body schema without using it as the validator; if not, document the payload as
  a named component referenced from the route description and keep the handler's
  manual `safeParse`. Either way the **runtime contract (401/422) is the
  invariant** and must not change.
- **`3.1.0` vs `3.0.x` default.** Confirm `@fastify/swagger` emits 3.1.0 when
  `openapi.openapi: "3.1.0"` is set; adjust if the toolchain forces 3.0.x.

## Related

- [[users-service-design]]
- [[mcp-servers]]
- [[versioning]]
