import { vi } from "vitest";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
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
// for that factory to return. `flushTraces` must be ASSERTED: Lambda freezes the
// process on return, so a missing flush loses every span silently.
// See [[testing]]
export const spanExporter = new InMemorySpanExporter();

// CONTRACT: Install the context manager NodeSDK gives us in production. Without
// it `startActiveSpan` still creates spans but none is ever ACTIVE, so every
// span comes out an unparented root — the nesting this suite asserts becomes
// untestable and a real regression passes unnoticed.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});

export const pipelineTracer = provider.getTracer("events-pipeline-test");

export const flushTraces = vi.fn(async () => {});

// The tracer the tests use to mint a synthetic ORIGIN trace — the stand-in for
// the publisher whose traceparent rides on the SQS message. It writes into the
// same exporter, so an origin span is visible to assertions like any other.
export const originTracer = provider.getTracer("origin-test");

// Installs the file-wide mock. Call it at the TOP LEVEL of a test file.
// CONTRACT: The factory is declared INLINE here, not imported by the test file.
// `vi.mock` is hoisted above every import, so a factory referenced by name is
// evaluated before this module initializes and fails with "Cannot access
// '__vi_import_1__' before initialization".
export function mockTracingModule() {
  vi.mock("#shared/observability/tracing", () => ({
    pipelineTracer,
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
