---
title: Users Service Design
type: spec
area: users
status: active
created: 2026-06-26
updated: 2026-08-05
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

## Events

`services/users/src/shared/messaging/event-publisher.ts` implements `SqsEventPublisher`, which
sends the envelope via `SendMessageCommand`. `register.ts` calls
`this.events.publishUserCreated(...)` after the user and Cognito account are created.
`NoopEventPublisher` still exists in the same file, but only as the binding used by tests and
any environment that must not emit — it is not the production path.

| Event | Trigger | Queue |
|---|---|---|
| `USER_CREATED` | `POST /v1/users/register` success | SQS, real publish via `SqsEventPublisher` |

The envelope carries `event_id` (generated in the publisher, the pipeline's idempotency key),
`type`, `source`, `user_id`, `order_id: null`, an `author` object (`{ actor: AuditActor.Register,
user_id, cognito_sub? }` — the same semantic actor already stamped into `createdBy`/`updatedBy`
for this write, distinguishing WHO originated the event from `user_id`, which is its subject),
and `payload: { email, fullName }`. A publish failure is logged (`user_created_publish_failed`)
and swallowed, never rethrown: the user row and Cognito account already exist by the time
publishing runs, so failing the request would return an error for a registration that actually
succeeded. See [[events-pipeline-design]] for the consumer side and the full envelope contract.

## OpenAPI autogen

`services/users/openapi.yaml` is **generated**, not hand-maintained: it is built from the Fastify route Zod schemas (`http/schemas.ts`) via `@fastify/swagger` + `fastify-type-provider-zod`, running `pnpm generate:openapi`. It is the artifact imported into Apidog (see `docs/infrastructure/runbooks/mcp-servers.md`). Any route or schema change requires regenerating and committing `openapi.yaml` in the same change. See [[2026-07-10-users-openapi-autogen-design]] for the generator design (including orphan-component pruning for the `*Input` schema variants).

## gRPC Methods

| Method | Request | Response |
|---|---|---|
| `GetUserById` | `{ id: string }` | `User` object, including `address` (typed `Address` message — see below) |

Used by Orders and Tracking services for inter-service lookups (see [[ADR-0003-grpc-inter-service]]).

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
  the `author` object's role in the pipeline's `created_by`/`updated_by` audit split.
