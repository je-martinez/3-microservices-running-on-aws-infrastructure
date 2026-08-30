import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { pipelineTracer } from "#shared/observability/tracing";
import type { Envelope } from "#domain/envelope";
import type { RecordEmailFn } from "#email/sender";
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
/**
 * Extra collaborators a handler may use. Empty in production.
 *
 * Threaded as a parameter rather than imported by each handler so the E2E store
 * stays out of the production import graph, and so a handler remains callable in
 * a unit test with no fixture wiring at all.
 */
export type HandlerDeps = { recordEmail?: RecordEmailFn };

export type HandlerMap = Record<string, (envelope: Envelope, deps: HandlerDeps) => Promise<void>>;

export type ProcessRecordResult = { ok: true } | { ok: false; transient: boolean };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The document's status transitions, at INFO. These are deliberately NOT a
// duplicate of the entrypoint's `event_processing_*` flow logs, which sit one
// layer above and answer a different question:
//
//   event_processing_*    the CODE ran (the handler was invoked, returned, threw)
//   event_status_changed  the WRITE to DocumentDB is PERSISTED
//
// The two can disagree, and that gap is the whole point: a record can be
// processed successfully and still fail to persist its transition, in which case
// the flow log says `succeeded` while the document is stale. `IN_PROGRESS` has
// no equivalent at all upstairs — it is the only line that separates "the
// handler started" from "the handler finished but the result never landed".
//
// The cost is real and accepted: a healthy record goes from 2 lifecycle lines to
// ~5, on a Lambda whose logs are already amplified downstream (JE-177). They are
// INFO rather than DEBUG because the question they answer ("did the write
// land?") is one asked of PRODUCTION traffic, and DEBUG is off there — the lines
// existed at DEBUG and emitted zero times in the running Lambda, which is the
// same as not existing.
//
// `event_status`, not `status`: `status` is not in the shared log schema and
// would collide with the HTTP status other services log under that name.
// The envelope's event_id/type/... come from the ambient context, so nothing is
// spread here — and the payload, which this function holds in `doc`, is never
// touched by a log line.
//
// `reason` is carried on FAILED only, and only when known: a failure line
// without a motive forces a join against another line to be useful at all. The
// string is the same one persisted on the document — PERMANENT/TransientError
// messages built by the handlers, which are PII-free BY CONSTRUCTION for exactly
// this purpose (see the comment in #handlers/user-created and `outcome.reason`
// in src/handler.ts, which already logs this very string). Raw driver and Zod
// messages never reach here: the handlers reduce them to field paths and error
// names before throwing, because a Mongo error's message embeds the rejected
// document.
function logStatus(status: EventStatus, reason?: string): void {
  appLogger.info(
    { app_event: "event_status_changed", event_status: status, ...(reason ? { reason } : {}) },
    "event status changed",
  );
}

// A milestone on the ACTIVE span, as a span event.
//
// These are SECONDARY detail, not the way the phases are made visible — that job
// belongs to `withPhaseSpan` below. The distinction was learned the hard way:
// span events are the semantically correct OTel primitive for an instant, and
// this file originally relied on them alone for exactly that reason. In practice
// NEITHER viewer used here renders them in the waterfall — Jaeger hides them
// behind expanding the span and opening a tab, and OpenObserve's trace view does
// not surface them at all. A marker that takes two clicks to find marks nothing.
//
// They are kept because they cost nothing and they ARE queryable where it counts:
// OpenObserve stores them in a first-class `events` column, so
// `WHERE events LIKE '%handler_failed%'` finds every record that took a given
// path — something the waterfall cannot answer. Verified against the running
// stack.
//
// No PII, by the same rule the log lines follow: only the event's own lifecycle
// vocabulary, never the payload. `reason` is admitted on failure for the same
// reason logStatus admits it, and carries the same already-sanitized string.
function markPhase(name: string, reason?: string): void {
  trace.getActiveSpan()?.addEvent(name, reason ? { reason } : undefined);
}

