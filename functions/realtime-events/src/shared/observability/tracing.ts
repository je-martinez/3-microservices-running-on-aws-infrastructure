import { DiagConsoleLogger, DiagLogLevel, diag, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// Trace bootstrap for the four WebSocket Lambdas.
// CONTRACT: This file is bundled FOUR times, once per entrypoint — "shared"
// means authored once, never one runtime instance. So each handler must call
// flushTraces() in its own `finally`; there is nowhere central to drain from.

// CONTRACT: Do NOT add getNodeAutoInstrumentations(). esbuild inlines the AWS
// SDK into each bundle, leaving no module boundary for OTel to patch at
// require() time, so they produce ZERO spans in silence. Every span here is
// manual. The diag logger stays: without it an export failure (404, refused
// connection) is swallowed entirely. ERROR level, so healthy runs stay quiet.
// See [[logging-context]]
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

// CONTRACT: Keep the processor addressable in a module const, not behind
// NodeSDK's `traceExporter` option — each handler must forceFlush() it before
// returning. Lambda freezes the process on return, so anything still batched is
// lost or delivered on a later invocation under the wrong request.
// SimpleSpanProcessor avoids the flush but puts an HTTP round trip in the
// request path.
const processor = new BatchSpanProcessor(new OTLPTraceExporter());

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "realtime-events",
    "deployment.environment.name": process.env.DEPLOYMENT_ENVIRONMENT ?? "local",
  }),
  // CONTRACT: No `url` on the exporter and no endpoint in this file. OTLP config
  // lives in env vars (OTEL_EXPORTER_OTLP_ENDPOINT/_PROTOCOL,
  // OTEL_METRICS_EXPORTER/OTEL_LOGS_EXPORTER=none). The exporter appends
  // /v1/traces to the BASE url itself; a hand-built URL gets a silent 404.
  // See [[logging-context]]
  spanProcessors: [processor],
});

sdk.start();

export const wsTracer = trace.getTracer("realtime-events");

// Called from EVERY handler's own `finally` — there is no shared place to put
// it (see the bundling note above). Never throws: a collector that is down
// (locally it sits behind `profiles: [observability]`, so a plain
// `docker compose up` does not start it) must not turn a successful WebSocket
// handshake into a failed one.
export async function flushTraces(): Promise<void> {
  try {
    await processor.forceFlush();
  } catch (err) {
    console.error("otel forceFlush failed", err);
  }
}
