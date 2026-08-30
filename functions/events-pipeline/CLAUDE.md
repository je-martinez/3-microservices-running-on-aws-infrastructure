# CLAUDE.md — events-pipeline

Nested project memory for the **events-pipeline** (SQS → Lambda). Source of
truth for its stack and conventions. The global `events-pipeline-impl` agent
reads this first, every time. Cross-cutting rules are **referenced**, never
duplicated.

## 1. Stack & versions
- Trigger: SQS message → single Lambda (CQRS dispatch by event `type`).
- Runtime: Node.js (repo-pinned via `.nvmrc` — run `nvm use`).
- Database: DocumentDB (document model + schema).
- Production: AWS Lambda. Local: also a real Lambda on Floci (Terraform deploys
  the function + SQS event source mapping) — **not** a compose worker. See
  [../../docs/domains/events-pipeline/specs/events-pipeline-design.md](../../docs/domains/events-pipeline/specs/events-pipeline-design.md)
  and [../../docs/lessons/floci-sqs-lambda-docdb-support.md](../../docs/lessons/floci-sqs-lambda-docdb-support.md).
  Re-deploying the zip on code changes trades away docker-watch hot-reload, in
  exchange for the event source mapping actually being exercised locally.

## 2. Commands
This repo uses **pnpm**, not npm — a bare `npm install` corrupts the pnpm tree.

- Install: `nvm use && pnpm install`
- Typecheck: `pnpm run typecheck` (`tsc --noEmit` — esbuild strips types, never checks them)
- Build: `pnpm run build` (typecheck, then **bundle** with esbuild into a single
  self-contained `dist/handler.js`). The Lambda entrypoint is `handler.handler`,
  **not** `dist/handler.handler` — `archive_file` zips the CONTENTS of `dist/`,
  so the file lands at the zip root. Bundling is required, not cosmetic: plain
  `tsc` left `#` subpath imports in the output and shipped no `package.json` or
  `node_modules`, so the function died on its first invocation with
  `ERR_PACKAGE_IMPORT_NOT_DEFINED`. See `scripts/build.mjs`.
- Test: `pnpm test`
- Lint: `pnpm run lint`
- Run local: `terraform apply` (Block A infra) + `pnpm run build` inside
  `functions/events-pipeline/`, then re-`terraform apply` to redeploy the zip
  (the `archive_file` data source's hash triggers a Lambda update automatically
  when `dist/` changes). No `docker compose up events-pipeline --watch`.

> `tests/shared/db/events-repository.integration.test.ts` needs a reachable
> DocumentDB and therefore must run from **inside** `3mrai_3mrai-network`
> (see §3b). With the `DOCDB_*` env vars absent it **skips**, printing why and
> how to run it for real — `pnpm test` on a clean host stays green and honest,
> which is what Layer 1 (`make test-unit`, "no stack needed") requires.
>
> Strictness is **opt-in**, and belongs in the context where the integration
> tests are actually expected to run: set `EVENTS_PIPELINE_REQUIRE_INTEGRATION=1`
> there (inside the network, or in a future `make test-integration`). It means
> "I expect DocumentDB to be reachable", so a missing or broken env is a hard
> failure instead of a skip that silently proves nothing.

## 3. Folder structure
```
functions/events-pipeline/
├── src/handlers/      # type → handler map (e.g. OrderCreatedHandler)
├── src/pipeline/      # lifecycle: STARTED → IN_PROGRESS → COMPLETED/FAILED
├── src/domain/        # Event schema (event_id, status_history, audit fields)
├── src/email/         # react-email templates, catalog, renderer, SES sender
├── src/e2e/           # E2E-ONLY: the e2e_emails fixture store + its HTTP route
├── src/shared/{config,db,logging}/
│     logging/     # pino: logger options, app-logger, per-record ALS context,
│                  # email-hash (the cross-service email_hash contract)
└── tests/
```

## 3b. Local substrate — what Floci does and does not emulate
Probed on 2026-08-03 (Floci v1.5.28). Full evidence and the local-vs-AWS
classification: [../../docs/lessons/floci-sqs-lambda-docdb-support.md](../../docs/lessons/floci-sqs-lambda-docdb-support.md).
**Everything below is a local-only limitation — none of it constrains the
production design.** Do not design around these as if they were AWS limits.

