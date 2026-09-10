// CONTRACT: Do NOT import tracing here. It loads via `node --import` (Dockerfile CMD
// and the start/dev scripts), the only thing that works under ESM: static imports are
// hoisted before any module body runs, so importing the SDK "first" still leaves
// @grpc/grpc-js loaded before sdk.start() can patch it and the gRPC server comes out
// uninstrumented. See [[logging-context]]
import { env } from "#shared/config/env";
import { buildApp } from "#features/users/http/routes";
import { startGrpcServer } from "#shared/grpc/server";

const app = buildApp();

await app.listen({ port: env.PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// CONTRACT: Start the metrics poller here, NOT in buildApp() — the test suite calls
// buildApp too, and a live timer in every run would hit the database outside any
// test's control. The SCOPED `userQueryService` resolves safely from the root
// container because its only dependency is a root singleton.
const businessMetricsPoller = app.diContainer.resolve("businessMetricsPoller");
businessMetricsPoller.start();
process.on("SIGTERM", () => {
  businessMetricsPoller.stop();
});

const userQueryService = app.diContainer.resolve("userQueryService");
await startGrpcServer({ userQueryService }).catch((err) => {
  app.log.error(err, "gRPC server failed to start");
  process.exit(1);
});
app.log.info(`gRPC server listening on :${env.GRPC_PORT}`);
