---
title: Events Pipeline Design
type: spec
area: events-pipeline
status: accepted
created: 2026-06-26
updated: 2026-08-21
tags: [type/spec, area/events-pipeline, status/accepted, issue/JE-180, issue/JE-181]
related:
  - "[[2026-08-15-request-id-correlation-design]]"
  - "[[linear-references]]"
  - "[[observability-telemetry-milestone]]"
  - "[[2026-08-21-verify-in-the-viewer-not-the-api]]"
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
  - "[[ADR-0020-self-owned-password-reset]]"
  - "[[email-templates]]"
  - "[[2026-08-12-custom-business-metrics-cloudwatch-design]]"
  - "[[2026-08-18-distributed-tracing-spans-design]]"
  - "[[2026-08-18-distributed-tracing-spans]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
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
  PASSWORD_RESET_REQUESTED: passwordResetRequestedHandler,
};
```

`AUTH_OTP_REQUESTED` (added 2026-08-05) is published by Users' `otp-challenge-lambda`
(`CreateAuthChallenge` trigger, `infra/modules/cognito/`) rather than by a Users HTTP route —
the only event type in this pipeline whose producer is a Cognito Lambda, not a microservice. It
renders the `auth-otp` template (built on the existing plain `EmailLayout`) with the OTP code
and TTL. See [[users-service-design#Passwordless OTP authentication]] and
[[cognito-custom-auth-triggers]] for the producer side.

`PASSWORD_RESET_REQUESTED` (added 2026-08-09) is published by Users' `ForgotPasswordCommand`
(`POST /v1/users/password/forgot`, a normal HTTP route, unlike `AUTH_OTP_REQUESTED`'s Lambda
producer). Its payload — `{ email, full_name, code, ttlSeconds }` — is **deliberately identical
in shape** to `AUTH_OTP_REQUESTED`'s, since both carry the same four facts, but it is kept as a
**separate event type** rather than a variant of `AUTH_OTP_REQUESTED`: the two are different
flows with different Cognito APIs behind them (`AdminInitiateAuth`/`CUSTOM_AUTH` vs
`AdminSetUserPassword`), different TTLs (300s vs 600s), and different consequences if the mail
goes astray — collapsing them would mean a runtime branch deciding which email a recipient gets,
on a payload that cannot distinguish the two. It renders the `forgot-password` template (the
fifth, see [[email-templates]]) and, like `AUTH_OTP_REQUESTED`, has its `code` redacted before
persistence (see [Payload redaction](#payload-redaction--the-one-exception-to-persist-verbatim)
below). See [[users-service-design#Password reset]] and [[ADR-0020-self-owned-password-reset]]
for the producer side and why the reset is self-owned rather than Cognito's.

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
by design (see [Data Model](#data-model)). `AUTH_OTP_REQUESTED` and `PASSWORD_RESET_REQUESTED`
are the **two exceptions**: each payload carries a live, unexpired credential code, and a copy of
either sitting in the `events` collection would be a second, weaker copy of the authentication
surface. `PASSWORD_RESET_REQUESTED` is if anything the stricter of the two — its code does not
merely sign a user in, it authorises **choosing a new password**, so a leaked one hands over the
account rather than one session.

`redactPayload(type, payload)` (`src/domain/redact-payload.ts`) is applied **once**, at the exact
point `process-record.ts` builds the document it persists (`doc.payload = redactPayload(event.type,
event.payload)`) — never at the envelope the handler receives. The handler still gets the intact
envelope (with the real code) so it can render the email; only the persisted copy is stripped. A
per-type field map (`{ AUTH_OTP_REQUESTED: ["code"], PASSWORD_RESET_REQUESTED: ["code"] }`), not a
blanket "strip any field named `code`", keeps the redaction explicit and auditable — adding a new
event type never accidentally redacts a legitimate field just because it happens to share a name.

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
| `type` | string (enum) | `USER_CREATED`, `ORDER_CREATED`, `TRACKING_STATUS_CHANGED`, `AUTH_OTP_REQUESTED`, `PASSWORD_RESET_REQUESTED`. |
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

Template authoring rules, the client-support constraints that shape them (icon fonts and inline
SVG are unusable; remote `<img>` served from the assets bucket is the one that works, at 100%
client support), and the checklist for adding a new template are in [[email-templates]] — read
it before adding a fifth template.

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
- `auth-otp` — one component, one entry, added 2026-08-05 for `AUTH_OTP_REQUESTED`. Built on the
  existing plain `EmailLayout` (no dependency on branding templates). Renders the code as plain
  visible text, not obfuscated or as an image — deliberately, so E2E can extract it from the
  message body without OCR or fragile markup scraping. See
  [[users-service-design#Passwordless OTP authentication]].
- `forgot-password` — one component, one entry, added 2026-08-09 for
  `PASSWORD_RESET_REQUESTED`, the fifth template overall. Same code-visibility rule as `auth-otp`:
  the code is rendered twice, once as contiguous plain text and once as six boxed digits, so the
  gateway E2E can scrape it — see [[email-templates#One rule that is easy to break by "tidying"]].
  See [[users-service-design#Password reset]] and [[ADR-0020-self-owned-password-reset]].

### Preview & local inbox

react-email's `email dev` (default port 3000, reads the `emails/` dir) runs as a compose service
behind a profile so it does not start with a normal `make up`; it hot-reloads on `.tsx` edits.
Mailpit is a compose service (web UI 8025, SMTP 1025) with Floci relaying SES sends to it — every
email the Lambda sends lands in a real, inspectable inbox rather than a mock.

## Metrics

> [!info] Shipped 2026-08-12 — Custom Business Metrics milestone
> Full design and the Floci/OpenObserve gotchas that constrain these metrics:
> [[2026-08-12-custom-business-metrics-cloudwatch-design]]; the CloudWatch-not-OTLP pipeline and
> the shared query gotchas are in [[logging-context#Metrics — the third pillar, and why it does
> NOT go over OTLP]].

| Metric | Type | Dimensions |
|---|---|---|
| `emails_sent_total` | counter | `EmailType=<template>` |
| `emails_sent_total` | counter | `EmailType=ALL` |
| `emails_failed_total` | counter | `EmailType=<template>`, `FailureKind=permanent\|transient` |
| `emails_failed_total` | counter | `EmailType=ALL`, `FailureKind=permanent\|transient` |

`EmailType` takes the template key from [`src/email/catalog.ts`](#srcemailcatalogts--the-registry)
— `user-created`, `order-created`, `auth-otp`, `forgot-password`, and the five
`tracking-status-changed` variants — the template actually rendered and sent, not the event type
(`auth-otp` renders for `AUTH_OTP_REQUESTED`; `forgot-password` renders for
`PASSWORD_RESET_REQUESTED` — the template key and the event type are deliberately different
strings, see the catalog section above).
`EmailType=ALL` is a **separately published series**, not a query-time aggregate: Floci does not
aggregate across dimensions, so a dimensionless query for the total returns an empty result. This
is the events-pipeline's only gauge-free metric set: as a Lambda it has no long-lived process to
host a periodic poller, so every metric here is a counter published during invocation.

**Permanent and transient failures are emitted from different files, because they mean different
things operationally.** `SendEmailParams` gained a **required** `templateKey` field so both call
sites know which `EmailType` to publish:

- **`permanent`** — emitted from `src/email/renderer.ts`, right before it throws
  `PermanentError` for a missing template. The email is **lost**: [Error
  taxonomy](#error-taxonomy-load-bearing) records this `FAILED` and consumes the SQS message; there
  is no retry that would ever succeed. Any non-zero value here is a real incident — a customer
  never got their mail.
- **`transient`** — emitted from `src/email/sender.ts`, right before it throws `TransientError`
  for an SES send failure. SQS retries the record per the same error taxonomy, so the email most
  likely arrived on a later attempt. Small numbers are expected noise, not an incident.

Without the split, "5 emails failed" would conflate "5 customers never got their receipt" with
"SES hiccuped once and the retry worked" — two operationally opposite situations that a single
undifferentiated counter cannot distinguish.

> [!important] Amendment (2026-08-21) — the per-template breakdown was published but not collected
> `publishEmailMetric` has always published two series per email: a per-template one and the
> `EmailType=ALL` rollup. `GetMetricData` discovers nothing on its own (see
> [[2026-08-12-custom-business-metrics-cloudwatch-design#1. Floci does not aggregate across
> dimensions — and fails silently]]) — every dimension combination the collector wants must be
> named explicitly in its `queries` block. Until this session `observability/otel-collector-config.yaml`
> named only `EmailType: ALL`, so the per-template series reached CloudWatch and were never polled
> into OpenObserve.
>
> The fix added 18 explicit queries for `emails_failed_total` — one per template (9) ×
> `FailureKind` (`permanent`/`transient`). `emails_sent_total` deliberately stays `ALL`-only: a
> full breakdown of both metrics would be 27 queries, and the per-template split earns its cost
> only on **failures** ("the receipt template is broken" vs. "one OTP bounced" are different
> incidents); per-template *send* volume is already answerable from the `email render <template>`
> spans below, so a duplicate metrics path for it wasn't worth the query count.
>
> **One deliberate gap, not a bug.** The `permanent` failure is emitted precisely when a template
> key is **missing** from the catalog — so that key, by definition, cannot appear in the 9-query
> enumeration above, and its datapoint is invisible in the per-template breakdown. The `ALL`
> rollup still counts it, so "an email was lost" stays answerable; the breakdown narrows a known
> loss to its template, it does not replace `ALL` as the source of truth for "was anything lost."
>
> Verified: a per-template failure datapoint confirmed arriving in OpenObserve (`sum=1.0`).

> [!warning] This measures handoff to SES, not inbox delivery
> `emails_sent_total` means SES accepted the message for sending. Bounces and complaints are
> invisible to this metric; they would require SES event notifications, which are out of scope for
> this milestone. A dashboard reading "1,000 sent" must not be read as "1,000 delivered."

## Producers and their publish-failure policy

Five producers publish to the one shared queue. Each generates its own `event_id` and builds
the full envelope; each sets `type` and `source` as SQS message attributes (so the queue can be
inspected without deserializing the body) in addition to the body itself.

| Producer | Event | `event_id` derivation |
|---|---|---|
| Users | `USER_CREATED` | Generated at publish time (one event per registration). |
| Orders | `ORDER_CREATED` | Generated at publish time (one event per order). |
| Tracking | `TRACKING_STATUS_CHANGED` | Derived **deterministically** from `(order_id, status)` — see below. |
| Users' `otp-challenge-lambda` (Cognito `CreateAuthChallenge` trigger) | `AUTH_OTP_REQUESTED` | `otp_<sub>_<timestamp>`, generated once per challenge (a same-session retry reuses the code and does not republish). |
| Users' `ForgotPasswordCommand` (`POST /v1/users/password/forgot`) | `PASSWORD_RESET_REQUESTED` | Generated at publish time (one event per reset request for a known email; an unknown email publishes nothing at all — see [[ADR-0020-self-owned-password-reset]]). |

All five producers share the same publish-failure policy — **log and swallow, never
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
- **`ForgotPasswordCommand`** logs and swallows for a *security* reason, not merely a reliability
  one: an unawaited publish rejection surfacing as a 500 would only ever happen for an email that
  **exists**, which would turn the endpoint back into a user-enumeration oracle by a different
  route than the one `POST /v1/users/password/forgot`'s identical-response behavior already
  closes. The `try/catch` lives in the command itself, not delegated to the publisher's own
  swallow-and-log, because the property being protected belongs to the command, not to a
  collaborator whose behavior could change independently. See
  [[ADR-0020-self-owned-password-reset#Two security properties this flow is built around (load-bearing, tested)]].

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

## Realtime WebSocket fan-out (second output of `TRACKING_STATUS_CHANGED`)

> [!info] Shipped 2026-08-06, on `feature/realtime-events` (not yet merged)
> Full design: [[2026-08-05-realtime-tracking-events-websocket-design]]. The gateway E2E gap once
> open here was resolved the same day — an incorrect test assertion, not a delivery bug (see the
> resolved callout below) — so this section documents a closed, verified feature, not an open gap.

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

The frame `publishToUser` sends carries `type`, `order_id`, `status`, `previous_status`, and
`changed_at` — none of the five is PII, and none of them is the recipient's email address, matching
[[logging-context]]'s stance that a plaintext email never travels further than it has to. The email
address is exactly what the **email** side of this same handler needs (via Tracking's gRPC-resolved
`ResolvedUser.email`, see [[tracking-service-design#gRPC — outbound client to Users]]) and exactly
what the WebSocket side does not: the client that opened the socket already knows who it
authenticated as, so including it would add exposure with no benefit.

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
> `e2e/tests/gateway/realtime-tracking.spec.ts` has three tests. The invalid-token rejection test
> always passed. The two positive tests ("delivers all status transitions", "does not deliver one
> user's events to another user") were previously reported red, failing with **0 frames
> received**. The root cause was the tests' own expectation, not the delivery path: they waited
> for **five** messages including `PLACED`, but `TRACKING_STATUS_CHANGED` is published only from
> `update_tracking_status` (the transition path) — `PLACED` is the status a tracking is *created*
> at (`create_tracking.py`), which never calls it, so it is never pushed. A TestMode run therefore
> produces exactly **four** transitions (`PROCESSING`, `SHIPPED`, `OUT_FOR_DELIVERY`, `DELIVERED`)
> and four pushes; see [[tracking-service-design#Events]] and
> [[2026-08-05-realtime-tracking-events-websocket-design#Gateway E2E — the test that matters]].
> With the assertion corrected to four, both positive tests pass and the full E2E suite is
> 83/83. The direct-Lambda controller probe below, and the four ruled-out hypotheses, remain
> useful evidence that the delivery path itself was never the problem — kept here as the
> diagnostic trail that led to finding the real cause, a count-only assertion (`expected 5, got
> 4`) that could not distinguish a dropped message from a wrong expectation. A controller-run
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
- **Logging:** every line carries the shared cross-service context (`request_id`, `trace_id`, `user_id`, `order_id`, `event_id`); never the full payload or a plaintext email. See [[logging-context]]. `request_id` is present because the pipeline is a pure **consumer** of it: it reads the optional root `request_id` field off the envelope in `envelopeContext()` per SQS record and never mints one of its own; when the field is absent (e.g. a message queued before this field existed), it is omitted from the log line, never logged as null. This closed the gap [[2026-08-15-request-id-correlation-design]] exists for — but as of JE-138 (below) `trace_id` is present too, so `request_id` is no longer this hop's *only* correlation id, just its SDK-independent one.
- **Distributed tracing:** the SDK, backend, and span pattern are decided in [[ADR-0019-distributed-tracing-opentelemetry]] / [[2026-08-18-distributed-tracing-spans-design]] — see [Observability — tracing spans](#observability--tracing-spans) below for how this specific Lambda applies them.

## Observability — tracing spans

> [!info] Closed JE-138 (2026-08-19) — this Lambda now carries the full OTel SDK
> Full design: [[2026-08-18-distributed-tracing-spans-design#Decision 5 — events-pipeline: instrument the inside, not just the entry point|Decision 5]]. Implementation: [[2026-08-18-distributed-tracing-spans]].

> [!important] Revised (2026-08-21) — every record now parents to its own origin trace; `batch_size = 1` pin removed
> The design below originally parented a record to its origin only when the batch held exactly
> one record, falling back to a `FOLLOWS_FROM` link for multi-record batches — enforced by pinning
> the SQS event source mapping to `batch_size = 1`. That pin is gone: `recordSpanAttachment`
> (`functions/events-pipeline/src/handler.ts`) now parents **every** record to its own origin
> trace regardless of batch size, and `batch_size` is back to `10` (the `modules/lambda` default)
> in `infra/environments/local/main.tf` — a throughput knob again, not a tracing decision. Full
> reasoning: [[2026-08-18-distributed-tracing-spans-design#Decision 4 — the SQS hop: traceparent
> in `MessageAttributes`, every record parents to its own origin|Decision 4 (revised)]] and
> [[ADR-0019-distributed-tracing-opentelemetry]].

Span structure, one `CONSUMER` span per batch (its own trace) and one `INTERNAL` span **per
record** (in its own origin trace — not per batch, and no longer a child of the batch span):

```
events-queue process (CONSUMER, own trace, links -> N distinct origin traces in its batch)

