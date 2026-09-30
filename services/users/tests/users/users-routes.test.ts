import "reflect-metadata";

// CONTRACT: Seed env BEFORE any import of #config/config.module or controllers
// that pull AppConfigService. ConfigModule.forRoot parses env at import time.
// See [[env-files]]
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
  E2E_TESTING_ENABLED: "true",
});

const { afterAll, beforeAll, beforeEach, describe, expect, it, vi } = await import("vitest");
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
const { DomainExceptionFilter } = await import("#shared/http/domain-exception.filter");
const { RequestContextMiddleware } = await import("#shared/http/request-context.middleware");
const { DB } = await import("#shared/tokens");
const { CaptureCognitoIdentityCommand } = await import(
  "#features/users/webhooks/capture-cognito-identity"
);
const { E2eCleanupCommand } = await import("#features/users/http/e2e-cleanup");
const { E2eIdentityQuery } = await import("#features/users/http/e2e-identity");
const { UsersController } = await import("../../src/users/http/users.controller.ts");
const { E2eController } = await import("../../src/users/http/e2e.controller.ts");
const { CognitoWebhookController } = await import(
  "../../src/users/webhooks/cognito.controller.ts"
);
const { CurrentUserInterceptor } = await import(
  "../../src/users/http/current-user.interceptor.ts"
);
const { CacheGateway } = await import("#shared/cache/cache-gateway");
const { MeCacheInterceptor } = await import("#shared/cache/me-cache.interceptor");

describe("users HTTP routes", () => {
  let app: NestFastifyApplication;
  // CqrsModule.onApplicationBootstrap calls `register` on both buses.
  const commandBus = { execute: vi.fn(), register: vi.fn() };
  const queryBus = { execute: vi.fn(), register: vi.fn() };

  beforeAll(async () => {
    @Module({
      imports: [CqrsModule],
      controllers: [UsersController, CognitoWebhookController, E2eController],
      providers: [
        CurrentUserInterceptor,
        MeCacheInterceptor,
        RequestContextMiddleware,
        {
          provide: AppConfigService,
          useValue: {
            get: (key: string) => {
              if (key === "E2E_TESTING_ENABLED") return true;
              if (key === "WEBHOOK_SECRET") return "test-webhook-secret";
              return undefined;
            },
          },
        },
        {
          provide: DB,
          useValue: { user: { findByIdOrCognitoSub: vi.fn(async () => null) } },
        },
        {
          provide: CacheGateway,
          useValue: {
            enabled: false,
            get: vi.fn(),
            set: vi.fn(),
            invalidate: vi.fn(async () => undefined),
          },
        },
        { provide: CaptureCognitoIdentityCommand, useValue: { execute: vi.fn() } },
        { provide: E2eCleanupCommand, useValue: { execute: vi.fn() } },
        { provide: E2eIdentityQuery, useValue: { execute: vi.fn() } },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
      ],
    })
    class RoutesTestModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void {
        consumer.apply(RequestContextMiddleware).forRoutes("*");
      }
    }

    const moduleRef = await Test.createTestingModule({ imports: [RoutesTestModule] })
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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    commandBus.execute.mockReset();
    queryBus.execute.mockReset();
  });

  const authed = { "x-user-id": "cognito-sub-1" };

  it("POST /v1/users/login dispatches a LoginCommand and returns the tokens", async () => {
    commandBus.execute.mockResolvedValueOnce({
      accessToken: "a",
      refreshToken: "r",
      idToken: "i",
      expiresIn: 3600,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/users/login",
      payload: { email: "ada@example.com", password: "Sup3rS3cret!" },
    });

    expect(response.statusCode).toBe(200);
    expect(commandBus.execute).toHaveBeenCalledOnce();
    expect(response.json()).toMatchObject({ accessToken: "a", refreshToken: "r" });
  });

  it("GET /v1/users/me returns 404 not_found when the query resolves to null", async () => {
    // CONTRACT: The handler returns null for a routine miss; the controller —
    // not the handler — is what turns it into the 404 the E2E specs assert.
    queryBus.execute.mockResolvedValueOnce(null);

    const response = await app.inject({ method: "GET", url: "/v1/users/me", headers: authed });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });

  it("GET /v1/users/me serializes Date fields as ISO strings", async () => {
    queryBus.execute.mockResolvedValueOnce({
      id: "usr_1",
      email: "ada@example.com",
      fullName: "Ada",
      cognitoSub: "cognito-sub-1",
      address: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      deletedAt: null,
    });

    const response = await app.inject({ method: "GET", url: "/v1/users/me", headers: authed });

    expect(response.statusCode).toBe(200);
    expect(response.json().createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("GET /v1/users/me never exposes stripeCustomerId (spec D6)", async () => {
    queryBus.execute.mockResolvedValueOnce({
      id: "usr_1",
      email: "ada@example.com",
      fullName: "Ada",
      cognitoSub: "cognito-sub-1",
      address: null,
      stripeCustomerId: "cus_123",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      deletedAt: null,
    });

    const response = await app.inject({ method: "GET", url: "/v1/users/me", headers: authed });

    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty("stripeCustomerId");
  });

  it("rejects an invalid login body with 400 before dispatching anything", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/users/login",
      payload: { email: "not-an-email", password: "x" },
    });

    expect(response.statusCode).toBe(400);
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it("answers 401 unauthenticated on /v1/users/me with no x-user-id", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/users/me" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthenticated" });
  });

  it("PATCH /v1/users/me dispatches UpdateProfileCommand", async () => {
    commandBus.execute.mockResolvedValueOnce({
      id: "usr_1",
      email: "ada@example.com",
      fullName: "Ada Lovelace",
      cognitoSub: "cognito-sub-1",
      address: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      deletedAt: null,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/users/me",
      headers: authed,
      payload: { fullName: "Ada Lovelace" },
    });

    expect(response.statusCode).toBe(200);
    expect(commandBus.execute).toHaveBeenCalledOnce();
    expect(response.json().fullName).toBe("Ada Lovelace");
  });

  it("DELETE /v1/users/me returns 204 when the command reports deleted", async () => {
    commandBus.execute.mockResolvedValueOnce("deleted");

    const response = await app.inject({
      method: "DELETE",
      url: "/v1/users/me",
      headers: authed,
    });

    expect(response.statusCode).toBe(204);
  });

  it("POST /v1/users/password/forgot returns 202 accepted", async () => {
    commandBus.execute.mockResolvedValueOnce(undefined);

    const response = await app.inject({
      method: "POST",
      url: "/v1/users/password/forgot",
      payload: { email: "ada@example.com" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });
  });
});
