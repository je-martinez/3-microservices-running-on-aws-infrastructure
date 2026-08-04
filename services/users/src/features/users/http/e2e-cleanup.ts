import type { Db } from "#shared/db/prisma";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";

// Constructor-injected from the Awilix cradle (PROXY injection mode).
// Soft-deletes (never hard-deletes) every user tagged "E2E Source".
export class E2eCleanupCommand {
  private readonly db: Db;

  constructor({ db }: { db: Db }) {
    this.db = db;
  }

  async execute(): Promise<{ count: number }> {
    // `deleteMany` is redirected to a soft-delete update by the Prisma
    // extension (see [[soft-delete]]); `runAsActor` sets a fixed actor for
    // this call instead of relying on the request's `x-user-id` (this
    // maintenance endpoint isn't tied to an authenticated user).
    //
    // `deletedAt: null` is what keeps the count meaningful. The extension
    // injects that filter into `find*` but NOT into `deleteMany` — it forwards
    // `where` verbatim to `updateMany` — so without it this re-stamps every
    // row it has ever deleted and returns a running total of all history.
    // The E2E teardown prints that number, and it climbed every run (590 →
    // 643 → …) when it should report what the run just created. Re-deleting
    // was harmless but told you nothing.
    const res = (await runAsActor(AuditActor.E2eCleanup, () =>
      this.db.user.deleteMany({
        where: { tags: { has: "E2E Source" }, deletedAt: null },
      }),
    )) as { count: number };
    return { count: res.count };
  }
}