process_record (INTERNAL, CHILD_OF its own origin trace)
+-- phase persist (INTERNAL)
|   +-- documentdb insertOne
+-- documentdb updateOne IN_PROGRESS
+-- phase dispatch (INTERNAL)
|   +-- email render <template>
|   +-- ses SendEmail
|   +-- cloudwatch PutMetricData  (x2)
|   +-- ws publish
+-- documentdb updateOne COMPLETED
```

`events-queue process` and its `process_record` spans no longer share a trace: each record
parents directly to the origin trace that published it (via `messageAttributes.traceparent`),
producing one continuous cascade per origin — `create_order` -> `sqs.publish order_created` ->
`process_record` -> `ses SendEmail` — however many records the batch holds. `batchSpanLinks`
(`functions/events-pipeline/src/handler.ts`) gives the batch span itself one link per distinct
origin trace present in the batch, deduplicated by trace id, so the invocation is still
navigable from its work even though it is no longer that work's ancestor.

Verified under real load at `batch_size = 10`: 167 `process_record` spans across 17
`events-queue process` invocations (~10 records/batch), and **297 of 297 traces containing
`process_record` also contain spans from a producer service (users/orders/tracking) — a 100%
continuous-cascade rate**, measured with server-side aggregation in OpenObserve. A `metrics-tick`
span (the EventBridge 1-minute rate tick) still has `refs=0` — a timer has no origin trace, so it
correctly starts a brand-new one rather than being forced into a link.

### Full record-lifecycle coverage — the three status transitions now have spans

> [!info] Verified on trace `f39c148902b77f94aa9e90b762809f95` — coverage went from ~70ms/357ms to 345ms/347ms (99.5%)
> The record's three `transition()` writes to DocumentDB (`STARTED`, `IN_PROGRESS`, `COMPLETED`/
> `FAILED`) previously had **no span at all** — `process_record` itself reported 194ms of
> duration against roughly 1ms of visible children, i.e. most of the record's real time was
> invisible in the waterfall. Wrapping the two phases (`persist`, `dispatch`) and naming the two
> `documentdb updateOne` transition writes closed that gap: the same trace now accounts for
> 345ms of its 347ms total, up from ~70ms/357ms.
>
> **The status is in the span NAME, not only an attribute** —
> `documentdb updateOne IN_PROGRESS` / `documentdb updateOne COMPLETED`, not three bars all
> reading `updateOne` with a `status` attribute someone has to click into. A waterfall renders
> names first; three identically-named bars require expanding each one to tell them apart, which
> defeats the point of a waterfall as a fast visual scan.
>
> **`cloudwatch PutMetricData` appears twice per email metric.** `publishEmailMetric`
> (`functions/events-pipeline/src/shared/metrics/cloudwatch-metrics.ts`) emits one call for the
> template-specific series and a second for the cross-template `ALL` rollup — this is by design
> (two real CloudWatch API calls, not a duplicate span for one call), and shows up in the
> waterfall exactly as two bars under `phase dispatch`, one per `emails_sent_total`/
> `emails_failed_total` publish. **Not a double count either**: dimensions are part of a series'
> identity in CloudWatch, so the per-template and `ALL` series are distinct series, not one value
> published twice — a dashboard queries one or the other and never sums them (the business-metrics
> dashboard filters `WHERE emailtype = 'ALL'`). See [[2026-08-12-custom-business-metrics-cloudwatch-design]]
> for the full per-template-collection story (18 `emails_failed_total` queries added 2026-08-21).
>
> **The two bars now name the EmailType, not just carry it as an attribute.** Both
> `cloudwatch PutMetricData` spans were named identically (`cloudwatch PutMetricData
> emails_sent_total`), so telling the per-template call from the `ALL` rollup took a click into
> the attributes — the same problem the `documentdb updateOne <STATUS>` naming above already
> solved once. The span name now carries the EmailType too:
> `cloudwatch PutMetricData emails_sent_total (user-created)` /
> `cloudwatch PutMetricData emails_sent_total (ALL)`, plus a `metric.email_type` attribute for
> filtering — a name is for reading a waterfall, an attribute is for filtering a dashboard, and
> neither should require the other.
>
> **Phase SPANS, not span events, are what make the lifecycle visible.** Span *events* (`
> span.addEvent(...)`) were tried first — the semantically correct OTel primitive for an instant
> like "message received" or "handler dispatched" — and are still emitted as secondary detail via
> `markPhase()` in `process-record.ts`. In practice **neither viewer renders them usefully**:
> Jaeger hides a span's events behind expanding the span and opening a separate tab, and
> OpenObserve's trace view does not surface them at all. A marker that costs two clicks to find
> marks nothing. They are kept anyway because they cost nothing and OpenObserve stores them in a
> queryable `events` column — `WHERE events LIKE '%handler_failed%'` finds every record that took
> a given path, which the waterfall itself cannot answer — but the **phase spans** (`phase
> persist`, `phase dispatch`) are what actually make the record's lifecycle visible as bars with
> real duration, and are the mechanism to reach for first.

### Known follow-ups, tracked in Linear, not mirrored here

Two issues surfaced by this instrumentation are referenced, not duplicated, per
[[linear-references]] — current status/detail live in Linear, fetched on demand:

- [JE-180](https://linear.app/je-martinez/issue/JE-180) — email template render dominates the
  record's duration at 256MB Lambda memory: 110–237ms to render vs 59–74ms for the SES call
  itself, measured across all three templates, and not attributable to cold start. The `phase
  dispatch` breakdown above (`email render <template>` as its own bar) is what made this visible
  in the first place.
- [JE-181](https://linear.app/je-martinez/issue/JE-181) — events-pipeline logs stop reaching
  OpenObserve after a Lambda redeploy: each redeploy opens a new CloudWatch log stream, and the
  collector keeps following the old one, measured at 76 minutes of silence with zero collector
  errors logged.

**Why the batch span links instead of parenting.** An SQS batch carries messages from
**distinct** traces (Users, Orders, and Tracking all publish onto the one shared queue). The
batch span represents the invocation, which no single one of those origins caused, so it cannot
honestly be a child of any of them — it **links** instead, one link per distinct origin trace
present in its batch (`batchSpanLinks`, deduplicated by trace id). **Honest limitation, kept as
such:** OpenObserve's trace view does not draw a linked span's bar inside the origin trace's own
waterfall the way a child would — a link renders as a navigable reference instead. That is the
price of not fabricating a hierarchy the batch invocation does not have.

**Each `process_record` span, by contrast, IS a real child — of its own origin, not of the batch
span.** This was a deliberate revision (2026-08-21): the record spans used to be children of the
batch span, which is what forced a choice between parenting to one origin (misattributing the
rest) or linking to all of them (no continuous cascade at all) whenever a batch held more than one
origin. Making each record a child of its own origin instead removes that forced choice —
`process_record` gets the strong parent-child edge into the trace that actually produced it,
and the weaker, links-only relationship is reserved for the batch span, which is genuinely an
invocation-level concept spanning multiple origins. See the revised design note above and
[[2026-08-18-distributed-tracing-spans-design#Decision 4 — the SQS hop: traceparent in
`MessageAttributes`, every record parents to its own origin|Decision 4 (revised)]] for the full
reasoning and the conflict this dissolves.

**Every internal span here is manual, not auto-instrumented — a packaging necessity, not a style
choice.** `functions/events-pipeline/scripts/build.mjs` bundles the handler into a single
self-contained CJS file with esbuild (`bundle: true`, `format: "cjs"` — an ESM bundle loads under
local Node but fails on the real `nodejs20.x` runtime with `ERR_REQUIRE_CYCLE_MODULE`, verified
empirically); the AWS SDK, `mongodb`, and `zod` are all inlined, and the zip ships no
`node_modules`. OTel auto-instrumentation patches a module at `require()`/resolution time — once
esbuild has inlined `@aws-sdk/client-ses`, `mongodb`, and
`@aws-sdk/client-apigatewaymanagementapi` into one file, there is no module boundary left to
patch. Registering `getNodeAutoInstrumentations()` here would produce **zero spans, silently**,
for DocumentDB, SES, and the WebSocket push — the same silent-failure shape
[[logging-context#OTel configuration belongs in the environment, not in code]] already documents
three times over. So the DocumentDB insert, SES send, and WebSocket publish spans above are
created by hand, using the same `startActiveSpan`/`finally` shape every other manual span in this
design uses.

**The consumer needs the `traceparent` on the record — a type-level trap called out on purpose.**
`SqsRecord` in `handler.ts` originally declared only `messageId`/`body`; it had to widen to
include `messageAttributes`, or a publisher's `traceparent` would arrive on the message and be
silently dropped before it ever reached the link logic — the same "declare the field or it
vanishes" failure class documented throughout [[logging-context]].

**Lambda flush.** `BatchSpanProcessor` (not `SimpleSpanProcessor` — one HTTP request per span
would add per-invocation latency at this Lambda's batch sizes), with `forceFlush()` called in the
handler's `finally`. Lambda freezes the process on return, so buffered spans not explicitly
flushed are lost or arrive late on the next cold invocation, attributed to the wrong request.

## Related

- [[2026-08-15-request-id-correlation-design]] — the cross-service `request_id` correlation field.
  This was the design's motivating service: before the OTel SDK landed (JE-138, now closed — see
  [Observability — tracing spans](#observability--tracing-spans)), the pipeline had no
  correlation id at all. It is a pure consumer — reads the optional envelope field, never mints
  one.
- [[ADR-0019-distributed-tracing-opentelemetry]]
- [[2026-08-18-distributed-tracing-spans-design]] — the CONSUMER->INTERNAL span structure with
  links, the manual-spans-by-packaging-necessity finding, and the SqsRecord widening trap
  documented above.
- [[2026-08-18-distributed-tracing-spans]] — implementation plan, verified against a real Jaeger
  trace.
- [[2026-08-12-custom-business-metrics-cloudwatch-design]] — the metrics design this note's
  `## Metrics` section implements: the CloudWatch/`GetMetricData` pipeline, the per-template
  `EmailType` breakdown, and why the collector must name every dimension set explicitly.
