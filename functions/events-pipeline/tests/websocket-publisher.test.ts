import { describe, it, expect, vi, beforeEach } from "vitest";

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
