# CLAUDE.md — Users service

Nested project memory for the **Users** microservice. Source of truth for this
service's stack and conventions. The global `users-impl` agent reads this first,
every time. Cross-cutting rules are **referenced**, never duplicated.

## 1. Stack & versions
- Runtime: Node.js (repo-pinned via `.nvmrc`, currently 24.18.0 — run `nvm use`).
- Framework: **NestJS 12** (`@nestjs/core`, `@nestjs/common`, `@nestjs/platform-fastify`,
  `@nestjs/cqrs`, `@nestjs/microservices`, `@nestjs/config`, `@nestjs/swagger`) on
  Fastify 5 under the adapter.
- CQRS: `@CommandHandler` / `@QueryHandler` behind `CommandBus` / `QueryBus`. Controllers,
  gRPC, and the SQS consumer are transport only — they dispatch command/query objects.
  See [[cqrs]].
- DI: Nest providers — `@Inject(TOKEN)` only for interfaces / type aliases (`Db`,
  `AuthProvider`, `EventPublisher`, Redis); by-type everywhere else. A **value** import is
  required for an injected class (`import type` erases the token and fails at bootstrap).
  See [[dependency-injection]].
- Decorator metadata: Vitest uses `unplugin-swc`; `dev` / `generate:openapi` use
  `@swc-node/register` — both read `.swcrc` with `decoratorMetadata: true`. esbuild/`tsx`
  drop `design:paramtypes` (see [[2026-09-19-esbuild-drops-decorator-metadata]]). Canary:
  `tests/di-metadata.test.ts`.
- Auth (HTTP): global `AuthGuard` (`APP_GUARD`) + `@Public()` — no hand-maintained
  public-routes allowlist.
- Database: Aurora Postgres (read + write replicas).
- Cache: **ElastiCache Redis** (`ioredis`) — used ONLY for short-lived credentials that must
  expire on their own, today the password-reset codes. Reached at `REDIS_HOST`/`REDIS_PORT`
  from the generated env file; locally that host is Floci's backing container name and the
  port is the CONTAINER's 6379, **not** the host-side proxy port the ElastiCache API reports
  (they differ — see `infra/modules/redis/outputs.tf`). Durable state belongs in Postgres;
  do not reach for Redis as a general datastore.
- ORM: **Prisma v7** with the driver adapter (`@prisma/adapter-pg`) and
  `@prisma/extension-read-replicas`. A single client composes one cross-cutting extension
  (nano-id + audit + soft-delete + computed `isDeleted`) — `shared/db/`.
- Config: `@nestjs/config` validating the **same** Zod schema in `src/config/env.schema.ts`.
- Validation / OpenAPI: Zod schemas + hand-rolled `ZodValidationPipe`; OpenAPI via
  `z.toJSONSchema` (not `zod-to-json-schema`, which returns `{}` for Zod v4) —
  see [[openapi-specs]].
- Imports use Node **subpath imports**: `#shared/*`, `#features/*`, `#config/*`, `#users/*`,
  `#notifications/*` (see `package.json`). `main.ts` uses **relative** imports — 
  `@swc-node/register` does not resolve Node subpath imports on the entrypoint.

## 2. Commands
- Install: `nvm use && corepack enable && pnpm install --frozen-lockfile`
- Dev (watch): `pnpm dev` · Start: `pnpm start`
- Build: `pnpm build`
- Test: `pnpm test` (watch: `pnpm test:watch`)
- Lint: `pnpm lint`
- Run local (docker-watch): `docker compose up users --watch` (from repo root)
- Migrate: `pnpm prisma migrate dev` (via the `prisma` passthrough script). The
  local bootstrap chain applies migrations with `make migrate` (`migrate deploy`).
- **Generate the OpenAPI spec: `nvm use && pnpm generate:openapi`** (writes `openapi.yaml`,
  exits on its own in a few seconds). Needs no env file and no running stack: the generator
  applies placeholder env values and forces `E2E_TESTING_ENABLED` / `STRIPE_ENABLED` on, so
  the gated routes are always in the spec whatever your shell exports.

## 2a. GOLDEN RULE — keep `openapi.yaml` in sync

`services/users/openapi.yaml` is **generated from Zod schemas** via
`src/shared/openapi/generate-openapi.ts` (`z.toJSONSchema` + Nest document builder), and it
is the artifact imported into Apidog. It only stays correct if it is regenerated after the
schemas change.

