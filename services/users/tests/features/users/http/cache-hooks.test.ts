import { describe, it, expect, vi } from "vitest";
import { createContainer, asValue, asFunction, Lifetime } from "awilix";
import { buildApp } from "#features/users/http/routes";
import { UserQueryService } from "#features/users/queries/get-me";
import { CacheGateway } from "#shared/cache/cache-gateway";
import { meCacheKey } from "#shared/cache/cache-keys";

const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z");

function fakeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "usr_1",
    email: "a@b.co",
    fullName: "A",
    address: null,
    phoneNumber: null,
    tags: [] as string[],
    authType: "PASSWORD" as const,
    mustChangePassword: false,
    createdBy: "usr_1",
    createdAt: FIXED_DATE,
    updatedBy: "usr_1",
    updatedAt: FIXED_DATE,
    deletedBy: null,
    deletedAt: null,
    isDeleted: false,
    ...overrides,
  };
}

// Real-shaped, Map-backed, per tests/shared/cache/reset-code-store.test.ts.
function fakeRedis() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  const self = {
    data,
    ttls,
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

// A user identified by their Cognito sub, resolving through the REAL
// UserQueryService over a stubbed db — a mocked getMe would skip
// CurrentUser.resolve(), which is the only place user_id becomes known and
// therefore the only place the cache key can be completed.
function cacheContainer(
  opts: {
    redis?: unknown;
    cacheEnabled?: boolean;
    row?: Record<string, unknown> | null;
    findByIdOrCognitoSub?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const redis = opts.redis ?? fakeRedis();
  const row = opts.row === undefined ? fakeUser({ cognitoSub: "sub-a" }) : opts.row;
  const findByIdOrCognitoSub = opts.findByIdOrCognitoSub ?? vi.fn(async () => row);
  const update = vi.fn(async () => row);
  const container = createContainer({ injectionMode: "PROXY" });
  container.register({
    db: asValue({ user: { findByIdOrCognitoSub, update } } as any),
    env: asValue({ E2E_TESTING_ENABLED: false, CACHE_ENABLED: opts.cacheEnabled ?? true } as any),
    metricsPublisher: asValue({ publish: vi.fn(async () => {}) } as any),
    redis: asValue(redis as any),
    cacheGateway: asFunction((cradle: any) => new CacheGateway(cradle), {
      lifetime: Lifetime.SINGLETON,
    }),
    userQueryService: asFunction((cradle: any) => new UserQueryService(cradle), {
      lifetime: Lifetime.SCOPED,
    }),
    updateProfileCommand: asValue({
      execute: vi.fn(async () => fakeUser({ fullName: "Renamed", cognitoSub: "sub-a" })),
    } as any),
    changePasswordCommand: asValue({
      execute: vi.fn(async () => fakeUser({ mustChangePassword: false, cognitoSub: "sub-a" })),
    } as any),
    // Present because routes.ts resolves them at registration time.
    registerUserCommand: asValue({ execute: vi.fn() } as any),
    registerPasswordlessCommand: asValue({ execute: vi.fn() } as any),
    loginUserCommand: asValue({ execute: vi.fn() } as any),
    startOtpChallengeCommand: asValue({ execute: vi.fn() } as any),
    verifyOtpChallengeCommand: asValue({ execute: vi.fn() } as any),
    refreshTokenCommand: asValue({ execute: vi.fn() } as any),
    forgotPasswordCommand: asValue({ execute: vi.fn(async () => undefined) } as any),
    confirmPasswordResetCommand: asValue({ execute: vi.fn(async () => undefined) } as any),
    captureCognitoIdentityCommand: asValue({ execute: vi.fn() } as any),
  });
  return { container, redis: redis as ReturnType<typeof fakeRedis>, findByIdOrCognitoSub };
}

const AS_A = { "x-user-id": "sub-a" };

describe("GET /v1/users/me response cache", () => {
  // (1) MISS then HIT, with X-Cache-TTL on the HIT only.
  it("answers MISS then HIT, and carries X-Cache-TTL on the HIT alone", async () => {
    const { container } = cacheContainer();
    const app = buildApp(container);

    const first = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(first.headers["x-cache-ttl"]).toBeUndefined();

    const second = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-cache"]).toBe("HIT");
    // 5-minute TTL, in whole seconds remaining.
    expect(Number(second.headers["x-cache-ttl"])).toBeGreaterThan(0);
    expect(Number(second.headers["x-cache-ttl"])).toBeLessThanOrEqual(300);

    await app.close();
  });

  // (2) The HIT body is BYTE-IDENTICAL to the MISS body. This is the test that
  // catches a cached ENTITY (Date objects) instead of a cached SERIALIZED body
  // (ISO strings) — a bug that makes a HIT and a MISS return different JSON for
  // the same user, which no status-code assertion would ever notice.
  it("returns a byte-identical body on the HIT", async () => {
    const { container } = cacheContainer();
    const app = buildApp(container);

    const miss = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });
    const hit = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });

    expect(hit.body).toBe(miss.body);
    expect(hit.json()).toEqual({
      ...fakeUser(),
      createdAt: FIXED_DATE.toISOString(),
      updatedAt: FIXED_DATE.toISOString(),
      deletedAt: null,
    });

    await app.close();
  });

  // (3) PATCH /v1/users/me invalidates.
  it("goes back to MISS after PATCH /v1/users/me", async () => {
    const { container } = cacheContainer();
    const app = buildApp(container);

    await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });
    expect(
      (await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A })).headers["x-cache"],
    ).toBe("HIT");

    const patched = await app.inject({
      method: "PATCH",
      url: "/v1/users/me",
      headers: AS_A,
      payload: { fullName: "Renamed" },
    });
    expect(patched.statusCode).toBe(200);
    // The write itself is never cached and carries no X-Cache header.
    expect(patched.headers["x-cache"]).toBeUndefined();

    expect(
      (await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A })).headers["x-cache"],
    ).toBe("MISS");

    await app.close();
  });

  // (4) A password change invalidates, because `mustChangePassword` is a field
  // of UserSchema and therefore part of the cached body. Easy to miss: nothing
  // about "change password" reads as "profile write".
  it("goes back to MISS after PATCH /v1/users/me/password", async () => {
    const { container } = cacheContainer({
      row: fakeUser({ cognitoSub: "sub-a", mustChangePassword: true }),
    });
    const app = buildApp(container);

    await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });
    expect(
      (await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A })).headers["x-cache"],
    ).toBe("HIT");

    const changed = await app.inject({
      method: "PATCH",
      url: "/v1/users/me/password",
      headers: AS_A,
      payload: { newPassword: "Sup3rSecret!" },
    });
    expect(changed.statusCode).toBe(200);

    expect(
      (await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A })).headers["x-cache"],
    ).toBe("MISS");

    await app.close();
  });

  // (5) CROSS-USER ISOLATION. Non-negotiable: the single worst failure this
  // cache could produce is one user reading another's profile.
  it("never serves user A's cached profile to user B", async () => {
    const rowA = fakeUser({ id: "usr_a", email: "a@b.co", cognitoSub: "sub-a" });
    const rowB = fakeUser({ id: "usr_b", email: "b@b.co", cognitoSub: "sub-b" });
    const redis = fakeRedis();
    const findByIdOrCognitoSub = vi.fn(async (identity: string) =>
      identity === "sub-a" ? rowA : rowB,
    );
    const { container } = cacheContainer({ redis, findByIdOrCognitoSub });
    const app = buildApp(container);

    const a1 = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: { "x-user-id": "sub-a" },
    });
    expect(a1.headers["x-cache"]).toBe("MISS");
    expect(a1.json().id).toBe("usr_a");

    // B's FIRST request must be a MISS — a HIT here would mean B matched A's
    // entry, which is the bug.
    const b1 = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: { "x-user-id": "sub-b" },
    });
    expect(b1.headers["x-cache"]).toBe("MISS");
    expect(b1.json().id).toBe("usr_b");
    expect(b1.json().email).toBe("b@b.co");

    // And each keeps its own entry afterwards.
    const a2 = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: { "x-user-id": "sub-a" },
    });
    expect(a2.headers["x-cache"]).toBe("HIT");
    expect(a2.json().id).toBe("usr_a");
    const b2 = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: { "x-user-id": "sub-b" },
    });
    expect(b2.headers["x-cache"]).toBe("HIT");
    expect(b2.json().id).toBe("usr_b");

    // Two distinct keys in the store, and neither is the other's.
    expect(redis.data.has(meCacheKey("sub-a", "usr_a"))).toBe(true);
    expect(redis.data.has(meCacheKey("sub-b", "usr_b"))).toBe(true);

    await app.close();
  });

  // (6) FAIL OPEN.
  it("answers BYPASS with a correct body when Redis throws", async () => {
    const broken = {
      ...fakeRedis(),
      pipeline: vi.fn(() => {
        const chain = {
          get: () => chain,
          pttl: () => chain,
          exec: async () => {
            throw new Error("ECONNREFUSED");
          },
        };
        return chain;
      }),
      set: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    };
    const { container } = cacheContainer({ redis: broken });
    const app = buildApp(container);

    const res = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("BYPASS");
    expect(res.headers["x-cache-ttl"]).toBeUndefined();
    expect(res.json().id).toBe("usr_1");

    await app.close();
  });

  // (7) A 404 is never cached: only 200s populate the store.
  it("does not cache a 404, so a later-created user is not shadowed", async () => {
    const { container, redis } = cacheContainer({ row: null });
    const app = buildApp(container);

    const res = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
    // Nothing was written — and note there is no key to write it under anyway:
    // an unresolved caller has no user_id.
    expect(redis.set).not.toHaveBeenCalled();

    await app.close();
  });

  // (8) The kill switch. Not "X-Cache: BYPASS" — NO header at all.
  it("emits no X-Cache header whatsoever when CACHE_ENABLED is false", async () => {
    const { container, redis } = cacheContainer({ cacheEnabled: false });
    const app = buildApp(container);

    const first = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });
    const second = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });

    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBeUndefined();
    expect(second.headers["x-cache"]).toBeUndefined();
    expect(second.json().id).toBe("usr_1");
    expect(redis.pipeline).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();

    await app.close();
  });

  it("stamps cache_result on the request's log line", async () => {
    const lines: string[] = [];
    const { container } = cacheContainer();
    const app = buildApp(container, { logStream: { write: (s: string) => lines.push(s) } });

    await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });
    await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });

    const requestLogs = lines
      .map((l) => JSON.parse(l))
      .filter((e) => e.http_route === "/v1/users/me");
    expect(requestLogs.map((e) => e.cache_result)).toEqual(["miss", "hit"]);

    await app.close();
  });

  it("omits cache_result on a non-cacheable route", async () => {
    const lines: string[] = [];
    const { container } = cacheContainer();
    const app = buildApp(container, { logStream: { write: (s: string) => lines.push(s) } });

    await app.inject({
      method: "PATCH",
      url: "/v1/users/me",
      headers: AS_A,
      payload: { fullName: "Renamed" },
    });

    const patchLog = lines
      .map((l) => JSON.parse(l))
      .find((e) => e.http_route === "/v1/users/me" && e.http_request_method === "PATCH");
    expect(patchLog).toBeDefined();
    // OMITTED, not null — an absent key reads as "this route is not cached".
    expect("cache_result" in patchLog!).toBe(false);

    await app.close();
  });
});
