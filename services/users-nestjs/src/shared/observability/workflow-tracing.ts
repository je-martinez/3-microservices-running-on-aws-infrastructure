import { SpanKind, SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";

// Manual span for a business workflow (register, login, change_password,
// otp_challenge, otp_verify, password_reset_requested, password_reset_confirm).
//
// CONTRACT: Keep `span.end()` in a `finally` — a span left open on the exception path
// is never exported and vanishes from the cascade without erroring anywhere.
// `attributes` carries the SAME fields as the flow's log line, so trace and logs tell
// one story; unknown fields are omitted, never null. See [[logging-context]]
const tracer = trace.getTracer("users-workflow");

/**
 * Run `fn` inside an INTERNAL span named after the workflow.
 *
 * Uses `startActiveSpan`, so everything traced inside `fn` becomes a CHILD rather
 * than a sibling — the workflow span is the root of the flow's subtree.
 */
export function withWorkflowSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL, attributes }, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