Behaves like real AWS, so rely on it: SQS visibility timeout,
`ApproximateReceiveCount`, automatic DLQ redrive, real batching in the event
source mapping, and **partial batch responses** — returning
`{ batchItemFailures: [{ itemIdentifier: <messageId> }] }` retries **only** the
failed records, verified empirically. Prefer that over throwing, which would
retry the whole batch.

Two constraints when writing code:

- **No multi-document transactions locally.** Floci backs DocumentDB with a
  single standalone `mongo:7.0` (no replica set), so `startTransaction()` fails
  — and it still fails with `retryWrites=false`, so don't chase that flag. Real
  Amazon DocumentDB does support them (engine 4.0+). The designed flow needs
  none: one insert plus single-document `$set`/`$push` updates are atomic in
  MongoDB. **If a handler ever needs a cross-collection atomic write, it will
  work in AWS but cannot be tested locally** — raise it rather than silently
  designing around it.
- **Connect to DocumentDB by container name, never by IP.** `aws docdb
  describe-db-clusters` returns a Docker network IP that Floci reassigns on
  every recreation, and port 27017 is not published to the host. Use the
  backing container name **`floci-docdb-<db-cluster-identifier>`** on
  `3mrai-network`. The connection string belongs in the generated env file
  (see [[env-files]]), never hardcoded. Tests running on the host must enter
  the Docker network to reach it.

## 3c. The E2E email store (`src/e2e/`) — test support, gated off by default

One document per rendered email, in a collection **`e2e_emails`** that is
deliberately NOT the production `events` collection, served back to the
Playwright suite over a **Lambda Function URL**. Everything here is inert unless
`E2E_TESTING_ENABLED=true`.

**Why it exists.** Mailpit answers "did the mail arrive?" but not "did the
pipeline ever render and send it?" — and those two failures look identical from
a spec's side while being fixed in completely different places. See
[../../docs/lessons/2026-08-29-the-emulator-was-the-ceiling-not-the-code.md](../../docs/lessons/2026-08-29-the-emulator-was-the-ceiling-not-the-code.md).

**It is ADDITIVE, and that is a rule, not a preference.** The E2E specs still
wait for and assert the real email. A spec that reads its OTP out of this store
instead of the message stops proving delivery end to end — a green suite bought
that way is worse than a red one.

Things worth knowing before touching it:

- **A separate collection, and a TTL index in the per-document form**:
  `createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 })` expires each row at
  the date it carries. This is the repo's only TTL index. It is created ONLY
  under the flag — a TTL on `events` would be scheduled data loss.
- **A THIRD event shape on this Lambda** (SQS batch, EventBridge tick, and now
  Function URL). The HTTP check is **first** in the dispatch chain: `processBatch`
  reads `event.Records.length`, so an HTTP event that reaches it dies with
  `Cannot read properties of undefined (reading 'length')` — observed live
  against a real Function URL before the branch existed.
- **The write happens at the point of send**, through an optional `recordEmail`
  callback on `sendEmail`, AFTER SES succeeds and swallowing its own failures.
  Recording earlier would make the store answer "what was attempted"; throwing
  later would fail a record whose email already went out, and the redelivery
  would send it twice.
- **The query route answers 404 to everything that is not fully authorised** —
  flag off, token unconfigured, token wrong — with a byte-identical body, and an
  unset token CLOSES the route. It serves plaintext OTP codes, so a 403 would
  confirm the route exists on a function holding live credentials.
- **`code` in this collection does not relax the production redaction.**
  `#domain/redact-payload` still strips it from the persisted event document; the
  plaintext exists only here, only under the flag, only for a TTL window.
- **Floci gotcha**: `create-function-url-config` and `get-function-url-config`
  work; **`list-function-url-configs` is broken** and answers with an S3
  `NoSuchBucket` XML error.

**Measured cost** (so it is not re-litigated): with the store on the pipeline
drains 0.71 ev/s, with it off 0.67 ev/s — the extra Mongo write is within noise.
The ~1 ev/s ceiling is Floci's delivery cadence, not this feature.

