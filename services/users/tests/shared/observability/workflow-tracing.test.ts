import { describe, expect, it, beforeEach } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";
import { testSpanExporter } from "../../setup-tracing.ts";

// A real tracer provider (registered in tests/setup-tracing.ts), not a mock.
// The point of these tests is the SHAPE of the span that actually reaches an
// exporter — kind, status, attributes, and above all that it was *ended*. A
// mocked span object would happily report whatever we told it to and would not
// catch the one failure this helper exists to prevent: a span left open, which
// never reaches Jaeger and fails silently rather than erroring.
//
// The provider MUST be registered from a setup file. See that file's comment:
// a module-scope `trace.getTracer()` (which this helper uses) resolves to a
// no-op ProxyTracer if no provider is registered yet, and never upgrades.
const exporter = testSpanExporter;

beforeEach(() => {
  exporter.reset();
});

describe("withWorkflowSpan", () => {
  it("creates an INTERNAL span named after the flow, carrying the given attributes, and sets OK on success", async () => {
    const result = await withWorkflowSpan(
      "register",
      { app_event: "register_succeeded", user_id: "usr_123" },
      async () => "done",
    );

    expect(result).toBe("done");
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("register");
    expect(spans[0].kind).toBe(SpanKind.INTERNAL);
    expect(spans[0].attributes.app_event).toBe("register_succeeded");
    expect(spans[0].attributes.user_id).toBe("usr_123");
    expect(spans[0].status.code).toBe(SpanStatusCode.OK);
  });

  it("closes the span in a finally, records the exception, and sets ERROR with the same reason on failure", async () => {
    await expect(
      withWorkflowSpan(
        "login",
        { app_event: "login_failed", reason: "invalid_credentials" },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    const spans = exporter.getFinishedSpans();
    // getFinishedSpans() only returns ENDED spans, so a non-empty result IS the
    // assertion that the `finally` ran on the exception path. Stated explicitly
    // because it is the whole reason the helper wraps `span.end()` in a finally.
    expect(spans).toHaveLength(1);
    expect(spans[0].ended).toBe(true);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].status.message).toBe("boom");
    expect(spans[0].attributes.reason).toBe("invalid_credentials");
    expect(spans[0].events.some((e) => e.name === "exception")).toBe(true);
  });

  it("nests work done inside the callback under the workflow span", async () => {
    // The helper uses startActiveSpan, so anything traced inside `fn` — a Prisma
    // query, an SQS publish — must come out as a CHILD, not a sibling. That
    // parenting is what makes the workflow span the root of the flow's subtree
    // in Jaeger instead of a decorative extra span beside it.
    await withWorkflowSpan("register", { app_event: "register_started" }, async () => {
      await withWorkflowSpan("inner", {}, async () => undefined);
    });

    const spans = exporter.getFinishedSpans();
    const outer = spans.find((s) => s.name === "register");
    const inner = spans.find((s) => s.name === "inner");
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(inner!.parentSpanContext?.spanId).toBe(outer!.spanContext().spanId);
    expect(inner!.spanContext().traceId).toBe(outer!.spanContext().traceId);
  });
});
