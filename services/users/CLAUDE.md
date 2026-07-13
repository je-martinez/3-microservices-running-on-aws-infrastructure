# CLAUDE.md — Users service

Nested project memory for the **Users** microservice. Source of truth for this
service's stack and conventions. The global `users-impl` agent reads this first,
every time. Cross-cutting rules are **referenced**, never duplicated.

## 1. Stack & versions
- Runtime: Node.js (repo-pinned via `.nvmrc`, currently 24.18.0 — run `nvm use`).
- Framework: Fastify.
- Database: Aurora Postgres (read + write replicas).
- ORM: Prisma.
- Env validation: Zod.

## 2. Commands
- Install: `nvm use && corepack enable && pnpm install --frozen-lockfile`
- Build: `pnpm build`
- Test: `pnpm test`
- Lint: `pnpm lint`
- Run local (docker-watch): `docker compose up users --watch` (from repo root)
- Migrate: `pnpm prisma migrate dev`
- **Generate the OpenAPI spec: `pnpm generate:openapi`** (writes `openapi.yaml`).

> These commands are the intended contract; the scripts themselves are created
> in the Users implementation milestone.

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
├── src/features/users/{commands,queries,domain,grpc}/
├── src/shared/{config,db,di,audit,messaging}/
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
- Leave finished work in the working tree for `github-ops` to commit.
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Service spec (vault): [../../docs/domains/users/specs/users-service-design.md](../../docs/domains/users/specs/users-service-design.md)
- Endpoints: `[POST] /users/register` (emits SQS `USER_CREATED`), `[POST] /users/login`, `[GET/PATCH] /users/me`. gRPC: `GetUserById`.
