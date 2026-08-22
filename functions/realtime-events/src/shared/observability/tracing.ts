import { DiagConsoleLogger, DiagLogLevel, diag, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// Trace bootstrap for the four WebSocket Lambdas. Same shape as Users'
// tracing.ts, minus the auto-instrumentations — see below for why they would
// be a no-op here.
//
// THIS ONE SOURCE FILE IS BUNDLED FOUR TIMES, once into each of
// dist/authorizer.js, dist/connect.js, dist/disconnect.js and dist/default.js:
// scripts/build.mjs declares four entryPoints and an `outdir`, not a shared
// `outfile`. That is correct, not duplication to dedupe — each Lambda is its
// own process running its own standalone bundle, so "shared" here means
// "authored once", never "one runtime instance across the four". The direct
// consequence is flushTraces(): each handler must import and CALL it in its own
// `finally`, because there is no cross-Lambda runtime to centralize it in.
//
// NO getNodeAutoInstrumentations(). OTel patches modules at require() time, and
// esbuild has already inlined the AWS SDK into each bundle, so there is no
// module boundary left to patch. Registering them would produce ZERO spans, in
// silence. Every span around an AWS call in this package is therefore written
// by hand.
//
// Surface the SDK's own diagnostics: without this an export failure — a 404, a
// refused connection — is swallowed entirely, which is how the Orders
// misconfiguration went unnoticed. ERROR level only, so healthy runs stay quiet.
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

// A BatchSpanProcessor held in a module-level const, rather than NodeSDK's
// `traceExporter` option, for one reason: forceFlush(). Lambda FREEZES the
// process the instant the handler returns, so whatever the batch processor
// still holds is either lost or delivered on some later invocation, attributed
// to the wrong request. Keeping the processor addressable is what lets each
// handler drain it before returning.
//
// SimpleSpanProcessor would avoid the flush but export synchronously on every
// span.end(), putting an HTTP round-trip to the collector inside the request
// path — see spec Decision 7.
const processor = new BatchSpanProcessor(new OTLPTraceExporter());

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "realtime-events",
    "deployment.environment.name": process.env.DEPLOYMENT_ENVIRONMENT ?? "local",
  }),
  // No `url` on the exporter and no endpoint anywhere in this file ON PURPOSE.
  // OTLP config lives in environment variables (OTEL_EXPORTER_OTLP_ENDPOINT,
  // OTEL_EXPORTER_OTLP_PROTOCOL, OTEL_METRICS_EXPORTER/OTEL_LOGS_EXPORTER=none),
  // set on these Lambdas in infra/environments/local/main.tf. The exporter
  // treats the endpoint as a BASE url and appends /v1/traces itself; hand-built
  // URLs are what made Orders POST every batch to the collector's root and get
  // a silent 404. See [[logging-context]].
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
