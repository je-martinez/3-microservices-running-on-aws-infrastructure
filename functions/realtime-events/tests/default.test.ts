import { describe, it, expect, beforeEach } from "vitest";
import { SpanKind } from "@opentelemetry/api";
import {
  flushTraces,
  resetTracingHarness,
  spanExporter,
  mockTracingModule,
} from "./tracing-harness.js";

// FILE-WIDE — see the note in connect.test.ts and tracing-harness.ts.
mockTracingModule();

describe("$default handler", () => {
  beforeEach(() => {
    resetTracingHarness();
  });

  it("rejects an inbound message without mutating connection state", async () => {
    const { handler } = await import("../src/default.js");
    const res = await handler({
      requestContext: { connectionId: "conn-1" },
    } as never);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/server-to-client only/);
  });

  // Own assertion: dist/default.js is a separate bundle with its own inlined
  // copy of the tracing module and its own flush call.
  describe("tracing", () => {
    it("wraps the handler in a SERVER span named 'ws_default' and flushes before returning", async () => {
      const { handler } = await import("../src/default.js");

      await handler({ requestContext: { connectionId: "conn-1" } } as never);

      const span = spanExporter
        .getFinishedSpans()
        .find((s) => s.name === "ws_default");
      expect(span).toBeDefined();
      expect(span!.kind).toBe(SpanKind.SERVER);
      expect(flushTraces).toHaveBeenCalledTimes(1);
    });
  });
});
