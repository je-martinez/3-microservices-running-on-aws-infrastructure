---
title: Users Service Design
type: spec
area: users
status: active
created: 2026-06-26
updated: 2026-07-12
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
  - "[[2026-06-28-users-service-design]]"
  - "[[2026-07-09-users-cognito-webhook-design]]"
  - "[[2026-07-10-users-openapi-autogen-design]]"
  - "[[2026-07-11-auth-error-mapping-design]]"
  - "[[2026-07-11-refresh-token-endpoint-design]]"
  - "[[2026-07-11-authenticated-identity-resolution-design]]"
  - "[[2026-07-12-app-user-id-token-claim-design]]"
  - "[[2026-07-12-audit-actor-enum-design]]"
---

# Users Service Design

## Summary

The Users service is responsible for user registration, authentication, and profile management.
It integrates with AWS Cognito for auth and resolves identity via a Cognito `sub`-or-`usr_`-id
lookup. ORM: Prisma. Event emission (`USER_CREATED` → SQS) is scaffolded but **not yet wired** —
see [Events](#events--aspirational-not-yet-wired) below.

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
| `GET` | `/v1/users/me` | Returns the authenticated user's profile, resolved via `findByIdOrCognitoSub`. |
| `PATCH` | `/v1/users/me` | Updates the authenticated user's profile. |
| `POST` | `/v1/webhooks/cognito` | Cognito PostConfirmation trigger webhook; shared-secret guarded (`x-webhook-secret`), no JWT authorizer. See [Cognito identity capture](#cognito-identity-capture). |
| `DELETE` | `/v1/users/e2e-cleanup` | **[E2E only]** Soft-deletes E2E-sourced users. Gated on `E2E_TESTING_ENABLED`. |
| `GET` | `/v1/users/e2e-identity` | **[E2E only]** Reads captured Cognito identity rows by email, for E2E assertions. Gated on `E2E_TESTING_ENABLED`. |

Authentication on `GET /v1/users/me` and `PATCH /v1/users/me` is enforced via API Gateway + Cognito (see [[ADR-0009-apigw-alb-fargate]] and [[ADR-0010-cognito-auth]]); locally the identity header is injected by nginx+njs, not by API Gateway claim mapping (see [[ADR-0017-floci-local]]).

## Error contract

A global `app.setErrorHandler` in `routes.ts` maps typed auth-domain errors (`services/users/src/shared/auth/auth-errors.ts`, all extending `AuthError`) to their HTTP status and a stable `error` code in the body — everything else (Zod validation 400s, unexpected 500s) keeps Fastify's default handling:

| Error | Route | Status | `error` code |
|---|---|---|---|
| `EmailAlreadyExistsError` | `POST /v1/users/register` | `409` | `email_exists` |
| `InvalidCredentialsError` | `POST /v1/users/login`, `POST /v1/users/refresh` | `401` | `invalid_credentials` |
| Not found (no error class — inline `404`) | `GET /v1/users/me`, `PATCH /v1/users/me` | `404` | `not_found` |

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

## Events — ASPIRATIONAL, not yet wired

> [!warning] Not implemented
> The table below describes **intended** future behavior. Today, `services/users/src/shared/messaging/event-publisher.ts` only implements a **`NoopEventPublisher`** — the emission call site exists (`register.ts` calls `this.events.publishUserCreated(...)`), but nothing is actually published. SQS wiring is deferred to a future milestone.

| Event | Trigger | Queue |
|---|---|---|
| `USER_CREATED` | `POST /v1/users/register` success | SQS *(not yet wired — currently a no-op)* |

The event payload, when wired, is intended to carry the new user ID and email. See [[cqrs]] for the target pattern.

## OpenAPI autogen

`services/users/openapi.yaml` is **generated**, not hand-maintained: it is built from the Fastify route Zod schemas (`http/schemas.ts`) via `@fastify/swagger` + `fastify-type-provider-zod`, running `pnpm generate:openapi`. It is the artifact imported into Apidog (see `docs/infrastructure/runbooks/mcp-servers.md`). Any route or schema change requires regenerating and committing `openapi.yaml` in the same change. See [[2026-07-10-users-openapi-autogen-design]] for the generator design (including orphan-component pruning for the `*Input` schema variants).

## gRPC Methods

| Method | Request | Response |
|---|---|---|
| `GetUserById` | `{ id: string }` | `User` object |

Used by Orders and Tracking services for inter-service lookups (see [[ADR-0003-grpc-inter-service]]).

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
- [[2026-06-28-users-service-design]]
- [[2026-07-09-users-cognito-webhook-design]]
- [[2026-07-10-users-openapi-autogen-design]]
- [[2026-07-11-auth-error-mapping-design]]
- [[2026-07-11-refresh-token-endpoint-design]]
- [[2026-07-11-authenticated-identity-resolution-design]]
- [[2026-07-12-app-user-id-token-claim-design]]
- [[2026-07-12-audit-actor-enum-design]]
