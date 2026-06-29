import { describe, it, expect, vi } from "vitest";
import { getUserByIdHandler } from "../../../../src/features/users/grpc/get-user-by-id.js";

describe("getUserByIdHandler", () => {
  it("delegates to the query with the request id", async () => {
    const getUserById = vi.fn(async () => ({ id: "usr_1" }));
    const res = await getUserByIdHandler({ getUserById }, { request: { id: "usr_1" } } as any);
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), "usr_1");
    expect(res.user).toEqual({ id: "usr_1" });
  });
});
