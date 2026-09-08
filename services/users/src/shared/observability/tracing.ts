import FastifyOtelInstrumentation from "@fastify/otel";
import { DiagConsoleLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { PrismaInstrumentation } from "@prisma/instrumentation";

// CONTRACT: This module MUST load before anything else in the process. The
// auto-instrumentations patch modules as they are require()d, so anything loaded
// earlier (fastify, @grpc/grpc-js, @prisma/client) is captured unpatched and emits
// NO spans — the symptom is silence, never an error.
// See [[logging-context]]

// Surface the SDK's own diagnostics: without this an export failure (a 404, a
// refused connection) is swallowed and spans are produced that never arrive.
// ERROR level only, so healthy runs stay quiet.
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "users",
    "deployment.environment.name": process.env.DEPLOYMENT_ENVIRONMENT ?? "local",
  }),
  // CONTRACT: Do NOT pass a `url`. The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT
  // as a BASE and appends `/v1/traces` itself; a hand-built URL POSTs every batch
  // to the collector's root and is answered 404, silently.
  // See [[logging-context]]
  traceExporter: new OTLPTraceExporter(),
  // CONTRACT: Traces only, disabled via OTEL_METRICS_EXPORTER=none and
  // OTEL_LOGS_EXPORTER=none in compose — NOT here. An `undefined` SDK option reads
  // as "not overridden", so auto-detection wins and the SDK exports to /v1/metrics
  // and /v1/logs, which both 404. See [[logging-context]]
  instrumentations: [
    getNodeAutoInstrumentations({
      // Pure noise at this scale: every file read becomes a span and buries the
      // HTTP/gRPC/Prisma spans that describe the request.
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
    // CONTRACT: Keep this registered here with `registerOnInitialization`. Without
    // it every server span is named after the bare method ("POST"), because
    // instrumentation-http names the span before Fastify has matched a route; this
    // plugin writes the route back so the span becomes "POST /v1/users/register".
    // Registering from server.ts instead only works if it beats every route
    // definition, which forfeits this file's load-order guarantee.
    // See [[logging-context]]
    new FastifyOtelInstrumentation({ registerOnInitialization: true }),
  ],
});

// CONTRACT: Register Prisma's own instrumentation HERE, before the first
// PrismaClient is constructed — it is absent from getNodeAutoInstrumentations, and
// registering it from the Awilix container patches nothing, silently, leaving the
// DB layer with zero spans. Do NOT add a BasicTracerProvider or context manager as
// @prisma/instrumentation's README does: NodeSDK above already owns both.
// See [[logging-context]]
registerInstrumentations({
  instrumentations: [new PrismaInstrumentation()],
});

sdk.start();

// Flush buffered spans on shutdown instead of dropping the last batch. Never
// blocks exit: a failed flush is logged and the process still exits cleanly —
// telemetry must not keep a container alive.
process.on("SIGTERM", () => {
  sdk
    .shutdown()
    .catch((err) => console.error("otel shutdown failed", err))
    .finally(() => process.exit(0));
});
