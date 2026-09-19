// CONTRACT: First import in the suite. Nest's decorators write to the metadata
// registry this polyfill installs; a later import leaves earlier-evaluated
// decorators writing nowhere. See [[dependency-injection]]
import "reflect-metadata";

import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

// CONTRACT: Register the tracer provider in setupFiles, never inside a spec.
// `trace.getTracer()` with no provider returns a ProxyTracer that caches the
// NO-OP delegate forever, and the global OTel API accepts only the FIRST
// registration per process — a late provider.register() is ignored and every
// span silently goes nowhere. See [[logging-context]]
export const testSpanExporter = new InMemorySpanExporter();

const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(testSpanExporter)],
});

provider.register();