**Whenever you add/remove an HTTP route, or change any route's schema — its body,
querystring, params, headers, or response — you MUST run
`nvm use && pnpm generate:openapi` and commit the regenerated `openapi.yaml`
together with the code change.** A route change without a matching `openapi.yaml` update is
an incomplete change. Acceptance is a **diff against the committed file** (named `$refs`,
zero orphans), not merely "the generator builds".

- Request/response models should be **named components**, not inline anonymous schemas.
- Verify after regenerating: every route's body/params/response resolves to a named `$ref`,
  and `pnpm build && pnpm lint && pnpm test` pass.

## 2b. GOLDEN RULE — test every endpoint in all three layers

Convention: [../../docs/shared/conventions/testing.md](../../docs/shared/conventions/testing.md) → [[testing]].

**Every Users HTTP endpoint MUST have all three test layers:**
1. **Unit/integration** — Vitest via `Test.createTestingModule()`; dispatch through
   `CommandBus` / `QueryBus`, never `handler.execute()` directly. Mutation-test
   span/`reason`/`app_event` assertions.
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
├── src/
│   ├── main.ts                 — bootstrap (FastifyAdapter, gRPC microservice, pollers)
│   ├── app.module.ts           — composition root (APP_GUARD / APP_FILTER / APP_INTERCEPTOR)
│   ├── config/                 — Zod env schema + AppConfigModule
│   ├── users/                  — UsersModule: commands, queries, http, webhooks, grpc
│   ├── notifications/          — NotificationsModule: commands, queries, http, messaging
│   ├── health/
│   ├── features/               — domain helpers still under the features path where shared
│   ├── shared/{auth,audit,cache,db,grpc,http,logging,messaging,metrics,observability,openapi,prisma,realtime}/
│   └── generated/prisma/
├── prisma/
├── tests/                      — vitest (di-metadata canary, handlers via bus, gRPC gates)
├── .swcrc
└── vitest.config.ts            — unplugin-swc
```

## 4. Conventions (referenced, never duplicated)
- Screaming architecture + DI: [../../docs/shared/patterns/screaming-architecture.md](../../docs/shared/patterns/screaming-architecture.md), [../../docs/shared/patterns/dependency-injection.md](../../docs/shared/patterns/dependency-injection.md)
- CQRS: [../../docs/shared/patterns/cqrs.md](../../docs/shared/patterns/cqrs.md)
- Soft delete only: [../../docs/shared/conventions/soft-delete.md](../../docs/shared/conventions/soft-delete.md)
- Prefixed nano IDs: [../../docs/shared/conventions/nano-id.md](../../docs/shared/conventions/nano-id.md)
- Audit fields: [../../docs/shared/conventions/audit-fields.md](../../docs/shared/conventions/audit-fields.md)
- API versioning: [../../docs/shared/conventions/versioning.md](../../docs/shared/conventions/versioning.md)
- OpenAPI specs (a GENERATED, committed artifact — never hand-written or hand-patched): [../../docs/shared/conventions/openapi-specs.md](../../docs/shared/conventions/openapi-specs.md) → [[openapi-specs]]
- DB naming (snake_case ↔ PascalCase aliases): [../../docs/shared/conventions/db-naming.md](../../docs/shared/conventions/db-naming.md)
- Env validation (Zod): [../../docs/shared/decisions/ADR-0014-env-validation-zod.md](../../docs/shared/decisions/ADR-0014-env-validation-zod.md)
- Logging context & tracing: [../../docs/shared/conventions/logging-context.md](../../docs/shared/conventions/logging-context.md)
- Code comments: [../../docs/shared/conventions/code-comments.md](../../docs/shared/conventions/code-comments.md) → [[code-comments]]

### Logging & tracing in this service
- Per-request context lives in **AsyncLocalStorage** stores (`shared/logging/log-context.ts`
  and `shared/audit/actor-context.ts`), seeded by `RequestContextMiddleware` for every
  request (including ones the guard rejects — a 401 still carries its `request_id`).
  Commands enrich context via `setLogContext` and log through `shared/logging/app-logger.ts`.
- **CONTRACT (audit actor):** Call `next()` from **inside** the `actorContext.run` callback in
  the middleware. A `next()` outside it leaves every later frame without the store and the
  Prisma audit extension writes a null actor. See [[audit-fields]].
- **CONTRACT (no plaintext email):** Never log a plaintext email — auth flows log a masked
  form; everything else uses `email_hash`. Put the masked email on the **log call site**, not
  in the ambient context — context fields stick to every later line.
- **PITFALL:** Prisma promises are lazy. Any `await` must happen **inside** the ALS callback, or
  the context is lost at the await site (see `runAsActor`'s comment and [[2026-07-12-prisma-lazy-promise-als]]).
- The OTel SDK is loaded via `node --import` (Dockerfile CMD + npm scripts), **not** a static
  import from application code. This service is ESM, where static imports are hoisted and
  resolved before any module body runs, so importing it "first" still left instrumented
  libraries already loaded.
- **Workflow spans:** `WorkflowInterceptor` wraps each `@Workflow` handler's `execute` in
  `onApplicationBootstrap`. `@nestjs/cqrs` does **not** run `APP_INTERCEPTOR` on the bus — the
  interceptor **must** be registered as a provider in `app.module.ts` or Nest never
  instantiates it (no spans + `RoutineFailure` unwrapped → 404 becomes 500). See
  [[2026-09-19-test-local-app-interceptor-hides-composition-root-omission]].
- The gRPC server needs a **manual** server span (`shared/observability/grpc-tracing.ts`): the
  x-api-key interceptor's `ServerInterceptingCall` consumes the metadata, so the auto
  instrumentation sees nothing. The caller's W3C context is extracted in that interceptor
  (`extractParentContext`), but **activated in `onReceiveHalfClose`, not `onReceiveMetadata`** —
  the metadata callback returns synchronously, long before grpc-js dispatches the async handler,
  so a `context.with` there unwinds before the handler runs and the server span comes out a ROOT
  (the JE-77 bug: two disjoint traces instead of one). Activate the extracted context in the
  continuation that dispatches the handler. Interceptors go on **`channelOptions`**, not under
  a nested `server:` key Nest silently drops
  ([[2026-09-19-nest-grpc-interceptors-silently-dropped]]).

## 5. Agent rules
- Converse with the user in **Spanish**; write code and comments in **English**.
- `users-impl` writes **only source code** — never runs git or touches Linear.
- Leave finished work in the working tree for the **main session** to commit
  (`github-ops` is an optional helper for complex git batches — see [[git-workflow]]).
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Service spec (vault): [../../docs/domains/users/specs/users-service-design.md](../../docs/domains/users/specs/users-service-design.md)
- Migration: [../../docs/superpowers/specs/2026-09-19-users-nestjs-migration-design.md](../../docs/superpowers/specs/2026-09-19-users-nestjs-migration-design.md)
- Endpoints (all `/v1`-prefixed — Nest controllers under `src/users/http/`,
  `src/notifications/http/`, `openapi.yaml`):
  - `[GET] /v1/health` (`@Public()`)
  - `[POST] /v1/users/register` → 201 · 409 `email_exists`
  - `[POST] /v1/users/login` → 200 · 401 `invalid_credentials`
  - `[POST] /v1/users/refresh` → 200 · 401 (Cognito `REFRESH_TOKEN_AUTH`)
  - `[GET|PATCH] /v1/users/me` → 200 · 404 (identity from the `x-user-id` header,
    resolved by `findByIdOrCognitoSub` — accepts the `usr_` id OR the Cognito sub).
    `GET` also returns `mustChangePassword`, the flag the frontend reads to force
    the set-new-password step (see the password-reset group below).
  - `[POST] /v1/users/register/passwordless` → 201; `[POST] /v1/users/otp/start`,
    `[POST] /v1/users/otp/verify` — the passwordless email-OTP login pair, over
    Cognito `CUSTOM_AUTH` (never native `USER_AUTH`/`EMAIL_OTP`, which Floci
    accepts and then silently skips the challenge). The code is emailed by the
    events-pipeline, not by Cognito: the challenge Lambda publishes
    `AUTH_OTP_REQUESTED` to SQS.
  - `[POST] /v1/users/password/forgot` → 202 (ALWAYS 202, whether or not the email
    exists — answering differently would be a user-enumeration oracle);
    `[POST] /v1/users/password/confirm` → 200 · 401 `invalid_reset_code`;
    `[PATCH] /v1/users/me/password` → 200 · 401. The last one sets a password and
    NOTHING else — it must never grow into a general profile update.
    - **The reset is ours, not Cognito's**, and that is not a preference: Cognito's
      `ForgotPassword` never returns the code to the caller, its `CustomMessage`
      trigger is never invoked on Floci (measured: 0 invocations against 1 from a
      control), and only Cognito's own code passes `ConfirmForgotPassword`. So
      Users mints the code, the events-pipeline emails it
      (`PASSWORD_RESET_REQUESTED`), and the change is applied with
      `AdminSetUserPassword`.
    - **Codes live in Redis, never Postgres** (`shared/cache/reset-code-store.ts`):
      key `password-reset:<emailHash>`, value = SHA-256 of the code, `SET … EX 600`
      so it expires natively with no sweeper job, `DEL` on success so it is
      single-use. `mustChangePassword` DOES live in Postgres — it is a durable
      attribute, not an ephemeral credential.
  - `[POST] /v1/webhooks/cognito` (shared-secret guarded identity capture, `@Public()`)
  - Payment methods and `[POST] /v1/users/stripe/webhook/:token` — only when
    `STRIPE_ENABLED`; see §7.
  - `[DELETE] /v1/users/e2e-cleanup`, `[GET] /v1/users/e2e-identity` — only when
    `E2E_TESTING_ENABLED`
  - gRPC: `GetUserById` — **live** on `:50051` (`GRPC_PORT`), via `@nestjs/microservices`,
    guarded by a constant-time `x-api-key` interceptor on **`channelOptions`**. Resolves by
    `usr_` id OR Cognito sub; returns `NOT_FOUND` when the user does not exist.
- Error contract: typed auth errors (`shared/auth/auth-errors.ts`) mapped by
  `DomainExceptionFilter` (`APP_FILTER`).
- `USER_CREATED` is published to the shared SQS events queue by
  `shared/messaging/event-publisher.ts` (`SqsEventPublisher`, `EVENTS_QUEUE_URL`), consumed by
  the events-pipeline Lambda. `NoopEventPublisher` is still there, but only as the binding for
  tests and any environment that must not emit — not the production path.
  - The publish is deliberately **best-effort**: a failure is logged with
    `app_event=user_created_publish_failed` and swallowed, never rethrown. The user and the
    Cognito account already exist by then, so failing the request would report an error for a
    registration that actually succeeded.
  - The envelope carries an `author` block — `{ actor: AuditActor.Register, user_id, cognito_sub }`
    — recording WHO originated the event, as distinct from the root `user_id`, which is who it is
    ABOUT (the same person here; not on every event). See [[audit-fields]].

## 7. Stripe payments
Design: [[2026-09-19-stripe-payments-design]] (read it for the flows; this is the map).

- **Env** (`src/config/env.schema.ts`) — a blank value (`""` or whitespace) counts as unset:
  - `STRIPE_ENABLED` (default `false`) mounts `PaymentMethodsModule` at import time.
  - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_URL_TOKEN` — optional. Flag on
    with one missing is a valid boot state; the routes that need it answer **503**.
  - `STRIPE_WEBHOOK_ALLOWED_CIDRS` — comma-separated IPv4/IPv6 addresses or CIDRs. Unset →
    the webhook answers 503 (never allow-all); **malformed → the process fails at boot**.
  - `STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS` (default `0`) — `X-Forwarded-For` hops to trust.