## 4. Conventions (referenced, never duplicated)
- CQRS dispatch: [../../docs/shared/patterns/cqrs.md](../../docs/shared/patterns/cqrs.md)
- Dependency injection: [../../docs/shared/patterns/dependency-injection.md](../../docs/shared/patterns/dependency-injection.md)
- Audit fields: [../../docs/shared/conventions/audit-fields.md](../../docs/shared/conventions/audit-fields.md) — persisted **snake_case** here (no ORM mapping layer), unlike this note's camelCase examples; see the events-pipeline spec's Data Model section.
- Env validation: [../../docs/shared/decisions/ADR-0014-env-validation-zod.md](../../docs/shared/decisions/ADR-0014-env-validation-zod.md)
- Logging context & tracing: [../../docs/shared/conventions/logging-context.md](../../docs/shared/conventions/logging-context.md)
- **Email templates: [../../docs/shared/conventions/email-templates.md](../../docs/shared/conventions/email-templates.md) → [[email-templates]] — READ BEFORE TOUCHING ANYTHING UNDER `emails/`.** Email is not a web page and the constraints are not guessable: inline SVG renders in no version of Outlook on Windows, icon fonts are stripped, and `<table>`/`<td>` must come from react-email's `Row`/`Column` rather than be hand-written. The note carries the client-support numbers behind each rule and the checklist for adding a template.

> No prefixed nano-IDs in this service: `event_id` (producer-generated) is the event's only
> identifier — no `friendlyId`, no `nanoid` dependency. See
> [../../docs/shared/conventions/nano-id.md](../../docs/shared/conventions/nano-id.md) for the
> scope correction.

## 5. Agent rules
- Converse with the user in **Spanish**; write code and comments in **English**.
- `events-pipeline-impl` writes **only source code** — never runs git or Linear.
- Leave finished work in the working tree for the **main session** to commit
  (`github-ops` is an optional helper for complex git batches — see [[git-workflow]]).
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Service spec (vault): [../../docs/domains/events-pipeline/specs/events-pipeline-design.md](../../docs/domains/events-pipeline/specs/events-pipeline-design.md)
- Local substrate probe (SQS/Lambda/DocumentDB on Floci): [../../docs/lessons/floci-sqs-lambda-docdb-support.md](../../docs/lessons/floci-sqs-lambda-docdb-support.md) — see §3b
- Lifecycle: message saved as `STARTED` → `IN_PROGRESS` (to handler) → `COMPLETED`, or `FAILED` (error saved).
- Envelope (producer → pipeline contract, `src/domain/envelope.ts`): `event_id`, `type`, `source`,
  `user_id`, `order_id`, `payload`, and a **required `author`** object
  `{ actor, user_id?, cognito_sub? }`. `author` records WHO ORIGINATED the event; the root
  `user_id` is its SUBJECT. They differ routinely — a `TRACKING_STATUS_CHANGED` from the carrier
  webhook is ABOUT a user but originated from no human at all, so `author.user_id` /
  `author.cognito_sub` are **omitted** (never null, never filled with the actor label).
  `author.actor` is the producer's own `AuditActor`, format `<source>:<action>`.
- Event fields (all snake_case, persisted as-is — no ORM): `event_id`, `order_id`, `user_id`, `type`, `source`, `payload`, `status`, `error`, `status_history`, `created_by`, `created_at`, `updated_by`, `updated_at`, `deleted_by`, `deleted_at`, `is_deleted`. `event_id` is producer-generated and the event's only identifier (uniquely indexed) — the pipeline mints no `friendlyId` of its own.
  - `created_by` carries the **producer's** `author.actor` (what ORIGINATED the event, e.g.
    `tracking_api:carrier_status_update`); `updated_by` is `events-pipeline` (what PROCESSED it)
    on every later transition. This is the one place in the repo where the two audit columns
    deliberately name different sources — see [[audit-fields]]. Note `author` itself is NOT a
    document field: its actor is extracted to `created_by`, its ids go to the log context.

### Logging & tracing in this service
- **pino**, built from the same options Users uses (`src/shared/logging/logger.ts`), so a line
  from this Lambda and a line from Users are indistinguishable downstream: `severity_text` /
  `severity_number` replace pino's numeric level, and `err` is promoted to top-level
  `error_type` / `error_message`.
- The AsyncLocalStorage context unit is **one SQS record**, not an HTTP request — that is the only
  real adaptation of the Users pattern. `runWithLogContext` must `await` INSIDE the callback or the
  store is lost at the await site (same hazard as [[prisma-lazy-promise-als]]; here it is the
  mongodb driver's and SES client's promises).
