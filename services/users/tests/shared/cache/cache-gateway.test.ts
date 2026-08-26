import { describe, it, expect, vi, beforeEach } from "vitest";
import { CacheGateway } from "#shared/cache/cache-gateway";
import { ME_KEY_PREFIX } from "#shared/cache/cache-keys";

// A minimal in-memory stand-in for the ioredis commands the gateway uses.
// Deliberately NOT a blanket mock: the tests below assert the exact `EX`-form
// arguments to `set` and the PTTL semantics, which is precisely what a mocked
// client lets silently regress — see [[mocks-hide-schema-bugs]] and the same
// stance in tests/shared/cache/reset-code-store.test.ts.
//
// `pipeline()` is real-shaped too, because `get()` reads the value and its
// remaining TTL in ONE round trip. A fake without it would make every get()
// throw and report BYPASS, which reads exactly like a working fail-open.
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
    // ioredis returns -2 for "no such key" and -1 for "no expiry".
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

function makeGateway(overrides: { redis?: unknown; cacheEnabled?: boolean } = {}) {
  const publish = vi.fn(async () => {});
  const redis = overrides.redis ?? fakeRedis();
  const gateway = new CacheGateway({
    redis: redis as never,
    metricsPublisher: { publish } as never,
    env: { CACHE_ENABLED: overrides.cacheEnabled ?? true } as never,
  });
  return { gateway, redis: redis as ReturnType<typeof fakeRedis>, publish };
}

let clock: {
  gateway: CacheGateway;
  redis: ReturnType<typeof fakeRedis>;
  publish: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  clock = makeGateway();
});

describe("CacheGateway.get", () => {
  it("reports a miss for an absent key", async () => {
    const res = await clock.gateway.get("users:me:v1:s:u", ME_KEY_PREFIX);

    expect(res).toEqual({ hit: false, value: undefined, ttlRemaining: undefined, bypass: false });
  });

  it("round-trips a value and reports the remaining TTL in whole seconds", async () => {
    await clock.gateway.set("users:me:v1:s:u", ME_KEY_PREFIX, { id: "usr_1" }, 300);
    const res = await clock.gateway.get<{ id: string }>("users:me:v1:s:u", ME_KEY_PREFIX);

    expect(res.hit).toBe(true);
    expect(res.value).toEqual({ id: "usr_1" });
    expect(res.ttlRemaining).toBe(300);
    expect(res.bypass).toBe(false);
  });

  it("sets the value and its expiry in ONE command (the EX form)", async () => {
    await clock.gateway.set("users:me:v1:s:u", ME_KEY_PREFIX, { id: "usr_1" }, 300);

    expect(clock.redis.set).toHaveBeenCalledWith(
      "users:me:v1:s:u",
      JSON.stringify({ id: "usr_1" }),
      "EX",
      300,
    );
  });

  // FAIL OPEN. The governing rule of this design: the cache may never break or
  // degrade a read.
  it("reports BYPASS, never throws, when Redis errors", async () => {
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
    };
    const { gateway } = makeGateway({ redis: broken });

    const res = await gateway.get("users:me:v1:s:u", ME_KEY_PREFIX);

    expect(res).toEqual({ hit: false, value: undefined, ttlRemaining: undefined, bypass: true });
  });

  it("reports BYPASS when Redis exceeds the 50ms budget", async () => {
    const slow = {
      ...fakeRedis(),
      pipeline: vi.fn(() => {
        const chain = {
          get: () => chain,
          pttl: () => chain,
          exec: () =>
            new Promise<Array<[null, unknown]>>((resolve) =>
              setTimeout(() => resolve([[null, null], [null, -2]]), 500),
            ),
        };
        return chain;
      }),
    };
    const { gateway } = makeGateway({ redis: slow });

    const started = Date.now();
    const res = await gateway.get("users:me:v1:s:u", ME_KEY_PREFIX);

    expect(res.bypass).toBe(true);
    // The point of the timeout is that the caller is NOT made to wait 500ms.
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("swallows a set() failure entirely — a cache-write error never surfaces", async () => {
    const broken = {
      ...fakeRedis(),
      set: vi.fn(async () => {
        throw new Error("OOM");
      }),
    };
    const { gateway } = makeGateway({ redis: broken });

    await expect(
      gateway.set("users:me:v1:s:u", ME_KEY_PREFIX, { id: "usr_1" }, 300),
    ).resolves.toBeUndefined();
  });

  it("swallows an invalidate() failure — the write it follows already persisted", async () => {
    const broken = {
      ...fakeRedis(),
      del: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    };
    const { gateway } = makeGateway({ redis: broken });

    await expect(gateway.invalidate(ME_KEY_PREFIX, "users:me:v1:s:u")).resolves.toBeUndefined();
  });

  // A corrupt entry is indistinguishable, for the caller, from Redis being down:
  // both mean "answer from Postgres".
  it("reports BYPASS on an unparseable cached body", async () => {
    const redis = fakeRedis();
    redis.data.set("users:me:v1:s:u", "{not json");
    redis.ttls.set("users:me:v1:s:u", 300_000);
    const { gateway } = makeGateway({ redis });

    const res = await gateway.get("users:me:v1:s:u", ME_KEY_PREFIX);

    expect(res.bypass).toBe(true);
    expect(res.value).toBeUndefined();
  });
});

describe("CacheGateway metrics", () => {
  it("publishes cache_requests_total with the PREFIX only, never the full key", async () => {
    await clock.gateway.get("users:me:v1:sub-secret:usr_secret", ME_KEY_PREFIX);

    expect(clock.publish).toHaveBeenCalledWith("cache_requests_total", 1, {
      Service: "users",
      KeyPrefix: "users:me:v1",
      Result: "miss",
    });
    // The load-bearing assertion: a CloudWatch dimension value carrying a
    // cognito_sub would both explode cardinality and export PII.
    const dimensionValues = clock.publish.mock.calls.flatMap((c) => Object.values(c[2] as object));
    expect(dimensionValues.some((v) => String(v).includes("sub-secret"))).toBe(false);
    expect(dimensionValues.some((v) => String(v).includes("usr_secret"))).toBe(false);
  });

  it("publishes cache_operation_duration_ms in Milliseconds per operation", async () => {
    await clock.gateway.get("users:me:v1:s:u", ME_KEY_PREFIX);

    const call = clock.publish.mock.calls.find((c) => c[0] === "cache_operation_duration_ms");
    expect(call).toBeDefined();
    expect(call![2]).toEqual({ Service: "users", Operation: "get" });
    expect(call![3]).toBe("Milliseconds");
  });

  it("labels a Redis failure Result=bypass, not miss", async () => {
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
    };
    const { gateway, publish } = makeGateway({ redis: broken });

    await gateway.get("users:me:v1:s:u", ME_KEY_PREFIX);

    expect(publish).toHaveBeenCalledWith("cache_requests_total", 1, {
      Service: "users",
      KeyPrefix: "users:me:v1",
      Result: "bypass",
    });
  });
});

describe("CacheGateway kill switch", () => {
  it("touches Redis for nothing when CACHE_ENABLED is false", async () => {
    const { gateway, redis } = makeGateway({ cacheEnabled: false });

    expect(gateway.enabled).toBe(false);
    await gateway.get("users:me:v1:s:u", ME_KEY_PREFIX);
    await gateway.set("users:me:v1:s:u", ME_KEY_PREFIX, { id: "usr_1" }, 300);
    await gateway.invalidate(ME_KEY_PREFIX, "users:me:v1:s:u");

    expect(redis.pipeline).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });
});
