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

// CONTRACT: `event_id` is the idempotency key, and the unique index on it is
// what catches a redelivery — SQS is at-least-once. This must stay a
// PermanentError: unclassified defaults to transient, which would retry an
// ALREADY-PROCESSED message all the way to the DLQ. Its own subclass so logs can
// tell "we already did this" from "this event is unprocessable".
// See [[events-pipeline-design]]
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
      // CONTRACT: The error CLASS, never its message — a Mongo write error's
      // message embeds the REJECTED DOCUMENT, i.e. the payload with the user's
      // email. A span is no lower-PII a destination than a log line.
      // DuplicateEventError is built from event_id alone, so it is safe as-is.
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

    // CONTRACT: Keep the status IN the span name. A record performs one insert
    // and up to three transitions, and a waterfall renders names, not attributes
    // — three bars all reading `documentdb updateOne` cost a click each to tell
    // IN_PROGRESS from COMPLETED. `db.operation` keeps the plain `updateOne` for
    // aggregation, so the semantic convention still holds. Manual because esbuild
    // inlines the driver and nothing auto-instruments it.
    return withClientSpan(
      `documentdb updateOne ${status}`,
      SpanKind.CLIENT,
      {
        "db.system": "documentdb",
        "db.operation": "updateOne",
        "db.collection.name": COLLECTION,
        // The transition being persisted. Named `event_status` (not `status`) for
        // the same reason the log line is: `status` collides with the HTTP status
        // other services report under that key.
        event_status: status,
      },
      async () => {
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
      },
      // The error CLASS, never its message — identical rule to insertStarted: a
      // Mongo write error embeds the rejected document, and `patch.error` may
      // itself be a failure reason we are in the middle of recording.
      (err) => (err instanceof Error ? err.name : "transition_failed"),
    );
  }
}
