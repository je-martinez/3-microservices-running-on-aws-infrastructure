import { describe, it, expect, vi, beforeEach } from "vitest";

const deleteConnection = vi.fn();
vi.mock("../src/shared/connections-repository.js", () => ({ deleteConnection }));

describe("$disconnect handler", () => {
  beforeEach(() => {
    deleteConnection.mockReset();
    deleteConnection.mockResolvedValue(undefined);
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
});
