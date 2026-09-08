import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

// CONTRACT: Each service names its own publish span after the EVENT TYPE
// (`sqs.publish order_created` in Orders is the reference shape). The AWS SDK's
// own `<queue> send` span names the one part of the hop that never varies — every
// event goes to the same queue — so it cannot say what was published. It is not
// suppressed: it stays a CHILD, answering "how did the call to SQS go".
// See [[logging-context]]
const tracer = trace.getTracer("users-messaging");

/**
 * The handle `withPublishSpan` hands its callback. One verb, because these publishes
 * are best-effort and swallow their own send failure: nothing propagates out, so a
 * helper inferring status from a thrown error would render every failed send green.
 */
export interface PublishSpan {
  /** Mark the publish as failed: ERROR status + a recorded exception. */
  markFailed(err: unknown): void;
}

/**
 * Run `fn` inside a PRODUCER span named after the event being published.
 *
 * CONTRACT: Keep `startActiveSpan` and build the message attributes INSIDE `fn`.
 * `propagation.inject` reads the active span, so attributes built earlier name the
 * enclosing workflow span and the consumer hangs beside the publish instead of under
 * it; and a log line inside `fn` needs this span_id or OpenObserve's "View logs"
 * returns empty. `span.end()` stays in a `finally` — a span left open on the
 * exception path is never exported, without erroring anywhere.
 * See [[logging-context]]
 */
export function withPublishSpan<T>(eventType: string, fn: (span: PublishSpan) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(
    `sqs.publish ${eventType}`,
    {
      kind: SpanKind.PRODUCER,
      // The event type is both the span's name and an attribute: the name is what a
      // waterfall renders, the attribute is what a query filters on.
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
        // Not the send failure (the publisher swallows that) but anything else that
        // escaped — a bug building the envelope. Still colours the span red.
        handle.markFailed(err);
        throw err;
      } finally {
        // CONTRACT: Guard this — Ok is the one status the SDK treats as final, so
        // stamping it after markFailed overwrites the ERROR and a failed send renders
        // as a healthy hop.
        if (!failed) span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      }
    },
  );
}
