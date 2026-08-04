---
title: Events Pipeline Milestone Design
type: spec
area: events-pipeline
status: draft
created: 2026-08-03
updated: 2026-08-03
tags:
  - type/spec
  - area/events-pipeline
  - status/draft
propagates-to:
  - "[[events-pipeline-design]]"
  - "[[testing]]"
  - "[[env-files]]"
  - "[[tracking-service-design]]"
related:
  - "[[floci-sqs-lambda-docdb-support]]"
  - "[[cqrs]]"
  - "[[ADR-0002-cqrs]]"
  - "[[nano-id]]"
  - "[[audit-fields]]"
  - "[[logging-context]]"
  - "[[ADR-0007-secrets-parameter-store]]"
  - "[[ADR-0014-env-validation-zod]]"
  - "[[tracking-service-design]]"
---

# Events Pipeline Milestone Design

## Summary

Full end-to-end design for the events-pipeline milestone: SQS + DocumentDB Terraform, the
Lambda with CQRS dispatch, and wiring all **three** producers (Users, Orders, Tracking) for
real — replacing the existing `NoopEventPublisher` seams. **Definition of done:** a
`POST /v1/users/register` ends up as a document in DocumentDB and an email in Mailpit, and a
tracking delivery-status change ends up as a document in DocumentDB and a notification email in
Mailpit.

This spec both fills in what [[events-pipeline-design]] left open (the service is currently
design-only, no source code) and changes two of its existing decisions: handlers now send
email (not just process and record), and there are **three** producers (Users, Orders,
Tracking), not two.

> [!info] Reversal — Tracking now publishes
> [[tracking-service-design]] states Tracking is a pure consumer/updater that publishes no
> events. That was accurate for the state before this milestone. This design changes it: a
> delivery-status change (`SHIPPED → ON_THE_WAY → OUT_FOR_DELIVERY → DELIVERED`) is exactly the
> kind of thing a user expects to be emailed about, so Tracking becomes a third producer here.
> Tracking's spec is updated alongside this one (see `propagates-to:`) rather than left stale.

## Architecture

**One shared SQS queue.** Users, Orders, and Tracking all publish to it; a single Lambda
consumes and dispatches by `type`. Adding a producer requires no Terraform change — Tracking
joining as a third publisher in this same spec is that shared-queue decision paying off: no new
queue, no new event source mapping, no new DLQ, just a third `SendMessage` caller and a new
entry in the dispatch map.

> [!warning] Supersedes system-context.md
> `docs/00-overview/system-context.md` currently names two queues, `users-events` and
> `orders-events`. This design supersedes that row — reconcile it to a single shared queue
> when this spec propagates.

### Rejected alternatives

- **Per-producer queues.** Two event source mappings, two DLQs, more Terraform per producer
  added, for no benefit at this scale.
- **EventBridge → SQS → Lambda.** EventBridge's selling point is multiple consumers of the
  same event, and there is exactly one consumer today — per [[events-pipeline-design]], the
  pipeline is the terminal consumer of events. Adding the extra hop now is YAGNI. Migrating
  later is cheap: swap `SendMessage` for `PutEvents` in the two publishers, add a rule, and the
  Lambda is nearly untouched.

### Message envelope

The contract between producers and the pipeline:

```json
{
  "event_id": "...",
  "type": "USER_CREATED",
  "source": "users",
  "user_id": "...",
  "order_id": null,
  "payload": { "...": "..." }
}
```

- `event_id` — producer-generated, unique; the idempotency key.
- `type` — the dispatch key (e.g. `USER_CREATED`, `ORDER_CREATED`, `TRACKING_STATUS_CHANGED`).
- `source` — emitting service (`users`, `orders`, `tracking`).
- `user_id` — the originating user.
- `order_id` — **null for non-order events** such as `USER_CREATED`.
- `payload` — the full event payload; its shape varies by `type` and is validated by the
  per-type handler schema.

