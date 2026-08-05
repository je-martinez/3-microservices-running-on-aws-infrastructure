import type { Envelope } from "#domain/envelope";
import type { EventDocument, EventStatus } from "#domain/event";
import { redactPayload } from "#domain/redact-payload";
import { isTransient } from "#pipeline/errors";
import { appLogger } from "#shared/logging/app-logger";

// Actor stamped on `updated_by` (and on the repository's transition writes) —
// this pipeline is what PROCESSES the event, so it owns every mutation after the
// insert. It is NOT what created the row: see the audit split on the document
// below. See docs/shared/conventions/audit-fields.md.
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

// The document's status transitions, at DEBUG: the entrypoint already reports
// each record's outcome at INFO/ERROR with a reason, so these lines add nothing
// on a healthy path — their value is answering "how far did this event get
// before it stopped?" when the persisted document alone is ambiguous (a record
// stuck IN_PROGRESS means the handler never returned; one never reaching
// IN_PROGRESS means dispatch itself refused it). DEBUG keeps them out of the
// stream by default rather than tripling the volume of every batch.
//
// `event_status`, not `status`: `status` is not in the shared log schema and
// would collide with the HTTP status other services log under that name.
// The envelope's event_id/type/... come from the ambient context, so nothing is
// spread here — and the payload, which this function holds in `doc`, is never
// touched by a log line.
function logStatus(status: EventStatus): void {
  appLogger.debug({ app_event: "event_status_changed", event_status: status }, "event status changed");
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
    // The ONLY place redaction happens: this is the copy that reaches
    // DocumentDB. `envelope` itself is untouched, so the handler dispatched
    // below still receives the real payload (an OTP handler cannot email a
    // code it was never given). A no-op for every type without an entry in
    // #domain/redact-payload.
    payload: redactPayload(envelope.type, envelope.payload),
    status: "STARTED",
    error: null,
    status_history: [{ status: "STARTED", timestamp: now }],
    // The audit split, and it is deliberate:
    //   created_by = what ORIGINATED the row — the producer's semantic actor,
    //     carried over from the envelope (e.g. `users_api:register`,
    //     `tracking_api:carrier_status_update`). Stamping PIPELINE_ACTOR here
    //     made every event claim the pipeline as its cause, which is only ever
    //     true of the row, never of the event.
    //   updated_by = what PROCESSED it — this pipeline, which performs the later
    //     STARTED -> IN_PROGRESS -> COMPLETED/FAILED transitions (the repository
    //     stamps the same actor on each of them).
    created_by: envelope.author.actor,
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
    logStatus("STARTED");
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
    logStatus("FAILED");
    return { ok: false, transient: false };
  }

  await deps.repository.transition(envelope.event_id, "IN_PROGRESS");
  logStatus("IN_PROGRESS");

  try {
    await handler(envelope);
  } catch (err) {
    await deps.repository.transition(envelope.event_id, "FAILED", { error: errorMessage(err) });
    logStatus("FAILED");
    return { ok: false, transient: isTransient(err) };
  }

  await deps.repository.transition(envelope.event_id, "COMPLETED");
  logStatus("COMPLETED");
  return { ok: true };
}
