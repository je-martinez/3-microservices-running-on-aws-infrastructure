---
title: Tracking Service Design
type: spec
area: tracking
status: active
created: 2026-06-26
updated: 2026-06-27
tags: [type/spec, area/tracking, status/active]
related:
  - "[[soft-delete]]"
  - "[[nano-id]]"
  - "[[audit-fields]]"
  - "[[db-naming]]"
  - "[[versioning]]"
  - "[[ADR-0003-grpc-inter-service]]"
  - "[[ADR-0006-read-write-replicas]]"
---

# Tracking Service Design

## Summary

The Tracking service is responsible for recording and updating the delivery status of orders. It exposes a REST API for status mutations and a gRPC interface for efficient inter-service reads. It acts exclusively as a consumer/updater — it does not emit any domain events.

## Stack & Data Store

| Layer      | Technology                               |
|------------|------------------------------------------|
| Runtime    | Python 3.12 — FastAPI                    |
| Database   | Aurora MySQL (write replica + read replica) |
| Container  | AWS Fargate (ECS)                        |
| Auth       | Amazon Cognito (request validation)      |

Read replicas are used for all `GET` queries; write replica receives all mutations. See [[ADR-0006-read-write-replicas]].

## API / Endpoints

All endpoints are versioned under `/v1`. See [[versioning]].

| Method | Path                              | Description                          |
|--------|-----------------------------------|--------------------------------------|
| GET    | `/health`                         | Liveness/readiness probe. Returns `200 { "status": "ok" }` when healthy. No auth required. Used by ALB/Fargate as health check target. |
| POST   | `/trackings`                      | Create a new tracking record         |
| PUT    | `/trackings/{order_id}/status`    | Update the status of a tracking entry. `status` must be one of the four enum values defined in [Tracking statuses](#tracking-statuses). |

> [!note] Auth
> All endpoints require a valid Cognito JWT, **except `/health`** which is unauthenticated. The API Gateway validates the token before routing to the service.

## gRPC Methods

Inter-service reads use gRPC instead of REST. See [[ADR-0003-grpc-inter-service]].

| Method                    | Request                        | Response                          |
|---------------------------|--------------------------------|-----------------------------------|
| `GetTrackingByOrderId`    | `{ order_id: string }`         | Single `Tracking` message         |
| `GetTrackingsByOrderIds`  | `{ order_ids: [string] }`      | List of `Tracking` messages       |

## Data Model

All IDs use prefixed nano-IDs ([[nano-id]]). All tables apply soft-delete ([[soft-delete]]), audit fields ([[audit-fields]]), and follow naming conventions ([[db-naming]]).

### `Tracking`

| Column       | Type         | Notes                              |
|--------------|--------------|------------------------------------|
| `id`         | VARCHAR(21)  | Prefixed nano-ID, PK               |
| `user_id`    | VARCHAR(21)  | Reference to user                  |
| `order_id`   | VARCHAR(21)  | Reference to order, unique         |
| `status`     | VARCHAR(50)  | Current delivery status — enum: `SHIPPED`, `ON_THE_WAY`, `OUT_FOR_DELIVERY`, `DELIVERED` (see [Tracking statuses](#tracking-statuses)) |
| `datetime`   | DATETIME     | Timestamp of the current status    |
| `created_at` | DATETIME     | Audit — see [[audit-fields]]       |
| `updated_at` | DATETIME     | Audit — see [[audit-fields]]       |
| `deleted_at` | DATETIME     | Soft-delete — see [[soft-delete]]  |

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

> [!warning] No backward transitions
> Status updates must follow the progression above. A `PUT /trackings/{order_id}/status` request with a status that is equal to or earlier than the current status must be rejected with `400 Bad Request`.

## Events

> [!info] No events emitted
> The Tracking service does **not** produce any domain events. It is a pure consumer/updater: it receives status update requests (via REST or internal triggers) and persists them — it does not publish to SQS or any event bus.

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
