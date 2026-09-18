import { SpanKind, SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";

const tracer = trace.getTracer("users-realtime");

/**
 * Run `fn` inside a CLIENT or PRODUCER span for one outbound call.
 *
 * CONTRACT: Keep `span.end()` in a `finally` — a span left open on the exception
 * path is never exported and vanishes from the waterfall without erroring
 * anywhere. Parentage comes from the ambient context, which is why nothing takes a
 * parent argument. See [[logging-context]]
 */
export function withClientSpan<T>(
  name: string,
  kind: SpanKind.CLIENT | SpanKind.PRODUCER,
  attributes: Attributes,
  fn: () => Promise<T>,
  // CONTRACT: Required, never defaulted to `err.message`. An AWS SDK error can
  // embed the rejected request, and `recordException` would stamp the message and
  // stack trace unsanitized — which is also why there is no recordException below.
  // See [[logging-context]]
  describeError: (err: unknown) => string,
): Promise<T> {
  return tracer.startActiveSpan(name, { kind, attributes }, async (span) => {
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
