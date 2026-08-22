import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

// Manual PRODUCER span for a publish onto the shared SQS events queue.
//
// WHY THIS EXISTS, when the AWS SDK auto-instrumentation already emits a span
// for the send: that span is named `<queue> send` — for us always
// `3mrai-local-events-events send`, because every event in the system goes to
// the SAME queue. It names the one part of the hop that never varies, and says
// nothing about WHAT was published, which is the only thing a reader wants from
// a producer node. (It does not even follow the OTel messaging convention,
// which dictates `{operation} {destination}`, not the reverse.)
//
// So each service names its own publish span after the EVENT TYPE, and the
// three converge on one shape — Orders' `sqs.publish order_created`
// (Orders.Infrastructure/Messaging/SqsEventPublisher.cs) is the reference.
//
// The SDK's span is NOT suppressed: it stays as this span's CHILD, keeping its
// own timing and status for the wire-level call. This one answers "which event,
// and for whom"; that one answers "how did the call to SQS go".
const tracer = trace.getTracer("users-messaging");

/**
 * The handle `withPublishSpan` hands its callback.
 *
 * It exposes exactly one verb, and only because these publishes are deliberately
 * BEST-EFFORT: they catch their own send failure, log it, and return normally
 * (see the publisher). Nothing propagates out of the callback, so a helper that
 * inferred the status from a thrown error would render every failed send green.
 * The callback says so explicitly instead.
 */
export interface PublishSpan {
  /** Mark the publish as failed: ERROR status + a recorded exception. */
  markFailed(err: unknown): void;
}

/**
 * Run `fn` inside a PRODUCER span named after the event being published.
 *
 * Uses `startActiveSpan`, which makes this span the ACTIVE one for the duration
 * of `fn`. That is load-bearing twice over:
 *
 * 1. `propagation.inject` inside `fn` reads `context.active()`, so the
 *    `traceparent` that goes on the message names THIS span — the consumer
 *    hangs under the publish instead of beside it. Building the message
 *    attributes before entering here would inject the enclosing workflow span,
 *    which is exactly the bug fixed in Orders (commit 81c52a7).
 * 2. A log line emitted inside `fn` picks up this span's `span_id` (the Pino
 *    formatter reads the active span — see shared/logging/logger.ts), so
 *    OpenObserve's "View logs" on this span answers instead of coming back
 *    empty. That button filters on trace_id AND span_id with no fallback to the
 *    trace, so a span nothing logs from can only ever return nothing.
 *
 * `span.end()` lives in a `finally` for the same reason as `withWorkflowSpan`:
 * a span left open on the exception path never reaches Jaeger, and does so
 * without erroring anywhere.
 */
export function withPublishSpan<T>(eventType: string, fn: (span: PublishSpan) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(
    `sqs.publish ${eventType}`,
    {
      kind: SpanKind.PRODUCER,
      // The producer-side OTel messaging attributes. The event type is both the
      // span's name and an attribute: the name is what a waterfall renders, the
      // attribute is what a query filters on.
      attributes: {
        "messaging.system": "aws_sqs",
        "messaging.operation": "publish",
        "messaging.destination.kind": "queue",
        event_type: eventType,
      },
    },
    async (span) => {
      let failed = false;
      const handle: PublishSpan = {
        markFailed(err: unknown) {
          failed = true;
          span.recordException(err as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
        },
      };

      try {
        return await fn(handle);
      } catch (err) {
        // Not the send failure (the publisher swallows that one) but anything
        // that escaped anyway — a bug building the envelope, say. Still has to
        // colour the span red rather than leaving it unset.
        handle.markFailed(err);
        throw err;
      } finally {
        // Guarded, because Ok is the one status code the SDK treats as final:
        // stamping it after markFailed would silently overwrite the ERROR and a
        // failed send would render as a healthy hop.
        if (!failed) span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      }
    },
  );
}
