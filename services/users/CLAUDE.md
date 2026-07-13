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
  - gRPC: `GetUserById` (handler exists; no server wiring yet).
- Error contract: typed auth errors (`shared/auth/auth-errors.ts`) mapped by a global
  `setErrorHandler` in `routes.ts`.
- `USER_CREATED` is **not** on SQS yet — `shared/messaging/event-publisher.ts` ships a
  `NoopEventPublisher`; the emission point exists, the SQS wiring is deferred.
