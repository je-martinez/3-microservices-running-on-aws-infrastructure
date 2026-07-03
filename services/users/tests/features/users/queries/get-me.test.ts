import { describe, it, expect, vi } from "vitest";
import { UserQueryService } from "#features/users/queries/get-me";

describe("UserQueryService", () => {
  describe("getMe", () => {
    it("queries the db client by id (soft-delete exclusion is applied by the Prisma extension)", async () => {
      const findFirst = vi.fn(async () => null);
      const db = { user: { findFirst } } as any;
      const service = new UserQueryService({ db });
      await service.getMe("usr_1");
      expect(findFirst).toHaveBeenCalledWith({ where: { id: "usr_1" } });
    });
  });

  describe("getUserById", () => {
    it("queries the db client by id (soft-delete exclusion is applied by the Prisma extension)", async () => {
      const findFirst = vi.fn(async () => null);
      const db = { user: { findFirst } } as any;
      const service = new UserQueryService({ db });
      await service.getUserById("usr_1");
      expect(findFirst).toHaveBeenCalledWith({ where: { id: "usr_1" } });
    });
  });
});
