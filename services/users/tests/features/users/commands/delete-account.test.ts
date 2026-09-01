import { describe, it, expect, vi } from "vitest";
import { DeleteAccountCommand } from "#features/users/commands/delete-account";
import { AuditActor } from "#shared/audit/audit-actor";
import { getActor } from "#shared/audit/actor-context";
import { CascadeFailedError, CascadeUnavailableError } from "#shared/http/cascade-client";
import { CurrentUser } from "#shared/auth/current-user";
import { CacheGateway } from "#shared/cache/cache-gateway";
import { ME_KEY_PREFIX, meCacheKey } from "#shared/cache/cache-keys";
import { captureAppLogs, lineFor } from "../../../helpers/capture-app-logs.ts";

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
  const metricsPublisher = { publish: vi.fn(async () => {}) };
  return { db, cascade, auth, metricsPublisher, del, seenActor };
}

// Map-backed stand-in for the ioredis commands CacheGateway uses, the same
// shape as tests/shared/cache/cache-gateway.test.ts. `pipeline()` is real here
// for the reason recorded there: a fake missing it makes every `get` throw and
// report BYPASS, which reads exactly like a working fail-open — so a cache
// assertion would pass without the cache ever having held anything.
function fakeRedis() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  const self = {
    data,
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _mode: string, ttl: number) => {
      data.set(key, value);
      ttls.set(key, ttl * 1000);
      return "OK";
    }),
    pttl: vi.fn(async (key: string) => ttls.get(key) ?? -2),
    del: vi.fn(async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) if (data.delete(k)) n++;
      return n;
    }),
    pipeline: vi.fn(() => {
      const ops: Array<() => Promise<unknown>> = [];
      const chain = {
        get(key: string) {
          ops.push(() => self.get(key));
          return chain;
        },
        pttl(key: string) {
          ops.push(() => self.pttl(key));
          return chain;
        },
        async exec() {
          const out: Array<[null, unknown]> = [];
          for (const op of ops) out.push([null, await op()]);
          return out;
        },
      };
      return chain;
    }),
  };
  return self;
}

// A REAL CacheGateway over the fake client, not a stub of the gateway itself.
// Asserting on a stubbed `invalidate` call would only prove the command called
// a method; these tests warm a genuine entry and then assert it is gone, which
// is the property that actually matters.
function makeCache(cacheEnabled = true) {
  const redis = fakeRedis();
  const gateway = new CacheGateway({
    redis: redis as never,
    metricsPublisher: { publish: vi.fn(async () => {}) } as never,
    env: { CACHE_ENABLED: cacheEnabled } as never,
  });
  return { redis, gateway };
}

const ME_KEY = meCacheKey("sub-1", "usr_1");

