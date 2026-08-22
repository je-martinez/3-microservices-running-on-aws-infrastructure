import { SpanKind, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import { pipelineTracer } from "#shared/observability/tracing";

// One wrapper for every outbound call this Lambda makes: the DocumentDB insert,
// the SES send, the WebSocket push.
//
// WHY THESE SPANS ARE WRITTEN BY HAND AT ALL. Everywhere else in this repo an
// outbound client call is spanned by auto-instrumentation. It cannot be here:
// scripts/build.mjs bundles this function into ONE CJS file with @aws-sdk/* and
// mongodb INLINED, and OTel patches at require() time, so there is no module
// left to patch. Registering the instrumentations would yield ZERO spans for all
// three calls, in silence. See src/shared/observability/tracing.ts.
//
// WHY ONE HELPER RATHER THAN THREE COPIES: the status/`finally` handling is the
// part that must not drift. A span not ended never reaches Jaeger and does not
// surface as an error — it silently vanishes — so the one `finally` that ends it
// lives here, once, instead of three times.
//
// PARENTAGE COMES FROM THE AMBIENT CONTEXT, not from an argument. `startActiveSpan`
// picks up whatever span is active at the call site, which inside the record loop
// is `process_record` — that is what makes these spans children of the RECORD
// rather than of the batch, and it is why nothing here takes a parent parameter.
export function withClientSpan<T>(
  name: string,
  kind: SpanKind.CLIENT | SpanKind.PRODUCER,
  attributes: Attributes,
  fn: () => Promise<T>,
  // How a failure is DESCRIBED on the span. Not optional, and not defaulted to
  // `err.message`, because that default is unsafe for one of the three callers:
  // MongoDB write errors (DocumentValidationFailure, BSONObjectTooLarge, a
  // duplicate key) embed the REJECTED DOCUMENT in their message — i.e. the event
  // payload, carrying the user's email. src/handler.ts already reduces those to
  // `err.name` for exactly this reason; a span that recorded the raw message
  // would reopen that leak through Jaeger instead of CloudWatch. Making the
  // caller state its own rule is what keeps the safe choice from depending on
  // someone remembering to override a default.
  //
  // For the same reason there is no `recordException(err)` below: that helper
  // stamps `exception.message` AND `exception.stacktrace` on the span, neither
  // of which this function can sanitize.
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
