---
title: Tracking Service Design
type: spec
area: tracking
status: draft
created: 2026-06-26
updated: 2026-07-29
tags: [type/spec, area/tracking, status/draft]
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
---

# Tracking Service Design

> [!warning] Not implemented yet
> The Tracking service is **design-only** — no application code exists. `services/tracking/src/`
> contains only `.gitkeep` placeholders (no `requirements.txt`, no tests), and
> `services/tracking/Dockerfile` has every build line commented out. Only a stub
> [`services/tracking/CLAUDE.md`](../../../../services/tracking/CLAUDE.md) and a placeholder
> `tracking` service in the root `docker-compose.yml` (build + network wiring only — no ports, no
> database, no healthcheck) exist so far. Everything below describes the **intended** design, not
> running behavior.
>
> This is no longer true of the surrounding repo, though: the infrastructure and patterns
> Tracking needs now **exist** and can be followed directly.
> - **Aurora MySQL cluster** — `infra/environments/local/main.tf` provisions one (`rds_mysql`,
>   engine `mysql` 8.0) via the engine-switchable `rds-aurora` module, currently used by Orders.
> - **gRPC surface** — no longer hypothetical. `proto/users.proto` defines a real service; Users
>   serves it, and Orders consumes it as a client
>   (`services/orders/src/Orders.Infrastructure/Grpc/UserDirectoryGrpcClient.cs`), authenticating
>   calls with a shared `x-api-key` gRPC metadata entry. Tracking's gRPC handlers below follow the
>   same pattern.
>
> What is still genuinely missing, and remains a blocker for Tracking specifically: no
> SQS/messaging Terraform module (`infra/modules/messaging/` is an empty `.gitkeep`) and no
> DocumentDB module (`infra/modules/database/` is empty — only `rds-aurora` is a real module).
> Neither blocks Tracking today — it emits no domain events (see [Events](#events)), so messaging
> is a non-issue either way, and it uses Aurora MySQL, not DocumentDB.

## Summary

The Tracking service is responsible for recording and updating the delivery status of orders.
Creation happens exclusively over **gRPC** — it is triggered by the Orders service confirming an
order, an inter-service call, not a user-facing one (see [[ADR-0003-grpc-inter-service]]). Reads
exist on **both** transports for different callers: gRPC reads are unscoped inter-service lookups
(any order), while REST reads are user-scoped — a caller only ever sees their own trackings (see
[REST reads vs gRPC reads](#rest-reads-vs-grpc-reads) below). The REST surface otherwise stays
narrow: a status-update endpoint that simulates a third-party carrier notifying the system of a
delivery status change, plus the standard health check. The service acts exclusively as a
consumer/updater — it does not emit any domain events.

## Stack & Data Store

| Layer      | Technology                               |
|------------|------------------------------------------|
| Runtime    | Python 3.12 — FastAPI                    |
| Database   | Aurora MySQL (write replica + read replica) |
| Container  | AWS Fargate (ECS)                        |
| Auth       | Amazon Cognito (request validation)      |

Read replicas are used for all reads — both the gRPC (`GetTrackingByOrderId` /
`GetTrackingsByOrderIds`) and REST (`GET /v1/trackings/{orderId}` /
`GET /v1/trackings?order_ids=...`) surfaces; the write replica receives all mutations (gRPC
`CreateTracking` and the REST status-update endpoint). See [[ADR-0006-read-write-replicas]].

## API / Endpoints

Tracking record **creation is gRPC-only** (see [gRPC Methods](#grpc-methods)) — there is no `POST`
under REST. Reads exist on REST too, alongside the gRPC reads — see
[REST reads vs gRPC reads](#rest-reads-vs-grpc-reads) for why both exist. All endpoints are
versioned under `/v1`. See [[versioning]].

All REST routes sit behind the **existing** API Gateway (`infra/modules/api-gateway/`) — the same
one fronting Users and Orders. There is no new/dedicated gateway for Tracking; adding these routes
means adding entries to that module's `local.routes` map, per
[Gateway routing](#gateway-routing-existing-module-not-a-new-one) below.

| Method | Gateway path                       | Auth | Description                          |
|--------|-------------------------------------|------|--------------------------------------|
| GET    | `/v1/tracking/health`               | None | Liveness/readiness probe, **as published at the gateway** — see [Gateway-prefixed health path](#gateway-prefixed-health-path-not-bare-v1health) below for why this is prefixed and not the bare `/v1/health` the service itself serves. Returns `200 { "status": "ok" }` when healthy. Used by ALB/Fargate as health check target. |
| GET    | `/v1/trackings/{orderId}`           | Cognito JWT (gateway authorizer) | Returns one tracking + its `Tracking_History`, scoped to the caller. Filters by `order_id` **and** the caller's `user_id` (from the gateway-injected `x-user-id` header — see [Ownership & scoping](#ownership--scoping)); a tracking that exists but belongs to another user is indistinguishable from one that does not exist — returns `404`, not `403`. Path param is `{orderId}` (camelCase) at the gateway — see [Gateway path params are camelCase](#gateway-path-params-are-camelcase-not-snake_case) below. |
| GET    | `/v1/trackings?order_ids=<csv>`     | Cognito JWT (gateway authorizer) | Returns many trackings (+ each one's `Tracking_History`), scoped to the caller. `order_ids` is a comma-separated list of order ids, e.g. `?order_ids=ord_a,ord_b,ord_c` — see [Batch read query shape](#batch-read-query-shape) for why. Filters by `order_id` **and** the caller's `user_id`; ids that exist but belong to another user (or don't exist at all) are silently **omitted** from the results, never reported as an error — see [Ownership & scoping](#ownership--scoping). |
| PUT    | `/v1/trackings/{orderId}/status`    | Custom API key (service-validated, **not** Cognito) | Simulates a third-party carrier service notifying Tracking of a delivery status change. `status` must be one of the four enum values defined in [Tracking statuses](#tracking-statuses), and is subject to the guards in [State machine & update guards](#state-machine--update-guards). See [Auth schemes](#auth-schemes) — this endpoint has **no `x-user-id`** and is identified by `order_id` alone. Path param is `{orderId}` (camelCase) — see [Gateway path params are camelCase](#gateway-path-params-are-camelcase-not-snake_case). |

> [!warning] Three different auth schemes on one small service
> Unlike Users/Orders, where "all endpoints require a Cognito JWT except health" was previously
> true, Tracking has **three** distinct auth schemes across its surfaces — see
> [Auth schemes](#auth-schemes) below for the full breakdown. Do not assume the PUT endpoint has a
> Cognito JWT or an `x-user-id` header; it has neither.

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

### Auth schemes

Tracking's REST + gRPC surfaces span three separate trust domains — worth documenting explicitly,
because three schemes on one small service is exactly the kind of thing that gets confused:

| Surface | Auth | Caller |
|---|---|---|
| `GET /v1/tracking/health` (gateway) / `/v1/health` (internal) | None | ALB / Fargate health check |
| `GET /v1/trackings/{orderId}` and the batch read | Cognito JWT via the gateway's JWT authorizer, scoped by `x-user-id` | End user |
| `PUT /v1/trackings/{orderId}/status` | Custom API key, validated by the service itself | Third-party carrier / webhook |
| gRPC (`CreateTracking`, both reads) | `x-api-key` interceptor (see [[ADR-0003-grpc-inter-service]]) | Internal services (Orders) |

> [!important] The two key-based schemes are different keys for different trust domains
> The gRPC `x-api-key` is an **internal** service-to-service secret — the same pattern
> [[users-service-design]] established for inter-service calls. The PUT endpoint's API key is
> issued to an **external** party (the carrier/webhook). These must **not** be the same value or
> the same env var/secret: reusing the internal service credential as the externally-distributed
> carrier key would hand an outside vendor the ability to authenticate as an internal service.
> Provision them as two separate secrets.
>
> Both should be treated as rotatable secrets in Parameter Store, per
> [[ADR-0007-secrets-parameter-store]], not hardcoded values. Log failed auth attempts against the
> PUT endpoint (without ever logging the key itself, per [[logging-context]]) — an endpoint that
> mutates delivery state and is reachable without a user JWT is a broader attack surface than the
> rest of the service, and failed-attempt visibility is the cheapest mitigation available.

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
- `GET /v1/trackings/{orderId}` and the batch read are declared `auth = true` (Cognito JWT).
  `PUT /v1/trackings/{orderId}/status` is declared **`auth = false`** — it is not behind the
  Cognito authorizer at all; the service validates the custom API key itself, the gateway only
  passes the request through. `GET /v1/tracking/health` is also `auth = false` — see
  [Gateway-prefixed health path](#gateway-prefixed-health-path-not-bare-v1health) for why it is
  prefixed rather than bare.
- Locally, the module uses **per-route `HTTP_PROXY` integrations** (a Floci workaround, not a
  production concern) — see [[local-gateway-per-route-integrations]]. Each new Tracking route gets
  its own local integration entry the same way Orders' routes did. In production it is a single
  shared integration.
- The `x-user-id` header on the two Cognito-authenticated reads comes from the local nginx+njs JWT
  decode, since Floci's API Gateway cannot map JWT claims to headers — see
  [[nginx-njs-x-user-id-injection]]. The PUT endpoint receives no such header (see below).

### REST reads vs gRPC reads

Tracking exposes reads on **both** transports, and deliberately — they serve different callers with
different trust levels:

| | REST reads (`GET /v1/trackings/...`) | gRPC reads (`GetTrackingByOrderId`, `GetTrackingsByOrderIds`) |
|---|---|---|
| Caller | End user, through the gateway | Other microservices (inter-service) |
| Auth | Cognito JWT, validated by the gateway | `x-api-key` shared secret, per [[ADR-0003-grpc-inter-service]] |
| Scope | **User-scoped** — filtered by `order_id` AND the caller's `user_id`; only the caller's own trackings are ever returned | **Unscoped** — any `order_id`/`order_ids` the caller passes, no per-user filtering |
| Purpose | Let the end user see their own shipment; also the only way to verify tracking state from the gateway (see [Gateway E2E verification](#gateway-e2e-verification-of-testmode) below) | Let a trusted inter-service caller fetch tracking data it needs, e.g. for display in another service's response |

> [!note] Why reads exist on REST at all
> The original design had reads exposed only over gRPC. That left no way to verify tracking state
> **from the gateway** — the repo's [[testing]] convention requires a gateway E2E test with a real
> Cognito JWT for every endpoint, and the gateway speaks HTTP, not gRPC. There was no HTTP path to
> confirm a `TestMode` tracking actually reached `DELIVERED`. Beyond testing, the end user also has
> a legitimate need to see their own shipment. REST reads close both gaps without touching the gRPC
> reads, which stay exactly as they were for inter-service callers.

### Ownership & scoping

Both REST read endpoints filter by `order_id` **and** `user_id` in the query itself — not
fetch-then-compare — so a caller only ever receives trackings that belong to them. The caller's
identity comes from the gateway-injected `x-user-id` header, the same mechanism
[[orders-service-design]] uses (see its nginx+njs local gateway wiring).

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
non-standard batch-specific HTTP method), and it mirrors the gRPC method it fronts
(`GetTrackingsByOrderIds`, which takes `order_ids: [string]`) closely enough that the REST handler
is a thin translation over the same repository query. The response is a list of (`Tracking` +
`Tracking_History`) pairs, same shape as the single-read endpoint's payload, one per **owned**
order id found among those requested (see [Ownership & scoping](#ownership--scoping) for the
omission rule).

### Gateway E2E verification of TestMode

`GET /v1/trackings/{orderId}` is what makes it possible to verify
[TestMode automatic progression](#testmode-automatic-progression) from the gateway: a gateway E2E
test (real Cognito JWT, hitting the gateway URL, per [[testing]]) can create an order with
`x-test-mode: true` and then **poll** `GET /v1/trackings/{orderId}` until `status` reaches
`DELIVERED`. Before this endpoint existed, there was no HTTP-reachable way to observe that
progression at all — the only reads were gRPC, which the gateway doesn't speak and which internal
tests would have to fake around, missing exactly the class of gateway-only bug [[testing]] exists
to catch.

## gRPC Methods

Tracking record creation is gRPC-only. Reads are also exposed over gRPC, for inter-service
callers — trusted via `x-api-key` and **unscoped** to any particular end user, unlike the
user-scoped REST reads under [API / Endpoints](#api--endpoints). See
[REST reads vs gRPC reads](#rest-reads-vs-grpc-reads) for the full comparison, and
[[ADR-0003-grpc-inter-service]] for why gRPC is the inter-service protocol in the first place.

### Creation

Tracking records are created exclusively through this handler — never over REST. The caller is the
Orders service, confirming an order; this is inter-service communication, consistent with
[[ADR-0003-grpc-inter-service]].

| Method            | Request                                                                                    | Response                          |
|--------------------|---------------------------------------------------------------------------------------------|-----------------------------------|
| `CreateTracking`  | `{ order_id: string, user_id: string, shipping_address: Address, test_mode: bool }`         | Newly created `Tracking` message  |

`test_mode` (`TestMode`) controls automatic progression after creation — see
[TestMode automatic progression](#testmode-automatic-progression).

`shipping_address` is a snapshot of the delivery address, resolved by Orders via Users'
`GetUserById` and forwarded as-is — Tracking does not resolve or validate it, only persists it. See
[[orders-service-design#Delivery address flow (Users → Orders → Tracking)]] for the full path and
[[users-service-design]] for the typed `Address` wire shape and its privacy implication (never log
it — see [[logging-context]]).

> [!note] `test_mode` originates outside Tracking
> Tracking's own contract here is unchanged: it just receives a boolean. But that boolean is not
> Orders' own decision — it originates as an **optional HTTP header on the client's request**, so
> the full flow can be exercised end to end from the gateway. See
> [TestMode automatic progression](#testmode-automatic-progression) for the end-to-end path and
> [[orders-service-design]] for the Orders-side responsibility (reading the header, applying the
> guard, propagating the boolean).

### Reads

Both read methods return the tracking **together with its history** — not a bare `Tracking`
message. Neither filters by `user_id`: the caller is a trusted inter-service client (authenticated
via `x-api-key`, per [[ADR-0003-grpc-inter-service]]), not an end user, so any `order_id`/
`order_ids` passed in is looked up as-is. This is the deliberate difference from the REST reads —
see [REST reads vs gRPC reads](#rest-reads-vs-grpc-reads) under [API / Endpoints](#api--endpoints).

| Method                    | Request                        | Response                                            |
|---------------------------|--------------------------------|------------------------------------------------------|
| `GetTrackingByOrderId`    | `{ order_id: string }`         | `Tracking` message + its `Tracking_History` entries  |
| `GetTrackingsByOrderIds`  | `{ order_ids: [string] }`      | List of (`Tracking` + its `Tracking_History` entries) |

## Data Model

All IDs use prefixed nano-IDs ([[nano-id]]). All tables apply soft-delete ([[soft-delete]]), audit fields ([[audit-fields]]), and follow naming conventions ([[db-naming]]).

### `Tracking`

| Column       | Type         | Notes                              |
|--------------|--------------|------------------------------------|
| `id`         | VARCHAR(21)  | Prefixed nano-ID, PK               |
| `user_id`    | VARCHAR(21)  | Reference to user                  |
| `order_id`   | VARCHAR(21)  | Reference to order, unique         |
| `status`     | VARCHAR(50)  | Current delivery status — enum: `SHIPPED`, `ON_THE_WAY`, `OUT_FOR_DELIVERY`, `DELIVERED` (see [Tracking statuses](#tracking-statuses)) |
| `shipping_address` | JSON  | Snapshot of the delivery address, received as-is from Orders' `CreateTracking` call — see [Delivery address snapshot](#delivery-address-snapshot) below. |
| `datetime`   | DATETIME     | Timestamp of the current status    |
| `created_at` | DATETIME     | Audit — see [[audit-fields]]       |
| `updated_at` | DATETIME     | Audit — see [[audit-fields]]       |
| `deleted_at` | DATETIME     | Soft-delete — see [[soft-delete]]  |

#### Delivery address snapshot

`shipping_address` arrives on the `CreateTracking` gRPC call (see [Creation](#creation) above) and
is persisted once, at tracking-creation time — Tracking does not re-fetch or refresh it. It
originates in Users and is resolved by Orders during order creation; the full chain is documented
in [[orders-service-design#Delivery address flow (Users → Orders → Tracking)]].

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
| `status`      | VARCHAR(50)  | Status at the time of the event — enum: `SHIPPED \| ON_THE_WAY \| OUT_FOR_DELIVERY \| DELIVERED` (part of PK) |
| `datetime`    | DATETIME     | Timestamp of this status transition     |
| `created_at`  | DATETIME     | Audit — see [[audit-fields]]            |
| `updated_at`  | DATETIME     | Audit — see [[audit-fields]]            |
| `deleted_at`  | DATETIME     | Soft-delete — see [[soft-delete]]       |

**Composite PK:** `(tracking_id, status)`.

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

The `CreateTracking` gRPC handler accepts a `TestMode` boolean. When `TestMode=true`, the created
tracking starts at `SHIPPED` and then advances one status automatically every **10 seconds**,
following the forward-only progression above, until it reaches `DELIVERED`:

| Elapsed | Status              |
|---------|----------------------|
| t=0s    | `SHIPPED` (record created) |
| t=10s   | `ON_THE_WAY`          |
| t=20s   | `OUT_FOR_DELIVERY`    |
| t=30s   | `DELIVERED`           |

Each automatic transition writes a `Tracking_History` row, so a completed `TestMode` run leaves 4
history entries in total. When `TestMode` is false or absent, no automatic progression happens —
status only advances through the `PUT /v1/trackings/{orderId}/status` endpoint below.

#### End-to-end origin: a client header on Orders, not an Orders-side decision

`test_mode` is not a value Orders decides on its own — it originates as an **optional HTTP header
on the client's `POST /v1/orders` request** (see [[orders-service-design]]), so the whole flow can
be exercised end to end from the gateway without special-casing Orders. Tracking's contract stays
exactly the `test_mode` field on `CreateTracking` above; Tracking has no knowledge of the header —
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
   `test_mode` in the `CreateTracking` gRPC call to Tracking.

This is the same context-propagation shape the repo already uses for `x-user-id` (gateway →
service) and W3C `traceparent` (service → service over gRPC).

```
client → POST /v1/orders (x-test-mode: true)
       → Orders: E2E_TESTING_ENABLED ? header=="true" : false
       → gRPC CreateTracking({ order_id, user_id, test_mode })
       → Tracking: SHIPPED, then +10s each → DELIVERED
```

> [!warning] Orders carries a small but load-bearing responsibility here
> This decision spans two services. Orders owns reading the header, applying the
> `E2E_TESTING_ENABLED` guard, and propagating the resulting boolean into `CreateTracking` — a
> future change to Orders' order-creation flow must not drop this step, or `test_mode` silently
> goes permanently false. See [[orders-service-design]] for the Orders-side contract.

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

> [!info] No events emitted
> The Tracking service does **not** produce any domain events. It is a pure consumer/updater: it receives tracking creation and status-update requests (via gRPC and the REST status-update endpoint, including the automatic `TestMode` transitions) and persists them — it does not publish to SQS or any event bus.

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
| `x-user-id` injection (local) | [[nginx-njs-x-user-id-injection]] |

## Related

- [[soft-delete]]
- [[nano-id]]
- [[audit-fields]]
- [[db-naming]]
- [[versioning]]
- [[ADR-0003-grpc-inter-service]]
- [[ADR-0006-read-write-replicas]]
- [[orders-service-design]] — `POST /v1/orders` is where `test_mode` originates (`x-test-mode`
  header, guarded by `E2E_TESTING_ENABLED`) before Orders propagates it into `CreateTracking`; also
  where the `shipping_address` snapshot forwarded to `CreateTracking` is resolved and persisted;
  also the source of the `404`-not-`403` ownership pattern the REST reads reuse (see
  [REST reads vs gRPC reads](#rest-reads-vs-grpc-reads)) and the `x-user-id` gateway-injection
  mechanism both services rely on.
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
