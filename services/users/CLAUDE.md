# CLAUDE.md — Users service

Nested project memory for the **Users** microservice. Source of truth for this
service's stack and conventions. The global `users-impl` agent reads this first,
every time. Cross-cutting rules are **referenced**, never duplicated.

## 1. Stack & versions
- Runtime: Node.js (repo-pinned via `.nvmrc`, currently 24.18.0 — run `nvm use`).
- Framework: Fastify (+ `@fastify/awilix` for DI, `@fastify/swagger` +
  `fastify-type-provider-zod` for the OpenAPI spec generated from route schemas).
- DI: **Awilix** (PROXY injection; SINGLETON infra, SCOPED use-cases) — see [[dependency-injection]].
- Database: Aurora Postgres (read + write replicas).
- ORM: **Prisma v7** with the driver adapter (`@prisma/adapter-pg`) and
  `@prisma/extension-read-replicas`. A single client composes one cross-cutting
  extension (nano-id + audit + soft-delete + computed `isDeleted`) — `shared/db/`.
- Env validation: Zod.
- Imports use Node **subpath imports**: `#shared/*` and `#features/*` (see `package.json`).

## 2. Commands
- Install: `nvm use && corepack enable && pnpm install --frozen-lockfile`
- Dev (watch): `pnpm dev` · Start: `pnpm start`
- Build: `pnpm build`
- Test: `pnpm test` (watch: `pnpm test:watch`)
- Lint: `pnpm lint`
- Run local (docker-watch): `docker compose up users --watch` (from repo root)
- Migrate: `pnpm prisma migrate dev` (via the `prisma` passthrough script). The
  local bootstrap chain applies migrations with `make migrate` (`migrate deploy`).
- **Generate the OpenAPI spec: `pnpm generate:openapi`** (writes `openapi.yaml`).

## 2a. GOLDEN RULE — keep `openapi.yaml` in sync

`services/users/openapi.yaml` is **generated from the Fastify route Zod schemas**
(`@fastify/swagger` + `fastify-type-provider-zod`), and it is the artifact
imported into Apidog. It only stays correct if it is regenerated after the
schemas change.

**Whenever you add/remove an HTTP route, or change any route's `schema` — its
`body`, `querystring`, `params`, `headers`, or `response` — you MUST run
`nvm use && pnpm generate:openapi` and commit the regenerated `openapi.yaml`
together with the code change.** A route change without a matching
`openapi.yaml` update is an incomplete change.

- Request/response models should be **named components**, not inline anonymous
  schemas, so Apidog shows them as proper models. Register each reusable schema
  with `z.globalRegistry.add(schema, { id })` in `http/schemas.ts`. For a
  request body, the provider suffixes the request variant with `Input`, so id
  `Register` → component `RegisterInput` (see the registrations at the bottom of
  `http/schemas.ts`).
- The generator prunes component schemas that nothing `$ref`s (orphans), so only
  referenced models appear — keep that behavior (do not register a schema no
  route uses).
- Verify after regenerating: every route's body/params/response resolves to a
  named `$ref` (not inline), and `pnpm build && pnpm lint && pnpm test` pass.

## 2b. GOLDEN RULE — test every endpoint in all three layers

Convention: [../../docs/shared/conventions/testing.md](../../docs/shared/conventions/testing.md) → [[testing]].

**Every Users HTTP endpoint MUST have all three test layers:**
1. **Unit/integration** — vitest via `buildApp` with a mocked Awilix container.
2. **Internal E2E** — the service URL directly (`e2e/`, `localhost:3000`), `x-user-id` faked.
3. **Gateway E2E** — through `API_GATEWAY_URL` with a real Cognito JWT (the URL the
   user hits: JWT authorizer → njs → nginx → service). Specs live in
   `e2e/tests/gateway/`; run with `pnpm --filter @3mrai/e2e test` (needs `make bootstrap`).

**An endpoint without gateway E2E is an incomplete change** — in-process and internal
tests fake the authorizer and never touch the gateway, so they cannot catch
gateway-only bugs (missing route, dropped path param, method mismatch). Adding a
route means adding its gateway spec, same as regenerating `openapi.yaml` (§2a).

## 3. Folder structure (screaming architecture)
```
services/users/
├── src/features/users/{commands,queries,domain,http,webhooks,grpc}/
│     http/     — routes.ts, schemas.ts, generate-openapi.ts, e2e-cleanup, e2e-identity
│     webhooks/ — capture-cognito-identity, cognito-payload, message-id, verify-secret
├── src/shared/{config,db,di,audit,auth,id,messaging}/
│     auth/  — auth-provider, cognito-auth-provider, auth-errors
│     audit/ — actor-context (AsyncLocalStorage), audit-actor (AuditActor enum)
│     id/    — nano-id (MODEL_ID_PREFIXES)
├── src/generated/prisma/   (generated client — do not edit)
├── prisma/
└── tests/
```

