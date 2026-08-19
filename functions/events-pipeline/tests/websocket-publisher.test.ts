import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  mockTracingModule,
  pipelineTracer,
  resetTracingHarness,
  spanExporter,
} from "./tracing-harness.ts";

// FILE-WIDE: the publisher now opens a manual PRODUCER span, so it imports the
// tracing module, which calls sdk.start() and opens a real OTLP exporter at
// import time. See tests/tracing-harness.ts.
mockTracingModule();

// websocket-publisher imports #shared/logging/app-logger, which reaches
// #shared/config/env — Zod-parsed at MODULE LOAD (ADR-0014) and throwing
// without the full DOCDB/SES set. The values must therefore exist before the
// dynamic import of the module under test. None is read by this suite; they
// only satisfy the schema. Same block as tests/handler.test.ts.
vi.stubEnv("DOCDB_HOST", "docdb-test");
vi.stubEnv("DOCDB_USERNAME", "root");
vi.stubEnv("DOCDB_PASSWORD", "secret");
vi.stubEnv("DOCDB_DATABASE", "events");
vi.stubEnv("SES_FROM_ADDRESS", "noreply@example.com");
// Required by the schema since the email templates moved to remote images. Any
// valid absolute URL without a trailing slash satisfies it — this suite renders
// no template and fetches nothing.
vi.stubEnv("ASSETS_BASE_URL", "http://assets.test/bucket");

const queryByCognitoSub = vi.fn();
const deleteConnection = vi.fn();
vi.mock("../src/shared/realtime/connections-reader.js", () => ({
  queryByCognitoSub,
  deleteConnection,
}));

const postSend = vi.fn();
vi.mock("@aws-sdk/client-apigatewaymanagementapi", () => ({
  ApiGatewayManagementApiClient: class {
    send = postSend;
  },
  PostToConnectionCommand: class {
    constructor(public input: unknown) {}
  },
}));

function goneError() {
  const e = new Error("gone") as Error & {
    $metadata: { httpStatusCode: number };
    name: string;
  };
  e.name = "GoneException";
  e.$metadata = { httpStatusCode: 410 };
  return e;
}

describe("publishToUser", () => {
  beforeEach(() => {
    queryByCognitoSub.mockReset();
    deleteConnection.mockReset();
    postSend.mockReset();
    postSend.mockResolvedValue({});
    process.env.WS_MANAGEMENT_ENDPOINT = "http://floci:4566/execute-api/abc/dev";
    process.env.WS_CONNECTIONS_TABLE = "conns";
  });

  it("posts to every connection the user has open", async () => {
    queryByCognitoSub.mockResolvedValue(["conn-1", "conn-2"]);
    const { publishToUser } = await import(
      "../src/shared/realtime/websocket-publisher.js"
    );
    await publishToUser("sub-1", { hello: "world" });
    expect(postSend).toHaveBeenCalledTimes(2);
    expect(deleteConnection).not.toHaveBeenCalled();
  });

  it("deletes only the dead connection on 410 and still posts to the rest", async () => {
    queryByCognitoSub.mockResolvedValue(["dead", "alive"]);
    postSend.mockImplementation((cmd: { input: { ConnectionId: string } }) =>
      cmd.input.ConnectionId === "dead"
        ? Promise.reject(goneError())
        : Promise.resolve({}),
    );
    const { publishToUser } = await import(
      "../src/shared/realtime/websocket-publisher.js"
    );
    await publishToUser("sub-1", { hello: "world" });
    expect(deleteConnection).toHaveBeenCalledTimes(1);
    expect(deleteConnection).toHaveBeenCalledWith("dead");
  });

  it("never throws when the query itself fails", async () => {
    queryByCognitoSub.mockRejectedValue(new Error("dynamo down"));
    const { publishToUser } = await import(
      "../src/shared/realtime/websocket-publisher.js"
    );
    await expect(publishToUser("sub-1", {})).resolves.toBeUndefined();
  });

  it("does nothing when the user has no open connections", async () => {
    queryByCognitoSub.mockResolvedValue([]);
    const { publishToUser } = await import(
      "../src/shared/realtime/websocket-publisher.js"
    );
    await publishToUser("sub-1", {});
    expect(postSend).not.toHaveBeenCalled();
  });
});


describe("publishToUser — the manual WebSocket span", () => {
  beforeEach(() => {
    queryByCognitoSub.mockReset();
    deleteConnection.mockReset();
    postSend.mockReset();
    postSend.mockResolvedValue({});
    resetTracingHarness();
    process.env.WS_MANAGEMENT_ENDPOINT = "http://floci:4566/execute-api/abc/dev";
    process.env.WS_CONNECTIONS_TABLE = "conns";
  });

  it("opens a PRODUCER span named 'ws publish' as a CHILD of the active span", async () => {
    queryByCognitoSub.mockResolvedValue(["conn-1", "conn-2"]);
    const { publishToUser } = await import(
      "../src/shared/realtime/websocket-publisher.js"
    );

    // The parent stands in for `process_record`; parentage comes from the
    // ambient context, nothing is threaded in.
    let parentSpanId = "";
    await pipelineTracer.startActiveSpan("process_record", async (parent) => {
      parentSpanId = parent.spanContext().spanId;
      await publishToUser("sub-1", { hello: "world" });
      parent.end();
    });

    const wsSpan = spanExporter.getFinishedSpans().find((s) => s.name === "ws publish");
    expect(wsSpan).toBeDefined();
    expect(wsSpan!.kind).toBe(SpanKind.PRODUCER);
    expect(wsSpan!.parentSpanContext?.spanId).toBe(parentSpanId);
    expect(wsSpan!.attributes["messaging.system"]).toBe("apigatewaymanagementapi");
    expect(wsSpan!.attributes["messaging.batch.message_count"]).toBe(2);
    expect(wsSpan!.status.code).toBe(SpanStatusCode.OK);
  });

  it("records a zero connection count instead of omitting it when nothing is open", async () => {
    queryByCognitoSub.mockResolvedValue([]);
    const { publishToUser } = await import(
      "../src/shared/realtime/websocket-publisher.js"
    );

    await publishToUser("sub-1", {});

    // "the user had nothing open" and "the fan-out never got that far" are
    // different stories; an absent attribute cannot tell them apart.
    const wsSpan = spanExporter.getFinishedSpans().find((s) => s.name === "ws publish");
    expect(wsSpan!.attributes["messaging.batch.message_count"]).toBe(0);
    expect(wsSpan!.status.code).toBe(SpanStatusCode.OK);
  });

  it("still ends the span, OK, when the fan-out swallows a failure", async () => {
    // publishToUser NEVER throws by contract — the push is opportunistic and
    // must not fail the record. The span therefore ends OK: the RECORD did
    // succeed, and `ws_fanout_failed` on the log line is where the failure lives.
    queryByCognitoSub.mockRejectedValue(new Error("dynamo down"));
    const { publishToUser } = await import(
      "../src/shared/realtime/websocket-publisher.js"
    );

    await expect(publishToUser("sub-1", {})).resolves.toBeUndefined();

    const wsSpan = spanExporter.getFinishedSpans().find((s) => s.name === "ws publish");
    expect(wsSpan).toBeDefined();
    expect(wsSpan!.status.code).toBe(SpanStatusCode.OK);
  });
});
