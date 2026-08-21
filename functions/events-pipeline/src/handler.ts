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
import { env } from "#shared/config/env";
import { appLogger } from "#shared/logging/app-logger";
import { runWithLogContext, type LogContextStore } from "#shared/logging/log-context";
import { publishMetric, SERVICE_DIMENSION } from "#shared/metrics/cloudwatch-metrics";

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

type HandlerEvent = SqsEvent | MetricsTickEvent;

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

// How a record span attaches to the trace that published its message. The choice
// is made PER BATCH, from the batch size, and the two branches are not
// interchangeable:
//
//   1 record  -> PARENT. The origin is unambiguous, so `process_record` becomes
//     a real child of the publisher's span and the whole cascade stays ONE
//     trace: create_order -> SQS.SendMessage -> process_record -> ses SendEmail.
//     Before this, the email work lived in a second trace reachable only by
//     following a FOLLOWS_FROM reference — a user opening the create_order trace
//     saw no email at all.
//
//   2+ records -> LINK, as before. A batch mixes messages from DISTINCT traces,
//     so naming a parent means picking one of N origins and misattributing every
//     other record. A link says "caused by, elsewhere" per record, independently.
//
// The event source mapping is pinned to `batch_size = 1` (see the
// `lambda_events_pipeline` module call in infra/environments/local/main.tf), so
// the parent branch is the one that fires and the cascade is continuous for
// every order. That pin is the REASON the parenting is safe, not an incidental
// detail: it is what guarantees a batch never mixes origins.
//
// The link branch therefore looks dead, and stays anyway. Batch size is a
// deployment property this code does not control: raise it in Terraform, or run
// against an environment that sets it differently, and multi-record batches
// reappear immediately. Deleting this branch would not prevent that — it would
// only make the handler parent all N records to whichever origin came first,
// silently filing one customer's email under another customer's order. It is a
// correctness guard for a configuration change, not unreachable code.
//
// Why links and not "parent to the first, link the rest": OpenTelemetry's
// messaging conventions are explicit that a span has exactly one parent and
// that links are the mechanism for a consumer covering N origins
// (https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/).
// Picking a winner among equals would misattribute the other N-1 rather than
// represent them. The batch span also records
// `messaging.batch.message_count`, so a batch that ever exceeds one is visible
// in the trace instead of being inferred from a missing parent.
interface RecordSpanAttachment {
  // Passed to startActiveSpan as the parent context. `undefined` means "use the
  // active context", i.e. the batch span — which is what both the multi-record
  // branch and the no-traceparent case want.
  parentContext?: Context;
  links: Link[];
}

function recordSpanAttachment(record: SqsRecord, batchSize: number): RecordSpanAttachment {
  const spanContext = originSpanContext(record);
  if (spanContext === undefined) return { links: [] };

  return batchSize === 1
    ? { parentContext: trace.setSpanContext(ROOT_CONTEXT, spanContext), links: [] }
    : { links: [{ context: spanContext }] };
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
  // counterpart of each publisher's PRODUCER span. Its children are the
  // per-record spans below; it is deliberately NOT parented to any of their
  // origin traces (see processBatch).
  return tracer.startActiveSpan(
    "events-queue process",
    { kind: SpanKind.CONSUMER, attributes: { "messaging.system": "aws_sqs" } },
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
  try {
    const client = await getMongoClient();
    const db = client.db(env.DOCDB_DATABASE);
    if (!indexesEnsured) {
      await ensureIndexes(db);
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

  for (const record of event.Records) {
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
      continue;
    }

    // One span PER RECORD, attached to the trace that published the message —
    // as a real PARENT when this batch carries exactly one record, as a LINK
    // when it carries several. See recordSpanAttachment for why the size of the
    // batch is what decides. Both fields are empty when the message carries no
    // traceparent, which is a valid shape (a pre-instrumentation redelivery),
    // not a failure.
    const { parentContext, links } = recordSpanAttachment(record, event.Records.length);

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
            const failed = await processOneRecord(envelope, repository);
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
    if (failedTransiently) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}

// One record, inside its log context. Returns whether it must be redelivered
// (i.e. whether it belongs in batchItemFailures) — the caller assembles the
// batch response, this function owns the record's flow logs.
async function processOneRecord(
  envelope: Envelope,
  repository: EventsRepositoryPort,
): Promise<boolean> {
  const startedAt = Date.now();
  appLogger.info({ app_event: "event_processing_started" }, "processing event");

  const { port, outcome } = observe(repository);

  let result;
  try {
    result = await processRecord(envelope, { repository: port, handlers });
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
