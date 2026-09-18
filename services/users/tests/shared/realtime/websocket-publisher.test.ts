import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked at the module boundary: the reader's own contract is that it throws, and
// this suite exists to prove the publisher SWALLOWS those throws.
const queryByCognitoSub = vi.fn<(sub: string) => Promise<string[]>>();
const deleteConnection = vi.fn<(id: string) => Promise<void>>();
const send = vi.fn();

vi.mock("#shared/realtime/connections-reader", () => ({
  queryByCognitoSub: (sub: string) => queryByCognitoSub(sub),
  deleteConnection: (id: string) => deleteConnection(id),
}));

vi.mock("@aws-sdk/client-apigatewaymanagementapi", () => ({
  ApiGatewayManagementApiClient: class {
    send = send;
  },
  PostToConnectionCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

const { publishToUser } = await import("#shared/realtime/websocket-publisher");

describe("publishToUser", () => {
  beforeEach(() => {
    queryByCognitoSub.mockReset();
    deleteConnection.mockReset();
    send.mockReset();
    send.mockResolvedValue({});
    // Resolved, not bare: `deleteConnection` is awaited, and a mock returning
    // undefined makes the publisher's own `.catch` throw a TypeError that the
    // outer catch hides — the call assertion still passes over a broken path.
    deleteConnection.mockResolvedValue(undefined);
  });

  it("pushes to every open socket the user has", async () => {
    queryByCognitoSub.mockResolvedValue(["conn-1", "conn-2"]);

    await publishToUser("sub-abc", { type: "NOTIFICATION_CREATED" });

    expect(queryByCognitoSub).toHaveBeenCalledWith("sub-abc");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when the user has nothing open", async () => {
    queryByCognitoSub.mockResolvedValue([]);

    await expect(publishToUser("sub-abc", {})).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  // The reactive cleanup the design leans on — the TTL is only a backstop.
  it("deletes a connection that answers 410 Gone", async () => {
    queryByCognitoSub.mockResolvedValue(["dead-conn"]);
    send.mockRejectedValue(
      Object.assign(new Error("gone"), { name: "GoneException" }),
    );

    await publishToUser("sub-abc", {});

    expect(deleteConnection).toHaveBeenCalledWith("dead-conn");
  });

  it("also treats a bare 410 status as gone", async () => {
    queryByCognitoSub.mockResolvedValue(["dead-conn"]);
    send.mockRejectedValue({ $metadata: { httpStatusCode: 410 } });

    await publishToUser("sub-abc", {});

    expect(deleteConnection).toHaveBeenCalledWith("dead-conn");
  });

  // CONTRACT: The push must never fail the persistence. The notification is
  // already stored and appears when the panel is opened; realtime is an
  // enhancement, never the source of truth.
  it("never throws when a push fails", async () => {
    queryByCognitoSub.mockResolvedValue(["conn-1"]);
    send.mockRejectedValue(new Error("management api down"));

    await expect(publishToUser("sub-abc", {})).resolves.toBeUndefined();
  });

  it("never throws when the connections lookup itself fails", async () => {
    queryByCognitoSub.mockRejectedValue(new Error("dynamodb unreachable"));

    await expect(publishToUser("sub-abc", {})).resolves.toBeUndefined();
  });
});
