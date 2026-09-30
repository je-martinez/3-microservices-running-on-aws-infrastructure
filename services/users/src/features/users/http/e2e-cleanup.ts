import type { Db } from "#shared/db/prisma";
import type { CacheGateway } from "#shared/cache/cache-gateway";
import type { StripeClientHolder } from "#shared/stripe/stripe-client.provider";
import { isResourceMissing } from "#shared/stripe/stripe-errors";
import { withStripeSpan } from "#shared/observability/stripe-tracing";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { ME_KEY_PREFIX, meCacheKey } from "#shared/cache/cache-keys";

// Constructor-injected from the Awilix cradle (PROXY injection mode).
// Soft-deletes (never hard-deletes) every user tagged "E2E Source".
// `stripe` is OPTIONAL: this command exists whenever E2E_TESTING_ENABLED is
// set, independent of STRIPE_ENABLED, so a caller with no Stripe wiring at
// all must still clean up the DB. See [[dependency-injection]]
export class E2eCleanupCommand {
  private readonly db: Db;
  private readonly cacheGateway: CacheGateway;
  private readonly stripe: StripeClientHolder | undefined;

  constructor({
    db,
    cacheGateway,
    stripe,
  }: {
    db: Db;
    cacheGateway: CacheGateway;
    stripe?: StripeClientHolder;
  }) {
    this.db = db;
    this.cacheGateway = cacheGateway;
    this.stripe = stripe;
  }

  async execute(): Promise<{ count: number }> {
    // Read the rows BEFORE deleting them: the cache key needs both `id` and
    // `cognitoSub`, and after the soft-delete the query extension filters
    // these rows out of every find* (see [[soft-delete]]), so they would be
    // unreachable. `stripeCustomerId` rides along on the same read for the
    // same reason — it is what Task 6's cleanup pass below needs.
    const doomed = (await this.db.user.findMany({
      where: { tags: { has: "E2E Source" }, deletedAt: null },
      select: { id: true, cognitoSub: true, stripeCustomerId: true },
    })) as Array<{ id: string; cognitoSub: string | null; stripeCustomerId: string | null }>;

    // CONTRACT: Pass `deletedAt: null` explicitly. The extension injects it into
    // `find*` but NOT into `deleteMany`, which forwards `where` verbatim, so without it
    // this re-stamps every row ever deleted and the teardown count becomes a running
    // total of all history instead of what the run created. `runAsActor` sets a fixed
    // actor: this maintenance endpoint has no authenticated user.
    // See [[soft-delete]]
    const res = (await runAsActor(AuditActor.E2eCleanup, () =>
      this.db.user.deleteMany({
        where: { tags: { has: "E2E Source" }, deletedAt: null },
      }),
    )) as { count: number };

    // CONTRACT: Invalidate AFTER the delete persists. Otherwise a run leaves cached
    // profiles for users the database reports as gone and the NEXT run reads them for
    // five minutes — a stale-data failure that looks like a flake. Rows with no
    // `cognitoSub` are skipped: no read cached them, and a `…:null:usr_x` key matches
    // nothing while reading like a working invalidation.
    const keys = doomed
      .filter(
        (row): row is { id: string; cognitoSub: string; stripeCustomerId: string | null } =>
          row.cognitoSub !== null,
      )
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

    await this.cleanupStripeCustomers(doomed);

    return { count: res.count };
  }

  // No new app_event: e2e-cleanup is test-only infrastructure, not a
  // user-facing flow (Decision 25) — the span is enough to debug a stuck CI
  // sandbox. One Stripe failure must not stop the rest, since the DB
  // soft-delete above already persisted regardless of Stripe's state.
  private async cleanupStripeCustomers(
    doomed: Array<{ id: string; stripeCustomerId: string | null }>,
  ): Promise<void> {
    if (!this.stripe?.client) return;
    const client = this.stripe.client;

    for (const row of doomed) {
      if (!row.stripeCustomerId) continue;
      try {
        await withStripeSpan(
          "stripe.customer.delete",
          { "stripe.resource_type": "customer", "stripe.customer_id": row.stripeCustomerId },
          () => client.customers.del(row.stripeCustomerId as string),
        );
      } catch (err) {
        if (isResourceMissing(err)) continue;
        appLogger.warn(
          {
            err,
            // CONTRACT: A fixed code, never `err.message` — Stripe's own error
            // text can embed request/account details that must not reach logs.
            reason: "stripe_customer_delete_failed",
            user_id: row.id,
          },
          "E2E cleanup could not delete a Stripe customer; continuing with the rest",
        );
      }
    }
  }
}
