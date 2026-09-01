---
title: Account Deletion (Soft Delete) Design
type: spec
area: users
status: active
created: 2026-08-25
updated: 2026-08-26
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

> [!info] Corrected 2026-08-26 against the shipped implementation
> A pre-PR audit found this design had drifted from what actually shipped on three points: the
> ownership-key predicate ([below](#the-ownership-key-critical-verified--corrected-2026-08-26)),
> the reuse of `CartWriteService.DeleteForUserAsync`
> ([Reusable primitives](#reusable-primitives-already-in-the-repo--corrected-2026-08-26)), and
> the load-testing verdict (the **Testing** section, below) — plus two sections that were simply
> missing (empty-identity guards, observability). Each correction is marked inline; this note is
> not a rewrite from scratch.

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

## The ownership key (critical, verified) — corrected 2026-08-26

> [!warning] This section originally understated the cascade's predicate
> An earlier draft claimed the cascade keys on `cognito_sub` **alone**, scoping the `OR user_id`
> fallback to Tracking only. As **shipped**, both services match `cognito_sub OR user_id`. The
> text below is the corrected reasoning, not the original claim.

**Reads still key on `cognito_sub` ALONE — the widening below is erasure-only.** Nobody should
widen the reads to match this predicate; `cognito_sub` remains the sole ownership key every
user-scoped read filters by, in both services.

**Why the erasure cascade is wider than the reads.** `cognito_sub` is not the durable identity:
a user who deletes their account and registers again gets a **new** sub minted by Cognito, while
their internal `usr_` id never changes. A cascade keyed on `cognito_sub` alone would leave a row
whose sub is stale, empty, or fell out of sync perfectly intact and silently unreachable — the
`DELETE /v1/users/me` request would still answer `200`/`204`, with a cascade count of zero,
while the user's data quietly survives. Matching `user_id` as well closes that gap, and it costs
nothing: Orders indexes both columns (`idx_order_user_id`, `idx_order_cognito_sub`), and Tracking
indexes the equivalent pair.

Tracking has a **second, independent** reason to widen: `cognito_sub` is nullable on rows
predating migration `b17f4c2e9a30`, and those rows are reachable only through `user_id`. So
Tracking's predicate is `cognito_sub = :sub OR user_id = :usr`, and Users sends **both**
identifiers on the internal call regardless of which reason applies to a given row.

In Orders, `order_details` has **no index** on `user_id`/`cognito_sub` (only `order_id`,
`product_id`, `deleted_at`), so details must be swept via `order_id IN (...)` rather than by
the ownership key directly, following what the existing e2e-cleanup does.

**The OR cuts both ways — this is why empty identities are refused, not merely discouraged.**
`cognito_sub`/`user_id` are `NOT NULL varchar` columns in both services' MySQL/Postgres schemas,
which still permits the empty string `""`. An empty value reaching either side of the `OR` would
match **every row carrying an empty string in that same column** — someone else's data, erased
by a caller who sent (or was tricked into sending) a blank identity. This is not a hypothetical
edge case guarded "just in case": it is the direct, structural consequence of widening the
predicate to an `OR`, and it is why empty identities are refused at **four separate layers** —
see the next section.

## Empty-identity guards (four layers)

Because the cascade predicate is an `OR` over two `NOT NULL` columns that both still permit `""`
(see [above](#the-ownership-key-critical-verified--corrected-2026-08-26)), an empty
`cognito_sub` or `user_id` reaching either side of that `OR` would erase every row carrying an
empty string in the same column — not "nothing," but someone else's data. This is guarded
independently at four layers, deliberately redundant rather than trusting the layer above:

| Layer | Where | Behaviour |
|---|---|---|
| Users' outbound client | `services/users/src/shared/http/cascade-client.ts` | `CascadeClient.send` throws `CascadeFailedError` for an empty `cognitoSub`/`userId` **before the request leaves the process** |
| Orders' internal route | `services/orders/src/Orders.Api/Endpoints/InternalEndpoints.cs` | `400 cognito_sub_required` / `400 user_id_required` — two **distinct** reasons, not a shared `identity_required`, so an operator can tell which field the caller failed to send |
| Tracking's schema | `services/tracking/src/features/tracking/api/schemas.py` | Pydantic `Field(min_length=1)` on both `cognito_sub` and `user_id` on `InternalDeleteByUserRequest` → `422` |
| Tracking's repository | `services/tracking/src/features/tracking/domain/repository.py` | `soft_delete_by_user` raises `ValueError` if either identity is empty — a **second** gate behind the schema, because the method is public and a future non-HTTP caller reaching it another way must not be able to widen the blast radius by passing `""` |

Users' guard is checked first and is the only one of the four that prevents the cascade from
being **attempted** at all — a user row with a missing `cognitoSub` fails with
`CascadeUnavailableError("missing_cognito_sub")` before either downstream service is called (see
`DeleteAccountCommand.doExecute`). The other three guard the identity actually reaching each
service's own predicate, independent of what Users sent.

## API surface

- `DELETE /v1/users/me` — authenticated (`x-user-id` header, injected by the gateway/nginx,
  holds the Cognito sub). Responses: `204` complete; `401` no `x-user-id`; `404` row already
  deleted (reads already filter `deletedAt`, so this comes for free); `502` a cascade leg
  failed.
- `DELETE /v1/orders/by-user` — **internal**. Not exposed on the API Gateway. Authenticated
  with the shared `GRPC_API_KEY`, compared in constant time (`hmac.compare_digest` or
  equivalent), mirroring how Tracking already guards its carrier key. Body is **camelCase**
  (`{ cognitoSub, userId }`), matching every other Orders HTTP DTO. Responses: `200` with
  per-table counts; `400 cognito_sub_required` / `400 user_id_required` (see
  [Empty-identity guards](#empty-identity-guards-four-layers) above); `401` invalid/missing
  `GRPC_API_KEY`.
- `DELETE /v1/trackings/by-user` — **internal**, same auth. Body is **snake_case**
  (`{ cognito_sub, user_id }`), matching Tracking's wire convention. Cascades to
  `tracking_history` through the FK, children before parents, mirroring `soft_delete_by_tag`.
  Responses: `200 { deleted }`; `401` invalid/missing key; `422` an identity field failed
  `min_length=1`.

## Reusable primitives already in the repo — corrected 2026-08-26

> [!warning] `CartWriteService.DeleteForUserAsync` was NOT reused as-is
> An earlier draft implied the existing 2-arg `DeleteForUserAsync(db, cognitoSub, ct)` would be
> called directly by the cascade. As **shipped**, a **separate 3-arg overload** was added instead
> — the shared 2-arg form was deliberately left untouched. See below for why.

- `services/orders/src/Orders.Infrastructure/Carts/CartWriteService.cs` — **two** overloads now
  exist:
  - `DeleteForUserAsync(db, cognitoSub, ct)` (2-arg, pre-existing, **unchanged**): scoped to the
    caller's **current sub alone**, matching **at most one** cart. This is the form
    `DELETE /v1/cart`, an emptying `PUT /v1/cart`, and `POST /v1/orders`'s post-checkout cleanup
    all still use — each of them acts for a **live request** whose identity is the current sub.
    Widening this form to `OR user_id` would let a checkout or an emptying `PUT` destroy a cart
    that merely shares a `usr_` id under an **older** sub, silently losing someone's basket
    mid-purchase. It stays narrow on purpose.
  - `DeleteForUserAsync(db, cognitoSub, userId, ct)` (3-arg, **new**): matches
    `cognito_sub OR user_id`, the erasure cascade's own predicate (see
    [The ownership key](#the-ownership-key-critical-verified--corrected-2026-08-26) above), and is
    the **only** caller `InternalEndpoints.cs` uses. Static, takes the context, does **not**
    save, so the cascade enlists it in its own transaction — the same non-saving shape the 2-arg
    form already had, just with a wider predicate. Erasure is the one caller in the service that
    prefers deleting **too much** to leaving data behind, which is exactly the opposite bias from
    every other caller of this primitive.
- `services/tracking/src/features/tracking/domain/repository.py` —
  `soft_delete_by_tag`: FK-following mass-stamp template (children first), each statement
  guarded by `deleted_at IS NULL` for idempotency. It **previously** scoped by `cognito_sub`,
  and that scoping was removed because the E2E teardown has no user session. The cascade does
  **not** reuse `soft_delete_by_tag` itself — it ships as a **new sibling method**,
  `soft_delete_by_user`, reintroducing per-identity scoping (widened to `cognito_sub OR user_id`)
  for a use case where an identity **is** present. See [[tracking-service-design]] for its full
  documented shape.
- Users' soft-delete substrate is complete:
  `services/users/src/shared/db/prisma-extensions.ts` rewrites delete→update and injects
  `deletedAt: null` into every read.

## Observability

The spec originally had **zero** mentions of `app_event`. As shipped, the whole cascade is
instrumented per [[logging-context]]'s flow-log convention, with a workflow span at each hop:

**Users** — `DeleteAccountCommand`, wrapped end to end in `withWorkflowSpan("delete_account", …)`:

| `app_event` | When | `reason` values |
|---|---|---|
| `delete_account_started` | Always, once the caller resolves | — |
| `delete_account_succeeded` | After Postgres commits and (best-effort) Cognito deletes | — |
| `delete_account_failed` | Caller doesn't resolve, missing sub, or a cascade leg didn't confirm | `not_found`, `missing_cognito_sub`, `cascade_failed_orders`, `cascade_failed_tracking` |
| `delete_account_cognito_orphan` | `AdminDeleteUser` throws **after** the Postgres commit | the AWS error name |

`delete_account_cognito_orphan` is deliberately **not** a `_failed` event: the deletion already
succeeded from the user's point of view (`204` was returned), but the failure is alert-worthy —
it leaves an orphaned sub in the Cognito pool that blocks this person from ever re-registering
with the same address, the exact outcome the feature exists to prevent. It is swallowed (the
request must not fail on it) but must not be silent.

**`CascadeClient`** (`services/users/src/shared/http/cascade-client.ts`), one pair per leg:

| `app_event` | Dimension |
|---|---|
| `cascade_delete_succeeded` | `cascade_service` (`orders` \| `tracking`) |
| `cascade_delete_failed` | `cascade_service`, `reason` (`unreachable` or `status_<code>`) |

**Orders & Tracking** — both internal routes emit the same triad, each wrapped in that service's
own workflow-span helper (`IWorkflowTracer.TraceWorkflowAsync` / `workflow_span`):

| `app_event` | `reason` values |
|---|---|
| `internal_delete_by_user_started` | — |
| `internal_delete_by_user_succeeded` | — |
| `internal_delete_by_user_failed` | `invalid_api_key`, `cognito_sub_required`, `user_id_required`, `db_error` |

**Orders emits its `invalid_api_key` failure line deliberately OUTSIDE the workflow span.** An
unauthenticated request never started the flow, so there is nothing for the span to trace — the
span and the `_started` line both begin only once the key has passed
(`InternalEndpoints.cs`). Tracking's `InternalAuth` dependency rejects unauthenticated requests
before the route body (and its own `workflow_span`) runs at all, for the same reason.

**New metric: `users_deleted_total`** (counter, `Service=users`), the direct counterpart to
`users_registered_total`. Published by `DeleteAccountCommand` after the Postgres commit, awaited
but non-fatal — a metrics-publish outage must not fail a deletion that already happened, mirroring
every other counter in this service. **Zero-seeded in `BusinessMetricsPoller`**: without a
zero-seed, a service that has processed zero deletions since deploy has no data point at all for
this metric, and the registration series (`users_registered_total`) and the population gauge
(`users_total`, which already drops on deletion) diverge permanently with **no metric explaining
the gap** — the absence of `users_deleted_total` would itself look like a bug.

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

## Testing (three layers, per [[testing]]) — corrected 2026-08-26

- Unit/integration per service: the Users command with doubles; the cascade predicate in
  Orders and Tracking, including Tracking's `user_id` fallback for rows with a null
  `cognito_sub`.
- Internal E2E (direct service URL): the exhaustive cases.
- Gateway E2E with a real Cognito JWT — including the case that gives the whole feature its
  meaning: register → delete → re-register with the same email → assert the second account is
  empty (no orders, no tracking) while the old row is still in the database with `deletedAt`
  stamped and its real email intact.

> [!warning] "Load tests: not applicable" was wrong — they shipped
> The original dismissal read *"Load tests: not applicable — this does not change how users
> reach an existing flow."* That reasoning does not survive contact with what actually shipped.
> A **fourth layer** was added: `e2e/load-tests/src/accountDeletion.gatling.ts`.
>
> **Why the original dismissal was wrong.** `DELETE /v1/users/me` is the **only** user-facing
> request in this repo that synchronously fans out to **two services plus an external IdP**
> before it answers — every other endpoint touches at most its own database (Orders' `POST
> /v1/orders` calls Users over gRPC, but that is one dependency, not three). Its latency is
> therefore the **sum** of four dependencies (Orders, Tracking, Cognito's `AdminDeleteUser`, and
> Users' own commit), not a single query. That composition — not throughput — is exactly the
> "what shape does it have under sustained traffic?" question load testing exists to answer, and
> "this does not change how users reach an existing flow" answers a question about routing, not
> about the request's own dependency graph.
>
> **Measured result:** p95 **153ms** for `DELETE /v1/users/me`, against **50ms** for a simple
> read — the compounding the reasoning above predicts. The injection profile is deliberately
> modest (default `usersPerSec=1`, ramp to 5): every virtual user is destructive and single-use,
> registering, buying, and permanently removing itself, so there is no steady-state deletion
> rate to find by raising it — see the simulation file's own header comment for the full
> rationale, including why a small population of ordinary buyers runs alongside it (a cascade
> starving the connection pool shows up as slower *order reads*, not a slower delete).

> [!info] One known, honestly-recorded test gap
> **No test in any layer asserts the deleted row keeps its real email** (as opposed to a
> tombstoned/rewritten one). This is not an oversight so much as a structural blind spot: a
> soft-deleted row is invisible to **every** API read by construction (`deletedAt: null` is
> injected into every Prisma `find*`), so from outside the API, "the email was preserved" and
> "the email was erased" are **byte-identical outcomes** — no HTTP response can tell them apart.
> The assertion belongs in Users' own integration suite, which runs against a live Postgres and
> can query the row directly, bypassing the read filter. It has not been written yet; recorded
> here rather than silently left absent.

## Known dependency — cache invalidation (unfinished, on purpose)

The Response Caching Layer milestone (Linear JE-196/197/199/200) is **unfinished**, and none of
its code is on this branch — so there is nothing here for this milestone to invalidate today.
This section exists to make that gap **visible** rather than invisible, since an unstated future
dependency is exactly the kind of debt that goes unnoticed until it causes a real, hard-to-explain
bug.

When Orders' and Tracking's planned identity caches (`cognito_sub → user_id`) land, **they must
invalidate on account deletion**. Without that invalidation, a deleted sub keeps resolving from
cache for the remainder of its TTL, and the deletion appears — on any cached read — not to have
taken effect, even though the underlying rows are correctly soft-deleted. This is not a
theoretical risk to revisit later; it is a concrete, known interaction between two features that
happen not to overlap in time, and whoever implements the caching layer must read this note
before wiring the cache's invalidation triggers.

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
