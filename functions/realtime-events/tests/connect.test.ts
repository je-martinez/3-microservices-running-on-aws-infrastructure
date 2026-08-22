import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanKind } from "@opentelemetry/api";
import {
  flushTraces,
  resetTracingHarness,
  spanExporter,
  mockTracingModule,
} from "./tracing-harness.js";

const saveConnection = vi.fn();
vi.mock("../src/shared/connections-repository.js", () => ({ saveConnection }));
// FILE-WIDE, not inside the tracing describe: the handler imports the real
// tracing module, which opens an OTLP exporter at import time and would hang
// every test in this file on a collector that is not running. See
// tracing-harness.ts.
mockTracingModule();

describe("$connect handler", () => {
  beforeEach(() => {
    saveConnection.mockReset();
    saveConnection.mockResolvedValue(undefined);
    resetTracingHarness();
  });

  it("persists the connection using the authorizer's cognito_sub", async () => {
    const { handler } = await import("../src/connect.js");
    const res = await handler({
      requestContext: {
        connectionId: "conn-1",
        authorizer: { cognito_sub: "sub-1" },
      },
    } as never);
    expect(saveConnection).toHaveBeenCalledWith("conn-1", "sub-1");
    expect(res.statusCode).toBe(200);
  });

  it("returns 500 without persisting when the authorizer context is missing", async () => {
    const { handler } = await import("../src/connect.js");
    const res = await handler({
      requestContext: { connectionId: "conn-1", authorizer: {} },
    } as never);
    expect(saveConnection).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
  });

  // Its own describe: this bundle is built and deployed independently of the
  // other three, so its span and its flush are verified independently too.
  describe("tracing", () => {
    it("wraps the handler in a SERVER span named 'ws_connect' and flushes before returning", async () => {
      const { handler } = await import("../src/connect.js");

      await handler({
        requestContext: {
          connectionId: "conn-1",
          authorizer: { cognito_sub: "sub-1" },
        },
      } as never);

      const span = spanExporter
        .getFinishedSpans()
        .find((s) => s.name === "ws_connect");
      expect(span).toBeDefined();
      expect(span!.kind).toBe(SpanKind.SERVER);
      // Asserted, never assumed: Lambda freezes the process on return, so a
      // missing flush loses every span this function produces without any error.
      expect(flushTraces).toHaveBeenCalledTimes(1);
    });
  });
});
