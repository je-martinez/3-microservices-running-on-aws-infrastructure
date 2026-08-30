// Tracing FIRST, above every other import: this bundle has no `node --import`
// step, so "runs first" is decided purely by import order in the entry file.
import { flushTraces, pipelineTracer as tracer } from "#shared/observability/tracing";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  defaultTextMapGetter,
  trace,
  type Context,
  type Link,
  type SpanContext,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { EnvelopeSchema, type Envelope } from "#domain/envelope";
import { processRecord, type EventsRepositoryPort } from "#pipeline/process-record";
import type { EventDocument, EventStatus } from "#domain/event";
import { getMongoClient } from "#shared/db/client";
import { MongoEventsRepository, ensureIndexes, DuplicateEventError } from "#shared/db/events-repository";
import { handlers } from "#handlers/index";
import { env, e2eTestingEnabled } from "#shared/config/env";
import { appLogger } from "#shared/logging/app-logger";
import { runWithLogContext, type LogContextStore } from "#shared/logging/log-context";
import { publishMetric, SERVICE_DIMENSION } from "#shared/metrics/cloudwatch-metrics";
import { E2eEmailStore, ensureE2eIndexes } from "#e2e/email-store";
import type { RecordEmailFn } from "#email/sender";
import type { Db } from "mongodb";
import { handleEmailQuery, isFunctionUrlEvent, type FunctionUrlEvent } from "#e2e/http-query";

// Minimal structural shape of the slice of the SQS event this function reads.
// Deliberately not `SQSEvent` from @types/aws-lambda: only `messageId`, `body`
// and the one message attribute below are consumed, and narrowing the input to
// what is actually used keeps the unit tests free of 15 irrelevant required
// fields per record.
export interface SqsRecord {
  messageId: string;
  body: string;
  // The W3C `traceparent` the three publishers (Users, Orders, Tracking) inject
  // into MessageAttributes. Reading it is what joins this Lambda's spans to the
  // trace that produced the message — declared here because a field this
  // interface does not name is not a compile error at the call site, it is
  // simply `undefined`: the traceparent would arrive and be dropped in silence.
  //
  // Optional because a redelivered message published before the publishers were
  // deployed carries none, and so does the EventBridge tick path. Absent is a
  // legitimate shape, not a fault — see the link extraction in processBatch.
  messageAttributes?: Record<string, { stringValue?: string } | undefined>;
}

interface SqsEvent {
  Records: SqsRecord[];
}

// The scheduled tick that seeds the email counters (EventBridge rule
// `<name>-metrics-tick`, infra/modules/events_pipeline_schedule). Identified by
// `detail-type` rather than by the ABSENCE of `Records`: "not an SQS event"
// would also match a malformed SQS delivery, and silently treating that as a
// tick would drop real messages while reporting success.
const METRICS_TICK_DETAIL_TYPE = "3mrai.metrics.tick";

interface MetricsTickEvent {
  "detail-type": string;
}

type HandlerEvent = SqsEvent | MetricsTickEvent | FunctionUrlEvent;

function isMetricsTick(event: HandlerEvent): event is MetricsTickEvent {
  return (event as MetricsTickEvent)["detail-type"] === METRICS_TICK_DETAIL_TYPE;
}

interface BatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

// Shared cross-service log context (docs/shared/conventions/logging-context.md),
// emitted through pino by #shared/logging/app-logger — the same
// `buildLoggerOptions` schema Users uses, so a line from here and a line from
// Users are indistinguishable downstream.
//
// `trace_id`/`span_id` come from the OTel SDK bootstrapped in
// #shared/observability/tracing — nothing here synthesizes them; a
// locally-invented id would correlate with nothing.
//
// Unknown fields are OMITTED, never emitted as null — an `order_id: null` reads
// as "resolved to null" rather than "not applicable to this line".

