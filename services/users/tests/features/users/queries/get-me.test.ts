import { describe, it, expect, vi } from "vitest";
import { UserQueryService } from "#features/users/queries/get-me";

describe("UserQueryService", () => {
  describe("getMe", () => {
    it("resolves via db.user.findByIdOrCognitoSub", async () => {
      const findByIdOrCognitoSub = vi.fn(async () => null);
      const db = { user: { findByIdOrCognitoSub } } as any;
      await new UserQueryService({ db }).getMe("usr_1");
      expect(findByIdOrCognitoSub).toHaveBeenCalledWith("usr_1");
    });
  });

  describe("getUserById", () => {
    it("resolves via db.user.findByIdOrCognitoSub", async () => {
      const findByIdOrCognitoSub = vi.fn(async () => null);
      const db = { user: { findByIdOrCognitoSub } } as any;
      await new UserQueryService({ db }).getUserById("sub-uuid");
      expect(findByIdOrCognitoSub).toHaveBeenCalledWith("sub-uuid");
    });
  });
});
