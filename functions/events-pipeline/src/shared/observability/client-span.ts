import { SpanKind, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import { pipelineTracer } from "#shared/observability/tracing";

// One wrapper for every outbound call this Lambda makes: the DocumentDB insert,
// the SES send, the WebSocket push.
// CONTRACT: Do NOT replace these with auto-instrumentation. esbuild inlines
// @aws-sdk/* and mongodb into one CJS file, leaving no module boundary to patch,
// so the instrumentations yield ZERO spans in silence. Keep the single
// `finally`: an unended span never reaches the collector and raises no error.
// Parentage comes from the ambient context, which is why nothing takes a parent
// argument — that is what makes these children of the record, not the batch.
// See [[logging-context]]
export function withClientSpan<T>(
  name: string,
  kind: SpanKind.CLIENT | SpanKind.PRODUCER,
  attributes: Attributes,
  fn: () => Promise<T>,
  // CONTRACT: Required, and never defaulted to `err.message`. A MongoDB write
  // error embeds the REJECTED DOCUMENT in its message — the payload, with the
  // user's email. For the same reason there is no `recordException(err)` below:
  // it stamps `exception.message` and `exception.stacktrace` unsanitized.
  // See [[logging-context]]
  describeError: (err: unknown) => string,
): Promise<T> {
  return pipelineTracer.startActiveSpan(name, { kind, attributes }, async (span) => {
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
