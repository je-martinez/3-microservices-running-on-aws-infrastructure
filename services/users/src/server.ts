// NOTE: tracing is NOT imported here. It is loaded via `node --import` (see the
// Dockerfile CMD and the start/dev scripts), which is the only thing that works
// under ESM: static imports are hoisted and resolved before any module body
// runs, so importing the SDK "first" in this file still left @grpc/grpc-js
// loaded before sdk.start() could patch it — leaving the gRPC server
// uninstrumented. --import gives the SDK its own module graph, ahead of ours.
import { env } from "#shared/config/env";
import { buildApp } from "#features/users/http/routes";
import { startGrpcServer } from "#shared/grpc/server";

const app = buildApp();

await app.listen({ port: env.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Resolve the SAME UserQueryService the HTTP layer uses from the app's DI
// container (registered as `userQueryService` in shared/di/awilix-container.ts).
// It is a SCOPED registration whose only dependency (`db`) is a root SINGLETON,
// so resolving it from the root container is safe and yields the shared reader.
const userQueryService = app.diContainer.resolve("userQueryService");
await startGrpcServer({ userQueryService }).catch((err) => {
  app.log.error(err, "gRPC server failed to start");
  process.exit(1);
});
app.log.info(`gRPC server listening on :${env.GRPC_PORT}`);
