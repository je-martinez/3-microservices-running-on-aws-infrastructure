---
title: Account Deletion (Soft Delete) Design
type: spec
area: users
status: active
created: 2026-08-25
updated: 2026-08-25
tags:
  - type/spec
  - area/users
  - area/orders
  - area/tracking
  - status/active
propagates-to:
  - "[[users-service-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[soft-delete]]"
related:
  - "[[ADR-0004-soft-delete-only]]"
  - "[[soft-delete]]"
  - "[[audit-fields]]"
  - "[[users-service-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[testing]]"
  - "[[git-workflow]]"
---

# Account Deletion (Soft Delete) Design

## Context

A user must be able to delete their own account. Deleting it must cascade to their orders
(Orders service) and their tracking data (Tracking service). The user must afterwards be able
to register again with the **same** email address. The old record and the new record must
both persist in the database — one carrying `deletedAt`, the other live.

Produced through a brainstorming session on 2026-08-25; every decision below was explicitly
confirmed by the user. Author/decider: Jose E. Martinez.

## Confirmed decisions

1. **Actor.** Only the user themselves. New endpoint `DELETE /v1/users/me`, authenticated. No
   admin deletion path exists — there is no admin role in the repo today.

2. **Cognito: `AdminDeleteUser`.** The Cognito sub is removed from the pool, which is what
   frees the email address for re-registration. This deliberately departs from the letter of
   [[ADR-0004-soft-delete-only]], whose scope is the **databases** (the DB write user has no
   `DELETE` grant). Cognito is an external identity provider, not our database; keeping the
   sub via `AdminDisableUser` would permanently occupy the email in the pool and make the
   confirmed re-registration requirement impossible (`UsernameExistsException`). The durable
   record of the user is preserved in Postgres, which is what ADR-0004 exists to protect.

3. **Orders: unconditional cascade.** All orders are soft-deleted regardless of state. There
   is no "block if there are deliveries in flight" rule.

4. **Propagation: synchronous internal HTTP calls**, not an async event. Users calls
   `DELETE /v1/orders/by-user` and `DELETE /v1/trackings/by-user` directly. This beat the
   async option because the repo's messaging topology is strictly fan-in: three producers
   publish to **one** SQS queue consumed by **one** Lambda (`functions/events-pipeline`).
   Neither Orders nor Tracking consumes anything today; SQS delivers each message to a single
   consumer, so they cannot listen on the existing queue without stealing the Lambda's
   messages. Async propagation would mean building the repo's first inbound async machinery
   twice — a .NET `BackgroundService` polling loop, and a durable Python worker FastAPI has no
   natural home for — plus new fan-out infrastructure (SNS or dedicated queues) in Terraform.
   That is the bulk of the effort, and it is new infrastructure, not business logic. HTTP
   internal routes need zero new infrastructure and reuse the existing service-to-service
   pattern.

5. **No `USER_DELETED` event is published.** Explicitly cut after challenge. None of the
   pipeline's three consumers would do anything with it: DocumentDB would store a duplicate
   audit record of a fact already durably recorded by `deletedAt`/`deletedBy` in all three
   databases — exactly [[ADR-0004-soft-delete-only]]'s purpose; there is no farewell email
   (`USER_CREATED` exists because it sends the welcome email); and the WebSocket push routes
   by `cognito_sub` to open connections, but the sub has just been deleted from Cognito, so
   there is nobody to notify. Publishing it "for a future fan-out" is speculating on
   infrastructure that does not exist — if that fan-out is ever built, the migration is to
   replace the HTTP calls with the event, and publishing it now saves none of that work
   (YAGNI). Consequence: no new handler in `functions/events-pipeline`; the milestone touches
   three services, not four.