// Context derived from an envelope, minus anything absent. NEVER includes
// `payload` — it carries user PII (emails) and, for some producers, credentials.
//
// The author is FLATTENED into `author_*` keys rather than nested as a raw
// object: a nested `author` would arrive as a structured sub-document the
// collector cannot filter on directly, and every consumer would have to know to
// unwrap it. Flat keys index and query like every other shared-context field.
//
// The prefix is load-bearing, not cosmetic. `user_id` is ALREADY taken by the
// envelope's subject (who the event is about); the author's own id is a
// different identity, and spreading it under the same key would silently
// overwrite the subject — a line that reads as correct while attributing the
// event to the wrong user.
function envelopeContext(envelope: Envelope, messageId: string): LogContextStore {
  return {
    event_id: envelope.event_id,
    type: envelope.type,
    source: envelope.source,
    user_id: envelope.user_id,
    // Spread-or-nothing rather than `order_id: envelope.order_id ?? undefined`:
    // both omit the key from the JSON, but this never puts an explicit
    // `undefined` value in the store for `setLogContext` callers to trip over.
    ...(envelope.order_id === null ? {} : { order_id: envelope.order_id }),
    author_actor: envelope.author.actor,
    // Same spread-or-nothing rule: these two are absent whenever no human
    // originated the event (a carrier webhook, a timer), and an absent key is
    // the honest encoding of "not applicable" — `author_user_id: null` would
    // read as a resolved value.
    ...(envelope.author.user_id === undefined ? {} : { author_user_id: envelope.author.user_id }),
    ...(envelope.author.cognito_sub === undefined
      ? {}
      : { author_cognito_sub: envelope.author.cognito_sub }),
    // The producer's correlation id, propagated — never generated here. Same
    // spread-or-nothing rule: a message published before the producers started
    // sending `request_id` simply has no key on its lines, which reads as "this
    // message predates the field". `request_id: null` would instead read as
    // "correlated, to nothing" — a different and misleading claim.
    ...(envelope.request_id === undefined ? {} : { request_id: envelope.request_id }),
    message_id: messageId,
  };
}

// A propagator instance of our own, rather than the global `propagation` API.
// The global one is only a real decoder once some SDK has registered it, and
// `propagation.extract` on the unregistered default is a NO-OP that returns the
// context untouched — no error, no link, a cascade that just quietly stops at
// this Lambda. Owning the instance makes the decode a property of this file
// instead of a property of whatever ran first. It is the SAME W3C decoder the
// publishers' `inject` wrote with, so `tracestate` and any future version byte
// stay handled for free.
const traceContextPropagator = new W3CTraceContextPropagator();

// The span context of the trace that PUBLISHED this record, or undefined.
//
// Extracted from ROOT_CONTEXT, never from `context.active()`. On a malformed or
// unparseable traceparent the propagator returns the context it was GIVEN,
// unchanged — and the active context here already holds this Lambda's own batch
// span. Extracting from it would hand back that span's context and attach the
// record to the very batch processing it: a reference that looks valid, points
// at the wrong trace, and is indistinguishable from a real one downstream. From
// the root there is nothing to fall back to, so a bad value yields nothing at
// all, which is the honest answer.
function originSpanContext(record: SqsRecord): SpanContext | undefined {
  const traceparent = record.messageAttributes?.traceparent?.stringValue;
  if (traceparent === undefined) return undefined;

  return trace.getSpanContext(
    traceContextPropagator.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter),
  );
}

