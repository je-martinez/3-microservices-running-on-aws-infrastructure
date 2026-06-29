import { describe, it, expect, vi } from "vitest";
import { getMe } from "../../../../src/features/users/queries/get-me.js";

describe("getMe", () => {
  it("queries by email (x-user-id carries the user email from API Gateway)", async () => {
    const findFirst = vi.fn(async () => null);
    const reader = { user: { findFirst } } as any;
    await getMe({ reader }, "a@b.c");
    expect(findFirst).toHaveBeenCalledWith({ where: { email: "a@b.c", deletedAt: null } });
  });

  it("returns null when user is not found", async () => {
    const findFirst = vi.fn(async () => null);
    const reader = { user: { findFirst } } as any;
    const result = await getMe({ reader }, "notfound@example.com");
    expect(result).toBeNull();
  });
});
