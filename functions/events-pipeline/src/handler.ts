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

// Shared cross-service log context (docs/shared/conventions/logging-context.md),
// emitted through pino by #shared/logging/app-logger — the same
// `buildLoggerOptions` schema Users uses, so a line from here and a line from
// Users are indistinguishable downstream.
//
// `trace_id`/`span_id` are absent for now: this function is NOT instrumented
// yet — there is no @opentelemetry/* dependency and no SDK bootstrap in the
// bundle. They will appear automatically once the SDK is added (tracked
// separately); a locally-invented id would correlate with nothing, so nothing
// synthesizes one here.
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
    message_id: messageId,
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
export async function handler(event: SqsEvent): Promise<BatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  // Seed the failure counters at zero, once per invocation.
  //
  // emails_failed_total is only emitted when a send or a render fails, so on a
  // healthy system the series never exists — and a dashboard panel over a
  // non-existent stream renders "Error Loading Data". For an incident card that
  // is exactly backwards: the card that should read "no emails lost" is the one
  // that looks broken, so a real outage is indistinguishable from health.
  //
  // Once per INVOCATION rather than per record: the Lambda handles batches, and
  // a zero per record would be pure noise. The zero is arithmetically free —
  // CloudWatch sums within a period, so it never changes a real count.
  //
  // This is the only recurring hook available here. Unlike the HTTP services,
  // a Lambda has no long-lived process to host a periodic publisher.
  await Promise.all([
    ...(["permanent", "transient"] as const).map((failureKind) =>
      publishMetric("emails_failed_total", 0, {
        Service: SERVICE_DIMENSION,
        EmailType: "ALL",
        FailureKind: failureKind,
      }),
    ),
    // emails_sent_total is seeded for a different reason than the failure
    // counters: it DOES fire in normal operation, so its series exists — but
    // only while mail is flowing. Narrow the dashboard to a quiet range and the
    // series has no points there, and OpenObserve's metric panel throws
    // `Cannot read properties of undefined (reading 'values')` rather than
    // rendering 0. Seeding keeps a datapoint in every window, so a quiet hour
    // reads zero instead of erroring.
    publishMetric("emails_sent_total", 0, {
      Service: SERVICE_DIMENSION,
      EmailType: "ALL",
    }),
  ]);

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

    // One ALS scope per record: everything logged inside — here, in the state
    // machine, in the SES sender — carries this envelope's identity without any
    // call site spreading it by hand. Scoping per record (not per invocation) is
    // what keeps one record's event_id off the next one's lines.
    const failedTransiently = await runWithLogContext(
      envelopeContext(envelope, record.messageId),
      () => processOneRecord(envelope, repository),
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