// How a record span attaches to the trace that published its message.
//
// EVERY record is parented to its OWN origin, whatever the batch size. A batch
// of N records from N different requests therefore produces N continuous
// cascades — create_order -> SQS.SendMessage -> process_record -> ses SendEmail
// — one per order, instead of N detached ones.
//
// This replaced a hybrid that parented only when the batch held exactly one
// record and fell back to FOLLOWS_FROM links otherwise. That fallback existed
// because the record spans were children of the BATCH span, and a span has
// exactly one parent: with several origins the handler had to pick one and
// misattribute every other record. Parenting each record to its own origin
// dissolves the conflict rather than working around it — the records no longer
// share a parent, so there is nothing left to pick.
//
// The trade, made deliberately: the batch span is no longer an ancestor of the
// record spans, so a trace view no longer groups an invocation's work by
// ancestry. `batchSpanLinks` below restores that view as LINKS, which is the
// shape OpenTelemetry's messaging conventions prescribe for a consumer covering
// N origins (https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/).
// The question this optimizes for is "what happened to THIS order", not "what
// did THAT invocation do".
//
// What this buys operationally: `batch_size` stops being a tracing decision. It
// was pinned to 1 purely so the parent branch was the only branch, at the cost
// of one invocation per message; it can now be tuned for throughput without
// detaching the pipeline from the requests that drive it.
interface RecordSpanAttachment {
  // Passed to startActiveSpan as the parent context. `undefined` means "use the
  // active context", i.e. the batch span — the fallback for a record that
  // carries no usable traceparent.
  parentContext?: Context;
  links: Link[];
}

function recordSpanAttachment(record: SqsRecord): RecordSpanAttachment {
  const spanContext = originSpanContext(record);
  if (spanContext === undefined) return { links: [] };

  return { parentContext: trace.setSpanContext(ROOT_CONTEXT, spanContext), links: [] };
}

// The batch span's links: one per DISTINCT origin trace the batch carried.
//
// This is what keeps the invocation legible now that the record spans live in
// other traces. Without it the batch span would be an island — it would report
// a message count and nothing about the work behind it.
//
// Deduplicated by trace id: several records of one batch can come from the SAME
// request (an order that emits two events), and repeating that trace would
// suggest more distinct origins than the invocation actually served.
//
// Records with no traceparent contribute nothing, which is the honest encoding:
// there is no origin to point at.
function batchSpanLinks(records: SqsRecord[]): Link[] {
  const byTraceId = new Map<string, SpanContext>();
  for (const record of records) {
    const spanContext = originSpanContext(record);
    if (spanContext !== undefined && !byTraceId.has(spanContext.traceId)) {
      byTraceId.set(spanContext.traceId, spanContext);
    }
  }
  return [...byTraceId.values()].map((context) => ({ context }));
}

// Cold-start-scoped: indexes are ensured once per execution environment, not
// once per invocation. Module scope (not a `handler` local) is what makes it
// survive warm reuse.
let indexesEnsured = false;

