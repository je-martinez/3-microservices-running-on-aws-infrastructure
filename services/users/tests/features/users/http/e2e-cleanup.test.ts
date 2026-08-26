import { describe, it, expect, vi } from "vitest";
import { E2eCleanupCommand } from "#features/users/http/e2e-cleanup";
import { ME_KEY_PREFIX, meCacheKey } from "#shared/cache/cache-keys";
import { AuditActor } from "#shared/audit/audit-actor";

function makeDeps(rows: Array<{ id: string; cognitoSub: string | null }>) {
  const invalidate = vi.fn(async () => {});
  const db = {
    user: {
      findMany: vi.fn(async () => rows),
      deleteMany: vi.fn(async () => ({ count: rows.length })),
    },
  };
  return { db, cacheGateway: { invalidate } as any, invalidate };
}

// The command's whole job is the `where` it sends, so that is what these assert.
// The routes suite mocks E2eCleanupCommand wholesale and therefore cannot see it.
function commandWithSpy(count = 0) {
  const deleteMany = vi.fn(async () => ({ count }));
  const db = { user: { deleteMany, findMany: vi.fn(async () => []) } } as any;
  const cacheGateway = { invalidate: vi.fn(async () => {}) } as any;
  return { command: new E2eCleanupCommand({ db, cacheGateway }), deleteMany };
}

describe("E2eCleanupCommand", () => {
  it("deletes by tag and skips rows that are already soft-deleted", async () => {
    const { command, deleteMany } = commandWithSpy();

    await command.execute();

    // `deletedAt: null` is the half that regressed. The soft-delete extension
    // injects that filter into `find*` but forwards `deleteMany`'s `where`
    // verbatim to `updateMany`, so without it the command re-stamps every row it
    // has ever deleted and reports a running total of all history instead of what
    // this run created — the teardown's count climbed 590 → 643 across two runs.
    expect(deleteMany).toHaveBeenCalledWith({
      where: { tags: { has: "E2E Source" }, deletedAt: null },
    });
  });

  it("returns the number of rows deleted", async () => {
    const { command } = commandWithSpy(7);

    await expect(command.execute()).resolves.toEqual({ count: 7 });
  });

  it("runs under the E2E cleanup actor, not the request's caller", async () => {
    // This endpoint is maintenance: it has no authenticated user (global teardown
    // calls it with no x-user-id), so `deletedBy` must record a fixed actor rather
    // than whoever happened to call.
    const { command, deleteMany } = commandWithSpy();
    let actorDuringCall: string | undefined;
    deleteMany.mockImplementation(async () => {
      const { getActor } = await import("#shared/audit/actor-context");
      actorDuringCall = getActor();
      return { count: 0 };
    });

    await command.execute();

    expect(actorDuringCall).toBe(AuditActor.E2eCleanup);
  });
});

describe("E2eCleanupCommand cache invalidation", () => {
  it("drops each deleted user's cached profile", async () => {
    const d = makeDeps([
      { id: "usr_a", cognitoSub: "sub-a" },
      { id: "usr_b", cognitoSub: "sub-b" },
    ]);
    const command = new E2eCleanupCommand(d as any);

    const res = await command.execute();

    expect(res).toEqual({ count: 2 });
    expect(d.invalidate).toHaveBeenCalledWith(
      ME_KEY_PREFIX,
      meCacheKey("sub-a", "usr_a"),
      meCacheKey("sub-b", "usr_b"),
    );
  });

  // The rows must be read BEFORE the delete: the soft-delete extension filters
  // deleted rows out of every find*, so a read afterwards returns nothing and
  // the invalidation silently becomes a no-op.
  it("reads the doomed rows before deleting them", async () => {
    const d = makeDeps([{ id: "usr_a", cognitoSub: "sub-a" }]);
    const order: string[] = [];
    d.db.user.findMany = vi.fn(async () => {
      order.push("findMany");
      return [{ id: "usr_a", cognitoSub: "sub-a" }];
    });
    d.db.user.deleteMany = vi.fn(async () => {
      order.push("deleteMany");
      return { count: 1 };
    });
    const command = new E2eCleanupCommand(d as any);

    await command.execute();

    expect(order).toEqual(["findMany", "deleteMany"]);
  });

  it("skips a row with no cognitoSub rather than building a key with 'null' in it", async () => {
    // A user captured before the Cognito webhook fired has no sub, so no read
    // ever cached them under one. `users:me:v1:null:usr_c` would be a key that
    // matches nothing — a silent no-op that reads like a working invalidation.
    const d = makeDeps([{ id: "usr_c", cognitoSub: null }]);
    const command = new E2eCleanupCommand(d as any);

    await command.execute();

    expect(d.invalidate).not.toHaveBeenCalled();
  });

  it("still reports the deletion count when the cache call fails", async () => {
    const d = makeDeps([{ id: "usr_a", cognitoSub: "sub-a" }]);
    d.cacheGateway.invalidate = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const command = new E2eCleanupCommand(d as any);

    // The soft-delete has already persisted; a cache failure must not undo it.
    await expect(command.execute()).resolves.toEqual({ count: 1 });
  });
});
