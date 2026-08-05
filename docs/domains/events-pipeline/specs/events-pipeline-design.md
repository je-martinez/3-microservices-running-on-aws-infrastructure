---
title: Events Pipeline Design
type: spec
area: events-pipeline
status: accepted
created: 2026-06-26
updated: 2026-08-05
tags: [type/spec, area/events-pipeline, status/accepted]
related:
  - "[[cqrs]]"
  - "[[ADR-0002-cqrs]]"
  - "[[nano-id]]"
  - "[[ADR-0005-nano-id-prefixed]]"
  - "[[audit-fields]]"
  - "[[soft-delete]]"
  - "[[ADR-0004-soft-delete-only]]"
  - "[[env-files]]"
  - "[[testing]]"
  - "[[logging-context]]"
  - "[[tracking-service-design]]"
  - "[[2026-08-03-events-pipeline-milestone-design]]"
  - "[[2026-08-03-events-pipeline-milestone]]"
  - "[[terraform-modules]]"
---

# Events Pipeline Design

> [!info] Implemented, committed, and verified end to end (2026-08-04)
> The code exists at [`functions/events-pipeline/`](../../../../functions/events-pipeline/) —
> **not** `services/` — because this is a Lambda, not a long-running microservice. It is
> committed on `feature/events-pipeline`. The design below describes what shipped, not intent.
> SQS (+ DLQ) feeds one Lambda that dispatches by event `type`, persists the event document to
> DocumentDB, renders a react-email template, and sends it via SES (Mailpit is the local inbox).
> Three producers publish to **one shared queue**: Users (`USER_CREATED`), Orders
> (`ORDER_CREATED`), and Tracking (`TRACKING_STATUS_CHANGED`, on every delivery-status
> transition). Verified end to end with a real `POST /v1/users/register`: the request produced a
> DocumentDB document that walked `STARTED → IN_PROGRESS → COMPLETED` and delivered a
> "Welcome to 3MRAI" email to Mailpit. Test counts: 106 pipeline, 209 Users, 101 Orders, 457
> Tracking.

## Summary

The events pipeline is a single AWS Lambda function triggered by SQS messages. It receives
domain events from the three microservices (Users, Orders, Tracking), persists each message in
DocumentDB, dispatches it to the appropriate handler using the CQRS pattern, and — this is the
part the original design-only note did not have — **the handler renders an email from the event
and sends it**. A handler here does not just record an event; it turns the event into a
notification. The status of every message is tracked through a well-defined state machine.

## Stack & Data Store