describe("DeleteAccountCommand", () => {
  it("cascades to BOTH services before deleting the account", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    const order: string[] = [];
    cascade.deleteOrdersForUser.mockImplementation(async () => void order.push("orders"));
    cascade.deleteTrackingsForUser.mockImplementation(async () => void order.push("tracking"));
    db.user.delete.mockImplementation(async () => {
      order.push("users");
      return TARGET;
    });
    auth.deleteUser.mockImplementation(async () => void order.push("cognito"));

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    const result = await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(
      currentUser,
    );

    expect(result).toBe("deleted");
    // The order IS the safety property, so it is asserted directly rather than
    // inferred from the individual calls having happened.
    expect(order).toEqual(["orders", "tracking", "users", "cognito"]);
  });

  it("passes both identities to Tracking", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(currentUser);

    expect(cascade.deleteTrackingsForUser).toHaveBeenCalledWith("sub-1", "usr_1");
  });

  it("stamps the DeleteAccount audit actor", async () => {
    const { db, cascade, auth, metricsPublisher, seenActor } = makeDeps();
    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(currentUser);

    expect(seenActor.value).toBe(AuditActor.DeleteAccount);
  });

  it("returns not_found and touches nothing when the user does not exist", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps(null);
    const currentUser = new CurrentUser({ db, identity: "ghost" });
    const result = await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(
      currentUser,
    );

    expect(result).toBe("not_found");
    expect(cascade.deleteOrdersForUser).not.toHaveBeenCalled();
    expect(db.user.delete).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });

  it("does NOT delete the account when the Orders cascade fails", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    cascade.deleteOrdersForUser.mockRejectedValue(new CascadeFailedError("orders", "status 500"));

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await expect(
      new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(currentUser),
    ).rejects.toBeInstanceOf(CascadeFailedError);

    // The account survives, so the user can still authenticate and retry. This is
    // the entire reason the cascade runs before the deletion.
    expect(db.user.delete).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });

  it("does NOT delete the account when the Tracking cascade fails", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    cascade.deleteTrackingsForUser.mockRejectedValue(
      new CascadeFailedError("tracking", "status 503"),
    );

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await expect(
      new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(currentUser),
    ).rejects.toBeInstanceOf(CascadeFailedError);

    // Orders already deleted here. That is accepted and recoverable: both internal
    // routes are idempotent, so the user's retry re-runs Orders as a no-op and
    // completes Tracking.
    expect(db.user.delete).not.toHaveBeenCalled();
  });

  it("still reports success when Cognito fails after the row is stamped", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    auth.deleteUser.mockRejectedValue(new Error("cognito down"));

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    const result = await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(
      currentUser,
    );

    // Postgres has committed; failing the request would tell the user their delete
    // did not happen when it did. The orphaned pool entry is logged loudly instead.
    expect(result).toBe("deleted");
    expect(db.user.delete).toHaveBeenCalled();
  });

  // ── Observability ────────────────────────────────────────────────────────
  // The flow carries the full app_event triad per [[logging-context]]. These
  // assert the LINES, not just the span attributes: withWorkflowSpan puts
  // `delete_account_started` on the span only, so without an explicit log call
  // the started event would exist in traces and be absent from logs.

  it("logs the started/succeeded triad with email_hash and user_id", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    const currentUser = new CurrentUser({ db, identity: "sub-1" });

    const lines = await captureAppLogs(async () => {
      await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(
        currentUser,
      );
    });

    const started = lineFor(lines, "delete_account_started");
    const succeeded = lineFor(lines, "delete_account_succeeded");
    expect(started).toBeDefined();
    expect(succeeded).toBeDefined();
    expect(started!.user_id).toBe("usr_1");
    expect(started!.email_hash).toBeTypeOf("string");
    // Not an auth flow, so it gets no masked-email exemption: the address must
    // never appear in any form.
    expect(JSON.stringify(lines)).not.toContain("a@b.co");
  });

  it("logs a failed line naming WHICH cascade leg did not confirm", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    cascade.deleteTrackingsForUser.mockRejectedValue(
      new CascadeFailedError("tracking", "status 503"),
    );
    const currentUser = new CurrentUser({ db, identity: "sub-1" });

    const lines = await captureAppLogs(async () => {
      await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any)
        .execute(currentUser)
        .catch(() => undefined);
    });

    const failed = lineFor(lines, "delete_account_failed");
    expect(failed).toBeDefined();
    // The 502 the user sees is diagnosable only if the log says which side failed.
    expect(failed!.reason).toBe("cascade_failed_tracking");
    expect(failed!.severity_text).toBe("ERROR");
  });

  it("logs a failed line with reason not_found for an unknown user", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps(null);
    const currentUser = new CurrentUser({ db, identity: "ghost" });

    const lines = await captureAppLogs(async () => {
      await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(
        currentUser,
      );
    });

    expect(lineFor(lines, "delete_account_failed")?.reason).toBe("not_found");
  });

  it("refuses to cascade a user with no cognito sub, naming the real reason", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps({ ...TARGET, cognitoSub: null } as any);
    const currentUser = new CurrentUser({ db, identity: "usr_1" });

    const lines = await captureAppLogs(async () => {
      await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any)
        .execute(currentUser)
        .catch(() => undefined);
    });

    // Sending `?? ""` downstream would make Orders answer 400 and Tracking match
    // nothing, surfacing as a status code that says nothing about the cause.
    expect(cascade.deleteOrdersForUser).not.toHaveBeenCalled();
    expect(db.user.delete).not.toHaveBeenCalled();
    expect(lineFor(lines, "delete_account_failed")?.reason).toBe("missing_cognito_sub");
  });

  it("blames no downstream service when the cascade was never attempted", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps({ ...TARGET, cognitoSub: null } as any);
    const currentUser = new CurrentUser({ db, identity: "usr_1" });

    const error = await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any)
      .execute(currentUser)
      .catch((e) => e);

    // A CascadeFailedError would have to name a service, and naming one for a call
    // that never happened puts a lie in the logs and the trace.
    expect(error).toBeInstanceOf(CascadeUnavailableError);
    expect(error).not.toBeInstanceOf(CascadeFailedError);
    expect(String(error.message)).not.toContain("orders");
  });

  it("publishes the users_deleted_total counter", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(
      currentUser,
    );

    // The counterpart to users_registered_total — without it churn is invisible.
    expect(metricsPublisher.publish).toHaveBeenCalledWith("users_deleted_total", 1, {
      Service: "users",
    });
  });

  it("does not publish the counter when the cascade fails", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    cascade.deleteOrdersForUser.mockRejectedValue(new CascadeFailedError("orders", "status 500"));
    const currentUser = new CurrentUser({ db, identity: "sub-1" });

    await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any)
      .execute(currentUser)
      .catch(() => undefined);

    // A deletion that did not happen must not be counted.
    expect(metricsPublisher.publish).not.toHaveBeenCalled();
  });

  // ── Cache invalidation ───────────────────────────────────────────────────
  // GET /v1/users/me is cached for 5 minutes under users:me:v1:<sub>:<id>.
  // Without invalidation, a deleted account keeps serving its profile from
  // Redis for the rest of the TTL.

  it("drops the deleted user's cached profile", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    const { redis, gateway } = makeCache();

    // WARM IT FIRST. A test that deletes without ever populating the entry
    // passes against a no-op implementation, which is the vacuous pass this
    // milestone kept producing.
    await gateway.set(ME_KEY, ME_KEY_PREFIX, { id: "usr_1" }, 300);
    expect(redis.data.has(ME_KEY)).toBe(true);

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    const result = await new DeleteAccountCommand({
      db, cascade, auth, metricsPublisher, cacheGateway: gateway,
    } as any).execute(currentUser);

    expect(result).toBe("deleted");
    // The load-bearing assertion: the entry is GONE from the store, not merely
    // that some method was called.
    expect(redis.data.has(ME_KEY)).toBe(false);
    expect(await gateway.get(ME_KEY, ME_KEY_PREFIX)).toMatchObject({ hit: false });
  });

  it("invalidates only AFTER the row is deleted", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    const { redis, gateway } = makeCache();
    await gateway.set(ME_KEY, ME_KEY_PREFIX, { id: "usr_1" }, 300);

    const order: string[] = [];
    db.user.delete.mockImplementation(async () => {
      order.push("delete");
      return TARGET;
    });
    redis.del.mockImplementation(async (...keys: string[]) => {
      order.push("invalidate");
      let n = 0;
      for (const k of keys) if (redis.data.delete(k)) n++;
      return n;
    });

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await new DeleteAccountCommand({
      db, cascade, auth, metricsPublisher, cacheGateway: gateway,
    } as any).execute(currentUser);

    // Invalidating first leaves a window where a concurrent read re-populates
    // the entry from a row that still exists — a profile for a deleted account
    // living the full 5-minute TTL.
    expect(order).toEqual(["delete", "invalidate"]);
  });

  it("uses the read path's exact key: both cognito_sub and user_id", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    const { redis, gateway } = makeCache();

    // A near-miss key for the SAME user id under a different sub. Keying on
    // only one half would take this one out too (or miss the real one).
    const otherKey = meCacheKey("sub-other", "usr_1");
    await gateway.set(ME_KEY, ME_KEY_PREFIX, { id: "usr_1" }, 300);
    await gateway.set(otherKey, ME_KEY_PREFIX, { id: "usr_1" }, 300);

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await new DeleteAccountCommand({
      db, cascade, auth, metricsPublisher, cacheGateway: gateway,
    } as any).execute(currentUser);

    expect(redis.del).toHaveBeenCalledWith(ME_KEY);
    expect(redis.data.has(ME_KEY)).toBe(false);
    expect(redis.data.has(otherKey)).toBe(true);
  });

  it("still reports success when Redis fails during invalidation", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    const { redis, gateway } = makeCache();
    await gateway.set(ME_KEY, ME_KEY_PREFIX, { id: "usr_1" }, 300);
    redis.del.mockRejectedValue(new Error("redis down"));

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    const lines = await captureAppLogs(async () => {
      const result = await new DeleteAccountCommand({
        db, cascade, auth, metricsPublisher, cacheGateway: gateway,
      } as any).execute(currentUser);

      // FAIL-OPEN. Postgres has committed by now; throwing would tell the user
      // their account was not deleted when it was.
      expect(result).toBe("deleted");
    });

    expect(lineFor(lines, "delete_account_succeeded")).toBeDefined();
    const warn = lineFor(lines, "cache_unavailable");
    expect(warn?.severity_text).toBe("WARN");
    // Machine-readable reason, and only the key PREFIX — never the full key,
    // which carries cognito_sub and user_id.
    expect(warn?.reason).toBeTypeOf("string");
    expect(JSON.stringify(lines)).not.toContain(ME_KEY);
  });

  it("deletes the account with the cache disabled", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    const { redis, gateway } = makeCache(false);

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    const result = await new DeleteAccountCommand({
      db, cascade, auth, metricsPublisher, cacheGateway: gateway,
    } as any).execute(currentUser);

    // CACHE_ENABLED=false: the gateway no-ops, so nothing is cached and there
    // is nothing to delete — but the deletion itself must still complete.
    expect(result).toBe("deleted");
    expect(db.user.delete).toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("deletes the account when no cacheGateway is registered at all", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    const result = await new DeleteAccountCommand({
      db, cascade, auth, metricsPublisher,
    } as any).execute(currentUser);

    // The route tests build containers with no cacheGateway. An account
    // deletion that 500s for want of a cache would be worse than a stale entry.
    expect(result).toBe("deleted");
    expect(db.user.delete).toHaveBeenCalled();
  });
});
