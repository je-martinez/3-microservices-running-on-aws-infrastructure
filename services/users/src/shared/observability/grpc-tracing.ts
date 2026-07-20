import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

// Manual server-side span for gRPC handlers.
//
// WHY THIS EXISTS: @opentelemetry/instrumentation-grpc is loaded and does
// instrument the CLIENT side, but produces no SERVER span here. The server is
// built as `new grpc.Server({ interceptors: [...] })`, and `ServerInterceptingCall`
// consumes the metadata — the `call` the handler receives carries none at all
// (verified: the metadata map arrives empty). So the instrumentation had nothing
// to read, and the failure was silent: Orders emitted a traceparent, Users
// ignored it, and a cross-service trace ended at the boundary with no error.
//
// The PARENT context is extracted in the api-key interceptor, the only place
// that still sees the metadata. By the time this runs it is already the active
// context, so startActiveSpan picks it up and this span becomes a child of the
// caller's span.
const tracer = trace.getTracer("users-grpc");

/**
 * Run `fn` inside a SERVER span for a gRPC method.
 *
 * With a caller context extracted upstream the span joins that trace; without
 * one (a direct call, a unit test) it starts its own.
 */
export function withGrpcServerSpan<T>(method: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(
    method,
    { kind: SpanKind.SERVER, attributes: { "rpc.system": "grpc", "rpc.method": method } },
    async (span) => {
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
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
