import { DiagConsoleLogger, DiagLogLevel, diag, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// Trace bootstrap for the events-pipeline Lambda. Same shape as
// functions/realtime-events/src/shared/observability/tracing.ts and Users'
// tracing.ts, minus the auto-instrumentations — see below for why they would be
// a no-op here.
//
// NO getNodeAutoInstrumentations(). scripts/build.mjs bundles this whole
// function into ONE self-contained dist/handler.js (`bundle: true`,
// `format: "cjs"`) with @aws-sdk/*, mongodb and zod INLINED — the zip carries no
// node_modules and no package.json. OTel patches modules at require() time, and
// an inlined dependency is no longer a module: there is no boundary left to
// patch. Registering the auto-instrumentations here would produce ZERO spans for
// DocumentDB, SES or the WebSocket push, in SILENCE. Every span this Lambda
// emits is therefore written by hand, through the tracer below.
//
// Surface the SDK's own diagnostics: without this an export failure — a 404, a
// refused connection — is swallowed entirely, which is how the Orders
// misconfiguration went unnoticed. ERROR level only, so healthy runs stay quiet.
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

// A BatchSpanProcessor held in a module-level const, rather than NodeSDK's
// `traceExporter` option, for one reason: forceFlush(). Lambda FREEZES the
// process the instant the handler returns, so whatever the batch processor still
// holds is either lost or delivered on some later invocation, attributed to the
// wrong request. Keeping the processor addressable is what lets the handler
// drain it before returning.
//
// SimpleSpanProcessor would avoid the flush but export synchronously on every
// span.end(), putting an HTTP round-trip to the collector inside the record loop
// — once per record, per batch — see spec Decision 7.
const processor = new BatchSpanProcessor(new OTLPTraceExporter());

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "events-pipeline",
    "deployment.environment.name": process.env.DEPLOYMENT_ENVIRONMENT ?? "local",
  }),
  // No `url` on the exporter and no endpoint anywhere in this file ON PURPOSE.
  // OTLP config lives in environment variables (OTEL_EXPORTER_OTLP_ENDPOINT,
  // OTEL_EXPORTER_OTLP_PROTOCOL, OTEL_METRICS_EXPORTER/OTEL_LOGS_EXPORTER=none),
  // set on this Lambda in infra/environments/local/main.tf. The exporter treats
  // the endpoint as a BASE url and appends /v1/traces itself; hand-built URLs
  // are what made Orders POST every batch to the collector's root and get a
  // silent 404. See [[logging-context]].
  spanProcessors: [processor],
});

sdk.start();

// The ONE tracer every manual span in this Lambda comes from — the handler's
// batch and per-record spans, and (in the follow-up) the DocumentDB/SES/WS
// wrappers. There is no second, auto-instrumented source to reconcile against.
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
