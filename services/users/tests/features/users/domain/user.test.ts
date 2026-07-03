import { describe, it, expect } from "vitest";
import { toDomain } from "#features/users/domain/user";

describe("toDomain", () => {
  it("maps a db row to a domain user with derived isDeleted", () => {
    const row = {
      id: "usr_1",
      email: "a@b.c",
      fullName: "A B",
      address: null,
      phoneNumber: null,
      tags: ["E2E Source"],
      createdBy: "usr_1",
      createdAt: new Date(0),
      updatedBy: "usr_1",
      updatedAt: new Date(0),
      deletedBy: null,
      deletedAt: null,
    };
    const user = toDomain(row);
    expect(user.isDeleted).toBe(false);
    expect(user.tags).toEqual(["E2E Source"]);
  });
});
