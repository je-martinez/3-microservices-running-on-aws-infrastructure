---
title: Tracking Service Design
type: spec
area: tracking
status: accepted
created: 2026-06-26
updated: 2026-08-05
tags: [type/spec, area/tracking, status/accepted]
related:
  - "[[soft-delete]]"
  - "[[nano-id]]"
  - "[[audit-fields]]"
  - "[[db-naming]]"
  - "[[versioning]]"
  - "[[ADR-0003-grpc-inter-service]]"
  - "[[ADR-0006-read-write-replicas]]"
  - "[[ADR-0007-secrets-parameter-store]]"
  - "[[orders-service-design]]"
  - "[[users-service-design]]"
  - "[[logging-context]]"
  - "[[testing]]"
  - "[[local-gateway-per-route-integrations]]"
  - "[[nginx-njs-x-user-id-injection]]"
  - "[[grpc-api-key-authorization]]"
  - "[[user-id-vs-cognito-sub-ownership-key]]"
  - "[[two-api-keys-two-trust-domains]]"
  - "[[testmode-in-process-asyncio-task]]"
  - "[[events-pipeline-design]]"
  - "[[env-files]]"
  - "[[2026-08-03-events-pipeline-milestone-design]]"
---

# Tracking Service Design

> [!info] As built — fully wired and verified end to end (2026-07-31, endpoint table updated 2026-08-03)
> Every part of the chain this note once listed as missing now exists: a multi-stage
> `services/tracking/Dockerfile` that installs and starts the app, a `tracking` service in
> `docker-compose.yml` publishing `3002:8000` with a healthcheck, an nginx upstream
> (`location /v1/trackings` plus the rewritten `/v1/tracking/health`), and
> `enable_tracking_routes = true` in `infra/environments/local/main.tf` — so the gateway routes
> below are live, not inert (the flag-guarded `e2e-cleanup` route is service-local, not a gateway
> route — see [E2E cleanup](#e2e-cleanup-delete-v1trackingse2e-cleanup)).
>
> Verified from a destroyed environment, not incrementally: `make clean` (with `./data`
> deleted) → `make bootstrap` completed in **one pass** → **70/70 E2E tests pass**, including
> the full journey through the gateway (user → order → tracking → DELIVERED). See
> [[tracking/testing/index|Tracking Testing]] for current unit/integration coverage — run against
> a live MySQL rather than mocks.
>
> `infra/modules/messaging/` and `infra/modules/docdb/` (renamed from `database/` on 2026-08-04 —
> the old name suggested a generic database module when it only ever created DocumentDB) are no
> longer empty placeholders — the events-pipeline milestone (2026-08-04) built both, and Tracking
> itself uses Aurora MySQL, not DocumentDB, so neither ever blocked this service directly.
> Tracking is now a producer onto the shared queue those modules provision — see
> [Events](#events) and [[events-pipeline-design]].

## Summary

The Tracking service is responsible for recording and updating the delivery status of orders.
**Tracking is REST-only.** Creation happens via `POST /v1/trackings/init-tracking`, authenticated
by a Cognito JWT through the gateway the same as any other user-facing endpoint; the caller's
identity comes from the gateway-injected `x-user-id` header, and Tracking resolves the caller's
internal `usr_` id itself via an **outbound** gRPC call to Users. Reads are also REST, user-scoped —
a caller only ever sees their own trackings (see [Ownership & scoping](#ownership--scoping)). The
REST surface otherwise stays narrow: a status-update endpoint that simulates a third-party carrier
notifying the system of a delivery status change, plus the standard health check. As of the
events-pipeline milestone, Tracking is **also a producer**: every successful status transition
emits `TRACKING_STATUS_CHANGED` — see [Events](#events).

> [!note] This design was not the original one
> Creation and both reads originally shipped over gRPC (JE-90, JE-91). See
> [Deltas from the original design (superseded)](#deltas-from-the-original-design-superseded) at
> the bottom of this note for what changed and why.

## Stack & Data Store

| Layer      | Technology                               |
|------------|------------------------------------------|
| Runtime    | Python 3.12 — FastAPI                    |
| Database   | Aurora MySQL (write replica + read replica) |
| Container  | AWS Fargate (ECS)                        |
| Auth       | Amazon Cognito (request validation)      |

Read replicas are used for all reads — `GET /v1/trackings/{orderId}` and
`GET /v1/trackings?order_ids=...`; the write replica receives all mutations
(`POST /v1/trackings/init-tracking` and the REST status-update endpoint). See
[[ADR-0006-read-write-replicas]].

## API / Endpoints

Tracking is **REST-only**. Creation happens through `POST /v1/trackings/init-tracking`, behind the
same Cognito JWT gateway authorizer as the reads — see
[gRPC — outbound client to Users](#grpc--outbound-client-to-users) for the one remaining gRPC call
this triggers (outbound, to Users, not a server). All endpoints are versioned under `/v1`. See
[[versioning]].

All REST routes sit behind the **existing** API Gateway (`infra/modules/api-gateway/`) — the same
one fronting Users and Orders. There is no new/dedicated gateway for Tracking; adding these routes
means adding entries to that module's `local.routes` map, per
[Gateway routing](#gateway-routing-existing-module-not-a-new-one) below.

| Method | Gateway path                       | Auth | Description                          |
|--------|-------------------------------------|------|--------------------------------------|
| GET    | `/v1/tracking/health`               | None | Liveness/readiness probe, **as published at the gateway** — see [Gateway-prefixed health path](#gateway-prefixed-health-path-not-bare-v1health) below for why this is prefixed and not the bare `/v1/health` the service itself serves. Returns `200 { "status": "ok" }` when healthy. Used by ALB/Fargate as health check target. |
| POST   | `/v1/trackings/init-tracking`       | Cognito JWT (gateway authorizer) | Creates a tracking record. Body carries `order_id` and `shipping_address` only — the caller's identity comes from the gateway-injected `x-user-id` header, **not** the body. Rejects with `409 Conflict` when the order already has a tracking or any `Tracking_History`. Also accepts an optional `test_mode`, driving [TestMode automatic progression](#testmode-automatic-progression). |
| GET    | `/v1/trackings/{orderId}`           | Cognito JWT (gateway authorizer) | Returns one tracking + its `Tracking_History`, scoped to the caller. Filters by `order_id` **and** the caller's `cognito_sub` (from the gateway-injected `x-user-id` header — see [Ownership & scoping](#ownership--scoping)); a tracking that exists but belongs to another user is indistinguishable from one that does not exist — returns `404`, not `403`. Path param is `{orderId}` (camelCase) at the gateway — see [Gateway path params are camelCase](#gateway-path-params-are-camelcase-not-snake_case) below. |
| GET    | `/v1/trackings?order_ids=<csv>`     | Cognito JWT (gateway authorizer) | Returns many trackings (+ each one's `Tracking_History`), scoped to the caller. `order_ids` is a comma-separated list of order ids, e.g. `?order_ids=ord_a,ord_b,ord_c` — see [Batch read query shape](#batch-read-query-shape) for why. Filters by `order_id` **and** the caller's `cognito_sub`; ids that exist but belong to another user (or don't exist at all) are silently **omitted** from the results, never reported as an error — see [Ownership & scoping](#ownership--scoping). |
| PUT    | `/v1/trackings/{orderId}/status`    | Custom API key (service-validated, **not** Cognito) | Simulates a third-party carrier service notifying Tracking of a delivery status change. `status` must be one of the four enum values defined in [Tracking statuses](#tracking-statuses), and is subject to the guards in [State machine & update guards](#state-machine--update-guards). See [Auth schemes](#auth-schemes) — this endpoint has **no `x-user-id`** and is identified by `order_id` alone. Path param is `{orderId}` (camelCase) — see [Gateway path params are camelCase](#gateway-path-params-are-camelcase-not-snake_case). |
| DELETE | `/v1/trackings/e2e-cleanup`         | None — the route only **exists** under `E2E_TESTING_ENABLED` | The E2E harness's global-teardown route (JE-111). See [E2E cleanup](#e2e-cleanup-delete-v1trackingse2e-cleanup) below. |

> [!warning] Several auth schemes, in both directions
> Unlike Users/Orders, where "all endpoints require a Cognito JWT except health" was previously
> true, Tracking has **three inbound** schemes (none for health, Cognito JWT for the reads and
> init-tracking, a custom external key for the carrier PUT) **plus one outbound** scheme (an
> internal `x-api-key` when Tracking itself calls Users) — see [Auth schemes](#auth-schemes) below
> for the full breakdown, with the inbound/outbound direction made explicit. Do not assume the PUT
> endpoint has a Cognito JWT or an `x-user-id` header; it has neither.

> [!note] Gateway path vs internal service path
> The table above documents the **gateway** surface — what a client actually calls through
> `infra/modules/api-gateway/`. The Tracking service's own internal route handlers may spell paths
> differently (e.g. the health check is served unprefixed, see below, and a handler may bind its
> path param under a different name than the gateway's `{orderId}`, since the service reads it
> positionally). Where the two surfaces diverge, this spec calls it out explicitly rather than
> assuming they match.

#### Gateway-prefixed health path, not bare `/v1/health`

The gateway publishes `GET /v1/tracking/health`, **not** a bare `GET /v1/health` — following the
same per-service-prefixed convention already used for `GET /v1/users/health` and
`GET /v1/orders/health` (`infra/modules/api-gateway/main.tf` `local.routes`). The Tracking service
itself still serves the check **unprefixed**, at `/v1/health` internally; nginx rewrites the
prefixed gateway path down to the bare internal one (`infra/modules/compute/nginx/nginx.conf`, a
comment there marks this **HEALTH-ONLY** — the rewrite must not be extended to functional routes).

This prefix is not cosmetic — it is the only thing standing between a green health check and a
silently wrong one. nginx's default `location /` proxies anything unmatched to `users:3000`. A bare
`GET /v1/health` gateway route, with no distinguishing prefix, would fall through to that catch-all
and resolve to **Users**, returning Users' `200`. A Tracking health probe configured that way would
report healthy while never once reaching the Tracking service — worse than a `404`, because nothing
would ever flag it. Any future service added to this gateway must prefix its health route the same
way, for the same reason.

#### Gateway path params are camelCase, not snake_case

Gateway path params — `{orderId}` in the table above — are spelled **camelCase**, not the
snake_case (`{order_id}`) this spec used elsewhere and that earlier drafts of this table showed.
Floci's local API Gateway builds a Java regex named-capturing group from the param name
(`(?<orderId>[^/]+)`), and Java only allows `[A-Za-z0-9]` in capturing-group names — `{order_id}`
produces `(?<order_id>...)`, which throws `PatternSyntaxException` and returns a Floci `500`. This
is verified live in this repo for Orders' `get_order` route
(`infra/modules/api-gateway/main.tf`), and Tracking's `get_tracking` /
`update_tracking_status` routes follow the same constraint.

This is a **gateway-spelling** constraint only — the service reads the param positionally, so its
internal handler signature is free to use a different name (e.g. `order_id`). Document the gateway
spelling accurately here, since that is what a client actually calls; do not assume it matches
whatever name the service-side handler happens to use.

#### E2E cleanup, `DELETE /v1/trackings/e2e-cleanup`

The E2E harness's global-teardown route (JE-111), the Tracking peer of Orders' and Users' own
`e2e-cleanup` endpoints — see [[soft-delete]] for how each of the three implements the same
soft-delete-by-tag shape (Users: Prisma extension; Orders: `ExecuteUpdateAsync`; Tracking: the two
bulk `UPDATE`s below).

> [!important] No auth at all — the route itself is the guard
> This endpoint takes **no caller identity** — no Cognito JWT, no `x-user-id` dependency. The
> harness's teardown runs once, globally, at the end of a suite; there is no user session to run it
> as, so a route requiring a caller would `401` its only real caller (an earlier version did
> exactly that). What protects it instead is that the route **does not exist** unless
> `E2E_TESTING_ENABLED` is on (`src/main.py` only mounts the e2e router under that flag).

- **What it deletes:** every live `Tracking` row tagged `"E2E Source"`, **and its `Tracking_History`
  in cascade** — children first, then the parent, following the FK direction (mirrors
  `soft_delete_by_tag` in `src/features/tracking/domain/repository.py`). Never a physical `DELETE` —
  the audit columns (`deleted_at`, `deleted_by`) are stamped, same as every other soft-delete in this
  service; `deleted_by` is set to `AuditActor.E2E_CLEANUP` so a row removed by the harness stays
  distinguishable from one removed by a real flow.
- **The tag is applied at creation, not here.** A row is tagged `"E2E Source"` only when the
  `init-tracking` request sent `x-e2e-source: true` **and** `E2E_TESTING_ENABLED` was on at that
  moment — **both conditions are mandatory** (`src/shared/http/e2e_source.py`). The conjunction is
  what stops an untrusted client tagging its own rows for someone else's teardown to delete; the
  header alone must never be sufficient.
- **Response:** `200 {"deleted": N}` — the count of `Tracking` rows stamped (not history rows).
  `200` even when `N` is `0`: a teardown that matches nothing has still reached the state it asked
  for, so a re-run is not a failure.
- **Flag off → `405`, not `404`.** With `E2E_TESTING_ENABLED` off the route is never registered, and
  `/v1/trackings/e2e-cleanup` still matches `GET /v1/trackings/{order_id}`'s path — only the method
  is unsupported, so Starlette answers `405 Method Not Allowed`. A harness (or a future test) that
  treats "flag off" as a `404` will misdiagnose this endpoint; treat `405` as "flag off; nothing to
  clean up here."
- **Caller:** the E2E harness's global teardown (`e2e/support/global-teardown.ts`), which calls the
  equivalent route on all three services.

### Auth schemes

Tracking is REST-only, but its surfaces still span several trust domains — worth documenting
explicitly, and worth being explicit about **direction**, because Tracking is both a callee (its
REST surface, inbound) and a caller (its one remaining gRPC dependency, outbound) using a
key-based scheme in *each* direction. Confusing the two is the easiest mistake to make here: the
gRPC `x-api-key` used to be something Tracking **validated** (an inbound interceptor, see
[Deltas from the original design (superseded)](#deltas-from-the-original-design-superseded)); it
is now something Tracking **sends**.

**Inbound** — requests arriving at Tracking:

| Surface | Auth | Caller |
|---|---|---|
| `GET /v1/tracking/health` (gateway) / `/v1/health` (internal) | None | ALB / Fargate health check |
| `POST /v1/trackings/init-tracking` | Cognito JWT via the gateway's JWT authorizer, identity from `x-user-id` | End user |
| `GET /v1/trackings/{orderId}` and the batch read | Cognito JWT via the gateway's JWT authorizer, scoped by `cognito_sub` (from `x-user-id`) | End user |
| `PUT /v1/trackings/{orderId}/status` | Custom API key, validated by the service itself | Third-party carrier / webhook |

**Outbound** — the one call Tracking itself makes:

| Surface | Auth | Callee |
|---|---|---|
| gRPC `users.v1.Users/GetUserById` | `x-api-key` metadata entry (see [[ADR-0003-grpc-inter-service]]) | Users |

> [!important] The two key-based schemes are different keys for different trust domains
> The gRPC `x-api-key` Tracking sends to Users is an **internal** service-to-service secret — the
> same pattern [[users-service-design]] established for inter-service calls, and the same one
> Orders already uses for its own `GetUserById` call (see [[grpc-api-key-authorization]]). The PUT
> endpoint's API key is issued to an **external** party (the carrier/webhook) and flows in the
> opposite direction — inbound, not outbound. These must **not** be the same value or the same env
> var/secret: reusing the internal service credential as the externally-distributed carrier key
> would hand an outside vendor the ability to authenticate as an internal service. Provision them
> as two separate secrets.
>
> Both should be treated as rotatable secrets in Parameter Store, per
> [[ADR-0007-secrets-parameter-store]], not hardcoded values. Log failed auth attempts against the
> PUT endpoint (without ever logging the key itself, per [[logging-context]]) — an endpoint that
> mutates delivery state and is reachable without a user JWT is a broader attack surface than the
> rest of the service, and failed-attempt visibility is the cheapest mitigation available.
>
> See [[two-api-keys-two-trust-domains]] for the formal decision record.

### Gateway routing (existing module, not a new one)

Tracking's REST routes are added to the API Gateway the repo already has
(`infra/modules/api-gateway/main.tf`), the same one Users and Orders use — not a new gateway, not
direct service exposure. Concretely:

- Each route is a new entry in that module's `local.routes` map, carrying a route `key` (e.g.
  `"GET /v1/trackings/{orderId}"`) and an `auth` boolean, following the existing pattern for
  Users' and Orders' routes.
- `authorization_type` is `"JWT"` when `auth = true` and `"NONE"` when `auth = false`, with
  `authorizer_id` set only in the `true` case (`main.tf` ~line 123) — **per-route auth opt-out is
  already a supported, used pattern**, not something new this spec introduces. The precedent is
  `var.enable_e2e_cleanup_route`, which creates `DELETE /v1/users/e2e-cleanup` with `auth = false`.
- `POST /v1/trackings/init-tracking`, `GET /v1/trackings/{orderId}`, and the batch read are all
  declared `auth = true` (Cognito JWT). `PUT /v1/trackings/{orderId}/status` is declared
  **`auth = false`** — it is not behind the Cognito authorizer at all; the service validates the
  custom API key itself, the gateway only passes the request through. `GET /v1/tracking/health` is
  also `auth = false` — see
  [Gateway-prefixed health path](#gateway-prefixed-health-path-not-bare-v1health) for why it is
  prefixed rather than bare.
- Locally, the module uses **per-route `HTTP_PROXY` integrations** (a Floci workaround, not a
  production concern) — see [[local-gateway-per-route-integrations]]. Each new Tracking route gets
  its own local integration entry the same way Orders' routes did. In production it is a single
  shared integration.
- The `x-user-id` header on the three Cognito-authenticated routes (init-tracking, the single read,
  the batch read) comes from the local nginx+njs JWT decode, since Floci's API Gateway cannot map
  JWT claims to headers — see [[nginx-njs-x-user-id-injection]]. The PUT endpoint receives no such
  header (see below).

### REST reads

Tracking's reads are REST-only, user-scoped, and serve two purposes: letting the end user see their
own shipment, and giving the repo's [[testing]] convention an HTTP path to verify tracking state
from the gateway (see [Gateway E2E verification of TestMode](#gateway-e2e-verification-of-testmode)
below). They used to be paired with a second, unscoped gRPC surface for inter-service callers, which
was later removed — see
[Deltas from the original design (superseded)](#deltas-from-the-original-design-superseded) for why.

| | REST reads (`GET /v1/trackings/...`) |
|---|---|
| Caller | End user, through the gateway |
| Auth | Cognito JWT, validated by the gateway |
| Scope | **User-scoped** — filtered by `order_id` AND the caller's `cognito_sub`; only the caller's own trackings are ever returned — see [[user-id-vs-cognito-sub-ownership-key]] for why `user_id` must never be the filter |
| Purpose | Let the end user see their own shipment; also the only way to verify tracking state from the gateway (see [Gateway E2E verification](#gateway-e2e-verification-of-testmode) below) |

> [!note] Why reads exist on REST at all
> The original design had reads exposed only over gRPC. That left no way to verify tracking state
> **from the gateway** — the repo's [[testing]] convention requires a gateway E2E test with a real
> Cognito JWT for every endpoint, and the gateway speaks HTTP, not gRPC. There was no HTTP path to
> confirm a `TestMode` tracking actually reached `DELIVERED`. Beyond testing, the end user also has
> a legitimate need to see their own shipment. The unscoped gRPC reads for inter-service callers were
> later removed entirely, once the REST reads already served every consumer — see
> [Deltas from the original design (superseded)](#deltas-from-the-original-design-superseded).

### Ownership & scoping

Both REST read endpoints filter by `order_id` **and** `cognito_sub` in the query itself — not
`user_id`, and not fetch-then-compare — so a caller only ever receives trackings that belong to
them. The caller's identity comes from the gateway-injected `x-user-id` header, the same
mechanism [[orders-service-design]] uses (see its nginx+njs local gateway wiring). See
[[user-id-vs-cognito-sub-ownership-key]] for why the two identity columns are not
interchangeable and what breaks if a read is scoped by `user_id` instead.

This matches Orders' existing ownership semantics exactly (see
[[orders-service-design#API / Endpoints|the ownership note on `GET /v1/orders/{order_id}`]]):

- **Single read (`GET /v1/trackings/{orderId}`):** a tracking that exists but belongs to another
  user returns `404 Not Found`, the same response as a tracking that does not exist at all. The
  endpoint never answers `403 Forbidden` — that would leak the fact that *some* tracking exists for
  that `order_id`, just not to this caller.
- **Batch read (`GET /v1/trackings?order_ids=...`):** the equivalent rule is that non-owned ids
  (whether they belong to another user or don't exist) are simply **omitted** from the result list
  — never surfaced as a per-id error or partial-failure entry. A caller who passes ten ids and owns
  three gets back exactly three trackings, with no indication of what happened to the other seven.

### Batch read query shape

`GET /v1/trackings?order_ids=ord_a,ord_b,ord_c` — a single query parameter holding a
comma-separated list of order ids — is the chosen shape for the many-trackings read. This is the
natural REST idiom for "give me N resources by id" (no request body on a `GET`, no need for a
non-standard batch-specific HTTP method). It also mirrored the shape of the now-removed gRPC
`GetTrackingsByOrderIds` method (which took `order_ids: [string]`, see
[Deltas from the original design (superseded)](#deltas-from-the-original-design-superseded)) closely
enough that the REST handler is a thin translation over the same repository query. The response is a
list of (`Tracking` + `Tracking_History`) pairs, same shape as the single-read endpoint's payload,
one per **owned** order id found among those requested (see
[Ownership & scoping](#ownership--scoping) for the omission rule).

### Gateway E2E verification of TestMode

`GET /v1/trackings/{orderId}` is what makes it possible to verify
[TestMode automatic progression](#testmode-automatic-progression) from the gateway: a gateway E2E
test (real Cognito JWT, hitting the gateway URL, per [[testing]]) can create an order with
`x-test-mode: true` and then **poll** `GET /v1/trackings/{orderId}` until `status` reaches
`DELIVERED`. Before this endpoint existed, there was no HTTP-reachable way to observe that
progression at all — the only reads were gRPC, which the gateway doesn't speak and which internal
tests would have to fake around, missing exactly the class of gateway-only bug [[testing]] exists
to catch.

## gRPC — outbound client to Users

**Tracking serves no gRPC.** It has no gRPC server, no `.proto` of its own, and no inbound
`x-api-key`. Every operation — creation and both reads — is REST, under
[API / Endpoints](#api--endpoints).

The single gRPC in this service points the other way: an **outbound client** calling
`users.v1.Users/GetUserById`, to turn the caller's Cognito `sub` into the internal `usr_` id.
It exists because the gateway hands Tracking a `sub` while the service also wants the internal
id for reporting and cross-service joins — see [Ownership & scoping](#ownership--scoping). This
is inter-service communication, so it stays gRPC per [[ADR-0003-grpc-inter-service]], and it
carries the internal `x-api-key` the Users surface expects.

| Call                          | Sent                     | Received                                              |
|-------------------------------|--------------------------|-------------------------------------------------------|
| `users.v1.Users/GetUserById`  | `{ id: <cognito sub> }`  | `{ id, email, full_name, cognito_sub, address }`      |

Only `id` is consumed by the identity-resolution path. The response also carries the user's
`address`, which Tracking deliberately ignores there: `init-tracking` receives `shipping_address`
in its body, so nothing on that path reads the profile address, and carrying PII through a path
that never uses it is a liability ([[logging-context]]).

> [!note] `ResolvedUser` was widened to carry `email` (events-pipeline milestone)
> `email` is now carried on the `ResolvedUser` domain value, alongside `address` — the exception
> to "no caller needs it" the original docstring reserved. The `TRACKING_STATUS_CHANGED`
> publisher must put the recipient's email address in the event payload: the pipeline's
> `tracking-status-changed` handler rejects a payload missing `email` as a `PermanentError`, so
> without it the notification would never send. Tracking persists no email of its own — Users is
> the only place that holds one — so this RPC's response is where it has to come from. `email` is
> PII exactly like `address`: never log a `ResolvedUser`; log `email_hash` instead, per
> [[logging-context]].

**`NOT_FOUND` means the user does not exist. Every other status propagates** — a Users outage,
a deadline, a rejected key. Collapsing them into "unknown user" would turn an infrastructure
failure into a wrong answer about identity.

This is the same shape Orders uses for its own caller context; see
[[orders-service-design]] and Orders' `ICurrentCaller`, whose central lesson Tracking copies:
reading the sub costs nothing, while resolving the internal id is an explicit, memoized call.
A property getter that fired gRPC would make the log enricher — which reads identity on every
event — a network dependency.

## Data Model

All IDs use prefixed nano-IDs ([[nano-id]]). All tables apply soft-delete ([[soft-delete]]), audit fields ([[audit-fields]]), and follow naming conventions ([[db-naming]]).

### `Tracking`

| Column       | Type         | Notes                              |
|--------------|--------------|------------------------------------|
| `id`         | VARCHAR(21)  | Prefixed nano-ID, PK               |
| `user_id`    | VARCHAR(21)  | The internal `usr_` id, as Orders resolved it from Users. For reporting/joins only — **not** the ownership key reads filter by (see `cognito_sub` below). |
| `cognito_sub` | VARCHAR(255), nullable | **The ownership key every user-scoped REST read filters by** — see [[user-id-vs-cognito-sub-ownership-key]] and [Ownership & scoping](#ownership--scoping). Nullable: a row created before this field existed, or by a caller that omitted it, is simply unreachable over the user-scoped reads rather than mis-attributed to someone else. |
| `order_id`   | VARCHAR(21)  | Reference to order, unique         |
| `status`     | VARCHAR(50)  | Current delivery status — enum: `SHIPPED`, `ON_THE_WAY`, `OUT_FOR_DELIVERY`, `DELIVERED` (see [Tracking statuses](#tracking-statuses)) |
| `shipping_address` | JSON  | Snapshot of the delivery address, received as-is in the `init-tracking` request body — see [Delivery address snapshot](#delivery-address-snapshot) below. |
| `tags`       | JSON, `NOT NULL DEFAULT (JSON_ARRAY())` | Free-form labels; today only `"E2E Source"` is ever written, by [`init-tracking`](#api--endpoints) when the request carries `x-e2e-source: true` under `E2E_TESTING_ENABLED` — see [E2E cleanup](#e2e-cleanup-delete-v1trackingse2e-cleanup). MySQL has no array type, so this is a JSON array queried with `JSON_CONTAINS` rather than a Postgres-style `text[]`. |
| `datetime`   | DATETIME     | Timestamp of the current status    |
| `created_at` | DATETIME     | Audit — see [[audit-fields]]       |
| `updated_at` | DATETIME     | Audit — see [[audit-fields]]       |
| `deleted_at` | DATETIME     | Soft-delete — see [[soft-delete]]  |

#### Delivery address snapshot

`shipping_address` arrives in the `init-tracking` request body (see
[API / Endpoints](#api--endpoints)) and is persisted once, at tracking-creation time — Tracking
does not re-fetch or refresh it, and does not read the address Users returns on its own identity
lookup. It originates in Users and is resolved by Orders during order creation; the full chain is
documented in [[orders-service-design#Delivery address flow (Users → Orders → Tracking)]].

> [!note] Snapshot, not a live reference — deliberately
> This is a point-in-time copy, same as `Order.shipping_address` in Orders (see
> [[orders-service-design]]). If the user's profile address later changes, this record must
> continue to reflect the address the shipment was actually sent to. Do not replace it with a live
> lookup back to Users.

> [!warning] `Tracking_History` does NOT get this column
> The delivery address does not change per status transition — it is fixed for the lifetime of a
> given tracking record. Only `Tracking` carries `shipping_address`; do not add it to
> `Tracking_History` below.

### `Tracking_History`

Immutable log of every status transition.

| Column        | Type         | Notes                                   |
|---------------|--------------|-----------------------------------------|
| `tracking_id` | VARCHAR(21)  | FK → `Tracking.id` (part of PK)         |
| `user_id`     | VARCHAR(21)  | Reference to user                       |
| `order_id`    | VARCHAR(21)  | Reference to order                      |
| `cognito_sub` | VARCHAR(255), nullable | Denormalized off the parent `Tracking`, same as `user_id`/`order_id` above — a transition row needs its own ownership context to stay self-describing, and the read-scoping index below keys on it. |
| `status`      | VARCHAR(50)  | Status at the time of the event — enum: `SHIPPED \| ON_THE_WAY \| OUT_FOR_DELIVERY \| DELIVERED` (part of PK) |
| `datetime`    | DATETIME     | Timestamp of this status transition     |
| `created_at`  | DATETIME     | Audit — see [[audit-fields]]            |
| `updated_at`  | DATETIME     | Audit — see [[audit-fields]]            |
| `deleted_at`  | DATETIME     | Soft-delete — see [[soft-delete]]       |

**Composite PK:** `(tracking_id, status)`.

> [!note] No `tags` column here — deliberately
> Unlike `cognito_sub`, `tags` is **not** denormalized onto `Tracking_History`. History rows are
> reached through their parent's FK, so "the children of every tagged tracking" is already
> expressible without copying the tag down — see [E2E cleanup](#e2e-cleanup-delete-v1trackingse2e-cleanup).
> Copying it would give the tag two sources of truth that a partial update could put out of step.

### Tracking statuses

The `status` field is a fixed enum shared by `Tracking` and `Tracking_History`. Only these four values are valid:

| Value                | Meaning                                           |
|----------------------|---------------------------------------------------|
| `SHIPPED`            | The order has been dispatched from the warehouse. |
| `ON_THE_WAY`         | The shipment is in transit to the destination.    |
| `OUT_FOR_DELIVERY`   | The shipment is out for final-mile delivery.      |
| `DELIVERED`          | The shipment has been delivered to the recipient. |

**State machine — allowed progression (forward only):**

```
SHIPPED → ON_THE_WAY → OUT_FOR_DELIVERY → DELIVERED
```

This progression is enforced in two places: automatically, during
[TestMode automatic progression](#testmode-automatic-progression); and on every real update, via
the [State machine & update guards](#state-machine--update-guards) below.

### TestMode automatic progression

The `init-tracking` endpoint accepts a `test_mode` boolean. When it is true, the created tracking
starts at `SHIPPED` and then advances one status automatically every **10 seconds**, following the
forward-only progression above, until it reaches `DELIVERED`:

| Elapsed | Status              |
|---------|----------------------|
| t=0s    | `SHIPPED` (record created) |
| t=10s   | `ON_THE_WAY`          |
| t=20s   | `OUT_FOR_DELIVERY`    |
| t=30s   | `DELIVERED`           |

Each automatic transition writes a `Tracking_History` row, so a completed `TestMode` run leaves 4
history entries in total. When `TestMode` is false or absent, no automatic progression happens —
status only advances through the `PUT /v1/trackings/{orderId}/status` endpoint below.

Scheduling mechanism, and the accepted limitation if the process restarts mid-progression:
[[testmode-in-process-asyncio-task]].

#### End-to-end origin: a client header on Orders, not an Orders-side decision

`test_mode` is not a value Orders decides on its own — it originates as an **optional HTTP header
on the client's `POST /v1/orders` request** (see [[orders-service-design]]), so the whole flow can
be exercised end to end from the gateway without special-casing Orders. Tracking's contract stays
exactly the `test_mode` field on `init-tracking` above; Tracking has no knowledge of the header —
this section documents the path leading up to that field for the reader tracing the flow.

1. **Header:** `x-test-mode: true` on `POST /v1/orders` (the Orders endpoint) — kebab-case with the
   `x-` prefix, consistent with the repo's existing `x-user-id` and `x-api-key`.
2. **Activation:** only the exact string value `"true"` activates it. Absent, empty, or any other
   value means false.
3. **Guard:** the header only takes effect when the `E2E_TESTING_ENABLED` environment flag is on —
   the same protection Orders already uses for its flag-guarded e2e-cleanup endpoint (JE-54). In
   production the flag is off, so the header is ignored and the simulation can never be triggered
   there; when the flag is off, `test_mode` is always false regardless of the header.
4. **Propagation:** Orders reads the header, applies the guard, and passes the resulting boolean as
   `test_mode` on its HTTP call to `init-tracking` — forwarding the `x-user-id` it received from
   the gateway, so Tracking resolves the caller itself rather than being told who they are.

This is the same context-propagation shape the repo already uses for `x-user-id` (gateway →
service) and W3C `traceparent` (service → service).

```
client → POST /v1/orders (x-test-mode: true)
       → Orders: E2E_TESTING_ENABLED ? header=="true" : false
       → POST /v1/trackings/init-tracking
           { order_id, shipping_address, test_mode }   x-user-id forwarded
       → Tracking: SHIPPED, then +10s each → DELIVERED
```

> [!warning] Orders carries a small but load-bearing responsibility here
> This decision spans two services. Orders owns reading the header, applying the
> `E2E_TESTING_ENABLED` guard, and propagating both the resulting boolean and the caller's
> `x-user-id` to `init-tracking` — a future change to Orders' order-creation flow must not drop
> either, or `test_mode` silently goes permanently false and the tracking loses its owner. See
> [[orders-service-design]] for the Orders-side contract.

### State machine & update guards

`PUT /v1/trackings/{orderId}/status` exists to **simulate a third-party carrier service**
notifying Tracking of a delivery status change. It is subject to the following guards:

> [!important] No JWT, no `x-user-id` — identified by `orderId` alone
> Unlike the two REST read endpoints, this endpoint is **not** called by an end user through the
> Cognito authorizer — it is called by an external carrier/webhook authenticated with a custom API
> key (see [Auth schemes](#auth-schemes)). Its gateway route carries no JWT authorizer, so there is
> no gateway-injected `x-user-id` header on this request at all. Consequently the handler cannot
> scope or verify the caller by identity the way the GET reads do (see
> [Ownership & scoping](#ownership--scoping)) — it identifies the tracking to update purely by the
> `orderId` path parameter (see [Gateway path params are camelCase](#gateway-path-params-are-camelcase-not-snake_case)).
> An implementer who assumes `x-user-id` is present here will write broken code; do not reuse the
> read endpoints' ownership-filter logic on this handler.

> [!warning] No updates once delivered
> A tracking whose status is already `DELIVERED` (terminal) cannot be updated at all — any
> `PUT /v1/trackings/{orderId}/status` request against it must be rejected with `400 Bad Request`.

> [!warning] No backward transitions
> A `DELIVERED` (or any later-status) tracking cannot move back to an earlier status — e.g.
> `DELIVERED` → `SHIPPED` is rejected with `400 Bad Request`.

> [!warning] Forward-only, strictly ahead
> Status updates must otherwise follow the progression above. A request with a status that is
> equal to or earlier than the current status must be rejected with `400 Bad Request`.

## Events

> [!info] Reversal — Tracking now publishes (events-pipeline milestone, 2026-08-04)
> This note previously stated Tracking emits no domain events and is a pure consumer/updater.
> That was accurate before the events-pipeline milestone; it is no longer true. Tracking is now
> a **third producer** alongside Users and Orders, publishing to the same shared SQS queue
> [[events-pipeline-design]] consumes. See [[2026-08-03-events-pipeline-milestone-design]] for the
> full design.

Tracking publishes `TRACKING_STATUS_CHANGED` from `update_tracking_status`
(`src/features/tracking/commands/update_status.py`) — the **single write path** shared by both
the carrier webhook (`PUT /v1/trackings/{orderId}/status`) and TestMode's automatic progression
(see [TestMode automatic progression](#testmode-automatic-progression)). Emitting from this one
call site, rather than from each caller separately, is what guarantees both paths notify the same
way instead of drifting apart.

- **Every successful transition emits, `DELIVERED` included — no suppression.** A TestMode run
  that walks a tracking through all four statuses in ~30 seconds produces **four emails in
  Mailpit** for that one tracking. This is expected, not a bug; E2E assertions for Tracking must
  account for all four transitions, not just the final `DELIVERED` state.
- **`user_id` on the envelope comes from the persisted tracking row, not the request.** The
  carrier webhook carries **no** `x-user-id` at all — it is authenticated by an API key, not a
  Cognito JWT, and its repository lookup is deliberately unscoped (see
  [State machine & update guards](#state-machine--update-guards)). `_emit_status_changed` reads
  `updated.user_id` off the entity `update_tracking_status` already loaded and returned — the
  only source of an owner for this event. `cognito_sub` is deliberately **not** used here; it is
  the ownership key the REST reads filter by, not the envelope's `user_id`.
- **`event_id` is derived from `(order_id, status)`, not generated fresh per attempt.** Given the
  forward-only state machine, this pair is a natural key for a transition. This matters because
  of TestMode: if `event_id` were regenerated on every send attempt, a retry of the same
  transition (e.g. after a transient SQS error) would mint a new id, miss the events-pipeline's
  unique-index dedupe, and send a duplicate notification email for a transition that had already
  succeeded. Deriving from `(order_id, status)` means a retry of the same transition always
  collides on the same id.
- **Publish failures are logged and swallowed, never re-raised.** A `500` here would make the
  carrier's webhook retry a status change that is **already recorded**; the forward-only guard
  would then reject that retry as `400 not_strictly_forward` for a transition that genuinely
  happened — turning a notification failure into a spurious rejection of a legitimate carrier
  update. `SqsEventPublisher`/the publisher-resolution path swallows both send failures and
  publisher-construction failures for this reason; see `_emit_status_changed`'s docstring in
  `update_status.py`.
- **The queue URL is generated, never hardcoded** — `EVENTS_QUEUE_URL` is written into
  `.env.local.tracking` by `make env-file`, the same generated-env-file pattern Users and Orders
  use. See [[env-files]].

Tracking's publisher is a Python/boto3 SQS client (`send_message`), setting `type` and `source`
(`"tracking"`) as message attributes, matching the shape of the Users and Orders publishers. A
Noop-equivalent publisher is retained for tests that must not emit, mirroring
`NoopEventPublisher` in Users and Orders.

See [[events-pipeline-design]] for the consuming side: the shared queue, the dispatch map, the
error taxonomy that decides whether a publish-side failure downstream gets retried, and the
`tracking-status-changed` email template family (one event type, four rendered variants selected
by `payload.status`).

## Cross-cutting rules

| Rule            | Convention               |
|-----------------|--------------------------|
| Soft delete     | [[soft-delete]]          |
| ID generation   | [[nano-id]]              |
| Audit columns   | [[audit-fields]]         |
| Column naming   | [[db-naming]]            |
| API versioning  | [[versioning]]           |
| gRPC transport  | [[ADR-0003-grpc-inter-service]] |
| DB replicas     | [[ADR-0006-read-write-replicas]] |
| Endpoint test coverage | [[testing]]       |
| Secrets (carrier API key, gRPC `x-api-key`) | [[ADR-0007-secrets-parameter-store]] |
| Gateway routing (existing module, per-route local integrations) | [[local-gateway-per-route-integrations]] |
| Event publishing (SQS, generated queue URL) | [[env-files]], [[events-pipeline-design]] |
| `x-user-id` injection (local) | [[nginx-njs-x-user-id-injection]] |

## Deltas from the original design (superseded)

This service was first designed and **built** around gRPC, and shipped that way. Someone reading
git history will find a `proto/tracking.proto`, a gRPC server, an inbound `x-api-key` interceptor,
and generated stubs, all removed later. They were not a false start — they worked and were tested.
This section records why they are gone.

**Creation was `CreateTracking`, a gRPC RPC** ([JE-90](https://linear.app/je-martinez/issue/JE-90)).
Orders called it when confirming an order, passing `user_id` and `cognito_sub` explicitly in the
request. It is now `POST /v1/trackings/init-tracking`.

**Reads were exposed twice**: over gRPC, unscoped, for inter-service callers
([JE-91](https://linear.app/je-martinez/issue/JE-91)), and over REST, user-scoped, for end users.
The gRPC pair is gone; the REST reads already served every consumer.

**Why it changed.** A whole gRPC server — contract, codegen, an authentication interceptor, and a
second transport to keep working — existed to carry two operations that HTTP already carried. The
service was paying the cost of being a gRPC server without the traffic or the cross-language
pressure that justifies one. gRPC remains where it earns its place: as an **outbound client**, for
identity resolution against Users, which is genuinely inter-service and which Orders already does
the same way. See [gRPC — outbound client to Users](#grpc--outbound-client-to-users).

**What this removed along the way**, worth knowing because each was load-bearing at the time:

- The inbound `x-api-key` trust domain. Tracking no longer authenticates any inbound service
  caller; the key it holds now points outward, at Users. Two key-based schemes still exist and are
  still deliberately distinct — see [Auth schemes](#auth-schemes).
- A sync→async bridge. `CreateTracking` ran on a gRPC thread pool with no event loop, so scheduling
  TestMode required registering uvicorn's loop and submitting through `run_coroutine_threadsafe`.
  Creation is now an ordinary async handler, so the progression is scheduled directly and that
  machinery is unnecessary.
- `cognito_sub` as a wire field. Orders used to send it; the gateway now supplies it as `x-user-id`
  on the request itself. It remains a **column**, and remains the ownership key every user-scoped
  read filters by — see [Ownership & scoping](#ownership--scoping). Only its transport changed.

## Related

- [[soft-delete]]
- [[nano-id]]
- [[audit-fields]]
- [[db-naming]]
- [[versioning]]
- [[ADR-0003-grpc-inter-service]]
- [[ADR-0006-read-write-replicas]]
- [[orders-service-design]] — `POST /v1/orders` is where `test_mode` originates (`x-test-mode`
  header, guarded by `E2E_TESTING_ENABLED`) before Orders propagates it to `init-tracking`; also
  where the `shipping_address` forwarded in that request is resolved and persisted;
  also the source of the `404`-not-`403` ownership pattern the REST reads reuse (see
  [Ownership & scoping](#ownership--scoping)) and the `x-user-id` gateway-injection mechanism both
  services rely on.
- [[users-service-design]] — the origin of the delivery address, resolved by Orders via
  `GetUserById` before it reaches Tracking.
- [[logging-context]] — the address must never be logged, the same way plaintext email never is.
- [[testing]] — the three-layer test convention (unit/integration, internal E2E, gateway E2E with a
  real Cognito JWT) that the REST read endpoints exist to satisfy for Tracking's reads.
- [[ADR-0007-secrets-parameter-store]] — both the carrier's PUT-endpoint API key and the internal
  gRPC `x-api-key` should be rotatable secrets in Parameter Store, not hardcoded values; see
  [Auth schemes](#auth-schemes).
- [[local-gateway-per-route-integrations]] — Tracking's routes are added to the existing API
  Gateway module's `local.routes` map, and locally get per-route `HTTP_PROXY` integrations the same
  way Orders' routes did; see [Gateway routing](#gateway-routing-existing-module-not-a-new-one).
- [[nginx-njs-x-user-id-injection]] — where the `x-user-id` header on Tracking's two
  Cognito-authenticated REST reads comes from locally; explicitly absent on the PUT endpoint.
- [[grpc-api-key-authorization]] — the shared `x-api-key` scheme Tracking's outbound
  `GetUserById` call presents to Users, the same mechanism Orders already uses.
- [[user-id-vs-cognito-sub-ownership-key]] — the ADR formalizing why user-scoped reads filter
  by `cognito_sub`, never `user_id`, and the incident that motivated it.
- [[two-api-keys-two-trust-domains]] — the ADR formalizing why `GRPC_API_KEY` and
  `TRACKING_CARRIER_API_KEY` must never collapse into one secret.
- [[testmode-in-process-asyncio-task]] — the ADR formalizing the in-process `asyncio`
  scheduling choice for TestMode and its accepted restart-loses-progress limitation.
- [[events-pipeline-design]] — the consuming side of `TRACKING_STATUS_CHANGED`: the shared SQS
  queue, the dispatch map, the error taxonomy, and the `tracking-status-changed` email template
  family (one event type, four rendered variants).
- [[env-files]] — `EVENTS_QUEUE_URL` is generated into `.env.local.tracking`, never hardcoded.
- [[2026-08-03-events-pipeline-milestone-design]] — the full design for Tracking joining as a
  third producer, including the `event_id` derivation and the `user_id`-from-persisted-row trap.