// One lifecycle PHASE of a record, as a real span with a real duration.
//
// This is what makes the phases visible. A phase span groups the work between two
// milestones into a bar the waterfall actually draws, in both viewers, without
// anyone expanding anything: `persist` covers getting the record into DocumentDB,
// `dispatch` covers handing it to its CQRS handler and everything that handler
// does (the template render and the SES call live inside it).
//
// INTERNAL, and deliberately thin: a phase owns no I/O of its own. Its children
// are the spans that already existed, so the added nesting level buys grouping and
// costs no duplicated measurement — a phase's duration is its children's span plus
// the code between them, which is exactly the number "where did the time go?"
// needs.
//
// Errors are recorded and RETHROWN: a phase that swallowed would break the state
// machine below, which decides FAILED vs retry from the exception. The message is
// the caller's already-sanitized `describeError` output, never `err.message` —
// same PII rule as the DocumentDB spans, since a Mongo error embeds the rejected
// document.
async function withPhaseSpan<T>(
  name: string,
  fn: () => Promise<T>,
  describeError: (err: unknown) => string,
): Promise<T> {
  return pipelineTracer.startActiveSpan(name, { kind: SpanKind.INTERNAL }, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: describeError(err) });
      throw err;
    } finally {
      span.end();
    }
  });
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
  deps: { repository: EventsRepositoryPort; handlers: HandlerMap; handlerDeps?: HandlerDeps },
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

  // The first milestone, before any I/O: it timestamps the moment this record
  // entered the state machine, so the gap between it and the insert span below is
  // readable as the cost of building the document (redaction included) rather
  // than being folded into the insert's own duration.
  markPhase("message_received");

  try {
    // Phase 1 of 2. Wraps the insert rather than just being it: the phase's
    // duration also covers building and redacting the document above the call, so
    // "getting this record persisted" is one bar instead of an insert span with
    // unattributed time in front of it.
    await withPhaseSpan(
      "phase persist",
      async () => {
        await deps.repository.insertStarted(doc);
      },
      // Error CLASS only — a Mongo write error's message embeds the rejected
      // document, i.e. the payload. Same rule the insert span itself applies.
      (err) => (err instanceof Error ? err.name : "persist_failed"),
    );
    logStatus("STARTED");
  } catch (err) {
    // Nothing was persisted, so there is no document to mark FAILED. Report the
    // failure upward and let SQS decide (transient → retried, then DLQ).
    //
    // Marked explicitly: this is the one exit where the record leaves NO trace in
    // DocumentDB at all, so without a milestone the span would end with a failed
    // insert child and nothing saying the lifecycle stopped there rather than
    // continuing. The insert span already carries the sanitized error class; this
    // event names the outcome, not the cause.
    markPhase("persist_failed_record_dropped");
    return { ok: false, transient: isTransient(err) };
  }

  // Own-property lookup: a plain `handlers[type]` would resolve inherited
  // members like "constructor" or "toString" and try to call them.
  const handler = Object.prototype.hasOwnProperty.call(deps.handlers, envelope.type)
    ? deps.handlers[envelope.type]
    : undefined;

  if (!handler) {
    // Permanent by definition: retrying an event nobody handles can never help.
    markPhase("no_handler_for_type", "Unknown event type");
    await deps.repository.transition(envelope.event_id, "FAILED", { error: "Unknown event type" });
    logStatus("FAILED", "Unknown event type");
    return { ok: false, transient: false };
  }

  await deps.repository.transition(envelope.event_id, "IN_PROGRESS");
  logStatus("IN_PROGRESS");

  // The handoff to the CQRS handler. This is the boundary that matters most in
  // the waterfall: everything after it and before `handler_returned` is the
  // handler's own work (for ORDER_CREATED, the SES call that dominates the
  // record's duration), and everything outside the pair is this state machine's
  // overhead. Without the pair, a slow record cannot be attributed to either.
  markPhase("handler_dispatched");

  try {
    // Phase 2 of 2, and the one that matters most in a waterfall: everything the
    // CQRS handler does nests under this bar — the template render and the SES
    // call for an email event, the WebSocket publish for a tracking one. Time
    // inside it is the handler's; time outside it is this state machine's
    // overhead. Without the phase those children hang directly off
    // `process_record` and there is nothing separating "the pipeline was slow"
    // from "the handler was slow".
    await withPhaseSpan(
      "phase dispatch",
      async () => {
        await handler(envelope, deps.handlerDeps ?? {});
      },
      // The handlers already reduce driver/Zod errors to PII-free strings before
      // throwing (see #handlers/user-created), which is the same string persisted
      // on the document and logged as `reason`.
      errorMessage,
    );
  } catch (err) {
    const reason = errorMessage(err);
    markPhase("handler_failed", reason);
    await deps.repository.transition(envelope.event_id, "FAILED", { error: reason });
    logStatus("FAILED", reason);
    return { ok: false, transient: isTransient(err) };
  }

  markPhase("handler_returned");

  await deps.repository.transition(envelope.event_id, "COMPLETED");
  logStatus("COMPLETED");
  return { ok: true };
}
