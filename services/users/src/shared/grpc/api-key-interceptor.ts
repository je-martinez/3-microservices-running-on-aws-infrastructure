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

// Extract the caller's W3C trace context from inbound gRPC metadata, relative to
// the currently-active context. Returns the active context unchanged when no
// traceparent is present (a direct call), so the handler legitimately starts its
// own root rather than a fabricated child.
//
// Pulled out as a pure, exported function so the propagation behaviour — the
// part that regressed in JE-77 — is unit-testable without a live gRPC server.
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

            // Auth passed. Extract the caller's W3C trace context so the
            // handler's span can become a CHILD of the caller's rather than a
            // new root.
            //
            // Extraction has to happen HERE, and nowhere else: `ServerInterceptingCall`
            // consumes the metadata, so the `call` the handler receives carries
            // none at all (verified — the metadata map arrives empty). That is
            // why @opentelemetry/instrumentation-grpc produced no server span
            // and why extracting inside the handler could not work either.
            //
            // But the extracted context must NOT be activated here — see
            // onReceiveHalfClose. This callback returns synchronously, long
            // before grpc-js dispatches the async handler, so a `context.with`
            // around `mdNext` would already have unwound by the time the handler
            // (and its withGrpcServerSpan) runs, leaving it a root span. So we
            // stash the context and activate it in the continuation that
            // actually dispatches the handler.
            //
            // Deliberately AFTER the auth gate: an unauthenticated call is
            // rejected before any tracing work happens.
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