- [[linear-references]] — the convention behind referencing JE-180/JE-181 above by link instead
  of mirroring their content into this note.
- [[observability-telemetry-milestone]] — the milestone this instrumentation work belongs to.
- [[2026-08-21-verify-in-the-viewer-not-the-api]] — why the phase spans documented above
  (`phase persist`/`phase dispatch`) replaced span events as the primary signal: span events
  render in neither viewer's waterfall, verified the hard way.
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
- [[email-templates]] — how to build a template: client-support constraints, authoring rules,
  and the checklist for adding a new one.
- [[2026-08-05-realtime-tracking-events-websocket-design]] — the design for the WebSocket fan-out
  documented above: the connections table, the `by-cognito-sub` GSI, the three new env vars, and
  the gateway E2E resolution.
- [[2026-08-05-realtime-tracking-events-websocket]] — the implementation plan that shipped it.
- [[user-id-vs-cognito-sub-ownership-key]] — why the fan-out keys the GSI lookup by
  `author.cognito_sub`, never `envelope.user_id`.
- [[ADR-0020-self-owned-password-reset]] — why `PASSWORD_RESET_REQUESTED` exists, its producer
  (`ForgotPasswordCommand`), and the two security properties its best-effort publish protects.
- [[2026-08-12-custom-business-metrics-cloudwatch-design]] — the design for the email
  sent/failed metrics, the permanent-vs-transient split, and the required `templateKey` field.
