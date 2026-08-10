---
title: Users Service Design
type: spec
area: users
status: active
created: 2026-06-26
updated: 2026-08-09
tags: [type/spec, area/users, status/active]
related:
  - "[[soft-delete]]"
  - "[[nano-id]]"
  - "[[audit-fields]]"
  - "[[db-naming]]"
  - "[[cqrs]]"
  - "[[versioning]]"
  - "[[dependency-injection]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[ADR-0017-floci-local]]"
  - "[[cognito-pre-token-lambda]]"
  - "[[logging-context]]"
  - "[[env-files]]"
  - "[[testing]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[auth-error-mapping]]"
  - "[[authenticated-identity-resolution]]"
  - "[[app-user-id-token-claim]]"
  - "[[refresh-token-endpoint]]"
  - "[[cognito-identity-webhook]]"
  - "[[openapi-autogen]]"
  - "[[2026-06-28-users-service-design]]"
  - "[[2026-07-09-users-cognito-webhook-design]]"
  - "[[2026-07-10-users-openapi-autogen-design]]"
  - "[[2026-07-11-auth-error-mapping-design]]"
  - "[[2026-07-11-refresh-token-endpoint-design]]"
  - "[[2026-07-11-authenticated-identity-resolution-design]]"
  - "[[2026-07-12-app-user-id-token-claim-design]]"
  - "[[2026-07-12-audit-actor-enum-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[2026-08-05-passwordless-otp-auth-design]]"
  - "[[2026-08-05-passwordless-otp-auth]]"
  - "[[passwordless-auth-type]]"
  - "[[cognito-custom-auth-triggers]]"
  - "[[ADR-0020-self-owned-password-reset]]"
  - "[[self-owned-password-reset-codes-in-redis]]"
  - "[[password-policy-checklist-gap]]"
  - "[[redis-elasticache-replication-group-floci]]"
---

# Users Service Design

## Summary

