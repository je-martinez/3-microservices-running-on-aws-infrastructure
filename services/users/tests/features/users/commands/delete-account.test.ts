import { describe, it, expect, vi } from "vitest";
import { DeleteAccountCommand } from "#features/users/commands/delete-account";
import { AuditActor } from "#shared/audit/audit-actor";
import { getActor } from "#shared/audit/actor-context";
import { CascadeFailedError } from "#shared/http/cascade-client";
import { CurrentUser } from "#shared/auth/current-user";

const TARGET = {
  id: "usr_1",
  email: "a@b.co",
  cognitoSub: "sub-1",
  fullName: "A",
  address: null,
  phoneNumber: null,
  tags: [],
  createdBy: null,
  createdAt: new Date(),
  updatedBy: null,
  updatedAt: new Date(),
  deletedBy: null,
  deletedAt: null,
};

function makeDeps(target: typeof TARGET | null = TARGET) {
  const seenActor: { value?: string } = {};
  const del = vi.fn(async () => {
    // Captured inside the fake, which is where the extension would read it.
    seenActor.value = getActor();
    return { ...TARGET, deletedAt: new Date() };
  });
  const db = {
    user: { findByIdOrCognitoSub: vi.fn(async () => target), delete: del },
  } as any;
  const cascade = {
    deleteOrdersForUser: vi.fn(async () => {}),
    deleteTrackingsForUser: vi.fn(async () => {}),
  };
  const auth = { deleteUser: vi.fn(async () => {}) };
  return { db, cascade, auth, del, seenActor };
}

describe("DeleteAccountCommand", () => {
  it("cascades to BOTH services before deleting the account", async () => {
    const { db, cascade, auth } = makeDeps();
    const order: string[] = [];
    cascade.deleteOrdersForUser.mockImplementation(async () => void order.push("orders"));
    cascade.deleteTrackingsForUser.mockImplementation(async () => void order.push("tracking"));
    db.user.delete.mockImplementation(async () => {
      order.push("users");
      return TARGET;
    });
    auth.deleteUser.mockImplementation(async () => void order.push("cognito"));

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    const result = await new DeleteAccountCommand({ db, cascade, auth } as any).execute(
      currentUser,
    );

    expect(result).toBe("deleted");
    // The order IS the safety property, so it is asserted directly rather than
    // inferred from the individual calls having happened.
    expect(order).toEqual(["orders", "tracking", "users", "cognito"]);
  });

  it("passes both identities to Tracking", async () => {
    const { db, cascade, auth } = makeDeps();
    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await new DeleteAccountCommand({ db, cascade, auth } as any).execute(currentUser);

    expect(cascade.deleteTrackingsForUser).toHaveBeenCalledWith("sub-1", "usr_1");
  });

  it("stamps the DeleteAccount audit actor", async () => {
    const { db, cascade, auth, seenActor } = makeDeps();
    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await new DeleteAccountCommand({ db, cascade, auth } as any).execute(currentUser);

    expect(seenActor.value).toBe(AuditActor.DeleteAccount);
  });

  it("returns not_found and touches nothing when the user does not exist", async () => {
    const { db, cascade, auth } = makeDeps(null);
    const currentUser = new CurrentUser({ db, identity: "ghost" });
    const result = await new DeleteAccountCommand({ db, cascade, auth } as any).execute(
      currentUser,
    );

    expect(result).toBe("not_found");
    expect(cascade.deleteOrdersForUser).not.toHaveBeenCalled();
    expect(db.user.delete).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });

  it("does NOT delete the account when the Orders cascade fails", async () => {
    const { db, cascade, auth } = makeDeps();
    cascade.deleteOrdersForUser.mockRejectedValue(new CascadeFailedError("orders", "status 500"));

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await expect(
      new DeleteAccountCommand({ db, cascade, auth } as any).execute(currentUser),
    ).rejects.toBeInstanceOf(CascadeFailedError);

    // The account survives, so the user can still authenticate and retry. This is
    // the entire reason the cascade runs before the deletion.
    expect(db.user.delete).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });

  it("does NOT delete the account when the Tracking cascade fails", async () => {
    const { db, cascade, auth } = makeDeps();
    cascade.deleteTrackingsForUser.mockRejectedValue(
      new CascadeFailedError("tracking", "status 503"),
    );

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await expect(
      new DeleteAccountCommand({ db, cascade, auth } as any).execute(currentUser),
    ).rejects.toBeInstanceOf(CascadeFailedError);

    // Orders already deleted here. That is accepted and recoverable: both internal
    // routes are idempotent, so the user's retry re-runs Orders as a no-op and
    // completes Tracking.
    expect(db.user.delete).not.toHaveBeenCalled();
  });

  it("still reports success when Cognito fails after the row is stamped", async () => {
    const { db, cascade, auth } = makeDeps();
    auth.deleteUser.mockRejectedValue(new Error("cognito down"));

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    const result = await new DeleteAccountCommand({ db, cascade, auth } as any).execute(
      currentUser,
    );

    // Postgres has committed; failing the request would tell the user their delete
    // did not happen when it did. The orphaned pool entry is logged loudly instead.
    expect(result).toBe("deleted");
    expect(db.user.delete).toHaveBeenCalled();
  });
});
