import "reflect-metadata";

// CONTRACT: Seed env BEFORE any import of #config/config.module — the
// controller imports AppConfigService, and ConfigModule.forRoot parses env at
// import time. See [[env-files]]
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
const { PaymentMethodsController } = await import(
  "../../src/payment-methods/http/payment-methods.controller.ts"
);
const { CurrentUserInterceptor } = await import(
  "../../src/users/http/current-user.interceptor.ts"
);

// CONTRACT: Dispatches through CommandBus/QueryBus mocks — never calls a
// handler's execute() directly (R10). Mirrors tests/users/users-routes.test.ts.
describe("payment-methods HTTP routes", () => {
  let app: NestFastifyApplication;
  const commandBus = { execute: vi.fn(), register: vi.fn() };
  const queryBus = { execute: vi.fn(), register: vi.fn() };
  const findByIdOrCognitoSub = vi.fn();

  beforeAll(async () => {
    @Module({
      imports: [CqrsModule],
      controllers: [PaymentMethodsController],
      providers: [
        CurrentUserInterceptor,
        RequestContextMiddleware,
        {
          provide: AppConfigService,
          useValue: {
            get: (key: string) => (key === "E2E_TESTING_ENABLED" ? false : undefined),
          },
        },
        { provide: DB, useValue: { user: { findByIdOrCognitoSub } } },
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
    findByIdOrCognitoSub.mockReset();
  });

  const authed = { "x-user-id": "cognito-sub-1" };

  it("answers 401 unauthenticated with no x-user-id on every route", async () => {
    const routes = [
      { method: "POST" as const, url: "/v1/users/me/payment-methods/setup-intent" },
      { method: "GET" as const, url: "/v1/users/me/payment-methods" },
      { method: "POST" as const, url: "/v1/users/me/payment-methods" },
      { method: "DELETE" as const, url: "/v1/users/me/payment-methods/pm_1" },
      { method: "PUT" as const, url: "/v1/users/me/payment-methods/pm_1/default" },
    ];

    for (const route of routes) {
      const response = await app.inject(route);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthenticated" });
    }
    expect(commandBus.execute).not.toHaveBeenCalled();
    expect(queryBus.execute).not.toHaveBeenCalled();
  });

  it("resolves the caller to their internal usr_ id and 404s when it resolves to no user", async () => {
    findByIdOrCognitoSub.mockResolvedValueOnce(null);

    const response = await app.inject({
      method: "GET",
      url: "/v1/users/me/payment-methods",
      headers: authed,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
    expect(queryBus.execute).not.toHaveBeenCalled();
  });

  it("POST setup-intent dispatches CreateSetupIntentCommand with the resolved usr_ id", async () => {
    findByIdOrCognitoSub.mockResolvedValueOnce({ id: "usr_1" });
    commandBus.execute.mockResolvedValueOnce({ clientSecret: "seti_123_secret_abc" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/users/me/payment-methods/setup-intent",
      headers: authed,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ clientSecret: "seti_123_secret_abc" });
    const dispatched = commandBus.execute.mock.calls[0][0];
    expect(dispatched.input).toEqual({ userId: "usr_1", e2eSource: false });
  });

  it("GET / dispatches ListPaymentMethodsQuery with the resolved usr_ id", async () => {
    findByIdOrCognitoSub.mockResolvedValueOnce({ id: "usr_1" });
    queryBus.execute.mockResolvedValueOnce([
      { id: "pm_1", type: "card", brand: "visa", last4: "4242", expMonth: 1, expYear: 2030, isDefault: true },
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/v1/users/me/payment-methods",
      headers: authed,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    const dispatched = queryBus.execute.mock.calls[0][0];
    expect(dispatched.userId).toBe("usr_1");
  });

  it("POST / dispatches AttachPaymentMethodCommand with the body's paymentMethodId", async () => {
    findByIdOrCognitoSub.mockResolvedValueOnce({ id: "usr_1" });
    commandBus.execute.mockResolvedValueOnce({ id: "pm_1" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/users/me/payment-methods",
      headers: authed,
      payload: { paymentMethodId: "pm_1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "pm_1" });
    const dispatched = commandBus.execute.mock.calls[0][0];
    expect(dispatched.input).toEqual({ userId: "usr_1", paymentMethodId: "pm_1", e2eSource: false });
  });

  it("rejects an attach body whose paymentMethodId is not a pm_ id with 400", async () => {
    findByIdOrCognitoSub.mockResolvedValueOnce({ id: "usr_1" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/users/me/payment-methods",
      headers: authed,
      payload: { paymentMethodId: "not-a-pm-id" },
    });

    expect(response.statusCode).toBe(400);
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it("rejects a :id param that is not a pm_ id with 400", async () => {
    findByIdOrCognitoSub.mockResolvedValueOnce({ id: "usr_1" });

    const response = await app.inject({
      method: "DELETE",
      url: "/v1/users/me/payment-methods/not-a-pm-id",
      headers: authed,
    });

    expect(response.statusCode).toBe(400);
    expect(commandBus.execute).not.toHaveBeenCalled();
  });

  it("DELETE :id returns 204 when the command reports detached", async () => {
    findByIdOrCognitoSub.mockResolvedValueOnce({ id: "usr_1" });
    commandBus.execute.mockResolvedValueOnce("detached");

    const response = await app.inject({
      method: "DELETE",
      url: "/v1/users/me/payment-methods/pm_1",
      headers: authed,
    });

    expect(response.statusCode).toBe(204);
    const dispatched = commandBus.execute.mock.calls[0][0];
    expect(dispatched.input).toEqual({ userId: "usr_1", paymentMethodId: "pm_1" });
  });

  it("DELETE :id returns 404 not_found when the command reports a routine miss", async () => {
    findByIdOrCognitoSub.mockResolvedValueOnce({ id: "usr_1" });
    commandBus.execute.mockResolvedValueOnce("not_found");

    const response = await app.inject({
      method: "DELETE",
      url: "/v1/users/me/payment-methods/pm_1",
      headers: authed,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });

  it("PUT :id/default returns 204 when the command reports set_default", async () => {
    findByIdOrCognitoSub.mockResolvedValueOnce({ id: "usr_1" });
    commandBus.execute.mockResolvedValueOnce("set_default");

    const response = await app.inject({
      method: "PUT",
      url: "/v1/users/me/payment-methods/pm_1/default",
      headers: authed,
    });

    expect(response.statusCode).toBe(204);
    const dispatched = commandBus.execute.mock.calls[0][0];
    expect(dispatched.input).toEqual({ userId: "usr_1", paymentMethodId: "pm_1" });
  });

  it("PUT :id/default returns 404 not_found when the command reports a routine miss", async () => {
    findByIdOrCognitoSub.mockResolvedValueOnce({ id: "usr_1" });
    commandBus.execute.mockResolvedValueOnce("not_found");

    const response = await app.inject({
      method: "PUT",
      url: "/v1/users/me/payment-methods/pm_1/default",
      headers: authed,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });

  it("maps a thrown PaymentMethodRejectedException to its 403 body", async () => {
    findByIdOrCognitoSub.mockResolvedValueOnce({ id: "usr_1" });
    const { PaymentMethodRejectedException } = await import(
      "../../src/payment-methods/commands/attach-payment-method.command.ts"
    );
    commandBus.execute.mockRejectedValueOnce(new PaymentMethodRejectedException());

    const response = await app.inject({
      method: "POST",
      url: "/v1/users/me/payment-methods",
      headers: authed,
      payload: { paymentMethodId: "pm_1" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "payment_method_rejected" });
  });

  it("maps a thrown PaymentMethodDeclinedException to its 402 body", async () => {
    findByIdOrCognitoSub.mockResolvedValueOnce({ id: "usr_1" });
    const { PaymentMethodDeclinedException } = await import(
      "../../src/payment-methods/commands/attach-payment-method.command.ts"
    );
    commandBus.execute.mockRejectedValueOnce(new PaymentMethodDeclinedException());

    const response = await app.inject({
      method: "POST",
      url: "/v1/users/me/payment-methods",
      headers: authed,
      payload: { paymentMethodId: "pm_1" },
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toEqual({ error: "payment_method_declined" });
  });

  it("maps a thrown StripeUnavailableException to its 503 body", async () => {
    findByIdOrCognitoSub.mockResolvedValueOnce({ id: "usr_1" });
    const { StripeUnavailableException } = await import(
      "../../src/shared/stripe/stripe-unavailable.exception.ts"
    );
    commandBus.execute.mockRejectedValueOnce(new StripeUnavailableException());

    const response = await app.inject({
      method: "POST",
      url: "/v1/users/me/payment-methods/setup-intent",
      headers: authed,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "stripe_unavailable" });
  });
});
