import { EnvelopeSchema, type Envelope } from "#domain/envelope";
import { processRecord, type EventsRepositoryPort } from "#pipeline/process-record";
import type { EventDocument, EventStatus } from "#domain/event";
import { getMongoClient } from "#shared/db/client";
import { MongoEventsRepository, ensureIndexes, DuplicateEventError } from "#shared/db/events-repository";
import { handlers } from "#handlers/index";
import { env } from "#shared/config/env";

// Minimal structural shape of the slice of the SQS event this function reads.
// Deliberately not `SQSEvent` from @types/aws-lambda: only `messageId` and
// `body` are consumed, and narrowing the input to what is actually used keeps
// the unit tests free of 15 irrelevant required fields per record.
interface SqsRecord {
  messageId: string;
  body: string;
}

interface SqsEvent {
  Records: SqsRecord[];
}

interface BatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

// Shared cross-service log context (docs/shared/conventions/logging-context.md).
// `trace_id` is NOT synthesized here: it comes from the OpenTelemetry SDK when
// instrumentation is present, and a locally-invented one would correlate with
// nothing. Unknown fields are OMITTED, never emitted as null — a `order_id:
// null` reads as "resolved to null" rather than "not applicable to this line".
type LogContext = Record<string, string | number | boolean | undefined>;

function log(level: "info" | "warn" | "error", message: string, context: LogContext): void {
  const line: Record<string, unknown> = {
    severity: level.toUpperCase(),
    service_name: "events-pipeline",
    message,
  };
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) line[key] = value;
  }
  // Structured JSON on stdout/stderr — CloudWatch (and the OTel collector that
  // tails it) parses it as-is. No logging library and no OTel SDK options in
  // code: OTel configuration belongs in environment variables.
  console[level](JSON.stringify(line));
}

// Context derived from an envelope, minus anything absent. NEVER includes
// `payload` — it carries user PII (emails) and, for some producers, credentials.
function envelopeContext(envelope: Envelope): LogContext {
  return {
    event_id: envelope.event_id,
    type: envelope.type,
    source: envelope.source,
    user_id: envelope.user_id,
    order_id: envelope.order_id ?? undefined,
  };
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
          if (err instanceof DuplicateEventError) outcome.duplicate = true;
          outcome.reason = errorMessage(err);
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

// Lambda entrypoint — deployed as `dist/handler.handler`, matching
// infra/modules/lambda's `var.handler` default and the
// aws_lambda_event_source_mapping that invokes it.
//
// Returns partial batch responses rather than throwing: Floci honors
// `batchItemFailures` correctly (verified empirically — see
// docs/lessons/floci-sqs-lambda-docdb-support.md), retrying ONLY the listed
// items. Throwing would retry the whole batch, redelivering records that already
// completed.
export async function handler(event: SqsEvent): Promise<BatchResponse> {
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
    log("error", "events pipeline batch aborted", {
      app_event: "event_processing_failed",
      reason: errorMessage(err),
      transient: true,
      record_count: event.Records.length,
    });
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
      // which would put the raw body (emails, tokens) into CloudWatch.
      log("error", "rejected malformed event body", {
        app_event: "event_processing_failed",
        reason: "invalid_envelope",
        transient: false,
        message_id: record.messageId,
      });
      continue;
    }

    const context = envelopeContext(envelope);
    log("info", "processing event", { ...context, app_event: "event_processing_started" });

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
      log("error", "event processing threw", {
        ...context,
        app_event: "event_processing_failed",
        reason: errorMessage(err),
        transient: true,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

    if (result.ok) {
      // No SUCCESS severity by design (it is not an OTel level): success is INFO
      // plus app_event=*_succeeded.
      log("info", "processed event", { ...context, app_event: "event_processing_succeeded" });
      continue;
    }

    if (outcome.duplicate) {
      // A benign at-least-once redelivery of an already-persisted event, not a
      // fault. processRecord already classified it permanent (DuplicateEventError
      // extends PermanentError), so the message is CONSUMED; logging it at ERROR
      // would turn normal SQS behaviour into alert noise.
      log("info", "skipped duplicate event", {
        ...context,
        app_event: "event_processing_skipped",
        reason: "duplicate_event",
      });
      continue;
    }

    log("error", "failed to process event", {
      ...context,
      app_event: "event_processing_failed",
      reason: outcome.reason,
      transient: result.transient,
    });

    // Only transient failures come back. A permanent one is already persisted as
    // FAILED with its error — retrying it would just re-fail until the DLQ.
    if (result.transient) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