6. **Email uniqueness — partial unique index.** In `services/users/prisma/schema.prisma`,
   `email` stops being `@unique` and becomes
   `@@unique([email], where: raw("deleted_at IS NULL"))`. This requires enabling the
   `partialIndexes` preview feature on the generator (the repo runs Prisma 7.8; partial
   indexes are declaratively supported since 7.4 via the `where` argument — no raw-SQL
   migration needed). The old row **keeps its real email intact** — no tombstoning or
   rewriting to `deleted+<id>@…`, which was rejected because it destroys the historical data
   the user asked to preserve and breaks audit `email_hash`. This is the Postgres equivalent
   of the `STORED` generated-column trick Orders already uses for the cart's one-active-cart
   invariant (`active_user_id`, see `CartConfiguration.cs`).

7. **gRPC: no change.** `GetUserById` keeps returning `NOT_FOUND` for a deleted user (reads
   already inject `deletedAt: null`). No `include_deleted` flag is added to the shared proto.
   Orders already swallows the failure best-effort when resolving the internal id; Tracking
   uses it in init-tracking, a flow a deleted user no longer executes.

8. **Re-registration semantics.** After re-registering with the same email there will be two
   rows with that email — one stamped `deletedAt`, one live. The old orders and tracking data
   stay bound to the **old** `usr_` id and the **old** Cognito sub. The new user does not see
   the old history, and no attempt is made to reattach it. "Persisting the old record" means
   retaining it in the database for audit, not showing it back to the user. Cognito issues a
   new sub, so this is both legally correct and technically unavoidable.

## Order of operations

1. Cascade to Orders (internal HTTP). On failure → `502`, nothing has been touched, user
   retries.
2. Cascade to Tracking (internal HTTP). On failure → `502`.
3. Stamp the Users row (soft delete).
4. `AdminDeleteUser` in Cognito — the point of no return, and what frees the email.

Cascade goes **first** and the account is deleted **last** because the reverse order is
unrecoverable: if the account were deleted first and the cascade then failed, the user could
no longer authenticate to retry, leaving orphaned orders with no path to fix them. With this
order a partial failure leaves the account alive and the user simply retries.

## Partial failure

Both internal routes **must be idempotent** — the soft-delete predicate is guarded by
`deleted_at IS NULL`, exactly as the existing `soft_delete_by_tag` (Tracking) and
`CartWriteService.DeleteForUserAsync` (Orders) already do. So if step 2 fails after step 1
succeeded, a retry re-calls Orders as a no-op and completes Tracking: the inconsistency is
**transient and self-healing by retry**, rather than permanent.

Explicitly **rejected**: transactional compensation (undoing the Orders delete).
Reintroducing deleted rows needs an "undelete" primitive that exists in none of the three
services and would be more new surface than the feature itself.

Cognito's `AdminDeleteUser` (step 4) runs **after** the Postgres commit and is best-effort in
the same sense already documented in `services/users/src/shared/auth/auth-provider.ts` — once
Postgres has stamped the row, a Cognito failure must not return an error to the user. But it
**must** be logged loudly, because it leaves an orphan in the pool that would block
re-registration. This is the one point in the flow that merits an alert.

## The ownership key (critical, verified)

The cascade keys on `cognito_sub`, **not** `user_id`, in both services — `cognito_sub` is the
ownership key every user-scoped read filters by. A cascade keyed on `user_id` would compile,
run, and match nothing.

In Tracking, `cognito_sub` is nullable on rows predating migration `b17f4c2e9a30`, and those
rows do have `user_id`. So Tracking's predicate is `cognito_sub = :sub OR user_id = :usr`, and
Users therefore sends **both** identifiers on the internal call.

In Orders, `order_details` has **no index** on `user_id`/`cognito_sub` (only `order_id`,
`product_id`, `deleted_at`), so details must be swept via `order_id IN (...)` rather than by
the ownership key directly, following what the existing e2e-cleanup does.

## API surface

