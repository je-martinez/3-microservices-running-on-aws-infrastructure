---
title: Events Pipeline Design
type: spec
area: events-pipeline
status: accepted
created: 2026-06-26
updated: 2026-08-06
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
  - "[[2026-08-05-passwordless-otp-auth-design]]"
  - "[[2026-08-05-passwordless-otp-auth]]"
  - "[[users-service-design]]"
  - "[[cognito-custom-auth-triggers]]"
  - "[[2026-08-05-realtime-tracking-events-websocket-design]]"
  - "[[2026-08-05-realtime-tracking-events-websocket]]"
  - "[[user-id-vs-cognito-sub-ownership-key]]"
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
  AUTH_OTP_REQUESTED: authOtpRequestedHandler,
};
```

`AUTH_OTP_REQUESTED` (added 2026-08-05) is published by Users' `otp-challenge-lambda`
(`CreateAuthChallenge` trigger, `infra/modules/cognito/`) rather than by a Users HTTP route —
the only event type in this pipeline whose producer is a Cognito Lambda, not a microservice. It
renders the `auth-otp` template (built on the existing plain `EmailLayout`) with the OTP code
and TTL. See [[users-service-design#Passwordless OTP authentication]] and
[[cognito-custom-auth-triggers]] for the producer side.

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

## Payload redaction — the one exception to "persist verbatim"

Every other event type persists its `payload` to DocumentDB verbatim — that is the audit trail,
by design (see [Data Model](#data-model)). `AUTH_OTP_REQUESTED` is the **one exception**: its
payload carries a live, unexpired OTP code, and a copy of that code sitting in the `events`
collection would be a second, weaker copy of the authentication surface.

`redactPayload(type, payload)` (`src/domain/redact-payload.ts`) is applied **once**, at the exact
point `process-record.ts` builds the document it persists (`doc.payload = redactPayload(event.type,
event.payload)`) — never at the envelope the handler receives. The handler still gets the intact
envelope (with the real code) so it can render the email; only the persisted copy is stripped. A
per-type field map (`{ AUTH_OTP_REQUESTED: ["code"] }`), not a blanket "strip any field named
`code`", keeps the redaction explicit and auditable — adding a new event type never accidentally
redacts a legitimate field just because it happens to share a name.

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
| `type` | string (enum) | `USER_CREATED`, `ORDER_CREATED`, `TRACKING_STATUS_CHANGED`, `AUTH_OTP_REQUESTED`. |
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
- `tracking-status-changed-{shipped,on-the-way,out-for-delivery,delivered}` — **one** event type
  (`TRACKING_STATUS_CHANGED`), **four** catalog entries sharing **one** component
  (`TrackingStatusChangedEmail`). The handler picks the entry key from `payload.status`. This is
  the mirror image of the dispatch-map claim above: a new event type costs one dispatch entry,
  and one event type can fan out to several rendered variants without adding a second dispatch
  entry — the variation belongs in template selection, not in the event taxonomy. A rejected
  alternative was a distinct event type per status (`TRACKING_SHIPPED`, `TRACKING_ON_THE_WAY`,
  …), which would have duplicated near-identical dispatch entries and handlers for logic the
  catalog already handles cleanly.
- `auth-otp` — one component, one entry, added 2026-08-05 for `AUTH_OTP_REQUESTED`. Built on the
  existing plain `EmailLayout` (no dependency on branding templates). Renders the code as plain
  visible text, not obfuscated or as an image — deliberately, so E2E can extract it from the
  message body without OCR or fragile markup scraping. See
  [[users-service-design#Passwordless OTP authentication]].

### Preview & local inbox

react-email's `email dev` (default port 3000, reads the `emails/` dir) runs as a compose service
behind a profile so it does not start with a normal `make up`; it hot-reloads on `.tsx` edits.
Mailpit is a compose service (web UI 8025, SMTP 1025) with Floci relaying SES sends to it — every
email the Lambda sends lands in a real, inspectable inbox rather than a mock.

## Producers and their publish-failure policy

Four producers publish to the one shared queue. Each generates its own `event_id` and builds
the full envelope; each sets `type` and `source` as SQS message attributes (so the queue can be
inspected without deserializing the body) in addition to the body itself.

| Producer | Event | `event_id` derivation |
|---|---|---|
| Users | `USER_CREATED` | Generated at publish time (one event per registration). |
| Orders | `ORDER_CREATED` | Generated at publish time (one event per order). |
| Tracking | `TRACKING_STATUS_CHANGED` | Derived **deterministically** from `(order_id, status)` — see below. |
| Users' `otp-challenge-lambda` (Cognito `CreateAuthChallenge` trigger) | `AUTH_OTP_REQUESTED` | `otp_<sub>_<timestamp>`, generated once per challenge (a same-session retry reuses the code and does not republish). |

All four producers share the same publish-failure policy — **log and swallow, never
re-raise** — for reasons that differ by call site:

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
- The **OTP challenge Lambda** is a Cognito trigger, not an HTTP handler — a publish failure there
  surfaces as a failed `CreateAuthChallenge` invocation, which Cognito itself retries/fails per its
  own trigger semantics, outside this pipeline's control. See [[cognito-custom-auth-triggers]].

The Noop implementations (`NoopEventPublisher` in Users and Orders; a Noop-equivalent in
Tracking) stay in the codebase for tests that must not emit.

### Tracking's `event_id`: derived, not random — and why

Tracking derives `event_id` deterministically from `(order_id, status)` rather than generating a
fresh id per publish attempt. This matters specifically because of TestMode: it walks a tracking
through all four statuses in roughly 30 seconds, and if `event_id` were freshly generated on
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

## Realtime WebSocket fan-out (second output of `TRACKING_STATUS_CHANGED`)

> [!info] Shipped 2026-08-06, on `feature/realtime-events` (not yet merged)
> Full design: [[2026-08-05-realtime-tracking-events-websocket-design]]. **One gateway E2E gap is
> still open** (see the callout below) — this section documents what shipped, not a closed
> milestone.

The `TRACKING_STATUS_CHANGED` handler (`src/handlers/tracking-status-changed.ts`) gained a
**second output**, called after `sendEmail`: a push to every WebSocket connection the event's
owner currently has open. The email remains the durable, primary notification; the WebSocket
push is a strictly additive, opportunistic enhancement layered on top of it — nothing about the
existing dispatch, status machine, or error taxonomy above changed to add it.

### Governing rule: the fan-out never changes event outcome

`publishToUser` (`src/shared/realtime/websocket-publisher.ts`) **never throws**. This is not an
implementation detail, it is the load-bearing constraint the whole feature is built around: if a
WebSocket-push failure were allowed to fail the SQS record, [Error taxonomy](#error-taxonomy-load-bearing)
above would treat it as retryable, SQS would redeliver the record, and the handler would call
`sendEmail` a **second time** for a transition the user was already notified about — trading a
realtime-delivery failure for a duplicate email. That is exactly the trade every one of this
pipeline's four producers already rejects (see
[Producers and their publish-failure policy](#producers-and-their-publish-failure-policy)); the
WebSocket fan-out inherits the same policy rather than introducing a new one.

Concretely: a `PostToConnection` `410 Gone` deletes that one connection row and continues with
the rest of the batch (not an error); any other `PostToConnection` failure is logged and
swallowed; a total failure (e.g. the DynamoDB query itself fails) is logged and swallowed, and
the event still reaches `COMPLETED` if the email sent. A user with no open connections is the
normal case — the GSI query returns empty and nothing else happens.

### Keyed by `author.cognito_sub`, not `envelope.user_id`

The handler reads `envelope.author.cognito_sub` — **not** `envelope.user_id` — to key the
connections lookup:

```typescript
// Keyed by `author.cognito_sub`, NOT `envelope.user_id`. The latter is the
// internal usr_ id; the connections GSI is keyed by the Cognito sub, so
// querying with user_id returns an empty list indistinguishable from "no open
// connections". See the user-id-vs-cognito-sub-ownership-key ADR.
const cognitoSub = envelope.author.cognito_sub;
if (cognitoSub) {
  await publishToUser(cognitoSub, { ... });
}
```

`author.cognito_sub` is the same optional envelope field documented in
[The envelope's `author` object](#the-envelopes-author-object) above — omitted, never null, when
absent. For `TRACKING_STATUS_CHANGED` specifically, Tracking's publisher now populates it off the
persisted tracking row; see [[tracking-service-design#Events]] for why it comes from the row and
not the request, and why it is `None`/omitted rather than an empty string when the row predates
the column. If it is absent, the fan-out is skipped entirely (no lookup, no push) — a
`cognito_sub`-less event only ever gets the email.

Querying the `by-cognito-sub` GSI (below) with the internal `usr_` id instead of the Cognito sub
would **return an empty list with no error at all** — indistinguishable from "user has no open
connections." Keying explicitly by `cognito_sub`, with a name that visibly does not match a
`usr_`-shaped value, turns that mismatch into a question an implementer notices rather than a
silent zero-result query. See [[user-id-vs-cognito-sub-ownership-key]] for the same trap
documented on Tracking's own REST reads.

### The connections table and its `by-cognito-sub` GSI

`infra/modules/dynamodb/` provisions `websocket_connections`, written and deleted by a **sibling**
package, `functions/realtime-events/` (its own `$connect`/`$disconnect`/authorizer/`$default`
Lambdas — a different domain and trigger from this SQS-triggered pipeline, so it is not folded
into this package; see [[2026-08-05-realtime-tracking-events-websocket-design#5-new-functionsrealtime-events-package]]).

| Attribute | Role |
|---|---|
| `connection_id` | Partition key. The API Gateway `connectionId`. |
| `cognito_sub` | GSI partition key (`by-cognito-sub`). The `sub` claim from the JWT presented on `$connect`. |
| `connected_at` | Epoch timestamp, diagnostics only. |
| `ttl` | Epoch expiry — a **safety net**, not the cleanup mechanism. Real cleanup is reactive: this pipeline's `connections-reader.ts` deletes a row the instant `PostToConnection` answers `410 Gone`. |

This pipeline only **reads** the table (`src/shared/realtime/connections-reader.ts`: `Query` on
`by-cognito-sub`, `DeleteItem` on a `410`) — it never writes a connection row. Two logical writers
exist across the two packages (connect/disconnect handlers write; this pipeline deletes dead rows
on 410), and the schema is documented in exactly one place, the design spec's
[Data model](../../../superpowers/specs/2026-08-05-realtime-tracking-events-websocket-design.md#data-model--websocket_connections-table)
section — not duplicated here.

### Three new env vars

Generated by `make env-file` into `.env.local.events-pipeline` (per [[env-files]]; never
hardcoded):

| Var | Purpose |
|---|---|
| `WS_CONNECTIONS_TABLE` | The DynamoDB table name (`connections-reader.ts`'s `Query`/`DeleteItem` target). |
| `WS_CONNECTIONS_GSI` | The GSI name to query; defaults to `by-cognito-sub` if unset. |
| `WS_MANAGEMENT_ENDPOINT` | The `@connections` management API endpoint `PostToConnectionCommand` targets. Locally this is Floci's **undocumented** `http://floci:4566/execute-api/{apiId}/{stage}` shape — see [Floci facts](#floci-facts-websocket-api-gateway--dynamodb) below; production uses the real AWS-generated endpoint. |

