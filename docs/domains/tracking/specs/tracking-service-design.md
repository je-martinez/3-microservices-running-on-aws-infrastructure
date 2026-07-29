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
  - "[[orders-service-design]]"
  - "[[users-service-design]]"
  - "[[logging-context]]"
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
Creation and reads happen exclusively over **gRPC** — creation is triggered by the Orders service
confirming an order, an inter-service call, not a user-facing one (see [[ADR-0003-grpc-inter-service]]).
The only REST surface is a narrow **status-update** endpoint that simulates a third-party carrier
notifying the system of a delivery status change, plus the standard health check. The service acts
exclusively as a consumer/updater — it does not emit any domain events.

## Stack & Data Store

| Layer      | Technology                               |
|------------|------------------------------------------|
| Runtime    | Python 3.12 — FastAPI                    |
| Database   | Aurora MySQL (write replica + read replica) |
| Container  | AWS Fargate (ECS)                        |
| Auth       | Amazon Cognito (request validation)      |

Read replicas are used for all reads (the gRPC `GetTrackingByOrderId` / `GetTrackingsByOrderIds` methods); the write replica receives all mutations (gRPC `CreateTracking` and the REST status-update endpoint). See [[ADR-0006-read-write-replicas]].

## API / Endpoints

Tracking record **creation and reads are gRPC-only** (see [gRPC Methods](#grpc-methods)) — there is
no `POST` and no `GET` under REST. The REST surface is intentionally small: the health check and a
single status-update endpoint. All endpoints are versioned under `/v1`. See [[versioning]].

| Method | Path                              | Description                          |
|--------|-----------------------------------|--------------------------------------|
| GET    | `/v1/health`                      | Liveness/readiness probe. Returns `200 { "status": "ok" }` when healthy. No auth required. Used by ALB/Fargate as health check target. |
| PUT    | `/v1/trackings/{order_id}/status` | Simulates a third-party carrier service notifying Tracking of a delivery status change. `status` must be one of the four enum values defined in [Tracking statuses](#tracking-statuses), and is subject to the guards in [State machine & update guards](#state-machine--update-guards). |

> [!note] Auth
> All endpoints require a valid Cognito JWT, **except `/v1/health`** which is unauthenticated. The API Gateway validates the token before routing to the service.

## gRPC Methods

Tracking record creation and all reads use gRPC instead of REST. See [[ADR-0003-grpc-inter-service]].

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

Both read methods return the tracking **together with its history** — not a bare `Tracking` message.

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
status only advances through the `PUT /v1/trackings/{order_id}/status` endpoint below.

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

`PUT /v1/trackings/{order_id}/status` exists to **simulate a third-party carrier service**
notifying Tracking of a delivery status change. It is subject to the following guards:

> [!warning] No updates once delivered
> A tracking whose status is already `DELIVERED` (terminal) cannot be updated at all — any
> `PUT /v1/trackings/{order_id}/status` request against it must be rejected with `400 Bad Request`.

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
  where the `shipping_address` snapshot forwarded to `CreateTracking` is resolved and persisted.
- [[users-service-design]] — the origin of the delivery address, resolved by Orders via
  `GetUserById` before it reaches Tracking.
- [[logging-context]] — the address must never be logged, the same way plaintext email never is.
