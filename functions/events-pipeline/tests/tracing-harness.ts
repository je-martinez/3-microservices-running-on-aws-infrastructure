import { vi } from "vitest";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

// Shared harness standing in for `#shared/observability/tracing` in every test
// that imports the handler.
//
// WHY THE REAL MODULE MUST NEVER LOAD HERE. It calls `sdk.start()` at import
// time, which registers a global tracer provider and opens a real OTLP
// exporter. In a unit test there is no collector listening, so the handler's
// `await flushTraces()` sits on a connection to 127.0.0.1:4318 until Vitest's
// 5s timeout kills the test — taking out every pre-existing handler test, not
// just the tracing ones. That is exactly what happened in
// functions/realtime-events the first time this was wired up, because only the
// tracing tests installed the mock and the plain ones loaded the real module.
//
// So the mock is registered FILE-WIDE, via a hoisted `vi.mock` at the top of
// the test file, never per-`describe`. The exporter and the spy below are module
// state precisely so that hoisted factory has something stable to return — a
// `vi.mock` factory runs before any test body, so it cannot close over a value
// created inside one.
//
// The spy matters as much as the exporter: `flushTraces` must be ASSERTED, not
// assumed. Lambda freezes the process on return, so a missing flush costs this
// function every span it produced, silently.
//
// SimpleSpanProcessor, not Batch: the test needs the span in the exporter the
// moment span.end() returns, with no flush and no timer.
export const spanExporter = new InMemorySpanExporter();

// The context manager NodeSDK installs for us in production, installed by hand
// here. Without it `startActiveSpan` still creates spans but nothing is ever
// ACTIVE: every span comes out a root of its own trace, unparented. The nesting
// this suite asserts — record spans as children of the batch span, and (with the
// manual DocumentDB/SES/WS wrappers) their children in turn — would then be
// untestable, and a real regression in the handler's context handling would pass
// unnoticed because the harness never nested anything either.
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
//
// It wraps `vi.mock` instead of the test file calling `vi.mock` with an imported
// factory, because `vi.mock` is HOISTED above every import: a factory referenced
// by name from this module would be evaluated before this module is initialized,
// which fails with "Cannot access '__vi_import_1__' before initialization".
// Declaring the factory inline here — where `pipelineTracer` and `flushTraces`
// are resolved lazily, at call time, inside the factory body — sidesteps the
// hoisting entirely.
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
