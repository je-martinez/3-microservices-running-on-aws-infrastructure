// WHY: Import tracing first; bundling without node --import relies on import execution order.
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

// WHY: Minimal structural SQS slice to avoid pulling full @types/aws-lambda in unit tests.
export interface SqsRecord {
  messageId: string;
  body: string;
  // W3C traceparent injected by publishers; joins record spans to the origin trace.
  messageAttributes?: Record<string, { stringValue?: string } | undefined>;
}

interface SqsEvent {
  Records: SqsRecord[];
}

// WHY: Identified by detail-type rather than absent Records to avoid dropping malformed SQS events.
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

// Shared cross-service log context.

// CONTRACT: Never include payload (carries PII). Prefix author fields as author_* to avoid
// overwriting the envelope root user_id. Unknown fields are omitted, never null.
// See [[logging-context]]
function envelopeContext(envelope: Envelope, messageId: string): LogContextStore {
  return {
    event_id: envelope.event_id,
    type: envelope.type,
    source: envelope.source,
    user_id: envelope.user_id,
    ...(envelope.order_id === null ? {} : { order_id: envelope.order_id }),
    author_actor: envelope.author.actor,
    ...(envelope.author.user_id === undefined ? {} : { author_user_id: envelope.author.user_id }),
    ...(envelope.author.cognito_sub === undefined
      ? {}
      : { author_cognito_sub: envelope.author.cognito_sub }),
    ...(envelope.request_id === undefined ? {} : { request_id: envelope.request_id }),
    message_id: messageId,
  };
}

// WHY: Explicit propagator instance avoids reliance on global SDK registration state.
const traceContextPropagator = new W3CTraceContextPropagator();

// CONTRACT: Extract traceparent from ROOT_CONTEXT (not active context) so bad or missing
// headers return undefined rather than misattributing to the current batch span.
// See [[logging-context]]
function originSpanContext(record: SqsRecord): SpanContext | undefined {
  const traceparent = record.messageAttributes?.traceparent?.stringValue;
  if (traceparent === undefined) return undefined;

  return trace.getSpanContext(
    traceContextPropagator.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter),
  );
}

// CONTRACT: Parent each record span to its origin traceparent, allowing concurrent batches
// to trace independently. Links on the batch span link distinct origin traces.
// See [[logging-context]]
interface RecordSpanAttachment {
  // Passed to startActiveSpan as the parent context, falling back to batch span if absent.
  parentContext?: Context;
  links: Link[];
}

function recordSpanAttachment(record: SqsRecord): RecordSpanAttachment {
  const spanContext = originSpanContext(record);
  if (spanContext === undefined) return { links: [] };

  return { parentContext: trace.setSpanContext(ROOT_CONTEXT, spanContext), links: [] };
}

// Links one span context per distinct origin trace ID present in the batch.
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

// Indexes ensured once per cold start in module scope.
let indexesEnsured = false;

// Test seam to reset cold-start index latch between test cases.
export function resetIndexBootstrapForTests(): void {
  indexesEnsured = false;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// WHY: Observes repository calls to extract failure reasons and duplicates for flow logging.
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
            outcome.duplicate = true;
            outcome.reason = err.message;
          } else {
            // CONTRACT: Do NOT log raw driver error messages — MongoDB write errors embed
            // the rejected document (carrying PII payload). Use err.name instead.
            // See [[logging-context]]
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

// CONTRACT: Return partial batchItemFailures rather than throwing to avoid whole-batch redeliveries.
// See [[floci-sqs-lambda-docdb-support]]
/**
 * Publishes 0 for each email counter so metric panels render during quiet windows.
 *
 * CONTRACT: Seed counter metrics with zero on a schedule. OpenObserve dashboard panels
 * throw if a time series has no data points during quiet periods.
 * See [[openobserve-cloudwatch]]
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
  // CONTRACT: Function URL routing must run before processBatch; non-SQS events lack Records.
  // See [[events-pipeline-design]]
  if (isFunctionUrlEvent(event)) {
    const client = await getMongoClient();
    const db = client.db(env.DOCDB_DATABASE);
    return (await handleEmailQuery(event, new E2eEmailStore(db))) as never;
  }

  // The scheduled tick seeds and returns before opening DocumentDB connections.
  if (isMetricsTick(event)) {
    // EventBridge metrics tick creates a new consumer span without parent links.
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

  // Consumer span for SQS batch invocation with links to distinct origin traces.
  const links = Array.isArray(event.Records) ? batchSpanLinks(event.Records) : [];

  return tracer.startActiveSpan(
    "events-queue process",
    { kind: SpanKind.CONSUMER, links, attributes: { "messaging.system": "aws_sqs" } },
    async (batchSpan) => {
      try {
        batchSpan.setAttribute("messaging.batch.message_count", event.Records.length);
        const result = await processBatch(event);
        batchSpan.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        batchSpan.recordException(err as Error);
        batchSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(err) });
        throw err;
      } finally {
        // CONTRACT: End span and flush traces before return. Lambda freezes the process
        // on return, so unflushed spans are delayed or lost.
        // See [[logging-context]]
        batchSpan.end();
        await flushTraces();
      }
    },
  );
}

// Runs DocumentDB bootstrap, concurrent record processing, and batch failure assembly.
async function processBatch(event: SqsEvent): Promise<BatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  let repository: MongoEventsRepository;
  let db: Db;
  try {
    const client = await getMongoClient();
    db = client.db(env.DOCDB_DATABASE);
    if (!indexesEnsured) {
      await ensureIndexes(db);
      if (e2eTestingEnabled) await ensureE2eIndexes(db);
      indexesEnsured = true;
    }
    repository = new MongoEventsRepository(db);
  } catch (err) {
    // Report batchItemFailures on DB failure to preserve structured logging.
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

  // CONTRACT: Process records concurrently via Promise.allSettled. Records are independent,
  // standard SQS has no ordering guarantees, and ALS context is scoped per record.
  // allSettled ensures every record reaches an individual verdict without abandoning siblings.
  // WORKAROUND(local): Local Floci delivery rate is bounded (~1 ev/s); do NOT serialize processing.
  // See [[floci-sqs-lambda-docdb-support]]
  const outcomes = await Promise.allSettled(event.Records.map(processRecordSafely));

  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "rejected") {
      batchItemFailures.push({ itemIdentifier: event.Records[index].messageId });
      continue;
    }
    if (outcome.value) {
      batchItemFailures.push({ itemIdentifier: event.Records[index].messageId });
    }
  }

  return { batchItemFailures };

  async function processRecordSafely(record: SqsRecord): Promise<boolean> {
    let envelope: Envelope;
    try {
      envelope = EnvelopeSchema.parse(JSON.parse(record.body));
    } catch {
      // CONTRACT: Log malformed envelope as permanent failure without echoing raw body (PII).
      // See [[logging-context]]
      appLogger.error(
        {
          app_event: "event_processing_failed",
          reason: "invalid_envelope",
          transient: false,
          message_id: record.messageId,
        },
        "rejected malformed event body",
      );
      return false;
    }

    const { parentContext, links } = recordSpanAttachment(record);

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

    return failedTransiently;
  }
}

// E2E test email recorder; returns undefined when E2E testing is disabled.
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
    appLogger.info(
      { app_event: "event_processing_succeeded", duration_ms },
      "processed event",
    );
    return false;
  }

  if (outcome.duplicate) {
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
