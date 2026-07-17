import { describe, it, expect, vi } from "vitest";
import { UpdateProfileCommand } from "#features/users/commands/update-profile";
import { AuditActor } from "#shared/audit/audit-actor";
import { getActor } from "#shared/audit/actor-context";
import { CurrentUser } from "#shared/auth/current-user";

function makeDb(target: { id: string } | null) {
  const findByIdOrCognitoSub = vi.fn(async () => target);
  // Capture the audit actor the extension would read at update time — the
  // command wraps the update in runAsActor(AuditActor.UpdateProfile).
  const seenActor: { value?: string } = {};
  const update = vi.fn(async () => {
    seenActor.value = getActor();
    return {
      id: "usr_1", email: "a@b.co", fullName: "New", address: null, phoneNumber: null,
      tags: [], createdBy: null, createdAt: new Date(), updatedBy: null, updatedAt: new Date(),
      deletedBy: null, deletedAt: null,
    };
  });
  return { db: { user: { findByIdOrCognitoSub, update } } as any, findByIdOrCognitoSub, update, seenActor };
}

describe("UpdateProfileCommand", () => {
  it("resolves via the CurrentUser context, then updates by the resolved id", async () => {
    const { db, findByIdOrCognitoSub, update } = makeDb({ id: "usr_1" });
    const currentUser = new CurrentUser({ db, identity: "sub-uuid" });
    const res = await new UpdateProfileCommand({ db }).execute(currentUser, { fullName: "New" });
    expect(findByIdOrCognitoSub).toHaveBeenCalledWith("sub-uuid");
    expect(update).toHaveBeenCalledWith({ where: { id: "usr_1" }, data: { fullName: "New" } });
    expect(res?.id).toBe("usr_1");
  });

  it("runs the update under the UpdateProfile audit actor", async () => {
    const { db, seenActor } = makeDb({ id: "usr_1" });
    const currentUser = new CurrentUser({ db, identity: "sub-uuid" });
    await new UpdateProfileCommand({ db }).execute(currentUser, { fullName: "New" });
    expect(seenActor.value).toBe(AuditActor.UpdateProfile);
  });

  it("returns null and does not update when no user matches", async () => {
    const { db, update } = makeDb(null);
    const currentUser = new CurrentUser({ db, identity: "nope" });
    const res = await new UpdateProfileCommand({ db }).execute(currentUser, { fullName: "X" });
    expect(res).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("calls findByIdOrCognitoSub only once even if resolve() is shared", async () => {
    const { db, findByIdOrCognitoSub } = makeDb({ id: "usr_1" });
    const currentUser = new CurrentUser({ db, identity: "sub-uuid" });
    await currentUser.resolve();
    await new UpdateProfileCommand({ db }).execute(currentUser, { fullName: "New" });
    expect(findByIdOrCognitoSub).toHaveBeenCalledTimes(1);
  });
});
