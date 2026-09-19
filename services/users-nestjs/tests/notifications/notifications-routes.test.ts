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

const { AuthGuard } = await import("#shared/auth/auth.guard");
const { DomainExceptionFilter } = await import("#shared/http/domain-exception.filter");
const { RequestContextMiddleware } = await import("#shared/http/request-context.middleware");
const { AppConfigService } = await import("#config/config.module");
const { DB } = await import("#shared/tokens");
const { NotificationsController } = await import(
  "../../src/notifications/http/notifications.controller.ts"
);
const { CurrentUserInterceptor } = await import(
  "../../src/users/http/current-user.interceptor.ts"
);
const { ListNotificationsQuery } = await import(
  "../../src/notifications/queries/list-notifications.query.ts"
);
const { MarkNotificationsReadCommand } = await import(
  "../../src/notifications/commands/mark-notifications-read.command.ts"
);

function page(overrides?: Record<string, unknown>) {
  return {
    items: [
      {
        id: "ntf_1",
        userId: "usr_alice",
        type: "ORDER_STATUS",
        title: "Your order has shipped",
        body: "ORD-3MRAI-10482 · Handed to the carrier and on its way to you.",
        metadata: { status: "SHIPPED", order_id: "ord_1", occurred_at: "2026-08-01T17:48:03" },
        readAt: null,
        createdAt: new Date("2026-08-01T17:48:03Z"),
      },
    ],
    unread_count: 3,
    window_total: 7,
    window_days: 90,
    ...overrides,
  };
}