### The pushed message deliberately carries no email address

The frame `publishToUser` sends carries `type`, `order_id`, and `status` only — no PII, no email
address, matching [[logging-context]]'s stance that a plaintext email never travels further than
it has to. The email address is exactly what the **email** side of this same handler needs (via
Tracking's gRPC-resolved `ResolvedUser.email`, see [[tracking-service-design#gRPC — outbound client to Users]])
and exactly what the WebSocket side does not: the client that opened the socket already knows who
it authenticated as.

### Floci facts (WebSocket API Gateway + DynamoDB)

Verified empirically during the design POC and again during implementation; see
[[2026-08-05-realtime-tracking-events-websocket-design#Verification results (POC, 2026-08-05)]]
for the full evidence trail.

- **WebSocket data plane:** `ws://localhost:4566/ws/{apiId}/{stage}` — not the
  `restapis/<id>/$default/_user_request_/<path>` shape the HTTP API uses locally.
- **`@connections` management API:** `http://localhost:4566/execute-api/{apiId}/{stage}` — an
  **undocumented** prefix that differs from real AWS's
  `https://{apiId}.execute-api.{region}.amazonaws.com/{stage}`. A wrong shape does **not** fail
  obviously: it returns HTTP 400 with an **S3 XML error body**
  (`<Error><Code>InvalidArgument</Code>`), because unrouted paths on `:4566` fall through to
  Floci's S3 handler — the same root cause behind the already-known quirk that odd API Gateway
  404s come back as `NoSuchBucket`. This reads exactly like a credentials problem and is not one.
- **The REQUEST authorizer on `$connect` is genuinely invoked**, and its returned `context`
  propagates intact to the `$connect` handler. This does **not** inherit the HTTP API's
  claim-to-header limitation (see [[nginx-njs-x-user-id-injection]]) — the two gateway types use
  different mechanisms (a propagated authorizer context vs. gateway-side claim-to-header mapping),
  and the WebSocket one genuinely works on Floci.
- **`update-function-code` genuinely replaces code** on this emulator — verified with a marker
  function during Task 10's fix — it is not one of Floci's silently-dropped update APIs.
- **A Cognito JWT verifier must take its issuer from configuration**, never derive it from the pool
  id alone. Floci stamps `iss` as `http://localhost:4566/<pool-id>`; a verifier that derives the
  issuer purely from `userPoolId` (as `aws-jwt-verify`'s top-level `CognitoJwtVerifier` does)
  unconditionally points at real AWS Cognito instead, and every token — valid or garbage — fails
  identically. `functions/realtime-events/src/shared/jwt.ts` uses the library's low-level
  `JwtRsaVerifier` with an explicit `issuer`/`jwksUri` sourced from `COGNITO_ISSUER`
  (`module.cognito.issuer` in Terraform — the same value the REST API Gateway's native JWT
  authorizer already consumes), plus a custom JWKS fetcher because Floci serves its JWKS endpoint
  over plain HTTP and `aws-jwt-verify`'s default fetcher rejects non-HTTPS URIs.

> [!success] Resolved (2026-08-06) — the outstanding issue below was an incorrect assertion
> `e2e/tests/gateway/realtime-events.spec.ts` has three tests. The invalid-token rejection test
> always passed. The two positive tests ("delivers all status transitions", "does not deliver one
> user's events to another user") were previously reported red, failing with **0 frames
> received**. The root cause was the tests' own expectation, not the delivery path: they waited
> for **four** messages including `SHIPPED`, but `TRACKING_STATUS_CHANGED` is published only from
> `update_tracking_status` (the transition path) — `SHIPPED` is the status a tracking is *created*
> at (`create_tracking.py`), which never calls it, so it is never pushed. A TestMode run therefore
> produces exactly **three** transitions (`ON_THE_WAY`, `OUT_FOR_DELIVERY`, `DELIVERED`) and three
> pushes; see [[tracking-service-design#Events]] and
> [[2026-08-05-realtime-tracking-events-websocket-design#Gateway E2E — the test that matters]].
> With the assertion corrected to three, both positive tests pass and the full E2E suite is
> 83/83. The direct-Lambda controller probe below, and the four ruled-out hypotheses, remain
> useful evidence that the delivery path itself was never the problem — kept here as the
> diagnostic trail that led to finding the real cause, a count-only assertion (`expected 4, got
> 3`) that could not distinguish a dropped message from a wrong expectation. A controller-run
> direct-Lambda probe verified the full chain works end to end (authenticated socket → GSI row →
> event published for that sub → frame delivered with the correct payload), and `410 Gone`
> cleanup was independently confirmed live. Four hypotheses were measured and ruled out along the
> way: premature socket close (the socket survived the full 75s timeout), sub mismatch (identical
> in the same run), GSI indexing lag (visible at t=0.0s), and stale env in Playwright
> (`.env.local.debug` matches the live API id) — none of them was the cause; the assertion was.
> See [[2026-08-05-realtime-tracking-events-websocket-design]] for the full diagnostic trail.

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
- [[2026-08-05-passwordless-otp-auth-design]] — the passwordless OTP design spec, source of `AUTH_OTP_REQUESTED` and the payload-redaction requirement.
- [[2026-08-05-passwordless-otp-auth]] — the implementation plan that shipped it.
- [[users-service-design]] — the fourth producer's home service, and the consumer-facing OTP endpoints.
- [[cognito-custom-auth-triggers]] — the `otp-challenge-lambda` that publishes `AUTH_OTP_REQUESTED`.
- [[2026-08-05-realtime-tracking-events-websocket-design]] — the design for the WebSocket fan-out
  documented above: the connections table, the `by-cognito-sub` GSI, the three new env vars, and
  the outstanding gateway E2E gap.
- [[2026-08-05-realtime-tracking-events-websocket]] — the implementation plan that shipped it.
- [[user-id-vs-cognito-sub-ownership-key]] — why the fan-out keys the GSI lookup by
  `author.cognito_sub`, never `envelope.user_id`.
