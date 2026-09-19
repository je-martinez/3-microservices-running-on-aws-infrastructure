import "reflect-metadata";

Object.assign(process.env, {
  DATABASE_WRITER_URL: "http://127.0.0.1/db",
  DATABASE_READER_URL: "http://127.0.0.1/db",
  COGNITO_USER_POOL_ID: "pool",
  COGNITO_CLIENT_ID: "client",
  AWS_ENDPOINT_URL: "http://127.0.0.1:4566",
  AWS_REGION: "us-east-1",
  WEBHOOK_SECRET: "test-webhook-secret",
  INTERNAL_API_KEY: "test-api-key",
  ORDERS_BASE_URL: "http://127.0.0.1:3001",
  TRACKING_BASE_URL: "http://127.0.0.1:3002",
  EVENTS_TOPIC_ARN: "arn:aws:sns:us-east-1:000000000000:events",
  NOTIFICATIONS_QUEUE_URL: "http://127.0.0.1:4566/queue",
  WS_MANAGEMENT_ENDPOINT: "http://127.0.0.1:4566/execute-api/api/$default",
  WS_CONNECTIONS_TABLE: "ws-connections",
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT: "6379",
  E2E_TESTING_ENABLED: "false",
  CACHE_ENABLED: "true",
});

const { afterAll, beforeEach, describe, expect, it, vi } = await import("vitest");
const { Module } = await import("@nestjs/common");
type MiddlewareConsumer = import("@nestjs/common").MiddlewareConsumer;
type NestModule = import("@nestjs/common").NestModule;
const { APP_FILTER, APP_GUARD } = await import("@nestjs/core");
const { CommandBus, CqrsModule, QueryBus } = await import("@nestjs/cqrs");
const { Test } = await import("@nestjs/testing");
const { FastifyAdapter } = await import("@nestjs/platform-fastify");
type NestFastifyApplication = import("@nestjs/platform-fastify").NestFastifyApplication;

const { AppConfigService } = await import("#config/config.module");
const { AuthGuard } = await import("#shared/auth/auth.guard");
const { CacheGateway } = await import("#shared/cache/cache-gateway");
const { meCacheKey } = await import("#shared/cache/cache-keys");
const { MeCacheInterceptor } = await import("#shared/cache/me-cache.interceptor");
const { DomainExceptionFilter } = await import("#shared/http/domain-exception.filter");
const { RequestContextMiddleware } = await import("#shared/http/request-context.middleware");
const { DB } = await import("#shared/tokens");
const { CaptureCognitoIdentityCommand } = await import(
  "#features/users/webhooks/capture-cognito-identity"
);
const { UsersController } = await import("../../src/users/http/users.controller.ts");
const { CognitoWebhookController } = await import(
  "../../src/users/webhooks/cognito.controller.ts"
);
const { CurrentUserInterceptor } = await import(
  "../../src/users/http/current-user.interceptor.ts"
);

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
    cognitoSub: "sub-a",
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

const AS_A = { "x-user-id": "sub-a" };

