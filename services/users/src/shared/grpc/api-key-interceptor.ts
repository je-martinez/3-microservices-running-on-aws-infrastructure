import { timingSafeEqual } from "node:crypto";
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

// Server interceptor: rejects the call with UNAUTHENTICATED before the handler
// runs unless metadata `x-api-key` matches GRPC_API_KEY. The metadata check runs
// in `onReceiveMetadata`, i.e. before the message/half-close reach the handler.
export function makeApiKeyInterceptor(expectedKey: string): grpc.ServerInterceptor {
  return function apiKeyInterceptor(
    _methodDescriptor: grpc.ServerMethodDefinition<unknown, unknown>,
    call: grpc.ServerInterceptingCallInterface,
  ): grpc.ServerInterceptingCall {
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
            mdNext(metadata);
          },
          onReceiveMessage(message, msgNext) {
            msgNext(message);
          },
          onReceiveHalfClose(hcNext) {
            hcNext();
          },
          onCancel() {},
        };
        next(listener);
      },
    });
  };
}
