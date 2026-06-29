import { describe, it, expect, vi } from "vitest";
import { getMe } from "../../../../src/features/users/queries/get-me.js";

describe("getMe", () => {
  it("queries reader filtering out soft-deleted rows", async () => {
    const findFirst = vi.fn(async () => null);
    const reader = { user: { findFirst } } as any;
    await getMe({ reader }, "usr_1");
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "usr_1", deletedAt: null } });
  });
});
