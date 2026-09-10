import { DiagConsoleLogger, DiagLogLevel, diag, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// Trace bootstrap for the events-pipeline Lambda.
// CONTRACT: Do NOT add getNodeAutoInstrumentations(). scripts/build.mjs bundles
// this function into one self-contained CJS file with @aws-sdk/*, mongodb and
// zod inlined, so OTel has no module boundary left to patch and every
// instrumentation produces ZERO spans, in silence. Every span here is manual.
// The diag logger stays: without it an export failure (404, refused connection)
// is swallowed entirely. ERROR level, so healthy runs stay quiet.
// See [[logging-context]]
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

// CONTRACT: Keep the processor addressable in a module const, not behind
// NodeSDK's `traceExporter` option — the handler must forceFlush() it before
// returning. Lambda freezes the process on return, so anything still batched is
// lost or delivered on a later invocation under the wrong request.
// SimpleSpanProcessor avoids the flush but puts an HTTP round trip inside the
// record loop, once per record.
// See [[events-pipeline-design]]
const processor = new BatchSpanProcessor(new OTLPTraceExporter());

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "events-pipeline",
    "deployment.environment.name": process.env.DEPLOYMENT_ENVIRONMENT ?? "local",
  }),
  // CONTRACT: No `url` on the exporter and no endpoint in this file. OTLP config
  // lives in env vars (OTEL_EXPORTER_OTLP_ENDPOINT/_PROTOCOL,
  // OTEL_METRICS_EXPORTER/OTEL_LOGS_EXPORTER=none). The exporter appends
  // /v1/traces to the BASE url itself; a hand-built URL POSTs to the collector's
  // root and gets a silent 404.
  // See [[logging-context]]
  spanProcessors: [processor],
});

sdk.start();

// The one tracer every manual span in this Lambda comes from. There is no
// second, auto-instrumented source to reconcile against.
export const pipelineTracer = trace.getTracer("events-pipeline");

// Called from the handler's own `finally`. Never throws: a collector that is
// down (locally it sits behind `profiles: [observability]`, so a plain
// `docker compose up` does not start it) must not turn a processed batch into a
// failed invocation — every record would be redelivered for a telemetry fault.
export async function flushTraces(): Promise<void> {
  try {
    await processor.forceFlush();
  } catch (err) {
    console.error("otel forceFlush failed", err);
  }
}