## 4. Conventions (referenced, never duplicated)
- Screaming architecture + DI: [../../docs/shared/patterns/screaming-architecture.md](../../docs/shared/patterns/screaming-architecture.md), [../../docs/shared/patterns/dependency-injection.md](../../docs/shared/patterns/dependency-injection.md)
- CQRS: [../../docs/shared/patterns/cqrs.md](../../docs/shared/patterns/cqrs.md)
- Soft delete only: [../../docs/shared/conventions/soft-delete.md](../../docs/shared/conventions/soft-delete.md)
- Prefixed nano IDs: [../../docs/shared/conventions/nano-id.md](../../docs/shared/conventions/nano-id.md)
- Audit fields: [../../docs/shared/conventions/audit-fields.md](../../docs/shared/conventions/audit-fields.md)
- API versioning: [../../docs/shared/conventions/versioning.md](../../docs/shared/conventions/versioning.md)
- DB naming (snake_case ↔ PascalCase aliases): [../../docs/shared/conventions/db-naming.md](../../docs/shared/conventions/db-naming.md)
- Env validation (Zod): [../../docs/shared/decisions/ADR-0014-env-validation-zod.md](../../docs/shared/decisions/ADR-0014-env-validation-zod.md)
- Logging context & tracing: [../../docs/shared/conventions/logging-context.md](../../docs/shared/conventions/logging-context.md)

### Logging & tracing in this service
- Per-request context lives in an **AsyncLocalStorage** store (`shared/logging/log-context.ts`),
  a sibling to the audit `actor-context.ts`, merged into every line by Pino's `formatters.log`.
  Commands enrich it via `setLogContext` and log through `shared/logging/app-logger.ts` — no
  logger is injected, so no function signature changes.
- **PITFALL:** Prisma promises are lazy. Any `await` must happen **inside** the ALS callback, or
  the context is lost at the await site (see `runAsActor`'s comment and [[prisma-lazy-promise-als]]).
- **PITFALL:** put the masked email on the **log call site**, not in the ambient context —
  context fields stick to every later line, which leaked it onto `request completed`.
- The OTel SDK is loaded via `node --import` (Dockerfile CMD + npm scripts), **not** imported in
  `server.ts`. This service is ESM, where static imports are hoisted and resolved before any
  module body runs, so importing it "first" still left instrumented libraries already loaded.
- The gRPC server needs a **manual** server span (`shared/observability/grpc-tracing.ts`): the
  x-api-key interceptor's `ServerInterceptingCall` consumes the metadata, so the auto
  instrumentation sees nothing. The caller's W3C context is extracted in that interceptor
  (`extractParentContext`), but **activated in `onReceiveHalfClose`, not `onReceiveMetadata`** —
  the metadata callback returns synchronously, long before grpc-js dispatches the async handler,
  so a `context.with` there unwinds before the handler runs and the server span comes out a ROOT
  (the JE-77 bug: two disjoint traces instead of one). Activate the extracted context in the
  continuation that dispatches the handler.

## 5. Agent rules
- Converse with the user in **Spanish**; write code and comments in **English**.
- `users-impl` writes **only source code** — never runs git or touches Linear.
- Leave finished work in the working tree for the **main session** to commit
  (`github-ops` is an optional helper for complex git batches — see [[git-workflow]]).
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Service spec (vault): [../../docs/domains/users/specs/users-service-design.md](../../docs/domains/users/specs/users-service-design.md)
- Endpoints (all `/v1`-prefixed — see `http/routes.ts`, `openapi.yaml`):
  - `[GET] /v1/health`
  - `[POST] /v1/users/register` → 201 · 409 `email_exists`
  - `[POST] /v1/users/login` → 200 · 401 `invalid_credentials`
  - `[POST] /v1/users/refresh` → 200 · 401 (Cognito `REFRESH_TOKEN_AUTH`)
  - `[GET|PATCH] /v1/users/me` → 200 · 404 (identity from the `x-user-id` header,
    resolved by `findByIdOrCognitoSub` — accepts the `usr_` id OR the Cognito sub)
  - `[POST] /v1/webhooks/cognito` (shared-secret guarded identity capture)
  - `[DELETE] /v1/users/e2e-cleanup`, `[GET] /v1/users/e2e-identity` — only when
    `E2E_TESTING_ENABLED`
  - gRPC: `GetUserById` — **live** on `:50051` (`GRPC_PORT`), served from
    `shared/grpc/server.ts` over the shared `/proto/users.proto`, guarded by a
    constant-time `x-api-key` interceptor (`GRPC_API_KEY`). Resolves by `usr_` id
    OR Cognito sub; returns `NOT_FOUND` when the user does not exist.
- Error contract: typed auth errors (`shared/auth/auth-errors.ts`) mapped by a global
  `setErrorHandler` in `routes.ts`.
- `USER_CREATED` is **not** on SQS yet — `shared/messaging/event-publisher.ts` ships a
  `NoopEventPublisher`; the emission point exists, the SQS wiring is deferred.
