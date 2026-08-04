import { describe, it, expect, vi } from "vitest";
import { E2eCleanupCommand } from "#features/users/http/e2e-cleanup";
import { AuditActor } from "#shared/audit/audit-actor";

// The command's whole job is the `where` it sends, so that is what these assert.
// The routes suite mocks E2eCleanupCommand wholesale and therefore cannot see it.
function commandWithSpy(count = 0) {
  const deleteMany = vi.fn(async () => ({ count }));
  const db = { user: { deleteMany } } as any;
  return { command: new E2eCleanupCommand({ db }), deleteMany };
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
