## Answers

1. **Users HTTP routes** are defined in `services/users/src/features/users/http/routes.ts`.

2. **Soft-delete** works entirely at the ORM/DB layer: there are no hard deletes anywhere. The database write user has no `DELETE` privilege, and a single Prisma client extension (`services/users/src/shared/db/prisma-extensions.ts`, composed in `services/users/src/shared/db/prisma.ts`) rewrites `delete`/`deleteMany` into `update`/`updateMany` that stamp `deletedAt`/`deletedBy`. The same extension injects `deletedAt: null` into `find*`/`count` queries by default (unless the caller already filters on `deletedAt`), and exposes a computed `isDeleted` result field per model via a `RESULT_EXTENSIONS` map — enforced by a test that checks every model with a `deletedAt` column is registered.

3. When a Users route's Zod `schema` changes (body/querystring/params/headers/response) or a route is added/removed, `openapi.yaml` (`services/users/openapi.yaml`) must be regenerated with `nvm use && pnpm generate:openapi` and committed alongside the code. It must be regenerated because it's generated output from the Fastify route Zod schemas (`@fastify/swagger` + `fastify-type-provider-zod`) and is the artifact imported into Apidog — a route change without a matching regeneration is an incomplete change per `services/users/CLAUDE.md` §2a.

4. Adding an HTTP endpoint to Users requires: (a) implement the route with a named-component Zod schema (registered via `z.globalRegistry.add`, not inline anonymous schemas); (b) regenerate `openapi.yaml` via `pnpm generate:openapi` and verify `pnpm build && pnpm lint && pnpm test` pass; (c) write all three test layers — unit/integration (vitest + mocked Awilix container), internal E2E (direct service URL with faked `x-user-id`), and gateway E2E (`API_GATEWAY_URL` with a real Cognito JWT, specs in `e2e/tests/gateway/`) — an endpoint without gateway E2E is considered incomplete since internal tests fake the authorizer and miss gateway-only bugs.

5. Env files are **generated**, never hand-edited — `make env-file` builds every file (`.env`, `.env.local.infra`, `.env.local.users`, `.env.local.orders`, `.env.local.tracking`, `.env.local.events-pipeline`, `.env.local.debug`) from Terraform outputs, because values (Cognito ids, DB ports) change on every apply. Each generated file has an AUTO-GENERATED box (overwritten every run — never edit) and a CUSTOM box (preserved) for overrides/personal tokens. `.env.example` is the only hand-maintained, committed file.

6. A log line must never contain: passwords, tokens, full request bodies, a plaintext email (only a masked form like `jo*****e@gmail.com` on auth flows, or `email_hash` elsewhere), or an OTP code in any form (not masked, hashed, or truncated — a 6-digit code is too low-entropy to survive partial exposure). Unknown context fields must be omitted, never emitted as `null`.

## Files read

1. `services/` (dir listing)
2. `services/users/CLAUDE.md`
3. `services/users/src/features/users/http/` (dir listing — errored, is a directory)
4. `docs/shared/conventions/soft-delete.md`
5. `docs/shared/conventions/env-files.md`
6. `docs/shared/conventions/logging-context.md`
7. `services/users/src/features/users/http/` (file listing via find)

## Answer sources

| Question # | File that answered it | Position in read sequence |
|---|---|---|
| 1 | `services/users/src/features/users/http/routes.ts` (confirmed via find, position 7; path also stated in `services/users/CLAUDE.md`, position 2) | 7 |
| 2 | `docs/shared/conventions/soft-delete.md` | 4 |
| 3 | `services/users/CLAUDE.md` (§2a) | 2 |
| 4 | `services/users/CLAUDE.md` (§2a + §2b) | 2 |
| 5 | `docs/shared/conventions/env-files.md` | 5 |
| 6 | `docs/shared/conventions/logging-context.md` | 6 |

## Total distinct files read

6
