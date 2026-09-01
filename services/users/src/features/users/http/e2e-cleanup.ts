import type { Db } from "#shared/db/prisma";
import type { CacheGateway } from "#shared/cache/cache-gateway";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { ME_KEY_PREFIX, meCacheKey } from "#shared/cache/cache-keys";

// Constructor-injected from the Awilix cradle (PROXY injection mode).
// Soft-deletes (never hard-deletes) every user tagged "E2E Source".
export class E2eCleanupCommand {
  private readonly db: Db;
  private readonly cacheGateway: CacheGateway;

  constructor({ db, cacheGateway }: { db: Db; cacheGateway: CacheGateway }) {
    this.db = db;
    this.cacheGateway = cacheGateway;
  }

  async execute(): Promise<{ count: number }> {
    // Read the rows BEFORE deleting them: the cache key needs both `id` and
    // `cognitoSub`, and after the soft-delete the query extension filters
    // these rows out of every find* (see [[soft-delete]]), so they would be
    // unreachable.
    const doomed = (await this.db.user.findMany({
      where: { tags: { has: "E2E Source" }, deletedAt: null },
      select: { id: true, cognitoSub: true },
    })) as Array<{ id: string; cognitoSub: string | null }>;

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

    // AFTER the delete has persisted, like every other invalidation in this
    // service. Without it an E2E run leaves cached profiles for users the
    // database now reports as gone, and the NEXT run reads them for up to five
    // minutes — a stale-data failure that looks like a test flake.
    //
    // Rows with no `cognitoSub` are skipped: no read ever cached them (the key
    // needs a sub), and a `users:me:v1:null:usr_x` key would match nothing
    // while reading like a working invalidation.
    const keys = doomed
      .filter((row): row is { id: string; cognitoSub: string } => row.cognitoSub !== null)
      .map((row) => meCacheKey(row.cognitoSub, row.id));
    if (keys.length > 0) {
      try {
        // `invalidate` swallows its own failures (see CacheGateway), so this
        // catch is belt-and-braces: the soft-delete has already persisted and
        // its count must be reported regardless of Redis's state.
        await this.cacheGateway.invalidate(ME_KEY_PREFIX, ...keys);
      } catch (err) {
        appLogger.warn(
          { err, app_event: "cache_unavailable", reason: "redis_error", cache_operation: "del" },
          "E2E cleanup could not invalidate cached profiles; they expire on their own TTL",
        );
      }
    }

    return { count: res.count };
  }
}
