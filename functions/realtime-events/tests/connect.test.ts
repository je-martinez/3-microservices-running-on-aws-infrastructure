import { describe, it, expect, vi, beforeEach } from "vitest";

const saveConnection = vi.fn();
vi.mock("../src/shared/connections-repository.js", () => ({ saveConnection }));

describe("$connect handler", () => {
  beforeEach(() => {
    saveConnection.mockReset();
    saveConnection.mockResolvedValue(undefined);
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
});
