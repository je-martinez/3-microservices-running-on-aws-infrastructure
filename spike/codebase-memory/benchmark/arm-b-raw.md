## Answers

1. **Users HTTP routes are defined in `services/users/src/features/users/http/routes.ts`.** This is confirmed by `services/users/CLAUDE.md` §3 (folder structure) and §6 (endpoint list, which cites `http/routes.ts`), and verified to exist by listing the `http/` folder.

2. **Soft-delete works via a single Prisma client extension** (`services/users/src/shared/db/prisma-extensions.ts`, composed in `shared/db/prisma.ts`) that transparently rewrites `delete`/`deleteMany` calls into `update`/`updateMany` setting `deletedAt`/`deletedBy`, so no SQL `DELETE` is ever issued — reinforced at the DB-privilege level (the write user has no `DELETE` grant). All `find*`/`count` queries exclude soft-deleted rows by default by injecting `deletedAt: null` into `where`. A computed `isDeleted` result field is registered per-model in a `RESULT_EXTENSIONS` map, enforced by a test that checks every model with a `deletedAt` column is registered there.

3. **`services/users/openapi.yaml` must be regenerated** (`nvm use && pnpm generate:openapi`) whenever an HTTP route is added/removed or a route's `schema` (body/querystring/params/headers/response) changes, and the regenerated file committed together with the code change. This is because `openapi.yaml` is generated from the Fastify route Zod schemas and is the artifact imported into Apidog — it only stays correct if regenerated after schema changes; a route change without a matching update is considered an incomplete change.

4. **All required steps for a new Users HTTP endpoint:** (a) implement the route with named Zod schemas registered via `z.globalRegistry.add(schema, { id })` in `http/schemas.ts` (not inline/anonymous, so Apidog shows proper models); (b) regenerate `openapi.yaml` via `nvm use && pnpm generate:openapi` and verify every body/params/response resolves to a named `$ref`; (c) run `pnpm build && pnpm lint && pnpm test`; (d) write all three test layers — unit/integration (vitest, mocked Awilix container), internal E2E (`e2e/tests/users.spec.ts` against `localhost:3000` with `x-user-id` faked), and gateway E2E (`e2e/tests/gateway/users.spec.ts` against `API_GATEWAY_URL` with a real Cognito JWT) — an endpoint missing either E2E spec is incomplete; (e) if the endpoint verifies a credential, add a dedicated rejection test (wrong credential must be refused, not just the happy path accepted).

5. **Env files are entirely generated, never hand-edited.** `make env-file` generates every env file (`.env`, `.env.local.infra`, `.env.local.users`, `.env.local.orders`, `.env.local.tracking`, `.env.local.events-pipeline`, `.env.local.debug`) from Terraform outputs via `infra/environments/local/scripts/generate_env_files.py`. Each file has an AUTO-GENERATED box (overwritten every run — never hand-edit) and a CUSTOM box (preserved across regeneration — put overrides/personal tokens there). `.env` itself holds only the 4 vars docker-compose interpolates. `.env.example` is the only committed file; everything else is git-ignored.

6. **Never log:** passwords, tokens, full request bodies, or a plaintext email (auth flows log a masked form like `jo*****e@gmail.com`; everywhere else uses `email_hash`, a truncated SHA-256). Additionally, an OTP code must never appear in a log line at all — not masked, not hashed, not truncated, and not echoed via a `reason`/validation-error string — because its low entropy (6 digits) makes even a partial or hashed form brute-forceable.

## Files read

1. `CLAUDE.md` (root)
2. `services/users/CLAUDE.md`
3. `docs/shared/conventions/soft-delete.md`
4. `docs/shared/conventions/testing.md`
5. `docs/shared/conventions/env-files.md`
6. `docs/shared/conventions/logging-context.md`

(Plus two non-read directory listings via Bash `find`, not counted as file reads: `services/users` top level and `services/users/src/features/users/http`.)

## Answer sources

| Question # | File that answered it | Position in read sequence |
|---|---|---|
| 1 | `services/users/CLAUDE.md` (§3, §6) | 2 |
| 2 | `docs/shared/conventions/soft-delete.md` | 3 |
| 3 | `services/users/CLAUDE.md` (§2a) | 2 |
| 4 | `services/users/CLAUDE.md` (§2a, §2b) + `docs/shared/conventions/testing.md` | 2, 4 |
| 5 | `docs/shared/conventions/env-files.md` (root `CLAUDE.md` gave the summary first) | 5 (1 for summary) |
| 6 | `docs/shared/conventions/logging-context.md` (root `CLAUDE.md` gave the summary first) | 6 (1 for summary) |

## Total distinct files read

6

## Index gaps

None. The index (root `CLAUDE.md` → `services/users/CLAUDE.md` → the relevant `docs/shared/conventions/*.md`) fully answered all six questions without needing to open any source `.ts` files — the two `find` directory listings were only used to confirm the routes file path/existence, not to derive an answer.