| Layer | Technology |
|---|---|
| Message broker | AWS SQS (one shared queue) + DLQ |
| Compute | AWS Lambda (single function, Node.js, `nodejs20.x` runtime) |
| Data store | AWS DocumentDB (MongoDB-compatible) |
| Schema validation | Zod |
| Email rendering | react-email (`@react-email/render`), templates as `.tsx` under `emails/` |
| Email transport | AWS SES (Mailpit as the local inbox) |
| ID generation | none — `event_id` is producer-generated, not minted by the pipeline (see [[#Data Model]]) |

A single Lambda function consumes the SQS queue. DocumentDB stores the full event document —
including the `status_history` array — so the audit trail is append-only and never destructively
updated.

The Lambda ships as a **single CommonJS esbuild bundle** (`dist/handler.js`), deliberately CJS
even though the source is ESM (`"type": "module"` in `package.json`). `archive_file` zips the
*contents* of `dist/` at the zip root, so the deployed function is a bare `.js` file with no
`package.json` next to it — nothing tells the runtime it is ESM, and the `nodejs20.x` runtime
resolves an extension-less `.js` as CommonJS. This was verified empirically, not assumed: an ESM
bundle emitted as `.js` loads fine under Node 24 (which sniffs module syntax) but fails under the
`nodejs20.x` runtime with `ERR_REQUIRE_CYCLE_MODULE` — a Node-24-only test would have reported a
false pass. Bundling itself (not plain `tsc`) is what makes the zip self-contained: plain `tsc`
left the `#` subpath imports (`#domain/*`, `#pipeline/*`, `#email/*`, `#handlers/*`,
`#shared/*`) unresolved in its output, and Node resolves `#` specifiers through the nearest
`package.json` — which `dist/` does not have — so the first invocation died with
`ERR_PACKAGE_IMPORT_NOT_DEFINED` before any handler code ran. esbuild resolves the `#`
specifiers at build time and inlines dependencies (including `mongodb`, `zod`, react/jsx-runtime,
and the react-email packages) so nothing is left to resolve at runtime. Type checking is not
lost: `pnpm run build` runs `tsc --noEmit` first — esbuild only strips types, it never checks
them.

## API / Endpoints

The pipeline has no public REST endpoints. It is invoked exclusively by the SQS trigger via an
`aws_lambda_event_source_mapping`.

## gRPC Methods

None. The pipeline is not a gRPC server or client.

## Dispatch

The Lambda applies the CQRS pattern (see [[cqrs]] and [[ADR-0002-cqrs]]) to route each incoming
event to its dedicated handler. The dispatch map (`src/handlers/index.ts`) is a plain object keyed
by `type`:

```typescript
const handlers: HandlerMap = {
  USER_CREATED: userCreatedHandler,
  ORDER_CREATED: orderCreatedHandler,
  TRACKING_STATUS_CHANGED: trackingStatusChangedHandler,
};
```

Execution flow per SQS record (`src/pipeline/process-record.ts`, AWS-SDK-free and unit-testable
without the emulator):

1. Parse and validate the SQS message body (Zod schema, `src/domain/envelope.ts`).
2. Persist the event document with `status: STARTED`, keyed by the producer-supplied `event_id`
   — persisted **before** dispatch, so a record with an invalid payload is still recorded as
   `FAILED` rather than silently dropped.
3. Look up the handler: `handlers[event.type]`.
4. If no handler is registered, set status to `FAILED` with `error: "Unknown event type"` and
   return (`PermanentError`, message consumed).
5. Update status to `IN_PROGRESS` and invoke the handler.
6. On success: update status to `COMPLETED`.
7. On exception: capture the error message, update status to `FAILED`, and classify the error
   (see [Error taxonomy](#error-taxonomy-load-bearing) below) to decide whether SQS should retry.

> [!note] Single Lambda
> All handlers live in the same Lambda deployment. Adding a new event type requires only
> registering a new key in the dispatch map and deploying; no infrastructure change is needed.
> This was proven, not assumed: `USER_CREATED` shipped first, end-to-end, and `ORDER_CREATED`
> was added second specifically to confirm it really is "one dispatch-map entry" and nothing
> more.

## Error taxonomy (load-bearing)

Every error a handler or the pipeline itself can raise falls into exactly one of two classes
(`src/pipeline/errors.ts`), and the class decides what SQS does next — this is not incidental
detail, it is what keeps a bad payload from becoming an infinite retry loop and what keeps a
transient outage from silently dropping an event:

- **`PermanentError`** — invalid payload, unknown event type, or a missing email template.
  Recorded `FAILED` and the SQS message is **consumed** (not reported as a batch item failure) —
  retrying a permanently invalid message can never make it valid, so retrying it would only
  waste attempts until it lands in the DLQ for the wrong reason.
- **`TransientError`** — DocumentDB or SES unreachable (network failure, timeout). The record's
  message id is returned in `batchItemFailures`, so SQS retries **only that record**, and it
  eventually lands in the DLQ if retries are exhausted (`maxReceiveCount = 3`).
- **Anything unclassified is treated as transient, deliberately.** `isTransient()` returns `true`
  for anything that is not a `PermanentError` — including a bare `Error` or a non-`Error` thrown
  value. This is a considered default, not an oversight: it prefers a retry over silently losing
  an event. An error that should have been permanent but was thrown as a bare `Error` costs a
  couple of wasted retries before landing in the DLQ; an error that should have been transient
  but was misclassified as permanent would drop a real event on its first failure.

Partial batch responses (`{ batchItemFailures: [{ itemIdentifier: <messageId> }] }`) are what
make the per-record retry possible — verified working on Floci, retrying only the failed records
and never the whole batch.

## Status Machine

Each event document moves through four states. Transitions are recorded as entries in the `status_history` array (append-only).

| State | Trigger | Description |
|---|---|---|
| `STARTED` | SQS message received | Document created in DocumentDB before any processing begins. |
| `IN_PROGRESS` | Handler lookup succeeds | Status updated immediately before invoking the handler. |
| `COMPLETED` | Handler returns without error | Final success state; no further transitions. |
| `FAILED` | Unknown type or handler exception | Error message stored in `error` field. A `PermanentError` here is final; a `TransientError` here is what SQS retries — see [Error taxonomy](#error-taxonomy-load-bearing). |

```
SQS message received
       │
       ▼
  [STARTED] ──── unknown type ────► [FAILED] (permanent, consumed)
       │
       ▼
 [IN_PROGRESS] ── PermanentError ──► [FAILED] (consumed)
       │
       └──────── TransientError ───► [FAILED] (batchItemFailures → SQS retry → DLQ)
       │
       ▼
  [COMPLETED]
```

## Data Model

Collection: `events` (DocumentDB)

> [!info] `event_id` is the only identifier — no `friendlyId`
> The events-pipeline does **not** mint its own display id. `event_id` is generated by the
> **producer** (Users, Orders, Tracking) and is the event's only identifier, carrying the
> unique index used for idempotency. There is no `evt_`-prefixed nano-id and no `nanoid`
> dependency in this package — see [[nano-id]] for why this service no longer participates in
> that scheme.

### The envelope's `author` object

Every producer sets a required `author` object (`src/domain/envelope.ts`, `AuthorSchema`) on the
SQS message body, alongside the existing `event_id`/`type`/`source`/`user_id`/`order_id`/
`payload` fields:

| Field | Type | Notes |
|---|---|---|
| `author.actor` | string | Required. The producer's semantic `AuditActor` (e.g. `users_api:register`, `tracking_api:carrier_status_update`) — the same value that service already stamps into its own `created_by` column. Becomes this document's `created_by` (see below). |
| `author.user_id` | string | Optional, omitted (never null) when no human originated the event. |
| `author.cognito_sub` | string | Optional, omitted (never null) when the human actor supplied no Cognito sub. |

`author` is **required**, not optional: an optional field would silently permit an unattributed
event with no signal that attribution was missing. There is deliberately no `author.source` —
the producing service is already the envelope's root `source`, and a second copy would only
invite disagreement.

`author.actor`/`author.user_id`/`author.cognito_sub` are also what the Lambda flattens into
`author_actor`/`author_user_id`/`author_cognito_sub` on every per-record log line — see
[[logging-context]].

| Field | Type | Notes |
|---|---|---|
| `event_id` | string | Producer-generated idempotency key; the event's only identifier. Uniquely indexed — a redelivered SQS message collides on this index and is treated as already-processed. Not minted by the pipeline. |
| `order_id` | string \| null | ID of the related order (null for non-order events such as `USER_CREATED`). |
| `user_id` | string | ID of the originating user. |
| `type` | string (enum) | `USER_CREATED`, `ORDER_CREATED`, `TRACKING_STATUS_CHANGED`. |
| `source` | string | Which microservice emitted the event (`users`, `orders`, `tracking`). |
| `payload` | object | Full event payload as-received; structure varies by `type`, validated per-type by Zod. |
| `status` | string (enum) | Current state: `STARTED` \| `IN_PROGRESS` \| `COMPLETED` \| `FAILED`. |
| `error` | string \| null | Populated only when `status = FAILED`. |
| `status_history` | array of objects | Append-only log: `{ status, timestamp, error? }` per transition. |
| `created_by` | string | The envelope's `author.actor` — what ORIGINATED the event. See [[audit-fields]] for the full `created_by`/`updated_by` split rationale. |
| `created_at` | datetime | See [[audit-fields]]. |
| `updated_by` | string | Always `"events-pipeline"` — what PROCESSED the event, stamped on every `STARTED`→`IN_PROGRESS`→`COMPLETED`/`FAILED` transition. See [[audit-fields]]. |
| `updated_at` | datetime | See [[audit-fields]]. |
| `deleted_by` | string \| null | See [[audit-fields]]. |
| `deleted_at` | datetime \| null | See [[audit-fields]]. |
| `is_deleted` | boolean | Materialized, not computed on read — stamped alongside `deleted_at`/`deleted_by` on every write, since this repository is hand-written with no ORM extension to derive it implicitly. See [[audit-fields]]. |

> [!note] snake_case, unlike [[audit-fields]]'s camelCase examples
> [[audit-fields]] documents the audit fields in camelCase because it describes the code-level
> API. Users/Prisma, Tracking/SQLAlchemy, and Orders/EF Core all persist them in snake_case
> through an ORM mapping layer (`@map("created_by")`, SQLAlchemy column names, `.HasColumnName("created_by")`
> respectively), so the camelCase names never reach the database in any of those three. The
> events-pipeline repository is hand-written with no ORM — the TypeScript property name IS the
> stored field name — so every persisted field here is snake_case to align with what the other
> services actually store, not to diverge from [[audit-fields]]. This is the only service where
> the interface itself, not an ORM mapping, produces the on-disk casing.

Hard deletes are prohibited; see [[soft-delete]] and [[ADR-0004-soft-delete-only]].

DocumentDB indexes:

- `event_id` (unique)
- `order_id`
- `user_id`
- `type`
- `status`
- `created_at`

## Email

Handlers do not just record events — they render an email from the event's payload and send it.
Validation remains the precondition for rendering: `validate payload (Zod) → render react-email
template to HTML → SES SendEmail → COMPLETED`.

### `src/email/catalog.ts` — the registry

A single registry (`EmailCatalog`, `Record<string, EmailTemplateEntry<unknown>>`) mapping a
template key to its component and sample props. Three consumers read this object and nothing
else — handlers (to render), the local preview server (`email dev`, to list templates), and
tests (to snapshot every entry, so an unintended template change is caught). One source of
truth: adding a template is one entry here, with no change to the renderer or the dispatch code.

Entries are registered through a `defineTemplate<P>()` helper rather than a plain
`Record<string, EmailTemplateEntry<any>>`: each call is checked against its own prop type at
registration (passing a component with props that don't match its declared type is a compile
error), and only the map's value type erases to `unknown` so entries with different prop shapes
can coexist. A plain `any`-typed map would have type-checked the same registration while
disabling checking for every future entry — exactly the kind of mistake that would otherwise
surface as a runtime "cannot read property of undefined" inside a deployed template.

Registered templates:

- `user-created` — one component, one entry.
- `order-created` — one component, one entry.
- `tracking-status-changed-{placed,processing,shipped,out-for-delivery,delivered}` — **one** event
  type (`TRACKING_STATUS_CHANGED`), **five** catalog entries sharing **one** component
  (`TrackingStatusChangedEmail`). The handler picks the entry key from `payload.status`. This is
  the mirror image of the dispatch-map claim above: a new event type costs one dispatch entry,
  and one event type can fan out to several rendered variants without adding a second dispatch
  entry — the variation belongs in template selection, not in the event taxonomy. A rejected
  alternative was a distinct event type per status (`TRACKING_PLACED`, `TRACKING_PROCESSING`,
  …), which would have duplicated near-identical dispatch entries and handlers for logic the
  catalog already handles cleanly.

### Preview & local inbox

react-email's `email dev` (default port 3000, reads the `emails/` dir) runs as a compose service
behind a profile so it does not start with a normal `make up`; it hot-reloads on `.tsx` edits.
Mailpit is a compose service (web UI 8025, SMTP 1025) with Floci relaying SES sends to it — every
email the Lambda sends lands in a real, inspectable inbox rather than a mock.

## Producers and their publish-failure policy

Three producers publish to the one shared queue. Each generates its own `event_id` and builds
the full envelope; each sets `type` and `source` as SQS message attributes (so the queue can be
inspected without deserializing the body) in addition to the body itself.

| Producer | Event | `event_id` derivation |
|---|---|---|
| Users | `USER_CREATED` | Generated at publish time (one event per registration). |
| Orders | `ORDER_CREATED` | Generated at publish time (one event per order). |
| Tracking | `TRACKING_STATUS_CHANGED` | Derived **deterministically** from `(order_id, status)` — see below. |

All three producers share the same publish-failure policy — **log and swallow, never
re-raise** — but for three different reasons, because the consequence of re-raising differs by
call site:

- **Users** logs and swallows because the user row and the Cognito account already exist by the
  time publishing runs; re-raising would leave the client retrying into a permanent `409`
  (`email_exists`) it can never resolve by retrying.
- **Orders** logs and swallows for the same shape of reason, but because the publish call runs
  **inside** the write transaction — re-raising would roll back a commercially valid, already
  paid-for order over a notification failure.
- **Tracking** logs and swallows because a `500` here would make the carrier's webhook retry a
  status transition that is **already recorded**; the forward-only guard would then reject that
  retry as `400 not_strictly_forward` for a change that genuinely happened, turning a
  notification failure into a spurious rejection of a legitimate carrier update.

The Noop implementations (`NoopEventPublisher` in Users and Orders; a Noop-equivalent in
Tracking) stay in the codebase for tests that must not emit.

### Tracking's `event_id`: derived, not random — and why

Tracking derives `event_id` deterministically from `(order_id, status)` rather than generating a
fresh id per publish attempt. This matters specifically because of TestMode: it walks a tracking
through all five statuses in roughly 40 seconds, and if `event_id` were freshly generated on
every send attempt, a retry of the same transition (e.g. after a transient SQS error) would mint
a new id, miss the pipeline's unique-index dedupe, and send a **duplicate notification email**
for a transition that had already succeeded. Deriving from `(order_id, status)` means a retry of
the same transition always collides on the pipeline's unique index instead.

**`user_id` on the Tracking envelope comes from the persisted tracking row, not the request.**
The carrier webhook that drives most transitions carries no `x-user-id` at all — it is
authenticated by an API key, not a Cognito JWT, and its repository lookup is intentionally
unscoped. The entity `update_status` already loaded and returned is the only source of an owner
for the event; `_emit_status_changed` reads `updated.user_id` off that persisted entity. See
[[tracking-service-design]] for the full mechanics of this emission.

## Cross-cutting rules

- **Soft delete only:** documents are never hard-deleted. See [[soft-delete]] and [[ADR-0004-soft-delete-only]].
- **No prefixed nano-IDs here:** unlike the other services, this service does not mint its own id — `event_id` is producer-generated and is the sole identifier. See [[nano-id]] for the scope correction and [[ADR-0005-nano-id-prefixed]] for the ADR this service no longer consumes.
- **Audit fields:** all documents carry the six standard audit fields (persisted snake_case — see [[#Data Model]]) plus the computed `is_deleted`. See [[audit-fields]].
- **CQRS dispatch:** handler selection is by event `type`; commands and queries are never mixed in the same handler. See [[cqrs]] and [[ADR-0002-cqrs]].
- **Env files:** the DocumentDB connection string and `EVENTS_QUEUE_URL` are generated, never hardcoded — see [[env-files]].
- **Testing:** this component has no HTTP endpoints, so the repo's three-layer convention is adapted rather than applied literally — see [[testing]] and Tracking's producer-side testing in [[tracking-service-design]].
- **Logging:** every line carries the shared cross-service context (`trace_id`, `user_id`, `order_id`, `event_id`); never the full payload or a plaintext email. See [[logging-context]].

## Related

- [[cqrs]]
- [[ADR-0002-cqrs]]
- [[nano-id]]
- [[ADR-0005-nano-id-prefixed]]
- [[audit-fields]]
- [[soft-delete]]
- [[ADR-0004-soft-delete-only]]
- [[env-files]]
- [[testing]]
- [[logging-context]]
- [[tracking-service-design]] — the third producer, its deterministic `event_id`, and why `user_id` comes from the persisted row.
- [[2026-08-03-events-pipeline-milestone-design]]
- [[2026-08-03-events-pipeline-milestone]]
- [[terraform-modules]] — the `docdb`, `messaging`, and `lambda` module inventory backing this service.