describe("GET /v1/users/me response cache", () => {
  let app: NestFastifyApplication;
  let redis: ReturnType<typeof fakeRedis>;
  let findByIdOrCognitoSub: ReturnType<typeof vi.fn>;
  const commandBus = { execute: vi.fn(), register: vi.fn() };
  const queryBus = { execute: vi.fn(), register: vi.fn() };

  async function boot(opts: {
    redis?: ReturnType<typeof fakeRedis>;
    cacheEnabled?: boolean;
    findByIdOrCognitoSub?: ReturnType<typeof vi.fn>;
  } = {}) {
    redis = opts.redis ?? fakeRedis();
    findByIdOrCognitoSub =
      opts.findByIdOrCognitoSub ?? vi.fn(async () => fakeUser({ cognitoSub: "sub-a" }));
    const cacheEnabled = opts.cacheEnabled ?? true;

    @Module({
      imports: [CqrsModule],
      controllers: [UsersController, CognitoWebhookController],
      providers: [
        CurrentUserInterceptor,
        MeCacheInterceptor,
        RequestContextMiddleware,
        {
          provide: AppConfigService,
          useValue: {
            get: (key: string) => {
              if (key === "E2E_TESTING_ENABLED") return false;
              if (key === "WEBHOOK_SECRET") return "test-webhook-secret";
              if (key === "CACHE_ENABLED") return cacheEnabled;
              return undefined;
            },
          },
        },
        {
          provide: DB,
          useValue: { user: { findByIdOrCognitoSub } },
        },
        {
          provide: CacheGateway,
          useFactory: () =>
            new CacheGateway({
              redis: redis as never,
              metricsPublisher: { publish: vi.fn(async () => {}) } as never,
              env: { CACHE_ENABLED: cacheEnabled } as never,
            }),
        },
        { provide: CaptureCognitoIdentityCommand, useValue: { execute: vi.fn() } },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
      ],
    })
    class CacheTestModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void {
        consumer.apply(RequestContextMiddleware).forRoutes("*");
      }
    }

    const moduleRef = await Test.createTestingModule({ imports: [CacheTestModule] })
      .overrideProvider(CommandBus)
      .useValue(commandBus)
      .overrideProvider(QueryBus)
      .useValue(queryBus)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }

  beforeEach(() => {
    commandBus.execute.mockReset();
    queryBus.execute.mockReset();
    queryBus.execute.mockImplementation(async () => fakeUser({ cognitoSub: "sub-a" }));
    commandBus.execute.mockImplementation(async () =>
      fakeUser({ fullName: "Renamed", cognitoSub: "sub-a" }),
    );
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("answers MISS then HIT, and carries X-Cache-TTL on the HIT alone", async () => {
    await boot();

    const first = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(first.headers["x-cache-ttl"]).toBeUndefined();

    const second = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(Number(second.headers["x-cache-ttl"])).toBeGreaterThan(0);
    expect(Number(second.headers["x-cache-ttl"])).toBeLessThanOrEqual(300);

    await app.close();
  });

  it("returns a byte-identical body on the HIT", async () => {
    await boot();

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

  it("goes back to MISS after PATCH /v1/users/me", async () => {
    await boot();

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
    expect(patched.headers["x-cache"]).toBeUndefined();

    expect(
      (await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A })).headers["x-cache"],
    ).toBe("MISS");

    await app.close();
  });

  it("goes back to MISS after PATCH /v1/users/me/password", async () => {
    findByIdOrCognitoSub = vi.fn(async () =>
      fakeUser({ cognitoSub: "sub-a", mustChangePassword: true }),
    );
    await boot({ findByIdOrCognitoSub });
    queryBus.execute.mockImplementation(async () =>
      fakeUser({ cognitoSub: "sub-a", mustChangePassword: true }),
    );
    commandBus.execute.mockImplementation(async () =>
      fakeUser({ mustChangePassword: false, cognitoSub: "sub-a" }),
    );

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

  it("never serves user A's cached profile to user B", async () => {
    const rowA = fakeUser({ id: "usr_a", email: "a@b.co", cognitoSub: "sub-a" });
    const rowB = fakeUser({ id: "usr_b", email: "b@b.co", cognitoSub: "sub-b" });
    const sharedRedis = fakeRedis();
    const lookup = vi.fn(async (identity: string) => (identity === "sub-a" ? rowA : rowB));
    await boot({ redis: sharedRedis, findByIdOrCognitoSub: lookup });
    queryBus.execute.mockImplementation(async (q: { currentUser: { identity: string } }) =>
      q.currentUser.identity === "sub-a" ? rowA : rowB,
    );

    const a1 = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: { "x-user-id": "sub-a" },
    });
    expect(a1.headers["x-cache"]).toBe("MISS");
    expect(a1.json().id).toBe("usr_a");

    const b1 = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: { "x-user-id": "sub-b" },
    });
    expect(b1.headers["x-cache"]).toBe("MISS");
    expect(b1.json().id).toBe("usr_b");
    expect(b1.json().email).toBe("b@b.co");

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

    expect(sharedRedis.data.has(meCacheKey("sub-a", "usr_a"))).toBe(true);
    expect(sharedRedis.data.has(meCacheKey("sub-b", "usr_b"))).toBe(true);

    await app.close();
  });

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
    await boot({ redis: broken as never });

    const res = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-cache"]).toBe("BYPASS");
    expect(res.headers["x-cache-ttl"]).toBeUndefined();
    expect(res.json().id).toBe("usr_1");

    await app.close();
  });

  it("does not cache a 404, so a later-created user is not shadowed", async () => {
    await boot({ findByIdOrCognitoSub: vi.fn(async () => null) });
    queryBus.execute.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
    expect(redis.set).not.toHaveBeenCalled();

    await app.close();
  });

  it("emits no X-Cache header whatsoever when CACHE_ENABLED is false", async () => {
    await boot({ cacheEnabled: false });

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
});
