import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

// CONTRACT: Named after the OPERATION, not the SDK surface (spec D25) — the
// name is what a waterfall renders, so it must say what happened. Mirrors
// withPublishSpan's naming reasoning. See [[logging-context]]
const tracer = trace.getTracer("users-stripe");

export interface StripeSpanHandle {
  /** Attach a queryable attribute discovered only inside `fn` (e.g. a Stripe object id). */
  setAttribute(key: string, value: string | number | boolean): void;
}

/**
 * CONTRACT: Run `fn` inside a CLIENT span named after the Stripe operation
 * (spec D25). CLIENT, not PRODUCER — Stripe is an outbound third-party
 * dependency, not a message publish. Keep `span.end()` in the `finally`
 * below; an exception path that skips it never gets exported. Unlike
 * `withPublishSpan`, the thrown error here MUST propagate — a Stripe call
 * failure is a real failure, not a swallowed best-effort send.
 * See [[logging-context]]
 */
export function withStripeSpan<T>(
  operation: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: StripeSpanHandle) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    operation,
    {
      kind: SpanKind.CLIENT,
      attributes: { "stripe.operation": operation, ...attributes },
    },
    async (span) => {
      const handle: StripeSpanHandle = {
        setAttribute(key, value) {
          span.setAttribute(key, value);
        },
      };
      try {
        const result = await fn(handle);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        // CONTRACT: Never a plaintext card, key, or client_secret on this
        // span (spec D25) — callers pass only ids/metadata into `attributes`
        // and `setAttribute`, never a raw Stripe response object.
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
