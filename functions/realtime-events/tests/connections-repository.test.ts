import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/lib-dynamodb", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/lib-dynamodb")>(
    "@aws-sdk/lib-dynamodb",
  );
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send }) },
  };
});

describe("connections repository", () => {
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({});
    process.env.COGNITO_USER_POOL_ID = "us-east-1_test";
    process.env.COGNITO_CLIENT_ID = "testclient";
    process.env.WS_CONNECTIONS_TABLE = "conns";
  });

  it("writes connection_id, cognito_sub, connected_at and ttl", async () => {
    const { saveConnection, TTL_SECONDS } = await import(
      "../src/shared/connections-repository.js"
    );
    await saveConnection("conn-1", "sub-1");

    expect(send).toHaveBeenCalledTimes(1);
    const item = send.mock.calls[0][0].input.Item;
    expect(item.connection_id).toBe("conn-1");
    expect(item.cognito_sub).toBe("sub-1");
    expect(typeof item.connected_at).toBe("number");
    // ttl must be in the future by roughly TTL_SECONDS
    const now = Math.floor(Date.now() / 1000);
    expect(item.ttl).toBeGreaterThan(now);
    expect(item.ttl).toBeLessThanOrEqual(now + TTL_SECONDS + 5);
  });

  it("deletes by connection_id only", async () => {
    const { deleteConnection } = await import(
      "../src/shared/connections-repository.js"
    );
    await deleteConnection("conn-1");
    expect(send.mock.calls[0][0].input.Key).toEqual({ connection_id: "conn-1" });
  });
});
