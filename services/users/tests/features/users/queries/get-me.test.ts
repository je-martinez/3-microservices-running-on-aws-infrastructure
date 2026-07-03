import { describe, it, expect, vi } from "vitest";
import { UserQueryService } from "../../../../src/features/users/queries/get-me.js";

describe("UserQueryService", () => {
  describe("getMe", () => {
    it("queries reader filtering out soft-deleted rows", async () => {
      const findFirst = vi.fn(async () => null);
      const reader = { user: { findFirst } } as any;
      const service = new UserQueryService({ reader });
      await service.getMe("usr_1");
      expect(findFirst).toHaveBeenCalledWith({ where: { id: "usr_1", deletedAt: null } });
    });
  });

  describe("getUserById", () => {
    it("queries reader filtering out soft-deleted rows", async () => {
      const findFirst = vi.fn(async () => null);
      const reader = { user: { findFirst } } as any;
      const service = new UserQueryService({ reader });
      await service.getUserById("usr_1");
      expect(findFirst).toHaveBeenCalledWith({ where: { id: "usr_1", deletedAt: null } });
    });
  });
});
