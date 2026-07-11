import { describe, it, expect, vi } from "vitest";
import { UpdateProfileCommand } from "#features/users/commands/update-profile";

function makeDb(target: { id: string } | null) {
  const findByIdOrCognitoSub = vi.fn(async () => target);
  const update = vi.fn(async () => ({
    id: "usr_1", email: "a@b.co", fullName: "New", address: null, phoneNumber: null,
    tags: [], createdBy: null, createdAt: new Date(), updatedBy: null, updatedAt: new Date(),
    deletedBy: null, deletedAt: null,
  }));
  return { db: { user: { findByIdOrCognitoSub, update } } as any, findByIdOrCognitoSub, update };
}

describe("UpdateProfileCommand", () => {
  it("resolves by id OR cognitoSub, then updates by the resolved id", async () => {
    const { db, findByIdOrCognitoSub, update } = makeDb({ id: "usr_1" });
    const res = await new UpdateProfileCommand({ db }).execute("sub-uuid", { fullName: "New" });
    expect(findByIdOrCognitoSub).toHaveBeenCalledWith("sub-uuid");
    expect(update).toHaveBeenCalledWith({ where: { id: "usr_1" }, data: { fullName: "New" } });
    expect(res?.id).toBe("usr_1");
  });

  it("returns null and does not update when no user matches", async () => {
    const { db, update } = makeDb(null);
    const res = await new UpdateProfileCommand({ db }).execute("nope", { fullName: "X" });
    expect(res).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});