// Test seam: a module-scope latch would otherwise leak across test cases in the
// same file, making the warm-reuse and retry-after-failure tests order-dependent.
export function resetIndexBootstrapForTests(): void {
  indexesEnsured = false;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Why this exists: `ProcessRecordResult` is `{ ok } | { ok, transient }` — it
// reports WHETHER a record failed, never WHY. That is the right shape for the
// state machine (the reason belongs on the persisted document, which it already
// writes), but the flow log needs a `reason`, and a duplicate redelivery must be
// told apart from a genuine fault so it can be logged at INFO.
//
// Rather than widen Task 7's result type, the entrypoint observes the same calls
// the state machine already makes: every failure path goes through either a
// throwing `insertStarted` or a `transition(..., "FAILED", { error })`. Wrapping
// the port is a composition concern, which is this file's job.
interface ObservedOutcome {
  reason?: string;
  duplicate: boolean;
}

function observe(
  repository: EventsRepositoryPort,
): { port: EventsRepositoryPort; outcome: ObservedOutcome } {
  const outcome: ObservedOutcome = { duplicate: false };
  return {
    outcome,
    port: {
      async insertStarted(doc: EventDocument): Promise<void> {
        try {
          await repository.insertStarted(doc);
        } catch (err) {
          if (err instanceof DuplicateEventError) {
            // Synthesized from event_id alone, so it is clean by construction
            // and safe to surface.
            outcome.duplicate = true;
            outcome.reason = err.message;
          } else {
            // NEVER the raw driver message. MongoDB write errors
            // (DocumentValidationFailure, BSONObjectTooLarge, a duplicate key on
            // a compound index) embed the REJECTED DOCUMENT in their message —
            // which is the payload, carrying the user's email and whatever else
            // the producer put there. The error class is enough to diagnose
            // from; the document itself is already persisted for inspection.
            outcome.reason = err instanceof Error ? err.name : "insert_failed";
          }
          throw err;
        }
      },
      async transition(
        event_id: string,
        status: EventStatus,
        patch?: { error?: string },
      ): Promise<void> {
        if (status === "FAILED" && patch?.error !== undefined) outcome.reason = patch.error;
        await repository.transition(event_id, status, patch);
      },
    },
  };
}

// Lambda entrypoint — deployed as `handler.handler`, matching
// infra/modules/lambda's `var.handler` default and the
// aws_lambda_event_source_mapping that invokes it. NOT `dist/handler.handler`:
// archive_file zips the CONTENTS of dist/, so handler.js sits at the ZIP ROOT
// and a `dist/` prefix would send the runtime looking for dist/dist/handler.js.
//
// Returns partial batch responses rather than throwing: Floci honors
// `batchItemFailures` correctly (verified empirically — see
// docs/lessons/floci-sqs-lambda-docdb-support.md), retrying ONLY the listed
// items. Throwing would retry the whole batch, redelivering records that already
// completed.
/**
 * Publishes a 0 for every email counter, so each series has a datapoint in
 * every time window regardless of traffic.
 *
 * WHY the counters need seeding at all: they are only emitted when a mail is
 * actually sent or fails, so in a quiet window their series has no points —
 * and OpenObserve's `metric` panel throws `Cannot read properties of undefined
 * (reading 'values')` instead of rendering 0. The card breaks precisely when
 * the answer is the reassuring one, which makes "no emails lost" and "the
 * pipeline is down" look identical on the dashboard.
 *
 * WHY it is driven by a SCHEDULE and not by the invocation itself: seeding used
 * to run at the top of every SQS batch, which cannot work — that path only runs
 * when mail is already flowing, so it published zeros exactly when they were not
 * needed and nothing during the quiet windows it was meant to cover. Verified:
 * `emails_sent_total` had ZERO points in the last 6h while `users_total`
 * (published by a real periodic loop) had continuous coverage. A Lambda has no
 * long-lived process to host a poller, so the clock has to come from outside —
 * hence the EventBridge rule.
 *
 * The zero is arithmetically free: CloudWatch sums within a period, so it never
 * alters a real count.
 */
async function seedEmailCounters(): Promise<void> {
  await Promise.all([
    ...(["permanent", "transient"] as const).map((failureKind) =>
      publishMetric("emails_failed_total", 0, {
        Service: SERVICE_DIMENSION,
        EmailType: "ALL",
        FailureKind: failureKind,
      }),
    ),
    publishMetric("emails_sent_total", 0, {
      Service: SERVICE_DIMENSION,
      EmailType: "ALL",
    }),
  ]);
}

export async function handler(event: HandlerEvent): Promise<BatchResponse> {
  // FIRST in the dispatch chain, and the order is load-bearing rather than
  // stylistic: processBatch reads `event.Records.length`, so an HTTP event that
  // reaches it dies with "Cannot read properties of undefined (reading
  // 'length')" — observed live against a Floci Function URL before this branch
  // existed, and reproduced by the test that guards it.
  //
  // No tracing span here on purpose. This route is test-support scaffolding,
  // not a business flow; giving it a CONSUMER span would put fixture reads in
  // the same waterfall as real order and email work.
  if (isFunctionUrlEvent(event)) {
    const client = await getMongoClient();
    const db = client.db(env.DOCDB_DATABASE);
    return (await handleEmailQuery(event, new E2eEmailStore(db))) as never;
  }

  // The scheduled tick seeds and returns. It must exit BEFORE the DocumentDB
  // connection below: a tick carries no records, so continuing would open a
  // connection for nothing every minute — and, worse, any future work added to
  // the record loop would run on a schedule against an empty batch.
  if (isMetricsTick(event)) {
    // A NEW trace with NO link. This invocation originates from an EventBridge
    // timer, not from a message a service published, so there is no origin
    // trace to point at — linking it to anything would be an invention.
    return tracer.startActiveSpan("metrics-tick", { kind: SpanKind.CONSUMER }, async (span) => {
      try {
        await seedEmailCounters();
        span.setStatus({ code: SpanStatusCode.OK });
        return { batchItemFailures: [] };
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(err) });
        throw err;
      } finally {
        span.end();
        await flushTraces();
      }
    });
  }

  // One CONSUMER span for the whole batch — the SQS receive side of the hop, the
  // counterpart of each publisher's PRODUCER span. It is deliberately NOT
  // parented to any origin trace: it represents the INVOCATION, which no single
  // request caused.
  //
  // It is no longer the record spans' ancestor either — those now live in their
  // own origin traces (see recordSpanAttachment). The links below are what tie
  // this invocation to the work it did.
  //
  // `batchSpanLinks` is computed defensively for the same reason the record
  // count is set inside the span rather than here: a malformed delivery with no
  // `Records` would throw while building the OPTIONS, i.e. before the span
  // exists, and the invocation would vanish from the trace instead of failing
  // visibly. An unreadable batch yields no links and still opens the span.
  const links = Array.isArray(event.Records) ? batchSpanLinks(event.Records) : [];

  return tracer.startActiveSpan(
    "events-queue process",
    { kind: SpanKind.CONSUMER, links, attributes: { "messaging.system": "aws_sqs" } },
    async (batchSpan) => {
      try {
        // The batch size is set INSIDE the span, not in the options above. A
        // malformed delivery with no Records at all throws on `.length`, and
        // from the options that throw happens BEFORE the span exists — the
        // failed invocation would then produce no span at all, exactly the
        // silent gap the `finally` below exists to prevent.
        batchSpan.setAttribute("messaging.batch.message_count", event.Records.length);
        const result = await processBatch(event);
        batchSpan.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        batchSpan.recordException(err as Error);
        batchSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(err) });
        throw err;
      } finally {
        // Both lines are load-bearing. A span not ended never reaches Jaeger,
        // and it does not show up as an error — it silently vanishes. And the
        // flush must happen HERE, before returning: Lambda freezes the process
        // on return, so an unflushed batch is lost or shipped on some later
        // invocation under the wrong request.
        batchSpan.end();
        await flushTraces();
      }
    },
  );
}

