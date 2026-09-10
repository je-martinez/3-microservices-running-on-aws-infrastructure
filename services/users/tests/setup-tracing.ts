import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

// CONTRACT: This must stay a vitest `setupFiles` entry, never lines at the top of a
// spec. `trace.getTracer()` with no provider registered returns a ProxyTracer that
// caches the NO-OP delegate forever, and ESM hoists module-scope tracers above every
// statement in the spec body — so a provider registered inside the spec always
// arrives too late and every span silently goes nowhere.
export const testSpanExporter = new InMemorySpanExporter();

const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(testSpanExporter)],
});

provider.register();
