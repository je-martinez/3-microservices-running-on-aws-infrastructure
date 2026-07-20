import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

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
const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://otel-collector:4318";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "users",
    "deployment.environment.name": process.env.DEPLOYMENT_ENVIRONMENT ?? "local",
  }),
  traceExporter: new OTLPTraceExporter({ url: `${OTLP_ENDPOINT}/v1/traces` }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Pure noise at this scale: every file read becomes a span and buries the
      // HTTP/gRPC/Prisma spans that actually describe a request.
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
  ],
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
