import { vi } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

// Shared harness standing in for `#shared/observability/tracing` in every test
// that imports a handler.
//
// WHY THE REAL MODULE MUST NEVER LOAD HERE. It calls `sdk.start()` at import
// time, which registers a global tracer provider and opens a real OTLP
// exporter. In a unit test there is no collector listening, so the handler's
// `await flushTraces()` sits on a connection to 127.0.0.1:4318 until Vitest's
// 5s timeout kills the test. That is not hypothetical: it took out all 8
// pre-existing handler tests the first time this was wired up, because only the
// tracing tests installed the mock and the plain ones loaded the real module.
//
// So the mock is registered FILE-WIDE, via a hoisted `vi.mock` at the top of
// each test file, never per-`describe`. The exporter and the spy below are
// module state precisely so that hoisted factory has something stable to return
// — a `vi.mock` factory runs before any test body, so it cannot close over a
// value created inside one.
//
// The spy matters as much as the exporter: `flushTraces` must be ASSERTED, not
// assumed. Each of the four bundles carries its own inlined copy of the call,
// and forgetting one costs that Lambda every span it produces, silently.
//
// SimpleSpanProcessor, not Batch: the test needs the span in the exporter the
// moment span.end() returns, with no flush and no timer.
export const spanExporter = new InMemorySpanExporter();

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});

export const wsTracer = provider.getTracer("realtime-events-test");

export const flushTraces = vi.fn(async () => {});

// Installs the file-wide mock. Call it at the TOP LEVEL of a test file.
//
// It wraps `vi.mock` instead of the test file calling `vi.mock` with an
// imported factory, because `vi.mock` is HOISTED above every import: a factory
// referenced by name from this module would be evaluated before this module is
// initialized, which fails with "Cannot access '__vi_import_1__' before
// initialization". Declaring the factory inline here — where `wsTracer` and
// `flushTraces` are resolved lazily, at call time, inside the factory body —
// sidesteps the hoisting entirely.
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
