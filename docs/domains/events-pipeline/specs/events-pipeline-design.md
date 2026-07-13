---
title: Events Pipeline Design
type: spec
area: events-pipeline
status: draft
created: 2026-06-26
updated: 2026-07-12
tags: [type/spec, area/events-pipeline, status/draft]
related:
  - "[[cqrs]]"
  - "[[ADR-0002-cqrs]]"
  - "[[nano-id]]"
  - "[[ADR-0005-nano-id-prefixed]]"
  - "[[audit-fields]]"
  - "[[soft-delete]]"
  - "[[ADR-0004-soft-delete-only]]"
---

# Events Pipeline Design

> [!warning] Not implemented yet
> The events-pipeline service is **design-only** — no source code exists. `services/events-pipeline/src/`
> contains only `.gitkeep` placeholders (no `package.json`, no tests), and
> `services/events-pipeline/Dockerfile` has every build line commented out. Only a stub
> [`services/events-pipeline/CLAUDE.md`](../../../../services/events-pipeline/CLAUDE.md) and a
> placeholder `events-pipeline` service in the root `docker-compose.yml` (build + network wiring
> only — no ports, no database, no healthcheck) exist so far. Everything below describes the
> **intended** design, not running behavior.
>
> The supporting infrastructure this design assumes is also not built yet: there is no
> SQS/messaging Terraform module (`infra/modules/messaging/` is an empty `.gitkeep`) and no
> DocumentDB module (`infra/modules/database/` is empty — only `rds-aurora` exists).

## Summary

The events pipeline is a single AWS Lambda function triggered by SQS messages. It receives domain events from the three microservices (Users, Orders, Tracking), persists each message in DocumentDB, and dispatches it to the appropriate handler using the CQRS pattern. The status of every message is tracked through a well-defined state machine.

## Stack & Data Store

| Layer | Technology |
|---|---|
| Message broker | AWS SQS |
| Compute | AWS Lambda (single function, Node.js) |
| Data store | AWS DocumentDB (MongoDB-compatible) |
| Schema validation | Zod |
| ID generation | prefix\_nanoid (see [[nano-id]]) |

A single Lambda function consumes the SQS queue. DocumentDB stores the full event document — including the `status_history` array — so the audit trail is append-only and never destructively updated.

## API / Endpoints

The pipeline has no public REST endpoints. It is invoked exclusively by the SQS trigger. Other services may query event state via a future internal gRPC method; none is defined in this milestone.

## gRPC Methods

None defined for this milestone.

## Dispatch

The Lambda applies the CQRS pattern (see [[cqrs]] and [[ADR-0002-cqrs]]) to route each incoming event to its dedicated handler. The dispatch map is a plain object keyed by `type`:

```typescript
const handlers: Record<EventType, EventHandler> = {
  USER_CREATED:  UserCreatedHandler,
  ORDER_CREATED: OrderCreatedHandler,
};
```

Execution flow per SQS record:

1. Parse and validate the SQS message body (Zod schema).
2. Persist the event document with `status: STARTED`.
3. Look up the handler: `handlers[event.type]`.
4. If no handler is registered, set status to `FAILED` with `error: "Unknown event type"` and return.
5. Update status to `IN_PROGRESS` and invoke the handler.
6. On success: update status to `COMPLETED`.
7. On exception: capture the error message, update status to `FAILED`.

> [!note] Single Lambda
> All handlers live in the same Lambda deployment. Adding a new event type requires only registering a new key in the dispatch map and deploying; no infrastructure change is needed.

## Status Machine

Each event document moves through four states. Transitions are recorded as entries in the `status_history` array (append-only).

| State | Trigger | Description |
|---|---|---|
| `STARTED` | SQS message received | Document created in DocumentDB before any processing begins. |
| `IN_PROGRESS` | Handler lookup succeeds | Status updated immediately before invoking the handler. |
| `COMPLETED` | Handler returns without error | Final success state; no further transitions. |
| `FAILED` | Unknown type or handler exception | Error message stored in `error` field; no retry is applied at this layer. |

```
SQS message received
       │
       ▼
  [STARTED] ──── unknown type ────► [FAILED]
       │
       ▼
 [IN_PROGRESS] ── exception ──────► [FAILED]
       │
       ▼
  [COMPLETED]
```

## Data Model

Collection: `events` (DocumentDB)

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | DocumentDB primary key |
| `friendlyId` | string | Prefixed nano-id, e.g. `evt_wldA4A0WwZAKUm`. See [[nano-id]] and [[ADR-0005-nano-id-prefixed]]. |
| `order_id` | string | ID of the related order (nullable for non-order events). |
| `user_id` | string | ID of the originating user. |
| `type` | string (enum) | e.g. `USER_CREATED`, `ORDER_CREATED`. |
| `source` | string | Which microservice emitted the event (e.g. `users`, `orders`). |
| `payload` | object | Full event payload as-received; structure varies by `type`. |
| `status` | string (enum) | Current state: `STARTED` \| `IN_PROGRESS` \| `COMPLETED` \| `FAILED`. |
| `error` | string \| null | Populated only when `status = FAILED`. |
| `status_history` | array of objects | Append-only log: `{ status, timestamp, error? }` per transition. |
| `createdBy` | string | See [[audit-fields]]. |
| `createdAt` | datetime | See [[audit-fields]]. |
| `updatedBy` | string | See [[audit-fields]]. |
| `updatedAt` | datetime | See [[audit-fields]]. |
| `deletedBy` | string \| null | See [[audit-fields]]. |
| `deletedAt` | datetime \| null | See [[audit-fields]]. |

`isDeleted` is a computed property (`deletedAt != null`). Hard deletes are prohibited; see [[soft-delete]] and [[ADR-0004-soft-delete-only]].

DocumentDB indexes:

- `friendlyId` (unique)
- `order_id`
- `user_id`
- `type`
- `status`
- `createdAt`

## Events

This service does not emit downstream events in the current milestone. It is the terminal consumer of events from Users, Orders, and Tracking.

## Cross-cutting rules

- **Soft delete only:** documents are never hard-deleted. See [[soft-delete]] and [[ADR-0004-soft-delete-only]].
- **Prefixed nano-IDs:** `friendlyId` uses the `evt_` prefix. See [[nano-id]] and [[ADR-0005-nano-id-prefixed]].
- **Audit fields:** all documents carry the six standard audit fields plus the computed `isDeleted`. See [[audit-fields]].
- **CQRS dispatch:** handler selection is by event `type`; commands and queries are never mixed in the same handler. See [[cqrs]] and [[ADR-0002-cqrs]].

## Related

- [[cqrs]]
- [[ADR-0002-cqrs]]
- [[nano-id]]
- [[ADR-0005-nano-id-prefixed]]
- [[audit-fields]]
- [[soft-delete]]
- [[ADR-0004-soft-delete-only]]
