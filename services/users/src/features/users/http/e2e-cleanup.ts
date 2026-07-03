import type { Db } from "#shared/db/prisma";
import { runAsActor } from "#shared/audit/actor-context";

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
    const res = (await runAsActor("e2e-cleanup", () =>
      this.db.user.deleteMany({ where: { tags: { has: "E2E Source" } } }),
    )) as { count: number };
    return { count: res.count };
  }
}
