import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

// Registers an in-memory tracer provider BEFORE any test module is imported.
//
// This has to be a vitest `setupFiles` entry rather than a few lines at the top
// of the spec, and the reason is load order, not tidiness. `trace.getTracer()`
// called while no provider is registered returns a ProxyTracer that caches the
// NO-OP delegate it resolved at construction time; it does not upgrade itself
// when a provider is registered afterwards. Modules like
// shared/observability/workflow-tracing.ts hold exactly such a module-scope
// tracer, and ESM hoists their imports above every statement in the spec body —
// so a provider registered inside the spec (even at module scope, let alone in
// a beforeAll) always arrives too late and every span silently goes nowhere.
//
// Setup files run before the test module graph is loaded, which is the only
// point early enough. Same class of load-order trap as
// src/shared/observability/tracing.ts's `node --import` requirement.
export const testSpanExporter = new InMemorySpanExporter();

const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(testSpanExporter)],
});

provider.register();