The Users service is responsible for user registration, authentication, and profile management.
It integrates with AWS Cognito for auth and resolves identity via a Cognito `sub`-or-`usr_`-id
lookup. ORM: Prisma. It publishes `USER_CREATED` to SQS on every successful registration — see
[Events](#events) below.

## Stack & Data Store

| Concern | Choice |
|---|---|
| Framework | Fastify (+ `@fastify/awilix` for DI, `@fastify/swagger` + `fastify-type-provider-zod` for the OpenAPI spec) |
| Database | Aurora PostgreSQL |
| Replicas | 1 write replica, 1 read replica, composed via `@prisma/extension-read-replicas` on a **single** Prisma client (see [[ADR-0006-read-write-replicas]] and [[dependency-injection]]) |
| ORM | Prisma |
| Auth | AWS Cognito (see [[ADR-0010-cognito-auth]]) |

## API / Endpoints

All routes are versioned under `/v1` (see [[versioning]]). Source of truth: `services/users/src/features/users/http/routes.ts`, published contract: `services/users/openapi.yaml` (see [OpenAPI autogen](#openapi-autogen) below).

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/health` | Liveness/readiness probe. Returns `{ "status": "ok" }`. No auth required. |
| `POST` | `/v1/users/register` | Creates a user in Cognito and the DB. Reserves the `usr_` id before Cognito `signUp` (see [`custom:app_user_id`](#customapp_user_id-token-claim)). |
| `POST` | `/v1/users/login` | Authenticates via Cognito; returns tokens. |
| `POST` | `/v1/users/refresh` | Exchanges a Cognito refresh token for new id/access tokens (`REFRESH_TOKEN_AUTH`). See [[2026-07-11-refresh-token-endpoint-design]]. |
| `POST` | `/v1/users/otp/start` | Starts a passwordless OTP challenge for the given email; returns `{ session }`. Works for both auth types — the second login path for a `PASSWORD` user and the only path for a `PASSWORDLESS` user. Public route, no JWT authorizer. See [Passwordless OTP authentication](#passwordless-otp-authentication) below. |
| `POST` | `/v1/users/otp/verify` | Verifies `{ email, session, code }` against the Cognito `CUSTOM_AUTH` challenge; returns the same `AuthTokens` shape as `POST /v1/users/login`. Public route. |
| `POST` | `/v1/users/register/passwordless` | Creates a `PASSWORDLESS` user: a `User` row with `authType=PASSWORDLESS` plus a backing Cognito user whose password is a random 32-byte value never revealed to the caller. Public route. |
| `POST` | `/v1/users/password/forgot` | Mints a self-owned reset code, stores its hash in Redis, publishes `PASSWORD_RESET_REQUESTED`. Always `202` with the same body, whether or not the email exists. Public route. See [Password reset](#password-reset) below. |
| `POST` | `/v1/users/password/confirm` | Verifies `{ email, code, newPassword }` against the Redis-stored code and, on success, applies the new password via `AdminSetUserPassword`. Public route. `401 invalid_reset_code` on any failure (unknown email, wrong code, expired code — indistinguishable). |
| `GET` | `/v1/users/me` | Returns the authenticated user's profile, resolved via `findByIdOrCognitoSub`, including `mustChangePassword`. |
| `PATCH` | `/v1/users/me` | Updates the authenticated user's profile. |
| `PATCH` | `/v1/users/me/password` | Sets a new password for the authenticated caller (no code) via `AdminSetUserPassword`; clears `mustChangePassword`. A dedicated command, not part of the general profile update — see [Password reset](#password-reset). |
| `POST` | `/v1/webhooks/cognito` | Cognito PostConfirmation trigger webhook; shared-secret guarded (`x-webhook-secret`), no JWT authorizer. See [Cognito identity capture](#cognito-identity-capture). |
| `DELETE` | `/v1/users/e2e-cleanup` | **[E2E only]** Soft-deletes E2E-sourced users. Gated on `E2E_TESTING_ENABLED`. |
| `GET` | `/v1/users/e2e-identity` | **[E2E only]** Reads captured Cognito identity rows by email, for E2E assertions. Gated on `E2E_TESTING_ENABLED`. |

Authentication on `GET /v1/users/me` and `PATCH /v1/users/me` is enforced via API Gateway + Cognito (see [[ADR-0009-apigw-alb-fargate]] and [[ADR-0010-cognito-auth]]); locally the identity header is injected by nginx+njs, not by API Gateway claim mapping (see [[ADR-0017-floci-local]]).

## Error contract

A global `app.setErrorHandler` in `routes.ts` maps typed auth-domain errors (`services/users/src/shared/auth/auth-errors.ts`, all extending `AuthError`) to their HTTP status and a stable `error` code in the body — everything else (Zod validation 400s, unexpected 500s) keeps Fastify's default handling:

| Error | Route | Status | `error` code |
|---|---|---|---|
| `EmailAlreadyExistsError` | `POST /v1/users/register`, `POST /v1/users/register/passwordless` | `409` | `email_exists` |
| `InvalidCredentialsError` | `POST /v1/users/login`, `POST /v1/users/refresh` | `401` | `invalid_credentials` |
| `InvalidOtpError` | `POST /v1/users/otp/verify` | `401` | `invalid_otp` |
| `InvalidResetCodeError` | `POST /v1/users/password/confirm` | `401` | `invalid_reset_code` — deliberately identical for an unknown email, a wrong code, and an expired code; see [Password reset](#password-reset). |
| Not found (no error class — inline `404`) | `GET /v1/users/me`, `PATCH /v1/users/me`, `PATCH /v1/users/me/password` | `404` | `not_found` |

`POST /v1/users/login` also returns `401 invalid_credentials` — the same generic code as a wrong
password — when the looked-up user has `authType=PASSWORDLESS`. This is a deliberate reuse of the
existing error, not a new one; see [Passwordless OTP authentication](#passwordless-otp-authentication)
and [[passwordless-auth-type]] for why a distinct code was rejected.

The Cognito webhook route (`POST /v1/webhooks/cognito`) has its own inline responses instead of `AuthError`: `401 unauthorized` (bad/missing shared secret), `422 invalid_payload` (schema validation), `500 no_matching_user` (a confirmed Cognito identity with no matching `users` row — see [Cognito identity capture](#cognito-identity-capture)).

See [[2026-07-11-auth-error-mapping-design]] for the design rationale.

## Data Model

Tables (all columns in `snake_case`; mapped to `camelCase`/`PascalCase` in the application layer via [[db-naming]]). Source of truth: `services/users/prisma/schema.prisma`.

### `users`

| Column | Type | Notes |
|---|---|---|
| `id` | `varchar` | Prefixed nano ID, e.g. `usr_…` (see [[nano-id]]) |
| `email` | `varchar` | Unique, not null |
| `cognito_sub` | `varchar` | Nullable, **unique**. The Cognito subject, captured from the identity webhook/in-process capture. |
| `full_name` | `varchar` | Maps to `fullName` |
| `address` | `jsonb` | Structured address object, nullable |
| `phone_number` | `varchar` | Nullable |
| `tags` | `text[]` | Array of labels; default `[]`. `E2E Source` marks records created by the Playwright E2E suite (see [[2026-06-28-users-service-design]]). |
| `auth_type` | `enum` (`AuthType`: `PASSWORD` \| `PASSWORDLESS`) | Default `PASSWORD`. Exposed **read-only** in the API response (`UserSchema.authType`) — never a writable field on register/update. See [[passwordless-auth-type]]. |
| `must_change_password` | `boolean` | Default `false`. Maps to `mustChangePassword`, read-only in the API. A durable user attribute (not an ephemeral credential, unlike the reset codes — see [[self-owned-password-reset-codes-in-redis]]), cleared by `PATCH /v1/users/me/password` or `POST /v1/users/password/confirm`. Migration `20260810032046_add_must_change_password`. |
| `created_by` / `created_at` | `varchar` / `timestamptz` | |
| `updated_by` / `updated_at` | `varchar` / `timestamptz` | |
| `deleted_by` / `deleted_at` | `varchar` / `timestamptz` | Null = active; set = soft-deleted |

`isDeleted` is a computed property based on `deleted_at` (see [[audit-fields]] and [[soft-delete]]). Indexed on `deletedAt` (`@@index([deletedAt])`).

### `users_cognito_data` — 1:1 identity snapshot

Upserted on every accepted Cognito webhook event (`cognitoSub` unique). Columns: `id` (`ucd_` prefix), `user_id` (unique FK → `users.id`), `cognito_sub` (unique), `email`, `client_id`, `last_event_type`, `raw_payload` (`jsonb`), plus the standard audit fields and `@@index([deletedAt])`.

### `users_cognito_events` — event log

One row per accepted trigger delivery. Columns: `id` (`cge_` prefix), `cognito_sub` (FK → `users_cognito_data.cognitoSub`), `event_type`, `message_id` (**unique**, derived as `sha256(sub + ":" + triggerSource)` — see [[2026-07-09-users-cognito-webhook-design]]), `raw_payload` (`jsonb`), plus the standard audit fields and `@@index([deletedAt])`. The unique `message_id` is what makes webhook delivery idempotent: a `P2002` conflict on it is treated as a routine duplicate, not an error.

> [!note] No Hard Deletes
> The DB user is forbidden from running `DELETE`. All removals go through soft delete only.

## Identity resolution

Identity arrives as the `x-user-id` header — set by the API Gateway authorizer in production, and by the local nginx+njs reverse proxy in dev (decoding the JWT; see [[ADR-0017-floci-local]] and [[ADR-0016-local-apigw-nginx-ecs]]). The header carries the Cognito `sub`.

The Prisma model method **`findByIdOrCognitoSub`** (`services/users/src/shared/db/prisma-extensions.ts`, registered under `model: { user: {...} } }` on the cross-cutting extension) resolves a user by **either** their `usr_` id or their Cognito `sub`, via `findFirst({ where: { OR: [{ id }, { cognitoSub }] } })`. It is used by `GET /v1/users/me`, `PATCH /v1/users/me`, and the internal `getMe`/`updateProfile` use-cases. See [[2026-07-11-authenticated-identity-resolution-design]] for the full design.

## `custom:app_user_id` token claim

`POST /v1/users/register` reserves the `usr_` id **before** calling Cognito `signUp`, passing it through as `appUserId`. This lands in a custom Cognito user-pool attribute, `custom:app_user_id`, at sign-up time — before the corresponding Postgres row exists. The same id is then used as the row's own `id`.

A **Pre-Token-Generation V2 Lambda** (the repo's first Lambda, `infra/modules/cognito/pre-token-lambda/`) copies `custom:app_user_id` into an `app_user_id` claim on both the id and access tokens. It is wired via the [[awscli-fallback-for-floci]] pattern (the pinned AWS provider has no `pre_token_generation_config` block). `app_user_id` is an additive, read-only convenience claim — it does not change identity resolution, which still goes through `x-user-id` / `cognitoSub`.

See [[cognito-pre-token-lambda]] (infra spec) and [[2026-07-12-app-user-id-token-claim-design]] (design) for the full mechanics.

## Cognito identity capture

`POST /v1/webhooks/cognito` is a **public** route (no JWT authorizer) guarded only by a shared secret (`x-webhook-secret`, verified against `env.WEBHOOK_SECRET`). It validates the payload against `cognitoWebhookPayloadSchema` (manual `safeParse`, not Fastify's `schema.body`, so an invalid payload returns `422` rather than Fastify's default `400`) and delegates to `CaptureCognitoIdentityCommand` — the single persistence path for identity capture, writing `users_cognito_data` + `users_cognito_events` in one nested/transactional Prisma write.

Because Floci never invokes Cognito Lambda triggers for PostConfirmation locally (see [[ADR-0017-floci-local]]), `register.ts` calls `CaptureCognitoIdentityCommand` **in-process** whenever `NODE_ENV !== "production"`, synthesizing the same event shape the production webhook receives. In production, the Lambda shim owns this call. The derived `message_id` (see [`users_cognito_events`](#users_cognito_events--event-log)) makes a double capture harmless. Identity capture is best-effort and never a precondition for registration: a failure is logged, not propagated.

See [[2026-07-09-users-cognito-webhook-design]] for the full design.

## Passwordless OTP authentication

> [!info] Implemented and verified live (2026-08-05)
> `CUSTOM_AUTH` in **both** local and production — never native `USER_AUTH`/`EMAIL_OTP`, which
> Floci silently accepts and returns tokens for with **no challenge issued at all**. Test
> counts: 254 unit (Users), 180 (events-pipeline), 11 (Lambda), 80 E2E, all green.

`POST /v1/users/otp/start`, `POST /v1/users/otp/verify`, and `POST
/v1/users/register/passwordless` add one-time-code-by-email authentication as a second login
path alongside password login, and as the only path for `PASSWORDLESS` users. All three routes
are public (listed in `public-routes.ts` and in `openapi.yaml`, no JWT authorizer).

`AuthProvider` gained two methods, implemented in `CognitoAuthProvider`:

- `startOtpChallenge(email)` — `AdminInitiateAuthCommand` with `AuthFlow: "CUSTOM_AUTH"`.
- `respondToOtpChallenge(email, session, code)` — `RespondToAuthChallengeCommand` with
  `ChallengeName: "CUSTOM_CHALLENGE"`.

`otp/verify` returns the same `AuthTokens` shape `POST /v1/users/login` returns, so the gateway,
JWT authorizer, and `app_user_id` claim handling (see [`custom:app_user_id`](#customapp_user_id-token-claim))
need no change — an OTP-issued token is indistinguishable downstream from a password-issued one.

The three Cognito Lambda triggers (`DefineAuthChallenge`, `CreateAuthChallenge`,
`VerifyAuthChallengeResponse`) that drive the challenge, the 6-digit code, its 300s TTL, and the
`AUTH_OTP_REQUESTED` event that emails it are infra-side — see
[[cognito-custom-auth-triggers]] and [[events-pipeline-design]].

### Login guard — 401, not 403, for a `PASSWORDLESS` user

`LoginUserCommand` now injects `db` and looks the user up by email **before** any Cognito call.
A `PASSWORDLESS` user is rejected with the same generic `401 invalid_credentials` login already
returns for a wrong password — deliberately **not** a distinct `403` — because
[[auth-error-mapping]]'s anti-enumeration rule requires login failures to stay
indistinguishable from the response alone. The real cause is logged only as `reason:
"passwordless_user"` on the existing `login_failed` app_event, never in the HTTP status or body.
Passwordless users get a random 32-byte password that is never revealed, so this service-side
check is what makes the guarantee structural rather than cosmetic. Full rationale:
[[passwordless-auth-type]].

Full design and the Floci feasibility evidence that ruled out native `EMAIL_OTP`:
[[2026-08-05-passwordless-otp-auth-design]] and [[2026-08-05-passwordless-otp-auth]].

## Password reset

> [!info] Implemented and verified end to end through the gateway (2026-08-09)

Three endpoints and one profile flag implement a **self-owned** password reset — Cognito's own
`ForgotPassword`/`ConfirmForgotPassword` is not used anywhere in this flow. See
[[ADR-0020-self-owned-password-reset]] for the full decision and the measured evidence that ruled
Cognito's native flow out (it never returns its code to the caller, its `CustomMessage` trigger
never fires on Floci, and it accepts only its own code at confirmation).

- `POST /v1/users/password/forgot` mints a 6-digit code (`generateResetCode`,
  `shared/auth/reset-code.ts`), stores its SHA-256 hash in Redis with a 10-minute native TTL
  (`ResetCodeStore.store`), and publishes `PASSWORD_RESET_REQUESTED` for the events pipeline to
  email (see [[events-pipeline-design#Email]] and [[email-templates]] for the `forgot-password`
  template). **Always answers `202` with the same body**, whether or not the email belongs to an
  account — a deliberate anti-enumeration property, not a missing `404` case.
- `POST /v1/users/password/confirm` verifies `{ email, code, newPassword }` against the Redis
  store (`ResetCodeStore.verifyAndConsume` — atomic verify-and-delete, so a code cannot be
  replayed) and, on success, applies the password with `AdminSetUserPassword` and clears
  `mustChangePassword`. Every rejection — unknown email, wrong code, expired code — returns the
  identical `401 invalid_reset_code`, preserving the same anti-enumeration property.
- `PATCH /v1/users/me/password` lets an already-authenticated caller set a new password directly
  (no code involved), via `ChangePasswordCommand` — a **dedicated** command, deliberately not
  folded into the general profile-update command, so a request meant to change a phone number can
  never silently rewrite a credential. Clears `mustChangePassword`.
- `GET /v1/users/me` exposes `mustChangePassword: boolean` (read-only), a **durable Postgres
  column** — unlike the reset codes, which live in Redis and expire on their own. The frontend
  reads this flag to force the user through the change-password screen before letting them
  continue. See [[self-owned-password-reset-codes-in-redis]] for why the code and the flag live
  in different stores.

Full storage design (why Redis, key namespacing by `email_hash`, the verify-before-Cognito
ordering, the best-effort publish that protects the anti-enumeration property against a queue
outage): [[self-owned-password-reset-codes-in-redis]]. Infra for the Redis instance itself,
including two Floci-only port/hostname traps: [[redis-elasticache-replication-group-floci]] and
[[floci-elasticache-two-ports-and-provider-panic]].

> [!warning] Open gap — the web-app checklist is stricter than the enforced policy
> The forced set-new-password screens (`assets/web-app/web-app.pen`) render a password checklist
> (10 chars, mixed case, number, symbol) that the Cognito pool does not actually enforce
> (`minimum_length = 8`, all `require_*` flags `false`) — and the Zod schemas on both
> `newPassword` fields mirror the pool deliberately, to avoid two independently-drifting rules.
> This is a recorded, **not yet resolved** product decision — see
> [[password-policy-checklist-gap]] for the mismatch table and the recommendation.

## Events

`services/users/src/shared/messaging/event-publisher.ts` implements `SqsEventPublisher`, which
sends the envelope via `SendMessageCommand`. `register.ts` calls
`this.events.publishUserCreated(...)` after the user and Cognito account are created.
`NoopEventPublisher` still exists in the same file, but only as the binding used by tests and
any environment that must not emit — it is not the production path.

| Event | Trigger | Queue |
|---|---|---|
| `USER_CREATED` | `POST /v1/users/register` success | SQS, real publish via `SqsEventPublisher` |
| `PASSWORD_RESET_REQUESTED` | `POST /v1/users/password/forgot`, for a known email only | SQS, real publish via `SqsEventPublisher`, best-effort inside `ForgotPasswordCommand` — see [Password reset](#password-reset) |

The `USER_CREATED` envelope carries `event_id` (generated in the publisher, the pipeline's
idempotency key), `type`, `source`, `user_id`, `order_id: null`, an `author` object (`{ actor:
AuditActor.Register, user_id, cognito_sub? }` — the same semantic actor already stamped into
`createdBy`/`updatedBy` for this write, distinguishing WHO originated the event from `user_id`,
which is its subject), and `payload: { email, fullName }`. A publish failure is logged
(`user_created_publish_failed`) and swallowed, never rethrown: the user row and Cognito account
already exist by the time publishing runs, so failing the request would return an error for a
registration that actually succeeded. See [[events-pipeline-design]] for the consumer side and the
full envelope contract.

`PASSWORD_RESET_REQUESTED`'s payload is `{ email, fullName, code, ttlSeconds }` — the same shape
as `AUTH_OTP_REQUESTED`'s, deliberately, since both carry the same four facts (see
[[events-pipeline-design#Dispatch]] for why they are still two separate event types rather than
one parameterized type). Its `code` is redacted before the event document reaches DocumentDB (see
[[events-pipeline-design#Payload redaction — the one exception to "persist verbatim"]]) — it is
`ForgotPasswordCommand`'s own `try/catch` around the publish call, not the publisher's generic
swallow-and-log, that keeps a publish failure from ever surfacing as a `500` for a known email
(see [[ADR-0020-self-owned-password-reset#Two security properties this flow is built around (load-bearing, tested)]]).

## OpenAPI autogen

`services/users/openapi.yaml` is **generated**, not hand-maintained: it is built from the Fastify route Zod schemas (`http/schemas.ts`) via `@fastify/swagger` + `fastify-type-provider-zod`, running `pnpm generate:openapi`. It is the artifact imported into Apidog (see `docs/infrastructure/runbooks/mcp-servers.md`). Any route or schema change requires regenerating and committing `openapi.yaml` in the same change. See [[2026-07-10-users-openapi-autogen-design]] for the generator design (including orphan-component pruning for the `*Input` schema variants).

## gRPC Methods

| Method | Request | Response |
|---|---|---|
| `GetUserById` | `{ id: string }` | `User` object, including `address` (typed `Address` message — see below) |

Used by Orders and Tracking services for inter-service lookups (see [[ADR-0003-grpc-inter-service]]).

## Change impact — editing `proto/users.proto`

`proto/users.proto` is **owned by Users** and consumed by three other components, each by a
**different mechanism** — which is why a proto edit propagates in three different ways, not one:

| Consumer | File | Mechanism |
|---|---|---|
| Users | `services/users/src/shared/grpc/server.ts` | Loads the proto at **runtime** via `@grpc/proto-loader` — no regeneration step |
| Orders | `services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj` | Compiles the proto at **build time** |
| Tracking | `services/tracking/src/shared/grpc/generated/users_pb2.py` | **Committed generated stubs** — must be regenerated with `services/tracking/scripts/generate_grpc_stubs.py` |
| events-pipeline | `functions/events-pipeline/src/handlers/order-created.ts` | Calls the Users gRPC surface |

> [!warning] The Tracking case is the one that bites
> `services/tracking/tests/test_grpc_stubs.py` re-runs codegen into a temp directory and compares
> it byte for byte with what is checked in, specifically because a runtime-loaded proto (Users) and
> a build-time-compiled one (Orders) both fail loudly and immediately when they drift, while
> committed generated stubs (Tracking) do not — nothing forces a regeneration. In the test's own
> words: *"`users.proto` is OWNED BY USERS and consumed by both Orders and Tracking, which is what
> makes this guard matter more than usual here: the contract can change in a service that has no
> way to know these stubs exist."* Edit the proto without regenerating Tracking's stubs and this
> test fails CI — the fix is exactly the command the test's own docstring prints:
> `services/tracking/.venv/bin/python services/tracking/scripts/generate_grpc_stubs.py`.

### `address` on `GetUserById` — typed message, not raw JSON

`GetUserById`'s response gains an `address` field so the delivery address can flow to Orders and,
from there, to Tracking (see [[orders-service-design]] and [[tracking-service-design]] for the rest
of the chain). Users already stores the address — `address Json?` on the `User` model
(`services/users/prisma/schema.prisma`, `address JSONB` since the `20260629051541_init` migration)
— and already exposes it over REST (`RegisterInputSchema`, `UpdateProfileInputSchema`, `UserSchema`
in `services/users/src/features/users/http/schemas.ts`, typed `z.unknown()` there). It was simply
never on the gRPC contract: today's `UserResponse` in `proto/users.proto` has only `id`, `email`,
`full_name`, `cognito_sub`.

The proto gains a dedicated `Address` message rather than a raw JSON string or
`google.protobuf.Struct`:

```proto
message Address {
  string line1 = 1;
  string line2 = 2;
  string city = 3;
  string state = 4;
  string country = 5;
  string postal_code = 6;
}
```

A typed message gives a real, validated contract that both consumers — Orders (.NET) and Tracking
(Python) — can consume ergonomically, instead of each having to parse an opaque blob. Users maps
its stored JSON onto these fields at read time; the de-facto shape seen in practice today is
`{ line1, city, country }` (from `e2e/support/chance-factory.ts`), even though the underlying
column is schema-free `Json?`.

> [!warning] proto3 scalars have no null
> Any address key absent from the stored JSON (e.g. `line2`, `state`, `postal_code` in the current
> de-facto shape) comes through as an **empty string**, not `null` — proto3 scalar fields have no
> null representation. Consumers must treat `""` as "not provided," not fail validation on it.

> [!warning] `GetUserById` now returns personal data, not just identity
> Adding `address` means this RPC's response carries PII, not only an identity lookup. The
> existing `x-api-key` interceptor on the Users gRPC surface
> (`services/users/src/shared/grpc/api-key-interceptor.ts`) is what guards this — no unauthenticated
> caller can reach it. Implementers must also **never log the address** while wiring or debugging
> this, the same way plaintext email is never logged — see [[logging-context]] (full request bodies
> and plaintext PII are forbidden in log lines).

## Cross-cutting rules

| Rule | Reference |
|---|---|
| Soft delete only | [[soft-delete]] |
| Prefixed nano IDs | [[nano-id]] |
| Audit fields on every table (semantic `AuditActor`) | [[audit-fields]], [[2026-07-12-audit-actor-enum-design]] |
| snake_case DB ↔ PascalCase app | [[db-naming]] |
| CQRS pattern | [[cqrs]] |
| API versioning | [[versioning]] |
| Dependency injection (Awilix) | [[dependency-injection]] |
| Authentication & authorization | [[ADR-0010-cognito-auth]] |
| Local identity header injection | [[ADR-0017-floci-local]] |
| Structured logging context (trace/actor fields, no raw email) | [[logging-context]] |
| Env files generated, never hand-edited | [[env-files]] |
| Three-layer testing (unit/integration, internal E2E, gateway E2E) | [[testing]] |
| Distributed tracing backend | [[ADR-0019-distributed-tracing-opentelemetry]] |
| Self-owned password reset (never Cognito's `ForgotPassword`) | [[ADR-0020-self-owned-password-reset]] |

## Observability

The service participates in the repo-wide observability conventions, not a Users-specific
scheme: structured logs carry the shared cross-service context (`trace_id`, `cognito_sub`,
`user_id`, `email_hash`, `duration_ms`) per [[logging-context]] — auth flows log a masked
email, never a plaintext one — and traces export to the backend decided in
[[ADR-0019-distributed-tracing-opentelemetry]] (Jaeger), configured entirely through
environment variables, not code.

## Service-local decisions

Decisions made specifically for this service (not cross-cutting, so they are not
convention/pattern notes in `shared/`) live in `docs/domains/users/decisions/`:

| Decision | Note |
|---|---|
| Login/register error mapping (401/409 via typed domain errors + global `setErrorHandler`) | [[auth-error-mapping]] |
| Authenticated identity resolution (`findByIdOrCognitoSub`) | [[authenticated-identity-resolution]] |
| `app_user_id` token claim via Pre-Token-Generation Lambda | [[app-user-id-token-claim]] |
| Refresh token endpoint (`POST /v1/users/refresh`) | [[refresh-token-endpoint]] |
| Cognito identity webhook (shared capture use case, two entry paths) | [[cognito-identity-webhook]] |
| OpenAPI spec generated from routes (`@fastify/swagger` + Zod) | [[openapi-autogen]] |
| Passwordless OTP auth: `AuthType` enum, service-side login guard, 401-not-403 | [[passwordless-auth-type]] |
| Password reset codes in Redis, not Postgres; `mustChangePassword` stays in Postgres | [[self-owned-password-reset-codes-in-redis]] |
| Open gap: web-app password checklist stricter than the enforced Cognito policy | [[password-policy-checklist-gap]] |

## Related

- [[soft-delete]]
- [[nano-id]]
- [[audit-fields]]
- [[db-naming]]
- [[cqrs]]
- [[versioning]]
- [[dependency-injection]]
- [[ADR-0010-cognito-auth]]
- [[ADR-0003-grpc-inter-service]]
- [[ADR-0006-read-write-replicas]]
- [[ADR-0009-apigw-alb-fargate]]
- [[ADR-0016-local-apigw-nginx-ecs]]
- [[ADR-0017-floci-local]]
- [[cognito-pre-token-lambda]]
- [[awscli-fallback-for-floci]]
- [[logging-context]]
- [[env-files]]
- [[testing]]
- [[ADR-0019-distributed-tracing-opentelemetry]]
- [[auth-error-mapping]]
- [[authenticated-identity-resolution]]
- [[app-user-id-token-claim]]
- [[refresh-token-endpoint]]
- [[cognito-identity-webhook]]
- [[openapi-autogen]]
- [[2026-06-28-users-service-design]]
- [[2026-07-09-users-cognito-webhook-design]]
- [[2026-07-10-users-openapi-autogen-design]]
- [[2026-07-11-auth-error-mapping-design]]
- [[2026-07-11-refresh-token-endpoint-design]]
- [[2026-07-11-authenticated-identity-resolution-design]]
- [[2026-07-12-app-user-id-token-claim-design]]
- [[2026-07-12-audit-actor-enum-design]]
- [[orders-service-design]] — `GetUserById`'s `address` is what Orders resolves and snapshots on
  order creation.
- [[tracking-service-design]] — the address snapshot's final stop, forwarded by Orders via an
  HTTP call to Tracking's `POST /v1/trackings/init-tracking`.
- [[events-pipeline-design]] — the consumer of `USER_CREATED`, the shared envelope contract, and
  the `author` object's role in the pipeline's `created_by`/`updated_by` audit split; also the
  consumer of `AUTH_OTP_REQUESTED` for passwordless OTP email delivery and
  `PASSWORD_RESET_REQUESTED` for the reset flow.
- [[2026-08-05-passwordless-otp-auth-design]] — the passwordless OTP design spec, including the
  Floci feasibility evidence for `CUSTOM_AUTH` over native `EMAIL_OTP`.
- [[2026-08-05-passwordless-otp-auth]] — the implementation plan that shipped it.
- [[passwordless-auth-type]] — the `AuthType` enum, service-side login guard, and 401-not-403
  decision.
- [[cognito-custom-auth-triggers]] — the infra side: the OTP challenge Lambda and trigger wiring,
  extended by [[ADR-0020-self-owned-password-reset]] with the `CustomMessage` finding.
- [[ADR-0020-self-owned-password-reset]] — why the password reset is self-owned rather than
  Cognito's, and the two load-bearing security properties.
- [[self-owned-password-reset-codes-in-redis]] — the Redis-vs-Postgres storage decision and the
  four endpoints in implementation detail.
- [[password-policy-checklist-gap]] — the open gap between the web-app's password checklist and
  the enforced Cognito policy.
- [[redis-elasticache-replication-group-floci]] — the infra module provisioning the Redis instance
  this flow depends on.