describe("notifications HTTP routes", () => {
  let app: NestFastifyApplication;
  // CqrsModule.onApplicationBootstrap calls `register` on both buses.
  const commandBus = { execute: vi.fn(), register: vi.fn() };
  const queryBus = { execute: vi.fn(), register: vi.fn() };

  beforeAll(async () => {
    @Module({
      imports: [CqrsModule],
      controllers: [NotificationsController],
      providers: [
        CurrentUserInterceptor,
        RequestContextMiddleware,
        {
          provide: AppConfigService,
          useValue: { get: () => undefined },
        },
        {
          provide: DB,
          useValue: { user: { findByIdOrCognitoSub: vi.fn(async () => null) } },
        },
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

  describe("GET /v1/notifications", () => {
    it("returns the page for an authenticated caller", async () => {
      queryBus.execute.mockResolvedValueOnce(page());

      const response = await app.inject({
        method: "GET",
        url: "/v1/notifications",
        headers: authed,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ unread_count: 3, window_total: 7, window_days: 90 });
      expect(body.items[0]).toMatchObject({
        id: "ntf_1",
        type: "ORDER_STATUS",
        title: "Your order has shipped",
        read_at: null,
      });
      expect(typeof body.items[0].created_at).toBe("string");
      expect(body.items[0].metadata).toEqual({
        status: "SHIPPED",
        order_id: "ord_1",
        occurred_at: "2026-08-01T17:48:03",
      });
      expect(body.items[0].userId).toBeUndefined();
      expect(queryBus.execute).toHaveBeenCalledOnce();
      expect(queryBus.execute.mock.calls[0]![0]).toBeInstanceOf(ListNotificationsQuery);
    });

    it("defaults the filter to all", async () => {
      queryBus.execute.mockResolvedValueOnce(page());

      await app.inject({ method: "GET", url: "/v1/notifications", headers: authed });

      const query = queryBus.execute.mock.calls[0]![0] as ListNotificationsQuery;
      expect(query.filter).toBe("all");
    });

    it.each(["all", "unread", "read"] as const)("accepts filter=%s", async (filter) => {
      queryBus.execute.mockResolvedValueOnce(page());

      const response = await app.inject({
        method: "GET",
        url: `/v1/notifications?filter=${filter}`,
        headers: authed,
      });

      expect(response.statusCode).toBe(200);
      const query = queryBus.execute.mock.calls[0]![0] as ListNotificationsQuery;
      expect(query.filter).toBe(filter);
    });

    it("rejects an unknown filter with 400", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/notifications?filter=archived",
        headers: authed,
      });

      expect(response.statusCode).toBe(400);
      expect(queryBus.execute).not.toHaveBeenCalled();
    });

    // CONTRACT: absent @Public(), which is what makes this 401.
    it("401s without an identity", async () => {
      const response = await app.inject({ method: "GET", url: "/v1/notifications" });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthenticated" });
    });

    it("serializes a read notification's read_at as an ISO string", async () => {
      queryBus.execute.mockResolvedValueOnce(
        page({
          items: [
            {
              id: "ntf_2",
              userId: "usr_alice",
              type: "WELCOME",
              title: "Welcome to 3MRAI",
              body: "Your account is ready.",
              metadata: { occurred_at: "2026-08-01T17:48:03" },
              readAt: new Date("2026-08-02T10:00:00Z"),
              createdAt: new Date("2026-08-01T17:48:03Z"),
            },
          ],
        }),
      );

      const response = await app.inject({
        method: "GET",
        url: "/v1/notifications",
        headers: authed,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().items[0].read_at).toBe("2026-08-02T10:00:00.000Z");
    });
  });

  describe("GET /v1/notifications/unread-count", () => {
    it("returns just the count", async () => {
      queryBus.execute.mockResolvedValueOnce(page({ unread_count: 12 }));

      const response = await app.inject({
        method: "GET",
        url: "/v1/notifications/unread-count",
        headers: authed,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ unread_count: 12 });
      expect(queryBus.execute.mock.calls[0]![0]).toBeInstanceOf(ListNotificationsQuery);
    });

    it("401s without an identity", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/notifications/unread-count",
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("PATCH /v1/notifications/read", () => {
    it("marks a list of ids read", async () => {
      commandBus.execute.mockResolvedValueOnce({ updated: 2, unread_count: 1 });

      const response = await app.inject({
        method: "PATCH",
        url: "/v1/notifications/read",
        headers: authed,
        payload: { ids: ["ntf_1", "ntf_2"] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ updated: 2, unread_count: 1 });
      const command = commandBus.execute.mock.calls[0]![0] as MarkNotificationsReadCommand;
      expect(command).toBeInstanceOf(MarkNotificationsReadCommand);
      expect(command.input.ids).toEqual(["ntf_1", "ntf_2"]);
    });

    // CONTRACT: 200 with updated: 0, NOT 400 — arriving with nothing unread is the
    // normal case for mark-on-enter.
    it("answers 200 for an empty id list", async () => {
      commandBus.execute.mockResolvedValueOnce({ updated: 0, unread_count: 1 });

      const response = await app.inject({
        method: "PATCH",
        url: "/v1/notifications/read",
        headers: authed,
        payload: { ids: [] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ updated: 0 });
    });

    // CONTRACT: A single-id PATCH affecting 0 rows returns 404, indistinguishable
    // from "does not exist" — deliberately, so it leaks nothing about another
    // user's notifications.
    it("404s when a single id matched nothing", async () => {
      commandBus.execute.mockResolvedValueOnce({ updated: 0, unread_count: 1 });

      const response = await app.inject({
        method: "PATCH",
        url: "/v1/notifications/read",
        headers: authed,
        payload: { ids: ["ntf_someone_elses"] },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "not_found" });
    });

    it("200s when a single id matched", async () => {
      commandBus.execute.mockResolvedValueOnce({ updated: 1, unread_count: 1 });

      const response = await app.inject({
        method: "PATCH",
        url: "/v1/notifications/read",
        headers: authed,
        payload: { ids: ["ntf_1"] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ updated: 1, unread_count: 1 });
    });

    it("does NOT 404 when a multi-id PATCH matched nothing", async () => {
      commandBus.execute.mockResolvedValueOnce({ updated: 0, unread_count: 1 });

      const response = await app.inject({
        method: "PATCH",
        url: "/v1/notifications/read",
        headers: authed,
        payload: { ids: ["ntf_1", "ntf_2"] },
      });

      expect(response.statusCode).toBe(200);
    });

    it("accepts exactly 50 ids", async () => {
      commandBus.execute.mockResolvedValueOnce({ updated: 50, unread_count: 0 });

      const response = await app.inject({
        method: "PATCH",
        url: "/v1/notifications/read",
        headers: authed,
        payload: { ids: Array.from({ length: 50 }, (_, i) => `ntf_${i}`) },
      });

      expect(response.statusCode).toBe(200);
    });

    it("rejects more than 50 ids with 400", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/v1/notifications/read",
        headers: authed,
        payload: { ids: Array.from({ length: 51 }, (_, i) => `ntf_${i}`) },
      });

      expect(response.statusCode).toBe(400);
      expect(commandBus.execute).not.toHaveBeenCalled();
    });

    it("401s without an identity", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/v1/notifications/read",
        payload: { ids: ["ntf_1"] },
      });
      expect(response.statusCode).toBe(401);
    });
  });
});
