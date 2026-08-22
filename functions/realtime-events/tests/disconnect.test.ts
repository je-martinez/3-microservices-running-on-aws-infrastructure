import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanKind } from "@opentelemetry/api";
import {
  flushTraces,
  resetTracingHarness,
  spanExporter,
  mockTracingModule,
} from "./tracing-harness.js";

const deleteConnection = vi.fn();
vi.mock("../src/shared/connections-repository.js", () => ({ deleteConnection }));
// FILE-WIDE — see the note in connect.test.ts and tracing-harness.ts.
mockTracingModule();

describe("$disconnect handler", () => {
  beforeEach(() => {
    deleteConnection.mockReset();
    deleteConnection.mockResolvedValue(undefined);
    resetTracingHarness();
  });

  it("deletes the row for the closing connection", async () => {
    const { handler } = await import("../src/disconnect.js");
    const res = await handler({
      requestContext: { connectionId: "conn-1" },
    } as never);
    expect(deleteConnection).toHaveBeenCalledWith("conn-1");
    expect(res.statusCode).toBe(200);
  });

  it("still returns 200 when the delete fails", async () => {
    deleteConnection.mockRejectedValue(new Error("boom"));
    const { handler } = await import("../src/disconnect.js");
    const res = await handler({
      requestContext: { connectionId: "conn-1" },
    } as never);
    expect(res.statusCode).toBe(200);
  });

  // Own assertion: dist/disconnect.js is a separate bundle with its own inlined
  // copy of the tracing module and its own flush call.
  describe("tracing", () => {
    it("wraps the handler in a SERVER span named 'ws_disconnect' and flushes before returning", async () => {
      const { handler } = await import("../src/disconnect.js");

      await handler({ requestContext: { connectionId: "conn-1" } } as never);

      const span = spanExporter
        .getFinishedSpans()
        .find((s) => s.name === "ws_disconnect");
      expect(span).toBeDefined();
      expect(span!.kind).toBe(SpanKind.SERVER);
      expect(flushTraces).toHaveBeenCalledTimes(1);
    });
  });
});
