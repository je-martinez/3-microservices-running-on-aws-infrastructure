import { vi } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

// Shared harness standing in for `#shared/observability/tracing`.
// CONTRACT: The real module must NEVER load here — `sdk.start()` at import time
// opens a real OTLP exporter, and with no collector listening the handler's
// `await flushTraces()` hangs until Vitest's 5s timeout kills EVERY handler
// test, not just the tracing ones. So register the mock FILE-WIDE via a hoisted
// `vi.mock`, never per-`describe`, and keep the exporter and spy as module state
// for that factory to return. `flushTraces` must be ASSERTED: each of the four
// bundles carries its own copy, and a missing one loses its spans silently.
// See [[testing]]
export const spanExporter = new InMemorySpanExporter();

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});

export const wsTracer = provider.getTracer("realtime-events-test");

export const flushTraces = vi.fn(async () => {});

// Installs the file-wide mock. Call it at the TOP LEVEL of a test file.
// CONTRACT: The factory is declared INLINE here, not imported by the test file.
// `vi.mock` is hoisted above every import, so a factory referenced by name is
// evaluated before this module initializes and fails with "Cannot access
// '__vi_import_1__' before initialization".
export function mockTracingModule() {
  vi.mock("../src/shared/observability/tracing.js", () => ({
    wsTracer,
    flushTraces,
  }));
}

// Call from beforeEach: spans and flush calls accumulate across tests in a file
// otherwise, and `toHaveBeenCalledTimes(1)` would start counting the previous
// test's flush.
export function resetTracingHarness() {
  spanExporter.reset();
  flushTraces.mockClear();
}
