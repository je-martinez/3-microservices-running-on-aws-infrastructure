---
title: Users Service Design
type: spec
area: users
status: active
created: 2026-06-26
updated: 2026-06-28
tags: [type/spec, area/users, status/active]
related:
  - "[[soft-delete]]"
  - "[[nano-id]]"
  - "[[audit-fields]]"
  - "[[db-naming]]"
  - "[[cqrs]]"
  - "[[versioning]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[2026-06-28-users-service-design]]"
---

# Users Service Design

## Summary

The Users service is responsible for user registration, authentication, and profile management. It integrates with AWS Cognito for auth, emits SQS events on registration, and exposes a gRPC method for inter-service user lookups. ORM: Prisma.

## Stack & Data Store

| Concern | Choice |
|---|---|
| Framework | Fastify |
| Database | Aurora PostgreSQL |
| Replicas | 1 write replica, 1 read replica (see [[ADR-0006-read-write-replicas]]) |
| ORM | Prisma |
| Auth | AWS Cognito (see [[ADR-0010-cognito-auth]]) |

## API / Endpoints

All routes are versioned under `/v1` (see [[versioning]]).

| Method | Path | Description |
|---|---|---|
| `POST` | `/users/register` | Creates a user in Cognito and the DB; emits `USER_CREATED` to SQS. |
| `POST` | `/users/login` | Authenticates via Cognito; returns tokens. |
| `GET` | `/users/me` | Returns the authenticated user's profile. |
| `PATCH` | `/users/me` | Updates the authenticated user's profile. |
| `GET` | `/health` | Liveness/readiness probe. Returns `{ "status": "ok" }` when healthy. No auth required. Used by ALB/Fargate as the health check target. |

Authentication on `GET /users/me` and `PATCH /users/me` is enforced via API Gateway + Cognito (see [[ADR-0009-apigw-alb-fargate]] and [[ADR-0010-cognito-auth]]).

## gRPC Methods

| Method | Request | Response |
|---|---|---|
| `GetUserById` | `{ id: string }` | `User` object |

Used by Orders and Tracking services for inter-service lookups (see [[ADR-0003-grpc-inter-service]]).

## Data Model

Table: `users` (all columns in `snake_case`; mapped to `PascalCase` in application layer via [[db-naming]]).

| Column | Type | Notes |
|---|---|---|
| `id` | `varchar` | Prefixed nano ID, e.g. `usr_…` (see [[nano-id]]) |
| `email` | `varchar` | Unique, not null |
| `full_name` | `varchar` | Maps to `fullName` |
| `address` | `jsonb` | Structured address object |
| `phone_number` | `varchar` | |
| `tags` | `text[]` | Array of labels; default `[]`. `E2E Source` marks records created by the Playwright E2E suite (see [[2026-06-28-users-service-design]]). |
| `created_by` | `varchar` | |
| `created_at` | `timestamptz` | |
| `updated_by` | `varchar` | |
| `updated_at` | `timestamptz` | |
| `deleted_by` | `varchar` | |
| `deleted_at` | `timestamptz` | Null = active; set = soft-deleted |

`isDeleted` is a computed property based on `deleted_at` (see [[audit-fields]] and [[soft-delete]]).

> [!note] E2E Source Tag — Server-Injected Only
> The tag value `E2E Source` is added by the server, never by the client. The `POST /users/register` handler appends it to `tags` **only** when the incoming request carries the header `X-E2E-Source: true` **and** the environment variable `E2E_TESTING_ENABLED=true` is set. This flag is disabled in production. Clients cannot write to `tags` directly — the field is absent from every public request schema. See [[2026-06-28-users-service-design]] for the implementation design.

> [!note] No Hard Deletes
> The DB user is forbidden from running `DELETE`. All removals go through soft delete only.

## Events

| Event | Trigger | Queue |
|---|---|---|
| `USER_CREATED` | `POST /users/register` success | SQS |

The event payload carries the new user ID and email. A Lambda subscriber receives it downstream (see [[cqrs]]).

## Cross-cutting rules

| Rule | Reference |
|---|---|
| Soft delete only | [[soft-delete]] |
| Prefixed nano IDs | [[nano-id]] |
| Audit fields on every table | [[audit-fields]] |
| snake_case DB ↔ PascalCase app | [[db-naming]] |
| CQRS pattern | [[cqrs]] |
| API versioning | [[versioning]] |
| Authentication & authorization | [[ADR-0010-cognito-auth]] |

## Related

- [[soft-delete]]
- [[nano-id]]
- [[audit-fields]]
- [[db-naming]]
- [[cqrs]]
- [[versioning]]
- [[ADR-0010-cognito-auth]]
- [[ADR-0003-grpc-inter-service]]
- [[ADR-0006-read-write-replicas]]
- [[ADR-0009-apigw-alb-fargate]]
- [[2026-06-28-users-service-design]]
