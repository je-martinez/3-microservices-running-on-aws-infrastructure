import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { env } from "#shared/config/env";
import { getUserByIdHandler } from "#features/users/grpc/get-user-by-id";
import type { UserQueryService } from "#features/users/queries/get-me";
import { makeApiKeyInterceptor } from "#shared/grpc/api-key-interceptor";

// This module lives at `src/shared/grpc/server.ts` in dev (tsx) and compiles to
// `dist/shared/grpc/server.js` — both are three levels under `services/users/`,
// so five `../` reach the repo root where `proto/users.proto` lives.
const PROTO_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../proto/users.proto",
);

export interface GrpcServerDeps {
  userQueryService: Pick<UserQueryService, "getUserById">;
}

export function buildGrpcServer(deps: GrpcServerDeps): grpc.Server {
  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDef) as unknown as {
    users: { v1: { Users: { service: grpc.ServiceDefinition } } };
  };

  const server = new grpc.Server({
    interceptors: [makeApiKeyInterceptor(env.GRPC_API_KEY)],
  });

  server.addService(proto.users.v1.Users.service, {
    async GetUserById(
      call: grpc.ServerUnaryCall<{ id: string }, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) {
      const { user } = await getUserByIdHandler(deps, {
        request: { id: call.request.id },
      });
      if (user === null) {
        callback({ code: grpc.status.NOT_FOUND, details: "user not found" });
        return;
      }
      callback(null, {
        id: user.id,
        email: user.email,
        full_name: user.fullName,
        cognito_sub: user.cognitoSub ?? "",
      });
    },
  });

  return server;
}

export function startGrpcServer(deps: GrpcServerDeps): Promise<grpc.Server> {
  const server = buildGrpcServer(deps);
  return new Promise((resolvePromise, reject) => {
    server.bindAsync(
      `0.0.0.0:${env.GRPC_PORT}`,
      grpc.ServerCredentials.createInsecure(),
      (err) => {
        if (err) return reject(err);
        resolvePromise(server);
      },
    );
  });
}
