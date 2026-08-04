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
related:
  - "[[floci-sqs-lambda-docdb-support]]"
  - "[[cqrs]]"
  - "[[ADR-0002-cqrs]]"
  - "[[nano-id]]"
  - "[[audit-fields]]"
  - "[[logging-context]]"
  - "[[ADR-0007-secrets-parameter-store]]"
  - "[[ADR-0014-env-validation-zod]]"
---

# Events Pipeline Milestone Design

## Summary

Full end-to-end design for the events-pipeline milestone: SQS + DocumentDB Terraform, the
Lambda with CQRS dispatch, and wiring both producers (Users, Orders) for real — replacing the
existing `NoopEventPublisher` seams. **Definition of done:** a `POST /v1/users/register` ends
up as a document in DocumentDB and an email in Mailpit.

This spec both fills in what [[events-pipeline-design]] left open (the service is currently
design-only, no source code) and changes two of its existing decisions: handlers now send
email (not just process and record), and there are only **two** producers (Users, Orders), not
three — Tracking does not publish events in this milestone.

## Architecture

**One shared SQS queue.** Users and Orders both publish to it; a single Lambda consumes and
dispatches by `type`. Adding a producer requires no Terraform change.

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
- `type` — the dispatch key (e.g. `USER_CREATED`, `ORDER_CREATED`).
- `source` — emitting service (`users`, `orders`).
- `user_id` — the originating user.
- `order_id` — **null for non-order events** such as `USER_CREATED`.
- `payload` — the full event payload; its shape varies by `type` and is validated by the
  per-type handler schema.

`type` and `source` are ALSO set as SQS message attributes, so the queue can be inspected
without deserializing the body.

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
