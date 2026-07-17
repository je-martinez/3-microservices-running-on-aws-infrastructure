import { describe, it, expect, vi } from "vitest";
import { UserQueryService } from "#features/users/queries/get-me";
import { CurrentUser } from "#shared/auth/current-user";

describe("UserQueryService", () => {
  describe("getMe", () => {
    it("resolves via the request-scoped CurrentUser context", async () => {
      const findByIdOrCognitoSub = vi.fn(async () => null);
      const db = { user: { findByIdOrCognitoSub } } as any;
      const currentUser = new CurrentUser({ db, identity: "usr_1" });
      await new UserQueryService({ db }).getMe(currentUser);
      expect(findByIdOrCognitoSub).toHaveBeenCalledWith("usr_1");
    });

    it("calls findByIdOrCognitoSub only once even if resolve() is shared", async () => {
      const findByIdOrCognitoSub = vi.fn(async () => null);
      const db = { user: { findByIdOrCognitoSub } } as any;
      const currentUser = new CurrentUser({ db, identity: "usr_1" });
      await new UserQueryService({ db }).getMe(currentUser);
      await currentUser.resolve();
      expect(findByIdOrCognitoSub).toHaveBeenCalledTimes(1);
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
