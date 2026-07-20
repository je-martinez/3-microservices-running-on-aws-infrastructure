// MUST be the first import in the process. The OTel auto-instrumentations patch
// modules at require time, so anything imported above this line — fastify,
// @grpc/grpc-js, @prisma/client — loads unpatched and emits no spans at all.
import "#shared/observability/tracing";

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
