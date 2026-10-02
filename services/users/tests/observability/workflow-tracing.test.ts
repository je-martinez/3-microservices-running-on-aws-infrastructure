import { beforeEach, describe, expect, it } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";
import { testSpanExporter } from "../setup.ts";

// CONTRACT: Assert against the real provider's exporter, never a mocked span. A
// mock reports whatever it is told, so it cannot catch a span left open on the
// exception path — the one failure this helper exists to prevent.
// See [[logging-context]]
beforeEach(() => {
  testSpanExporter.reset();
});

describe("withWorkflowSpan", () => {
  it("creates an INTERNAL span named after the flow, carrying the given attributes, and sets OK on success", async () => {
    const result = await withWorkflowSpan(
      "register",
      { app_event: "register_succeeded", user_id: "usr_123" },
      async () => "done",
    );

    expect(result).toBe("done");
    const spans = testSpanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("register");
    expect(spans[0]!.kind).toBe(SpanKind.INTERNAL);
    expect(spans[0]!.attributes.app_event).toBe("register_succeeded");
    expect(spans[0]!.attributes.user_id).toBe("usr_123");
    expect(spans[0]!.status.code).toBe(SpanStatusCode.OK);
  });

  it("ends the span, records the exception, and sets ERROR on failure, then rethrows", async () => {
    await expect(
      withWorkflowSpan("login", { app_event: "login_failed", reason: "invalid_credentials" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // getFinishedSpans() returns only ENDED spans, so a span here proves the
    // `finally` ran on the exception path.
    const spans = testSpanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.ended).toBe(true);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]!.status.message).toBe("boom");
    expect(spans[0]!.attributes.reason).toBe("invalid_credentials");
    expect(spans[0]!.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("stringifies a non-Error throw into the ERROR status message", async () => {
    await expect(
      withWorkflowSpan("metrics-tick", {}, async () => {
        throw "plain string";
      }),
    ).rejects.toBe("plain string");

    expect(testSpanExporter.getFinishedSpans()[0]!.status.message).toBe("plain string");
  });

  it("nests work done inside the callback under the workflow span", async () => {
    // CONTRACT: startActiveSpan, not startSpan — anything traced inside `fn`
    // must be a CHILD, or the workflow span is a decorative sibling instead of
    // the root of the flow's subtree.
    await withWorkflowSpan("register", { app_event: "register_started" }, async () => {
      await withWorkflowSpan("inner", {}, async () => undefined);
    });

    const spans = testSpanExporter.getFinishedSpans();
    const outer = spans.find((s) => s.name === "register");
    const inner = spans.find((s) => s.name === "inner");
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(inner!.parentSpanContext?.spanId).toBe(outer!.spanContext().spanId);
    expect(inner!.spanContext().traceId).toBe(outer!.spanContext().traceId);
  });
});
