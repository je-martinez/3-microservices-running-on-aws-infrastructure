import { SpanKind, SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";

// Manual span for a business workflow — the flows listed in
// docs/superpowers/specs/2026-08-18-distributed-tracing-spans-design.md
// Decision 3 (register, login, change_password, otp_challenge, otp_verify,
// password_reset_requested, password_reset_confirm).
//
// Deliberately the SAME shape as grpc-tracing.ts's withGrpcServerSpan: OK on
// success, ERROR with the thrown message otherwise, and span.end() in a
// `finally`. That last part is not defensive style — a span left open on the
// exception path never reaches Jaeger, and it does not surface as an error
// anywhere. It simply vanishes from the cascade.
//
// `attributes` carries the SAME fields already on the flow's log line
// (app_event, reason on failure, user_id, order_id, …) so the trace and the
// logs tell the same story and neither needs the other to be understood.
// Fields the caller does not know are omitted, never null — see
// [[logging-context]].
const tracer = trace.getTracer("users-workflow");

/**
 * Run `fn` inside an INTERNAL span named after the workflow.
 *
 * Uses `startActiveSpan`, so everything traced inside `fn` (Prisma queries, the
 * SQS publish, an outbound HTTP call) becomes a CHILD of this span rather than
 * a sibling — the workflow span is the root of the flow's subtree.
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