// Everything the entrypoint used to do inline, now running INSIDE the batch
// span: the DocumentDB bootstrap, the record loop and the batchItemFailures
// assembly.
async function processBatch(event: SqsEvent): Promise<BatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  let repository: MongoEventsRepository;
  // Declared alongside `repository` rather than inside the try, for the same
  // reason: the record loop below needs it, and the try only owns the bootstrap.
  let db: Db;
  try {
    const client = await getMongoClient();
    db = client.db(env.DOCDB_DATABASE);
    if (!indexesEnsured) {
      await ensureIndexes(db);
      // Only under the flag: a deployed environment that never enables E2E
      // creates neither the TTL index nor the fixture collection at all.
      if (e2eTestingEnabled) await ensureE2eIndexes(db);
      // Set only AFTER success: latching on a failed bootstrap would leave the
      // container permanently believing the indexes exist — including the unique
      // index on event_id that makes redelivery detectable.
      indexesEnsured = true;
    }
    repository = new MongoEventsRepository(db);
  } catch (err) {
    // The database is unreachable, so nothing in this batch was processed and
    // nothing may be consumed. Reporting every item (instead of throwing) keeps
    // the structured failure log, which a thrown error would replace with
    // Lambda's own unstructured stack trace.
    //
    // Logged with the fields spread explicitly: this happens BEFORE any record
    // is read, so there is no envelope and no ambient context to inherit.
    appLogger.error(
      {
        app_event: "event_processing_failed",
        reason: errorMessage(err),
        transient: true,
        record_count: event.Records.length,
      },
      "events pipeline batch aborted",
    );
    return { batchItemFailures: event.Records.map((r) => ({ itemIdentifier: r.messageId })) };
  }

  // Records run CONCURRENTLY, not in sequence. Each one is independent — its own
  // envelope, its own document keyed by a unique `event_id`, its own log scope —
  // so the serial loop this replaces was spending the batch's wall-clock waiting
  // on I/O (DocumentDB, SES) one record at a time.
  //
  // Measured on this stack: a record takes p50 256ms / p95 1111ms, almost all of
  // it awaiting the network, and the pipeline drained ~50 events/min. A full E2E
  // suite publishes far faster than that, so the queue grew for the whole run and
  // an event published mid-suite waited ~86s behind ~72 others — past the 45s
  // budget every email-asserting spec allows. The emails were never lost; they
  // arrived late. See e2e/support/purge-mailpit.ts for the full measurements.
  //
  // ## What this does NOT fix, and why no code change can
  //
  // This is correct and it helps — records now start together (verified: nine
  // consecutive `event_processing_started` lines 0.00s apart) and mid-suite email
  // latency fell from >90s to ~70s. But it does NOT get under the 45s budget,
  // because the binding constraint is LOCAL and lives outside this function.
  //
  // Floci delivers one batch per ~10s poll and runs at most 2 function containers
  // no matter what it is told, so the ceiling is batch_size / poll_interval ≈ 1
  // event/s. Measured end-to-end drains, all with this concurrent handler:
  //
  //   batch_size=10 -> 0.86-1.00 ev/s (~52/min)   <- the optimum, and the default
  //   batch_size=20 -> 0.11 ev/s      (~7/min)
  //   batch_size=50 -> did not drain 100 events in 10 minutes
  //
  // Bigger batches get DRAMATICALLY worse: Floci does not overlap invocations, so
  // one long batch blocks the next poll instead of adding parallelism. Two other
  // knobs were probed against the live emulator and rejected on measurement, not
  // on taste — `ScalingConfig.MaximumConcurrency=10` persists in the API but
  // still yields a peak of 2 containers, and raising memory 256MB -> 1024MB moved
  // p50 only 2161ms -> 1844ms (Floci does not emulate Lambda's memory-to-CPU
  // scaling, so the 256MB/render note in this service's CLAUDE.md is a PRODUCTION
  // characteristic, not a local one). Both were reverted; the live mapping matches
  // what Terraform declares.
  //
  // So the remaining E2E email failures are an EMULATOR THROUGHPUT limit, not a
  // defect in this pipeline. Do not "fix" them by widening the specs' 45s budget:
  // that budget is the one thing asserting the pipeline is timely, and in
  // production this function scales out per batch the way this code now assumes.
  //
  // Four properties make this safe, and each was checked rather than assumed:
  //
  //  1. NO ORDERING CONTRACT. The queue is standard, not FIFO
  //     (`3mrai-local-events-events`), so SQS already delivers unordered and
  //     nothing downstream may depend on record order. Serial execution was
  //     never preserving a guarantee — it only looked like it was.
  //  2. LOG CONTEXT IS PER-RECORD ALREADY. `runWithLogContext` enters an
  //     AsyncLocalStorage scope per record, and ALS isolates per async chain,
  //     not per tick — concurrent records keep their own event_id on their own
  //     lines. This is the property that would break the logs if it were false,
  //     and it is exactly what the existing per-record scope provides.
  //  3. SHARED CLIENTS ARE POOLED. `getMongoClient` caches ONE MongoClient
  //     (driver default maxPoolSize 100, far above a batch of 10) and the SES
  //     sender reuses one client. Both are built for concurrent use; the
  //     DocumentDB bootstrap and `indexesEnsured` latch run BEFORE this point,
  //     once per container, so no record races them.
  //  4. RECORDS ARE IDEMPOTENT. The unique index on `event_id` is what makes a
  //     redelivery detectable, and it holds identically whether two records are
  //     processed 1ms or 1 second apart.
  //
  // `allSettled`, never `all`: `all` rejects on the FIRST failure and abandons
  // the siblings still in flight, which would lose their batchItemFailures
  // entries and silently consume records that needed redelivery. Every record
  // must reach its own verdict.
  const outcomes = await Promise.allSettled(event.Records.map(processRecordSafely));

  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "rejected") {
      // processRecordSafely already logged and classified everything it could;
      // reaching here means the record span itself rethrew. Transient by the
      // same default the batch-level catch uses: losing an unprocessed event is
      // worse than retrying it.
      batchItemFailures.push({ itemIdentifier: event.Records[index].messageId });
      continue;
    }
    if (outcome.value) {
      batchItemFailures.push({ itemIdentifier: event.Records[index].messageId });
    }
  }

  return { batchItemFailures };

  // Kept as a closure over `repository` so the concurrent map above reads as one
  // line. Returns whether the record must be redelivered, matching the contract
  // the serial loop's `failedTransiently` had.
  async function processRecordSafely(record: SqsRecord): Promise<boolean> {
    let envelope: Envelope;
    try {
      envelope = EnvelopeSchema.parse(JSON.parse(record.body));
    } catch {
      // PERMANENT by definition: a body that cannot parse will never parse on a
      // retry, and without a valid event_id there is no document to persist it
      // against. Log and drop — deliberately NOT added to batchItemFailures, and
      // deliberately not rethrown (that would fail the whole batch).
      //
      // The parse error itself is not logged: Zod echoes the offending input,
      // which would put the raw body (emails, tokens) into CloudWatch. This is
      // also why it is NOT passed as `err` — the logger promotes an error's
      // message to `error_message` (see #shared/logging/logger).
      //
      // No envelope parsed, so there is no record context to run under: the two
      // fields that ARE known are spread explicitly.
      appLogger.error(
        {
          app_event: "event_processing_failed",
          reason: "invalid_envelope",
          transient: false,
          message_id: record.messageId,
        },
        "rejected malformed event body",
      );
      // `false` = do not redeliver, the same verdict the serial loop's
      // `continue` expressed by never reaching its batchItemFailures push.
      return false;
    }

    // One span PER RECORD, attached to the trace that published the message —
    // as a real PARENT when this batch carries exactly one record, as a LINK
    // when it carries several. See recordSpanAttachment for why the size of the
    // batch is what decides. Both fields are empty when the message carries no
    // traceparent, which is a valid shape (a pre-instrumentation redelivery),
    // not a failure.
    const { parentContext, links } = recordSpanAttachment(record);

    // One ALS scope per record: everything logged inside — here, in the state
    // machine, in the SES sender — carries this envelope's identity without any
    // call site spreading it by hand. Scoping per record (not per invocation) is
    // what keeps one record's event_id off the next one's lines.
    //
    // The log context is entered INSIDE the span so the two nest the same way
    // they read: every line for this record is emitted while the record span is
    // the active one.
    //
    // The parent context is passed as startActiveSpan's 3rd argument, which the
    // API only accepts when the callback is 4th — hence the explicit
    // `context.active()` for the branches that have no remote parent. Omitting
    // it there would parent the record span to ROOT_CONTEXT and orphan it from
    // the batch span, silently.
    const failedTransiently = await tracer.startActiveSpan(
      "process_record",
      {
        kind: SpanKind.INTERNAL,
        links,
        attributes: { "messaging.message.id": record.messageId },
      },
      parentContext ?? context.active(),
      (recordSpan) =>
        runWithLogContext(envelopeContext(envelope, record.messageId), async () => {
          try {
            const failed = await processOneRecord(envelope, repository, recordEmailFor(db, envelope));
            // A record that must be redelivered is an ERROR on its OWN span
            // only — the sibling records and the batch span stay OK, which is
            // the trace-side counterpart of batchItemFailures.
            recordSpan.setStatus({
              code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK,
            });
            return failed;
          } catch (err) {
            recordSpan.recordException(err as Error);
            recordSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(err) });
            throw err;
          } finally {
            recordSpan.end();
          }
        }),
    );

    // Only transient failures come back. A permanent one is already persisted as
    // FAILED with its error — retrying it would just re-fail until the DLQ.
    // The caller turns this into the batchItemFailures entry, in record order.
    return failedTransiently;
  }
}

