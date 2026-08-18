import { DiagConsoleLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { PrismaInstrumentation } from "@prisma/instrumentation";

// MUST be imported before anything else in the process — see the first line of
// server.ts. The auto-instrumentations monkey-patch modules as they are
// require()d, so any module loaded earlier (fastify, @grpc/grpc-js,
// @prisma/client) is captured unpatched and produces NO spans at all. This is
// not a style preference; getting it wrong yields silence, not an error.
//
// `deployment.environment.name` is written as a literal rather than imported
// from semantic-conventions/incubating: that subpath does not resolve cleanly
// under this project's module setup, and an incubating constant is by
// definition unstable. The string is the contract either way.
// Surface the SDK's own diagnostics. Without this an export failure — a 404, a
// refused connection — is swallowed entirely, which is exactly how the Orders
// misconfiguration went unnoticed: spans were produced, nothing arrived, and
// nothing complained. ERROR level only, so healthy runs stay quiet.
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "users",
    "deployment.environment.name": process.env.DEPLOYMENT_ENVIRONMENT ?? "local",
  }),
  // No `url` here ON PURPOSE. The exporter reads the standard
  // OTEL_EXPORTER_OTLP_ENDPOINT (set in docker-compose.yml) as a BASE url and
  // appends `/v1/traces` itself, per the OTLP spec.
  //
  // Hand-building the URL is what broke the Orders service — it passed the base
  // with no path, so every batch was POSTed to the collector's root and
  // answered 404, silently. Leaving the path to the SDK means a new service
  // needs no endpoint code at all, only the env var. See [[logging-context]].
  traceExporter: new OTLPTraceExporter(),
  // TRACES ONLY — enforced by OTEL_METRICS_EXPORTER=none and
  // OTEL_LOGS_EXPORTER=none in docker-compose.yml, NOT here. NodeSDK
  // auto-detects metrics and logs exporters from OTEL_EXPORTER_OTLP_ENDPOINT,
  // and an `undefined` option reads as "not overridden", so auto-detection
  // still wins. The collector serves /v1/traces only (/v1/metrics and /v1/logs
  // both 404), and this service's logs travel stdout -> fluentd, not OTLP.
  instrumentations: [
    getNodeAutoInstrumentations({
      // Pure noise at this scale: every file read becomes a span and buries the
      // HTTP/gRPC/Prisma spans that actually describe a request.
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
  ],
});

// Prisma is NOT covered by getNodeAutoInstrumentations above — it ships its own
// instrumentation package, so without this registration the DB layer produces
// zero spans and a workflow span has no query children under it.
//
// This MUST run before the first PrismaClient is constructed. `prisma.ts` builds
// the client, and it is only reached later through the Awilix container — well
// after this file, which is loaded first via `node --import` (see the top
// comment). Registering here is what guarantees that ordering; registering from
// the container instead would patch nothing, silently, with no error — the same
// load-order trap this file already documents for the auto-instrumentations.
//
// No `previewFeatures = ["tracing"]` in schema.prisma: that flag belonged to
// Prisma 6. This repo is on Prisma 7, where @prisma/instrumentation is the
// entire mechanism.
//
// And NOT the shape of @prisma/instrumentation's own README example: that one
// constructs a BasicTracerProvider plus an AsyncLocalStorageContextManager
// because it assumes a project with no SDK. NodeSDK below already owns both the
// global tracer provider and the context manager, so duplicating either would
// fight the one sdk.start() installs.
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
