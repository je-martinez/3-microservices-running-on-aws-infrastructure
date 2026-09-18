import { describe, it, expect } from "vitest";
import { MarkNotificationsReadCommand } from "#features/notifications/commands/mark-notifications-read";
import { AuditActor } from "#shared/audit/audit-actor";

function fakeDb(updatedCount = 2, unreadAfter = 1) {
  const updateManyArgs: Array<Record<string, unknown>> = [];
  return {
    updateManyArgs,
    db: {
      notification: {
        updateMany: async (args: Record<string, unknown>) => {
          updateManyArgs.push(args);
          return { count: updatedCount };
        },
        count: async () => unreadAfter,
      },
    } as never,
  };
}

const currentUser = { identity: "sub-abc", resolve: async () => ({ id: "usr_alice" }) } as never;

describe("MarkNotificationsReadCommand", () => {
  it("stamps read_at on the caller's unread rows only", async () => {
    const { db, updateManyArgs } = fakeDb();
    const result = await new MarkNotificationsReadCommand({ db }).execute(currentUser, [
      "ntf_1",
      "ntf_2",
    ]);

    expect(result).toEqual({ updated: 2, unread_count: 1 });
    const where = updateManyArgs[0]!.where as Record<string, unknown>;
    // CONTRACT: The user_id clause IS the ownership check — another user's ids
    // simply do not match and are not counted.
    expect(where).toMatchObject({ id: { in: ["ntf_1", "ntf_2"] }, userId: "usr_alice" });
    // CONTRACT: readAt IS NULL makes it idempotent, which matters because
    // mark-on-enter can fire twice on an Angular remount.
    expect(where.readAt).toBeNull();
  });

  // The audit actor is passed explicitly: this write can run inside a request, but
  // stamping it here keeps the column readable as the action rather than the caller.
  it("stamps the mark-read audit actor", async () => {
    const { db, updateManyArgs } = fakeDb();
    await new MarkNotificationsReadCommand({ db }).execute(currentUser, ["ntf_1"]);

    const data = updateManyArgs[0]!.data as Record<string, unknown>;
    expect(data.updatedBy).toBe(AuditActor.NotificationsMarkedRead);
    expect(data.readAt).toBeInstanceOf(Date);
  });

  // An empty list is the NORMAL case: arriving with nothing unread.
  it("returns 200-shaped zero for an empty id list without touching the db", async () => {
    const { db, updateManyArgs } = fakeDb();
    const result = await new MarkNotificationsReadCommand({ db }).execute(currentUser, []);

    expect(result.updated).toBe(0);
    expect(updateManyArgs).toHaveLength(0);
  });

  it("reports zero updated when the ids belong to someone else", async () => {
    const { db } = fakeDb(0, 5);
    const result = await new MarkNotificationsReadCommand({ db }).execute(currentUser, ["ntf_x"]);

    expect(result).toEqual({ updated: 0, unread_count: 5 });
  });

  it("returns zero for a caller with no user row", async () => {
    const { db, updateManyArgs } = fakeDb();
    const unknown = { identity: "sub-nobody", resolve: async () => null } as never;
    const result = await new MarkNotificationsReadCommand({ db }).execute(unknown, ["ntf_1"]);

    expect(result).toEqual({ updated: 0, unread_count: 0 });
    expect(updateManyArgs).toHaveLength(0);
  });
});
