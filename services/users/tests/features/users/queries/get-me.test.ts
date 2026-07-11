import { describe, it, expect, vi } from "vitest";
import { UserQueryService, byIdOrCognitoSub } from "#features/users/queries/get-me";

describe("byIdOrCognitoSub", () => {
  it("builds an OR over id and cognitoSub", () => {
    expect(byIdOrCognitoSub("x")).toEqual({ OR: [{ id: "x" }, { cognitoSub: "x" }] });
  });
});

describe("UserQueryService", () => {
  describe("getMe", () => {
    it("queries by id OR cognitoSub", async () => {
      const findFirst = vi.fn(async () => null);
      const db = { user: { findFirst } } as any;
      await new UserQueryService({ db }).getMe("usr_1");
      expect(findFirst).toHaveBeenCalledWith({ where: { OR: [{ id: "usr_1" }, { cognitoSub: "usr_1" }] } });
    });
  });

  describe("getUserById", () => {
    it("queries by id OR cognitoSub", async () => {
      const findFirst = vi.fn(async () => null);
      const db = { user: { findFirst } } as any;
      await new UserQueryService({ db }).getUserById("sub-uuid");
      expect(findFirst).toHaveBeenCalledWith({ where: { OR: [{ id: "sub-uuid" }, { cognitoSub: "sub-uuid" }] } });
    });
  });
});
