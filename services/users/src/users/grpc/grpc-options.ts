import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Transport, type MicroserviceOptions } from "@nestjs/microservices";
import type { Env } from "#config/env.schema";
import { makeApiKeyInterceptor } from "#shared/grpc/api-key-interceptor";

// This module lives three levels under services/users/ in both src and
// dist, so five `../` reach the repo root where proto/users.proto lives.
const PROTO_PATH = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../../proto/users.proto",
);

export function grpcMicroserviceOptions(env: Env): MicroserviceOptions {
  return {
    transport: Transport.GRPC,
    options: {
      package: "users.v1",
      protoPath: PROTO_PATH,
      url: `0.0.0.0:${env.GRPC_PORT}`,
      loader: { keepCase: true, longs: String, defaults: true, oneofs: true },
      // WORKAROUND(nestjs-microservices): Interceptors go in `channelOptions`,
      // NOT in a `server` key. GrpcOptions declares no `interceptors` field, and
      // server-grpc.js builds the server as `new grpc.Server(channelOptions)` —
      // so any other spelling is DROPPED SILENTLY and a call bearing a wrong
      // x-api-key returns the user's data with no error anywhere. The
      // UNAUTHENTICATED test in tests/grpc/users-grpc.test.ts is what
      // catches that. See [[grpc-context-activate-at-dispatch]]
      channelOptions: {
        interceptors: [makeApiKeyInterceptor(env.INTERNAL_API_KEY)],
      } as never,
    },
  };
}
