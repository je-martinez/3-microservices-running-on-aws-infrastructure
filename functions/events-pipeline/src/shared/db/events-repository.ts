import type { Collection, Db } from "mongodb";
import { SpanKind } from "@opentelemetry/api";
import type { EventsRepositoryPort } from "#pipeline/process-record";
import type { EventDocument, EventStatus } from "#domain/event";
import { PermanentError } from "#pipeline/errors";
import { withClientSpan } from "#shared/observability/client-span";

const COLLECTION = "events";

// Actor stamped on the audit fields — this pipeline is the writer, there is no
// end user in the loop. Mirrors process-record.ts's PIPELINE_ACTOR; kept local
// rather than exported across the boundary, since the state machine stamps the
// insert and this adapter stamps the updates.
const PIPELINE_ACTOR = "events-pipeline";

// MongoDB's duplicate-key error code, raised by the server when a write
// violates a unique index.
const MONGO_DUPLICATE_KEY = 11000;

// A redelivery of an already-persisted event. SQS is at-least-once, so the same
// message CAN arrive twice; the unique index on `event_id` (the producer's
// idempotency key) is what catches it.
//
// It extends PermanentError deliberately: isTransient() defaults to true for
// anything unclassified, which would put an ALREADY-PROCESSED message into
// batchItemFailures and have SQS retry it all the way to the DLQ. Classifying it
// as permanent makes processRecord return { ok: false, transient: false }, so the
// message is CONSUMED instead. Its own subclass (rather than a bare
// PermanentError) so logs and future callers can tell "we already did this" apart
// from "this event is unprocessable".
export class DuplicateEventError extends PermanentError {
  constructor(public readonly event_id: string) {
    super(`duplicate event: ${event_id} has already been persisted`);
    this.name = "DuplicateEventError";
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === MONGO_DUPLICATE_KEY
  );
}

// `event_id` — the PRODUCER's idempotency key and the event's only identifier;
// its uniqueness is what makes an SQS redelivery detectable, so it is the one
// unique index here. The rest are non-unique query indexes from the design
// spec's "DocumentDB indexes" list. createIndex is idempotent: re-running it
// against an existing, identically-specified index is a no-op, so this is safe
// to call on every cold start.
export async function ensureIndexes(db: Db): Promise<void> {
  const collection = db.collection<EventDocument>(COLLECTION);
  await collection.createIndex({ event_id: 1 }, { unique: true });
  await collection.createIndex({ order_id: 1 });
  await collection.createIndex({ user_id: 1 });
  await collection.createIndex({ type: 1 });
  await collection.createIndex({ status: 1 });
  await collection.createIndex({ created_at: 1 });
}

export class MongoEventsRepository implements EventsRepositoryPort {
  constructor(private readonly db: Db) {}

  // Typed collection handle. Not cosmetic: an untyped db.collection() widens to
  // Document, and $push's PushOperator<Document> then cannot infer the array
  // element type — status_history silently degrades to `undefined` and the
  // append below fails to compile. Typing it also checks insertStarted's
  // document against the domain shape at build time.
  private get collection(): Collection<EventDocument> {
    return this.db.collection<EventDocument>(COLLECTION);
  }

  async insertStarted(doc: EventDocument): Promise<void> {
    // Manual CLIENT span. esbuild inlines the mongodb driver into the single-file
    // bundle, so there is no require() boundary for auto-instrumentation to patch
    // and this call would otherwise be a hole in the trace between
    // `process_record` and the handler's next step. A child of whatever span is
    // active — inside the record loop that is `process_record`.
    return withClientSpan(
      "documentdb insertOne",
      SpanKind.CLIENT,
      { "db.system": "documentdb", "db.operation": "insertOne", "db.collection.name": COLLECTION },
      async () => {
        try {
          await this.collection.insertOne(doc);
        } catch (err) {
          // Translating driver-specific errors into the domain's taxonomy is
          // exactly this adapter's job — the port signature is unchanged.
          if (isDuplicateKeyError(err)) {
            throw new DuplicateEventError(doc.event_id);
          }
          // Anything else (connection refused, timeout, write concern) stays
          // unclassified and therefore transient: losing an unprocessed event is
          // strictly worse than retrying it.
          throw err;
        }
      },
      // The error CLASS, never its message. A Mongo write error's message embeds
      // the REJECTED DOCUMENT — the event payload, carrying the user's email —
      // which is why the handler already logs only `err.name`. The span obeys the
      // same rule; Jaeger is not a lower-PII destination than CloudWatch.
      // DuplicateEventError is synthesized from event_id alone, so its message is
      // clean by construction and safe to surface as-is.
      (err) =>
        err instanceof DuplicateEventError
          ? err.message
          : err instanceof Error
            ? err.name
            : "insert_failed",
    );
  }

  async transition(
    event_id: string,
    status: EventStatus,
    patch?: { error?: string },
  ): Promise<void> {
    const now = new Date();
    const errorPatch = patch?.error !== undefined ? { error: patch.error } : {};

    // Single-document update: $set and $push apply atomically together, so no
    // transaction is needed (and none is available on Floci's standalone mongo).
    // status_history is append-only — $push, never $set.
    await this.collection.updateOne(
      { event_id },
      {
        $set: {
          status,
          updated_at: now,
          updated_by: PIPELINE_ACTOR,
          ...errorPatch,
        },
        $push: {
          status_history: { status, timestamp: now, ...errorPatch },
        },
      },
    );
  }
}
