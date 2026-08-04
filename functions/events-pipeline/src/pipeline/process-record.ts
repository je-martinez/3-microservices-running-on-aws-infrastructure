import type { Envelope } from "#domain/envelope";
import type { EventDocument, EventStatus } from "#domain/event";
import { isTransient } from "#pipeline/errors";

// Actor stamped on the audit fields — this pipeline is the writer, there is no
// end user in the loop. See docs/shared/conventions/audit-fields.md.
const PIPELINE_ACTOR = "events-pipeline";

// Port the state machine depends on — implemented by Task 8's
// MongoEventsRepository. Deliberately NOT the AWS/Mongo SDK type: this file
// must not import any AWS SDK, which is what makes it unit-testable without
// the emulator.
export interface EventsRepositoryPort {
  insertStarted(doc: EventDocument): Promise<void>;
  transition(event_id: string, status: EventStatus, patch?: { error?: string }): Promise<void>;
}

// The CQRS dispatch table: event `type` → handler (e.g. ORDER_CREATED →
// OrderCreatedHandler). Populated by Task 10's src/handlers/index.ts.
export type HandlerMap = Record<string, (envelope: Envelope) => Promise<void>>;

export type ProcessRecordResult = { ok: true } | { ok: false; transient: boolean };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// One record's full lifecycle: STARTED -> IN_PROGRESS -> COMPLETED | FAILED.
// The document is persisted BEFORE dispatch (insertStarted first) so an event
// with an unknown type or an invalid payload is still recorded as FAILED rather
// than silently dropped — see the milestone design spec's "Ordering decision".
// The audit trail must capture failures too.
//
// `status_history` is append-only: this function seeds it with the STARTED entry
// on insert and never touches the array again. Every later status is handed to
// the repository as its own `transition` call, which appends ($push) rather than
// overwriting.
export async function processRecord(
  envelope: Envelope,
  deps: { repository: EventsRepositoryPort; handlers: HandlerMap },
): Promise<ProcessRecordResult> {
  const now = new Date();
  const doc: EventDocument = {
    event_id: envelope.event_id,
    order_id: envelope.order_id,
    user_id: envelope.user_id,
    type: envelope.type,
    source: envelope.source,
    payload: envelope.payload,
    status: "STARTED",
    error: null,
    status_history: [{ status: "STARTED", timestamp: now }],
    created_by: PIPELINE_ACTOR,
    created_at: now,
    updated_by: PIPELINE_ACTOR,
    updated_at: now,
    deleted_by: null,
    deleted_at: null,
    // Required by docs/shared/conventions/audit-fields.md — materialized on
    // write (this repository is hand-written, so nothing derives it on read).
    // A newly created event is never deleted.
    is_deleted: false,
  };

  try {
    await deps.repository.insertStarted(doc);
  } catch (err) {
    // Nothing was persisted, so there is no document to mark FAILED. Report the
    // failure upward and let SQS decide (transient → retried, then DLQ).
    return { ok: false, transient: isTransient(err) };
  }

  // Own-property lookup: a plain `handlers[type]` would resolve inherited
  // members like "constructor" or "toString" and try to call them.
  const handler = Object.prototype.hasOwnProperty.call(deps.handlers, envelope.type)
    ? deps.handlers[envelope.type]
    : undefined;

  if (!handler) {
    // Permanent by definition: retrying an event nobody handles can never help.
    await deps.repository.transition(envelope.event_id, "FAILED", { error: "Unknown event type" });
    return { ok: false, transient: false };
  }

  await deps.repository.transition(envelope.event_id, "IN_PROGRESS");

  try {
    await handler(envelope);
  } catch (err) {
    await deps.repository.transition(envelope.event_id, "FAILED", { error: errorMessage(err) });
    return { ok: false, transient: isTransient(err) };
  }

  await deps.repository.transition(envelope.event_id, "COMPLETED");
  return { ok: true };
}
