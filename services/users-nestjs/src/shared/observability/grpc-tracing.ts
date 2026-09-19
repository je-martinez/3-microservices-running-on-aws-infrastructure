import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

// CONTRACT: The gRPC SERVER span is manual. @opentelemetry/instrumentation-grpc
// instruments only the client side here — `ServerInterceptingCall` consumes the
// metadata, so the handler's `call` arrives with an empty map and the instrumentation
// has nothing to read. The failure is silent: a caller's traceparent is ignored and
// the cross-service trace ends at the boundary with no error. The parent context is
// extracted in the api-key interceptor and is already active by the time this runs.
// See [[ADR-0003-grpc-inter-service]]
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