- Author fields are logged as `author_actor` / `author_user_id` / `author_cognito_sub`. The prefix
  is load-bearing: the envelope's root `user_id` already occupies `user_id`, and an unprefixed key
  would silently overwrite one with the other.
- **PII:** never log `payload` (it carries emails). Never log a Zod parse error — it echoes the raw
  body. Reduce Mongo driver errors to `err.name`: the driver's message embeds the REJECTED
  DOCUMENT. Email recipients are logged only as `email_hash`.
- **No transports.** pino writes to its default synchronous stdout destination. This Lambda is
  bundled by esbuild into a single CJS file, and a worker-thread transport would break there.
- `trace_id` / `span_id` are stamped on every line by `logger.ts`'s formatter, read from the
  ACTIVE SPAN per line (lowercase hex, 32/16 chars; **omitted** when no span is active — never an
  all-zero id). Written by hand here, unlike Users: `@opentelemetry/instrumentation-pino` patches
  pino at `require()` time, and esbuild has inlined pino into the single-file bundle, so it would
  patch nothing and every line would ship without a trace id, silently.
- **Spans are all manual, for the same bundling reason** — `getNodeAutoInstrumentations()` would
  produce zero spans here. The SDK bootstrap is `src/shared/observability/tracing.ts`
  (`BatchSpanProcessor` + `flushTraces()`, which the handler MUST call in its `finally`: Lambda
  freezes the process on return). The handler opens `events-queue process` (CONSUMER) per batch
  and `process_record` (INTERNAL) per record, attached to the record's origin trace via
  `messageAttributes.traceparent`. The attachment is **parent-child for every
  record, at any batch size**, so an order's email work appears in the same trace as the request
  that caused it. Each record parents to its OWN origin, which is why a batch mixing N distinct
  origins needs no winner picked: the records do not share a parent. `batch_size` is therefore a
  throughput knob (currently the `modules/lambda` default of `10`), NOT a tracing decision — it
  was pinned to `1` until 2026-08-21 and no longer is. The cost of that shape: the batch span is
  **not** an ancestor of the record spans, so `batchSpanLinks` gives it one **link** per distinct
  origin trace (deduplicated) to keep the per-invocation view — do not turn those links back into
  a parent edge. A record whose message carries no `traceparent` still falls back under the batch
  span, which is the honest encoding of "no origin to attach to". Outbound calls use `withClientSpan`
  (`src/shared/observability/client-span.ts`): `documentdb insertOne`, `ses SendEmail`,
  `ws publish`. It takes an explicit `describeError` because a Mongo error's message embeds the
  rejected document — the span obeys the same PII rule as the log line.
- **Every step of a record's lifecycle carries a span, and the boundaries between them are span
  events.** The rule when adding work to `processRecord` or a handler: if it takes time, give it a
  span; if it is an instant, mark it with `markPhase` (`src/pipeline/process-record.ts`). A step
  with neither becomes a hole — measured: before this, `process_record` reported 194ms against
  ~1ms of visible children, because the three `transition()` writes, the template render and the
  CloudWatch publishes were all uninstrumented. The current shape covers **99.5%** of the span's
  duration:
  - `documentdb insertOne` and `documentdb updateOne <STATUS>` — the status is IN THE NAME because
    a waterfall renders names, not attributes; three bars all reading `updateOne` would each need
    a click to tell apart.
  - `email render <template>` — INTERNAL, not CLIENT: React rendering in-process, no socket.
  - `cloudwatch PutMetricData` — appears **twice** per email metric (`publishEmailMetric` emits a
    per-template series and an ALL rollup). It does NOT use `withClientSpan`, because that helper
    rethrows and this call's contract is that a metric failure never fails the record; the span
    records the error and the function still returns.
  - Phase events on `process_record`: `message_received`, `handler_dispatched`, `handler_returned`,
    and the failure marks (`persist_failed_record_dropped`, `no_handler_for_type`,
    `handler_failed`).
- **The render dominates the record** — 214–237ms against ~60–68ms for the SES call it feeds, and
  it is not cold start (no downward trend across six renders). Two causes, separated by
  measurement: `@react-email/render` costs ~60ms even warm on native hardware, and the function's
  256 MB gives it a fraction of a vCPU (Lambda CPU scales with memory). Tracked separately; do not
  "fix" it by deleting the span that revealed it.