- `DELETE /v1/users/me` — authenticated (`x-user-id` header, injected by the gateway/nginx,
  holds the Cognito sub). Responses: `204` complete; `401` no `x-user-id`; `404` row already
  deleted (reads already filter `deletedAt`, so this comes for free); `502` a cascade leg
  failed.
- `DELETE /v1/orders/by-user` — **internal**. Not exposed on the API Gateway. Authenticated
  with the shared `GRPC_API_KEY`, compared in constant time (`hmac.compare_digest` or
  equivalent), mirroring how Tracking already guards its carrier key.
- `DELETE /v1/trackings/by-user` — **internal**, same auth. Cascades to `tracking_history`
  through the FK, children before parents, mirroring `soft_delete_by_tag`.

## Reusable primitives already in the repo

- `services/orders/src/Orders.Infrastructure/Carts/CartWriteService.cs:253` —
  `DeleteForUserAsync(db, cognitoSub, ct)`: static, takes the context, does **not** save, so a
  caller enlists it in its own transaction. Exactly the shape the cascade wants, and it
  already soft-deletes the cart and its lines.
- `services/tracking/src/features/tracking/domain/repository.py:347` —
  `soft_delete_by_tag`: FK-following mass-stamp template (children first), each statement
  guarded by `deleted_at IS NULL` for idempotency. It **previously** scoped by `cognito_sub`,
  and that scoping was removed because the E2E teardown has no user session; a per-user
  variant reintroduces it for a use case where an identity **is** present.
- Users' soft-delete substrate is complete:
  `services/users/src/shared/db/prisma-extensions.ts` rewrites delete→update and injects
  `deletedAt: null` into every read.

## Migrations

- Users: **one** migration — the partial unique index on `email` plus the `partialIndexes`
  preview feature.
- Orders: none required. Tracking: none required. All audit columns and the needed indexes
  already exist.

## Wiring

- Add
  `delete_me = { key = "DELETE /v1/users/me", path = "/v1/users/me", auth = true }` to
  `infra/modules/api-gateway/main.tf`.
- nginx needs **no** new location block — `/v1/users/me` already falls under `location /`,
  which proxies to Users. Verified against `infra/modules/compute/nginx/nginx.conf`.
- The two internal routes are deliberately absent from the gateway.
- All three `openapi.yaml` files are generated, committed build artifacts verified by tests —
  they must be regenerated.

## Testing (three layers, per [[testing]])

- Unit/integration per service: the Users command with doubles; the cascade predicate in
  Orders and Tracking, including Tracking's `user_id` fallback for rows with a null
  `cognito_sub`.
- Internal E2E (direct service URL): the exhaustive cases.
- Gateway E2E with a real Cognito JWT — including the case that gives the whole feature its
  meaning: register → delete → re-register with the same email → assert the second account is
  empty (no orders, no tracking) while the old row is still in the database with `deletedAt`
  stamped and its real email intact.
- Load tests: not applicable — this does not change how users reach an existing flow.

## Related

- [[ADR-0004-soft-delete-only]] — the soft-delete-only rule this design deliberately departs
  from at the Cognito boundary (external identity provider, not a database) while staying
  within it for all three databases.
- [[soft-delete]] — the per-service soft-delete implementations this design's cascades build
  on (`CartWriteService.DeleteForUserAsync`, `soft_delete_by_tag`, Prisma delete rewriting).
- [[audit-fields]] — `deletedAt`/`deletedBy`, stamped by every leg of the cascade.
- [[users-service-design]] — target for the new `DELETE /v1/users/me` endpoint and the
  partial-unique-index email change.
- [[orders-service-design]] — target for the new internal `DELETE /v1/orders/by-user` route.
- [[tracking-service-design]] — target for the new internal `DELETE /v1/trackings/by-user`
  route and the `cognito_sub`/`user_id` fallback predicate.
- [[testing]] — the three-layer testing convention this design's test plan follows.
- [[git-workflow]] — branch/PR flow this milestone's implementation will follow.
