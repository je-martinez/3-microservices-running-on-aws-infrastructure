import { timingSafeEqual } from "node:crypto";
import { context, propagation, type Context } from "@opentelemetry/api";
import * as grpc from "@grpc/grpc-js";

// Constant-time comparison. Returns false (never throws) on length mismatch or
// a missing provided key, so timing does not leak whether the key was close.
export function apiKeyMatches(
  provided: string | undefined,
  expected: string,
): boolean {
  if (provided === undefined) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Extract the caller's W3C trace context from inbound gRPC metadata, relative to the
// active context. Returns it unchanged when no traceparent is present, so a direct
// call legitimately starts its own root rather than a fabricated child. Exported as a
// pure function so the propagation behaviour is testable without a live server.
export function extractParentContext(metadata: grpc.Metadata): Context {
  const carrier: Record<string, string> = {};
  for (const key of ["traceparent", "tracestate"]) {
    const value = metadata.get(key)[0]?.toString();
    if (value) carrier[key] = value;
  }
  return propagation.extract(context.active(), carrier);
}

// Server interceptor: rejects the call with UNAUTHENTICATED before the handler
// runs unless metadata `x-api-key` matches GRPC_API_KEY. The metadata check runs
// in `onReceiveMetadata`, i.e. before the message/half-close reach the handler.
export function makeApiKeyInterceptor(expectedKey: string): grpc.ServerInterceptor {
  return function apiKeyInterceptor(
    _methodDescriptor: grpc.ServerMethodDefinition<unknown, unknown>,
    call: grpc.ServerInterceptingCallInterface,
  ): grpc.ServerInterceptingCall {
    // Captured in onReceiveMetadata, applied in onReceiveHalfClose — the
    // continuation that actually dispatches the async handler.
    let parentContext = context.active();
    return new grpc.ServerInterceptingCall(call, {
      start(next) {
        const listener: grpc.ServerListener = {
          onReceiveMetadata(metadata, mdNext) {
            const provided = metadata.get("x-api-key")[0]?.toString();
            if (!apiKeyMatches(provided, expectedKey)) {
              call.sendStatus({
                code: grpc.status.UNAUTHENTICATED,
                details: "invalid api key",
                metadata: new grpc.Metadata(),
              });
              return;
            }

            // CONTRACT: Extract the caller's context HERE but do NOT activate it here.
            // `ServerInterceptingCall` consumes the metadata, so the handler's `call`
            // arrives with an empty metadata map — extraction cannot happen later. But
            // this callback returns synchronously, long before grpc-js dispatches the
            // async handler, so a `context.with` here unwinds first and the server span
            // comes out a ROOT: two disjoint traces. Stash it and activate in
            // onReceiveHalfClose, the continuation that dispatches the handler. After
            // the auth gate, so an unauthenticated call does no tracing work.
            // See [[grpc-context-activate-at-dispatch]]
            parentContext = extractParentContext(metadata);
            mdNext(metadata);
          },
          onReceiveMessage(message, msgNext) {
            msgNext(message);
          },
          onReceiveHalfClose(hcNext) {
            // The handler is dispatched from this continuation. Activate the
            // extracted caller context HERE so it is still active when the async
            // handler (and its withGrpcServerSpan) runs — context.with only
            // holds for the synchronous body of its callback, and onReceiveMetadata
            // returns long before the handler runs.
            context.with(parentContext, () => hcNext());
          },
          onCancel() {},
        };
        next(listener);
      },
    });
  };
}