`type` and `source` are ALSO set as SQS message attributes, so the queue can be inspected
without deserializing the body.

### `TRACKING_STATUS_CHANGED` payload

One event type covers all four transitions (see [[#Producer wiring]] → Tracking for why, and
the rejected per-status-type alternative). Envelope fields specific to this type:

```json
{
  "event_id": "...",
  "type": "TRACKING_STATUS_CHANGED",
  "source": "tracking",
  "user_id": "...",
  "order_id": "...",
  "payload": {
    "status": "OUT_FOR_DELIVERY",
    "previous_status": "ON_THE_WAY",
    "changed_at": "..."
  }
}
```

- `user_id` — the recipient of the notification email; read from the persisted tracking record
  (see the Tracking producer subsection — this is **not** available on the request).
- `payload.status` — the new status; the handler picks the email template variant by this
  field.
- `payload.previous_status` — included so the email can say what changed (e.g. "your order is
  now on the way"), not just the new state in isolation.
- `payload.changed_at` — the transition timestamp.

### Per-record flow (state machine)

1. Parse and validate the envelope (Zod).
2. Persist the event document with `status: STARTED` and an `evt_`-prefixed `friendlyId`.
3. Look up `handlers[type]` — if missing, set `FAILED` with `error: "Unknown event type"`.
4. Set `IN_PROGRESS`.
5. Invoke the handler.
6. On success: `COMPLETED`. On exception: `FAILED` with the error message.

Every transition `$push`es to `status_history` (append-only), verified working on Floci per
[[floci-sqs-lambda-docdb-support]].

### Ordering decision

The document is persisted **before** dispatch, so an event with an invalid payload is still
recorded as `FAILED` rather than silently dropped. This is a decision [[events-pipeline-design]]
left open — resolved here: the audit trail must capture failures too, since that is what makes
an event store useful.

### Idempotency (new field)

SQS is at-least-once and retries genuinely redeliver messages (verified in
[[floci-sqs-lambda-docdb-support]]). A Lambda-generated `friendlyId` differs per attempt, so it
cannot be used to dedupe. **The producer generates `event_id`**, and it carries a unique index
in DocumentDB — a retry collides on that index and is treated as already-processed instead of
being duplicated.

`event_id` is a **new field on the `events` collection**, added to the data model in
[[events-pipeline-design]] (which does not currently list it), persisted on every document, and
carrying its own unique index alongside the existing `friendlyId` unique index. The two are
different things and both are kept: `friendlyId` is the pipeline's own `evt_`-prefixed display
id (see [[nano-id]]); `event_id` is the producer's idempotency key.

This matters more here than in a typical event store because handlers send email: a duplicate
processing is a duplicate email to a real user, not just an extra row.

## Infrastructure (Terraform)

Two new modules in the currently-empty dirs, following existing module patterns (cloudposse/
label naming per ADR-0001):

- **`infra/modules/messaging/`** — `aws_sqs_queue` (main) with `RedrivePolicy` → DLQ,
  `maxReceiveCount = 3`; the DLQ itself; and `aws_lambda_event_source_mapping` with
  `batch_size` and **`function_response_types = ["ReportBatchItemFailures"]`**.

  > [!warning] Must be declared at create time
  > Floci silently drops `FunctionResponseTypes` on `update-event-source-mapping` (verified,
  > see [[floci-sqs-lambda-docdb-support]]). Adding it to an existing mapping requires
  > **recreating** the mapping, not updating it in place. This warning belongs as a comment in
  > the Terraform module itself, not only in CLAUDE.md.

- **`infra/modules/database/`** — `aws_docdb_cluster` + `aws_docdb_cluster_instance`;
  credentials to Parameter Store per [[ADR-0007-secrets-parameter-store]].

- **New module `infra/modules/lambda/`** — `aws_lambda_function`, its IAM execution role (SQS
  `ReceiveMessage`/`DeleteMessage`/`GetQueueAttributes`, plus SES send), log group, zip
  packaging. The existing `compute/` module is ECS/nginx-specific (cluster, task definition,
  service, ECS roles); putting a Lambda there would break its cohesion, hence a dedicated
  module. Whether the event source mapping itself lives in `messaging/` or `lambda/` is an
  implementation detail.

### Local specifics (all verified, all local-only — [[floci-sqs-lambda-docdb-support]])

- DocumentDB is **not** discovered like RDS: absent from `rds describe-db-clusters`, and port
  27017 is not published to the host.
- Connect via the backing container name **`floci-docdb-<db-cluster-identifier>`**, derived
  from the Terraform cluster identifier (not random), resolving over Docker DNS — no
  `docker inspect`, no alias step needed.
- The connection string is generated into `.env.local.events-pipeline` by `make env-file` per
  [[env-files]] (AUTO-GENERATED box) — never hardcoded, following the same per-service-file
  pattern env-files already established.
- A second `terraform apply` fails locally (a Floci `UpdateTags` quirk), so re-applying means
  tear-down + rebuild.

### Explicitly out of scope (YAGNI)

No FIFO queue (no ordering requirement); no custom KMS encryption; no DocumentDB read replicas
(Floci doesn't emulate them, and no load justifies them); no CloudWatch alarms.

## Lambda code

Structure under `functions/events-pipeline/`:

- `emails/` at the package root (react-email CLI default dir): `user-created.tsx`,
  `order-created.tsx`, `components/` for shared layout.
- `src/handler.ts` — Lambda entrypoint: iterates Records, assembles `batchItemFailures`.
- `src/pipeline/process-record.ts` — the state machine for **one** record. Knows nothing about
  AWS — takes an envelope, returns a result. This is what makes the state machine
  unit-testable without the emulator.
- `src/pipeline/errors.ts` — `PermanentError` vs `TransientError`.
- `src/handlers/{index,user-created,order-created}.ts` — the `type → handler` map.
- `src/email/{renderer,sender,catalog}.ts`.
- `src/domain/{envelope,event}.ts`, `src/shared/{config,db,di}/`.

### Error handling (deviation from [[events-pipeline-design]])

[[events-pipeline-design]] states "no retry is applied at this layer." This spec deliberately
deviates:

- **`PermanentError`** (invalid envelope, unknown type, payload that fails validation, missing
  template) → persist `FAILED` and **consume** the message, since retrying can never help.
- **`TransientError`** (DocumentDB unreachable, SES down, timeout) → the record goes into
  `batchItemFailures` so SQS retries it and it eventually lands in the DLQ.
- **Anything unclassified is treated as transient** — the safe default prefers retrying over
  silently losing an event.

Justification: partial batch responses are verified working on Floci
([[floci-sqs-lambda-docdb-support]]), and without this distinction a momentary SES outage would
silently drop emails instead of retrying them.

### DocumentDB client

Reused across invocations (declared outside the handler for warm-container reuse); URI from
env. **No transactions** — the flow is one insert plus a single-document `$set`/`$push`,
atomic in MongoDB on its own.

> [!note] Transactions work in AWS, not locally
> Real Amazon DocumentDB supports multi-document transactions from engine 4.0+, but Floci's
> standalone mongo container does not (per [[floci-sqs-lambda-docdb-support]]). If a future
> handler ever needs a cross-collection atomic write, it will work in AWS but cannot be tested
> locally — raise it rather than silently designing around it.

### Logging

Per [[logging-context]]: every line carries the shared context (`trace_id`, `user_id`,
`order_id`, `event_id`); flow logs use `app_event`
(`event_processing_started|_succeeded|_failed`) plus `reason` on failure. Never log the full
payload or a plaintext email — use the masked form / `email_hash`. OTel config goes in
environment variables, not code.

### Implementation order

Envelope + state machine + `USER_CREATED` end-to-end **first**; `ORDER_CREATED` **second**.
[[events-pipeline-design]] claims adding a type is "only registering a new key in the dispatch
map" — doing the second type separately is what proves that rather than assuming it. If it
turns out to need more than a dispatch-map entry, the dispatch is mis-factored.

## Email (new — this is what the handlers actually do)

[[events-pipeline-design]]'s handlers validate and process; this spec adds that they also
**send email**. Validation remains the precondition for rendering:
`validate payload (Zod) → render react-email template to HTML → SES SendEmail → COMPLETED`.

### Rendering decision

react-email renders to HTML in the Lambda via `@react-email/render`; SES is transport only
(`SendEmail`). Rejected: SES native templates (`CreateTemplate` + `SendTemplatedEmail`), which
Floci does support — rejected because the template would then live in infra rather than the
repo, would need re-syncing on every change, and variables would interpolate with SES syntax
instead of React. Templates stay versioned in the repo with preview.

### `src/email/catalog.ts` — the key piece

A single registry mapping template → component + sample props, consumed by all three
consumers: handlers (to render), the preview server (to list), and tests (for snapshots). One
source of truth; adding a template is one entry.

### `tracking-status-changed` template family

One event type (`TRACKING_STATUS_CHANGED`), four rendered variants — one per status
(`SHIPPED`, `ON_THE_WAY`, `OUT_FOR_DELIVERY`, `DELIVERED`). The handler selects the variant by
`payload.status` and passes `payload.previous_status` in as a prop so copy can reference the
prior state. This is the same catalog mechanism as `user-created`/`order-created`: multiple
template entries keyed by status live in `catalog.ts` alongside the others, not in a separate
registry — a `tracking-status-changed` handler is one entry in the same `type → handler` map,
with the status→component fan-out happening inside that one handler rather than as four
top-level dispatch entries (see Producer wiring → Tracking for why this is one event type, not
four).

### Preview server

react-email's `email dev` (default port 3000, reads the `emails/` dir), added as a compose
service behind a profile so it does **not** start with a normal `make up`. Hot-reloads on
`.tsx` edits.

### Mailpit

A compose service (web UI 8025, SMTP 1025), with Floci relaying to it via
`FLOCI_SERVICES_SES_SMTP_HOST=mailpit` and `FLOCI_SERVICES_SES_SMTP_PORT=1025`. Emails the
Lambda sends land in a real, inspectable inbox.

> [!warning] Floci SMTP relay caveat
> The SMTP relay does not preserve arbitrary headers, attachments, or complex multipart
> structures — fine for simple HTML. If attachments ever appear, inspect via Floci's
> `/_aws/ses` endpoint instead. Floci also always stores emails locally regardless of relay, so
> `/_aws/ses` works either way.

### Sender identity

`VerifyEmailIdentity` for the from-address in the local Terraform — immediate in Floci, no DNS
flow needed.

## Producer wiring

Both services already have the emission seam, so this is a substitution, not new plumbing:
Users has `EventPublisher`/`NoopEventPublisher` in
`services/users/src/shared/messaging/event-publisher.ts` (interface method
`publishUserCreated({ id, email })`), and Orders has `IEventPublisher`/`NoopEventPublisher` in
`services/orders/src/Orders.Infrastructure/Messaging/NoopEventPublisher.cs` (method
`PublishOrderCreatedAsync(orderId, userId, totalCents, createdAt, ct)`). Real implementations
replace the Noop registration in each service's DI container.

**Each producer must now generate `event_id`** and build the full envelope. The two existing
seam signatures do not carry an `event_id`, so the interfaces may need adjusting — the
implementer should decide whether the id is generated inside the publisher implementation
(keeping the seam signature untouched, which is preferable) or threaded through from the
caller.

Both publish with `SendMessage` to the one shared queue, setting `type` and `source` as SQS
message attributes. Each service reads the queue URL from its own generated env file per
[[env-files]], never hardcoded. The Noop implementations stay in the codebase for tests that
must not emit.

### Tracking (new — third producer)

Tracking joins as a third publisher to the same shared queue, emitting `TRACKING_STATUS_CHANGED`
on every delivery-status transition.

**Emission point.** The single write path for status changes is
`services/tracking/src/features/tracking/commands/update_status.py` — a transport-free command
(takes a dataclass, returns the persisted entity). Both the carrier webhook
(`PUT /v1/trackings/{orderId}/status`) and TestMode's automatic progression go through this one
command, so emitting from here covers both paths without duplicating the emission call at each
caller.

**One event type, not four.** All four transitions (`SHIPPED → ON_THE_WAY →
OUT_FOR_DELIVERY → DELIVERED`) emit the same `TRACKING_STATUS_CHANGED` type; the handler picks
the email template variant by `payload.status` (see Email → `tracking-status-changed` template
family). Rejected alternative: a distinct event type per status
(`TRACKING_SHIPPED`, `TRACKING_ON_THE_WAY`, ...). Rejected because four near-identical dispatch
entries and four near-identical handlers would duplicate logic that `catalog.ts` already
handles cleanly by supporting multiple template entries keyed off one payload field — the
variation belongs in the template selection, not in the event taxonomy.

**All four transitions send email, including `DELIVERED`.** No transition is exempt.

**TestMode emits too — no suppression branch.** Emission lives in `update_status.py`, the path
shared by both the carrier webhook and TestMode, so TestMode's automatic progression exercises
the real email flow end-to-end rather than a stubbed one. Rationale for not adding a
TestMode-only suppression: it would leave the email path untested in exactly the test meant to
cover it, and it would add a conditional branch to the one shared command that this design
otherwise keeps simple. Consequence: a TestMode E2E run progresses one tracking through all
four statuses in ~30 seconds and produces **four emails in Mailpit for that one tracking** —
this is expected, not a bug, and E2E assertions must account for it (see Testing).

> [!warning] Easy-to-miss trap — `user_id` comes from the tracking record, not the request
> The carrier webhook is authenticated by an API key and carries **no** `x-user-id` — its
> repository lookup in `update_status.py` is unscoped (`user_id=None`) precisely because there
> is no request-level identity to scope by. An implementer who reaches for a request-supplied
> user id here will produce an envelope with no recipient. **The persisted tracking row is the
> only source of `user_id`** for this event — read it from the entity `update_status.py`
> already loads and returns, not from any request context.

**Idempotency: `event_id` derived per transition, not per request.** Given the forward-only
state machine, `(order_id, status)` is a natural key for a transition and is what `event_id` is
derived from. This matters specifically because of TestMode: it fires four transitions in
roughly 30 seconds, and if `event_id` were instead regenerated fresh on every send attempt, a
retry of the same transition (e.g. after a transient SQS error) would mint a new id, miss the
pipeline's unique-index dedupe, and send a duplicate notification email for a transition that
already succeeded. Deriving from `(order_id, status)` means a retry of the same transition
always collides on the same id.

**Publisher implementation.** Tracking is Python/FastAPI, so its publisher is a Python/boto3
SQS client (`send_message`), setting `type` and `source` (`"tracking"`) as message attributes
like the other two producers. The queue URL comes from Tracking's own generated env file per
[[env-files]] (AUTO-GENERATED box), never hardcoded — same pattern as Users and Orders. A
Noop-equivalent publisher is retained in the codebase for tests that must not emit, mirroring
`NoopEventPublisher` in Users and Orders.

## Testing

The repo's three-layer convention ([[testing]]) is written for HTTP endpoints; this component
has none (it is SQS-triggered). This spec adapts the spirit — unit → integrated → the real
production path — rather than the literal layers.

### Layer 1 — unit, no AWS

- State machine: all four transitions, `status_history` append-only.
- Error classification: invalid payload → `PermanentError`, network failure →
  `TransientError`.
- Zod schemas: envelope and per-type payload, valid and invalid cases.
- Dispatch: known type → right handler; unknown type → `FAILED` "Unknown event type".
- Template rendering: every catalog entry renders without throwing and contains the expected
  data, with snapshots to catch unintended changes.

> [!warning] Known repo hazard — mocks hide schema bugs
> A test with mocked Mongo can pass while the real driver rejects the document. The unique
> index and `$push` behavior are **not** tested with mocks — they belong to layer 2.

### Layer 2 — integration against Floci

- Real persistence: full document including audit fields and `friendlyId`, connecting by
  container name from inside the Docker network.
- Unique-index/idempotency: insert the same `event_id` twice → second is rejected and no second
  email is sent.
- SES delivery asserted via the Mailpit API (or `/_aws/ses`), **not** a mock — assert
  recipient, subject, and that the body contains the event's data.

### Layer 3 — end-to-end, the real path

The analogue of the convention's gateway E2E: `POST /v1/users/register` through the gateway →
Users' real publisher puts the message on SQS → the event source mapping invokes the Lambda →
document appears in DocumentDB as `COMPLETED` → email appears in Mailpit.

This justifies choosing a real Lambda on Floci over a compose worker: it exercises the event
source mapping, which a worker never would, and it catches what internal tests cannot — that
the producer publishes the right envelope, that the mapping is configured correctly, and that
the IAM role has the needed permissions.

Plus a dedicated **`batchItemFailures` test** (the mechanism easiest to break unnoticed):
inject a batch with one good message and one that triggers a transient failure; assert the
good one is consumed exactly once and only the bad one is retried. This was verified by hand
during the [[floci-sqs-lambda-docdb-support]] probe and should become a test.

### Tracking's own three layers for the new emission

Tracking's producer role gets the same three-layer treatment as the pipeline side, scoped to
`update_status.py`'s new responsibility:

1. **Unit** — the command emits an envelope with the right `type`, `source`, `user_id` (from
   the persisted entity, not a request param), `order_id`, `payload.status`, and
   `payload.previous_status` for each of the four transitions; `event_id` is stable for the same
   `(order_id, status)` across repeated calls.
2. **Integration against Floci** — a real status update through the command really lands a
   message on the shared queue (inspected directly, not mocked), with the correct message
   attributes.
3. **E2E** — a delivery-status change (via the carrier webhook or TestMode progression)
   produces a `COMPLETED` document in DocumentDB and the corresponding email in Mailpit, for
   each of the four statuses.

> [!warning] TestMode E2E produces four emails per run
> Because TestMode emits on every transition with no suppression (see Producer wiring →
> Tracking), a single TestMode E2E run that progresses a tracking through all four statuses
> produces **four emails in Mailpit for that one tracking**, not one. E2E assertions for
> Tracking must expect and check all four, not just the final `DELIVERED` state.

### Async assertions

Poll with a timeout, never a fixed sleep — per the repo lesson, measure over 2-3× the expected
period or tests give a false PASS/FAIL. E2E rows are tagged so global teardown removes them, as
Tracking already does.

### Cannot be tested locally

Multi-document transactions (see the DocumentDB client note above). Explicit so nobody
introduces one unknowingly.

## Local runtime decision

The Lambda runs as a **real Lambda on Floci** (Terraform deploys the function and the event
source mapping), not as a compose worker.

**Trade-off:** local mirrors production and the event source mapping actually gets tested, at
the cost of re-deploying the zip on code changes — losing docker-watch hot-reload.

> [!warning] Consequence to reconcile during implementation
> The existing `events-pipeline` service in `docker-compose.yml` (build + watch, no ports/DB/
> healthcheck) no longer makes sense as a worker under this decision, and
> `functions/events-pipeline/CLAUDE.md` §1 still says "Local: a worker service via
> docker-watch." Both need reconciling during implementation.

## Related

- [[floci-sqs-lambda-docdb-support]]
- [[cqrs]]
- [[ADR-0002-cqrs]]
- [[nano-id]]
- [[audit-fields]]
- [[logging-context]]
- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0014-env-validation-zod]]
- [[events-pipeline-design]]
- [[tracking-service-design]]
