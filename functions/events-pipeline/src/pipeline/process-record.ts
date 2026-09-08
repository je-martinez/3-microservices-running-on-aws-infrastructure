import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { pipelineTracer } from "#shared/observability/tracing";
import type { Envelope } from "#domain/envelope";
import type { RecordEmailFn } from "#email/sender";
import type { EventDocument, EventStatus } from "#domain/event";
import { redactPayload } from "#domain/redact-payload";
import { isTransient } from "#pipeline/errors";
import { appLogger } from "#shared/logging/app-logger";

// CONTRACT: This actor stamps `updated_by` only. Do NOT stamp it on `created_by`
// — that field names what ORIGINATED the event, and overwriting it makes every
// row claim the pipeline as its cause.
// See [[audit-fields]]
const PIPELINE_ACTOR = "events-pipeline";

// CONTRACT: Do NOT widen this port to an AWS/Mongo SDK type. This file importing
// an SDK makes the state machine untestable without the emulator.
export interface EventsRepositoryPort {
  insertStarted(doc: EventDocument): Promise<void>;
  transition(event_id: string, status: EventStatus, patch?: { error?: string }): Promise<void>;
}

/**
 * Extra collaborators a handler may use. Empty in production.
 *
 * WHY: Threaded as a parameter, not imported per handler, so the E2E store stays
 * out of the production import graph.
 */
export type HandlerDeps = { recordEmail?: RecordEmailFn };

export type HandlerMap = Record<string, (envelope: Envelope, deps: HandlerDeps) => Promise<void>>;

export type ProcessRecordResult = { ok: true } | { ok: false; transient: boolean };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// CONTRACT: This reports the PERSISTED write, not that the handler ran — the
// entrypoint's `event_processing_*` answers that, and the two disagree when a
// transition fails to land. Keep the key `event_status`: `status` is not in the
// shared schema and collides with the HTTP status other services log. Keep it at
// INFO; at DEBUG it emits zero times in the running Lambda. `reason` carries the
// handlers' already-sanitized string — never a raw driver or Zod message, whose
// text embeds the rejected document.
// See [[logging-context]]
function logStatus(status: EventStatus, reason?: string): void {
  appLogger.info(
    { app_event: "event_status_changed", event_status: status, ...(reason ? { reason } : {}) },
    "event status changed",
  );
}

// CONTRACT: A milestone, not a phase. Do NOT rely on these to make a phase
// visible — OpenObserve's waterfall does not render span events, so a phase
// marked only here draws no bar; `withPhaseSpan` below is what draws it. They
// stay because they are queryable (`WHERE events LIKE '%handler_failed%'`).
// Lifecycle vocabulary only, never the payload; `reason` carries the same
// already-sanitized string logStatus takes.
// See [[logging-context]]
function markPhase(name: string, reason?: string): void {
  trace.getActiveSpan()?.addEvent(name, reason ? { reason } : undefined);
}

// CONTRACT: A phase span RETHROWS. Swallowing here breaks the state machine
// below, which decides FAILED vs retry from the exception. The span message is
// the caller's `describeError` output, never `err.message` — a Mongo error's
// message embeds the rejected document.
// See [[logging-context]]
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
// CONTRACT: Persist BEFORE dispatch. Reordering drops an event with an unknown
// type or invalid payload without any FAILED row. `status_history` is
// append-only: seeded here on insert, and every later status goes through the
// repository's `transition` ($push), never an overwrite.
// See [[events-pipeline-design]]
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
    // CONTRACT: The only redaction point, and it copies — do NOT redact
    // `envelope` in place, or the OTP handler loses the code it must email.
    payload: redactPayload(envelope.type, envelope.payload),
    status: "STARTED",
    error: null,
    status_history: [{ status: "STARTED", timestamp: now }],
    // CONTRACT: `created_by` is the producer's actor (what ORIGINATED the event,
    // e.g. `tracking_api:carrier_status_update`); `updated_by` is this pipeline
    // (what PROCESSED it). Do NOT collapse them — every event would then claim
    // the pipeline as its cause.
    // See [[audit-fields]]
    created_by: envelope.author.actor,
    created_at: now,
    updated_by: PIPELINE_ACTOR,
    updated_at: now,
    deleted_by: null,
    deleted_at: null,
    // CONTRACT: Materialized on write — this repository is hand-written and
    // nothing derives it on read.
    // See [[audit-fields]]
    is_deleted: false,
  };

  // WHY: Before any I/O, so the gap to the insert span reads as document-build
  // cost instead of being folded into the insert's duration.
  markPhase("message_received");

  try {
    // WHY: The phase wraps more than the insert, so document-build time is
    // inside the bar rather than unattributed in front of it.
    await withPhaseSpan(
      "phase persist",
      async () => {
        await deps.repository.insertStarted(doc);
      },
      // CONTRACT: Error CLASS only. A Mongo write error's message embeds the
      // rejected document, i.e. the payload.
      (err) => (err instanceof Error ? err.name : "persist_failed"),
    );
    logStatus("STARTED");
  } catch (err) {
    // Nothing was persisted, so there is no document to mark FAILED — report
    // upward and let SQS decide (transient → retried, then DLQ). The milestone
    // is the only trace this exit leaves anywhere.
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

  // WHY: Paired with `handler_returned`, this splits the handler's own work
  // from the state machine's overhead in the waterfall.
  markPhase("handler_dispatched");

  try {
    // WHY: Everything the CQRS handler does nests under this bar — the render,
    // the SES call, the WebSocket publish. Without it those children hang off
    // `process_record` and "the pipeline was slow" cannot be told apart from
    // "the handler was slow".
    await withPhaseSpan(
      "phase dispatch",
      async () => {
        await handler(envelope, deps.handlerDeps ?? {});
      },
      // CONTRACT: Handlers reduce driver/Zod errors to PII-free strings before
      // throwing; this is the same string persisted and logged as `reason`.
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