// One record, inside its log context. Returns whether it must be redelivered
// (i.e. whether it belongs in batchItemFailures) — the caller assembles the
// batch response, this function owns the record's flow logs.
// The E2E recorder for one envelope, or undefined when the store is off.
//
// Returns UNDEFINED rather than a no-op function when the flag is clear: the
// sender skips the whole block on undefined, so production pays nothing and the
// fixture collection stays out of its code path entirely.
//
// `run_id` falls back to "unattributed" rather than skipping the write. A
// production event legitimately carries none, and dropping those records would
// make the collection silently incomplete — worse for debugging than a row
// nobody queries, since the schema requires the field to be non-empty.
function recordEmailFor(db: Db, envelope: Envelope): RecordEmailFn | undefined {
  if (!e2eTestingEnabled) return undefined;

  return async (params) => {
    await new E2eEmailStore(db).record({
      to: params.to,
      subject: params.subject,
      html: params.html,
      template_key: params.templateKey,
      ...(params.code === undefined ? {} : { code: params.code }),
      run_id: envelope.run_id ?? "unattributed",
      event_id: envelope.event_id,
      // Read from the ACTIVE span, and omitted when there is none — the same
      // rule logger.ts follows rather than writing an all-zero id.
      ...(trace.getActiveSpan()?.spanContext().traceId
        ? { trace_id: trace.getActiveSpan()!.spanContext().traceId }
        : {}),
    });
  };
}

