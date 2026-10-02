import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { testSpanExporter } from "../../setup.ts";
import { captureAppLogs, lineFor } from "../../helpers/capture-app-logs.ts";

// Mocked at the module boundary: the reader's own contract is that it THROWS,
// and this suite exists to prove the publisher swallows those throws.
const queryByCognitoSub = vi.fn<(sub: string) => Promise<string[]>>();
const deleteConnection = vi.fn<(id: string) => Promise<void>>();
const send = vi.fn();

vi.mock("#shared/realtime/connections-reader", () => ({
  createConnectionsReader: () => ({ queryByCognitoSub, deleteConnection }),
}));

vi.mock("@aws-sdk/client-apigatewaymanagementapi", () => ({
  ApiGatewayManagementApiClient: class {
    send = send;
  },
  PostToConnectionCommand: class {
    constructor(public readonly input: { ConnectionId: string; Data: Uint8Array }) {}
  },
}));

const { createPublishToUser } = await import("#shared/realtime/websocket-publisher");

const CONFIG = {
  AWS_REGION: "us-east-1",
  AWS_ENDPOINT_URL: "http://localhost:4566",
  WS_CONNECTIONS_TABLE: "ws-connections",
  WS_CONNECTIONS_GSI: "cognito_sub-index",
  WS_MANAGEMENT_ENDPOINT: "http://localhost:4566/execute-api/abc/local",
} as Parameters<typeof createPublishToUser>[0];

function wsPublishSpan() {
  const spans = testSpanExporter.getFinishedSpans().filter((s) => s.name === "ws publish");
  expect(spans).toHaveLength(1);
  return spans[0]!;
}

describe("createPublishToUser", () => {
  let publishToUser: ReturnType<typeof createPublishToUser>;

  beforeEach(() => {
    testSpanExporter.reset();
    queryByCognitoSub.mockReset();
    deleteConnection.mockReset();
    send.mockReset();
    send.mockResolvedValue({});
    // CONTRACT: Resolved, not bare. `deleteConnection(...).catch` on a mock
    // returning undefined throws a TypeError the outer catch hides, and the call
    // assertion still passes over a broken path.
    deleteConnection.mockResolvedValue(undefined);
    publishToUser = createPublishToUser(CONFIG);
  });

  it("pushes the serialized message to every open socket the user has", async () => {
    queryByCognitoSub.mockResolvedValue(["conn-1", "conn-2"]);
    const message = { type: "NOTIFICATION_CREATED", unread_count: 3 };

    await publishToUser("sub-abc", message);

    expect(queryByCognitoSub).toHaveBeenCalledWith("sub-abc");
    expect(send).toHaveBeenCalledTimes(2);
    const inputs = send.mock.calls.map(([command]) => command.input);
    expect(inputs.map((i) => i.ConnectionId)).toEqual(["conn-1", "conn-2"]);
    expect(JSON.parse(Buffer.from(inputs[0].Data).toString())).toEqual(message);
  });

  it("is a no-op when the user has nothing open", async () => {
    queryByCognitoSub.mockResolvedValue([]);

    await expect(publishToUser("sub-abc", {})).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("deletes a connection that answers GoneException", async () => {
    queryByCognitoSub.mockResolvedValue(["dead-conn"]);
    send.mockRejectedValue(Object.assign(new Error("gone"), { name: "GoneException" }));

    const lines = await captureAppLogs(() => publishToUser("sub-abc", {}));

    expect(deleteConnection).toHaveBeenCalledWith("dead-conn");
    // A dead socket is expected, not a failure.
    expect(lineFor(lines, "notification_push_failed")).toBeUndefined();
  });

  it("also treats a bare 410 status as gone", async () => {
    queryByCognitoSub.mockResolvedValue(["dead-conn"]);
    send.mockRejectedValue({ $metadata: { httpStatusCode: 410 } });

    await publishToUser("sub-abc", {});

    expect(deleteConnection).toHaveBeenCalledWith("dead-conn");
  });

  it("never throws when deleting a gone connection fails", async () => {
    queryByCognitoSub.mockResolvedValue(["dead-conn"]);
    send.mockRejectedValue(Object.assign(new Error("gone"), { name: "GoneException" }));
    deleteConnection.mockRejectedValue(new Error("dynamodb unreachable"));

    await expect(publishToUser("sub-abc", {})).resolves.toBeUndefined();
  });

  // CONTRACT: The push must never fail the persistence. The notification is
  // already stored; a throw here loses it on the command path and stores it twice
  // on SQS redelivery. See [[2026-09-10-in-app-notifications-design]]
  it("never throws when a push fails, and logs it per connection inside the publish span", async () => {
    queryByCognitoSub.mockResolvedValue(["conn-1", "conn-2"]);
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("management api down"));

    // captureAppLogs rethrows, so a throwing publisher fails right here.
    const lines = await captureAppLogs(() => publishToUser("sub-abc", {}));

    expect(deleteConnection).not.toHaveBeenCalled();
    const failed = lines.filter((l) => l.app_event === "notification_push_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.connection_id).toBe("conn-2");
    expect(failed[0]!.reason).toBe("management api down");
    expect(failed[0]!.severity_text).toBe("ERROR");
    expect(failed[0]!.span_id).toBe(wsPublishSpan().spanContext().spanId);
  });

  it("never throws when the connections lookup itself fails", async () => {
    queryByCognitoSub.mockRejectedValue(new Error("dynamodb unreachable"));

    const lines = await captureAppLogs(() => publishToUser("sub-abc", {}));

    expect(send).not.toHaveBeenCalled();
    const failed = lineFor(lines, "notification_push_failed");
    expect(failed?.reason).toBe("dynamodb unreachable");
    expect(failed).not.toHaveProperty("connection_id");
  });

  describe("ws publish span", () => {
    it("is a PRODUCER span on the management API carrying the fan-out size", async () => {
      queryByCognitoSub.mockResolvedValue(["conn-1", "conn-2"]);

      await publishToUser("sub-abc", {});

      const span = wsPublishSpan();
      expect(span.kind).toBe(SpanKind.PRODUCER);
      expect(span.attributes["messaging.system"]).toBe("apigatewaymanagementapi");
      expect(span.attributes["messaging.operation"]).toBe("publish");
      expect(span.attributes["messaging.batch.message_count"]).toBe(2);
      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it("records a ZERO count when the user has nothing open", async () => {
      // CONTRACT: Zero is recorded, never omitted — an absent attribute cannot
      // tell "nothing open" from "the fan-out never got that far".
      queryByCognitoSub.mockResolvedValue([]);

      await publishToUser("sub-abc", {});

      expect(wsPublishSpan().attributes["messaging.batch.message_count"]).toBe(0);
    });

    it("carries no count when the lookup itself failed", async () => {
      queryByCognitoSub.mockRejectedValue(new Error("dynamodb unreachable"));

      await publishToUser("sub-abc", {});

      expect(wsPublishSpan().attributes).not.toHaveProperty("messaging.batch.message_count");
    });
  });
});