- **Routes** (`src/payment-methods/http/`): `[GET|POST] /v1/users/me/payment-methods`,
  `[POST] …/payment-methods/setup-intent`, `[DELETE] …/payment-methods/{id}`,
  `[PUT] …/payment-methods/{id}/default`.
- **Webhook** `[POST] /v1/users/stripe/webhook/:token` — checks run **IP → token → signature**.
  IP and token live in a Fastify `onRequest` hook, `src/payment-methods/webhooks/stripe-webhook-gate.ts`
  (403 `forbidden_source`; a wrong token answers Nest's plain 404 and logs nothing); the
  signature is verified in the controller (400 `invalid_signature`).
  - **WARNING:** Do NOT move the gate into a Nest middleware. Fastify also routes encoded
    paths (`/v1/users/%73tripe/webhook/x`) and an empty token to the handler, and a
    middleware's path match skips both.
- **Token redaction** (`src/shared/observability/redact-webhook-token.ts`) — applied in the
  logger's `req` serializer (`shared/logging/logger.ts`) and in the tracing hooks
  (`shared/observability/tracing.ts`: http `startIncomingSpanHook`, Fastify `requestHook`).
  A new place that records the URL must redact it too.
- **gRPC:** `GetUserById`'s `UserResponse` carries `stripe_customer_id` (`""` when none).
- **E2E cleanup** also deletes the Stripe customers of the `E2E Source`-tagged users it
  soft-deletes (a missing customer is skipped; one failure never stops the rest).
- **CONTRACT:** Never surface Stripe's error text — not in a response, a log line, or a
  `reason`. Map errors to fixed codes: its auth errors embed a masked API key, and its
  request errors can embed other customers' ids.