async function processOneRecord(
  envelope: Envelope,
  repository: EventsRepositoryPort,
  recordEmail?: RecordEmailFn,
): Promise<boolean> {
  const startedAt = Date.now();
  appLogger.info({ app_event: "event_processing_started" }, "processing event");

  const { port, outcome } = observe(repository);

  let result;
  try {
    result = await processRecord(envelope, { repository: port, handlers, handlerDeps: { recordEmail } });
  } catch (err) {
    // processRecord converts handler failures and a failed insert into
    // results, so reaching here means a `transition` threw mid-flight — the
    // document is persisted but its status is now stale. Unclassified is
    // transient by default: losing an unprocessed event is worse than
    // retrying it.
    appLogger.error(
      {
        app_event: "event_processing_failed",
        reason: errorMessage(err),
        transient: true,
        duration_ms: Date.now() - startedAt,
      },
      "event processing threw",
    );
    return true;
  }

  const duration_ms = Date.now() - startedAt;

  if (result.ok) {
    // No SUCCESS severity by design (it is not an OTel level): success is INFO
    // plus app_event=*_succeeded.
    appLogger.info(
      { app_event: "event_processing_succeeded", duration_ms },
      "processed event",
    );
    return false;
  }

  if (outcome.duplicate) {
    // A benign at-least-once redelivery of an already-persisted event, not a
    // fault. processRecord already classified it permanent (DuplicateEventError
    // extends PermanentError), so the message is CONSUMED; logging it at ERROR
    // would turn normal SQS behaviour into alert noise.
    appLogger.info(
      {
        app_event: "event_processing_skipped",
        reason: "duplicate_event",
        duration_ms,
      },
      "skipped duplicate event",
    );
    return false;
  }

  appLogger.error(
    {
      app_event: "event_processing_failed",
      reason: outcome.reason,
      transient: result.transient,
      duration_ms,
    },
    "failed to process event",
  );

  return result.transient;
}
