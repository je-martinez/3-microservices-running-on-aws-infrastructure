import "reflect-metadata";

// CONTRACT: Seed env WITH E2E_TESTING_ENABLED=true AND STRIPE_ENABLED=true
// before any import of app.module.ts. See the sibling
// e2e-cleanup-stripe-client-unmounted.test.ts for why this state lives in its
// own file rather than sharing one via vi.resetModules(). See [[env-files]]
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
  STRIPE_ENABLED: "true",
  STRIPE_SECRET_KEY: "rk_test_123",
});

const { afterAll, beforeAll, describe, expect, it } = await import("vitest");
const { Test } = await import("@nestjs/testing");
const { FastifyAdapter } = await import("@nestjs/platform-fastify");
type NestFastifyApplication = import("@nestjs/platform-fastify").NestFastifyApplication;
const { AppModule } = await import("../../src/app.module.ts");
const { E2eCleanupCommand } = await import("#features/users/http/e2e-cleanup");
const { STRIPE_CLIENT } = await import("#shared/tokens");

// IMPORTANT: Proves the @Global() fix on PaymentMethodsModule actually makes
// STRIPE_CLIENT reach UsersModule's factory through the REAL container —
// `optional: true` alone would silently resolve to undefined here if the
// token weren't visible across the two sibling modules. See R28 /
// [[dependency-injection]]
describe("E2eCleanupCommand DI (R28) — STRIPE_ENABLED=true", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("resolves the SAME STRIPE_CLIENT holder the @Global() PaymentMethodsModule provides", async () => {
    const command = app.get(E2eCleanupCommand);
    const holder = app.get(STRIPE_CLIENT);

    expect(command).toBeInstanceOf(E2eCleanupCommand);
    expect((command as unknown as { stripe?: unknown }).stripe).toBe(holder);
    expect((holder as { client: unknown }).client).not.toBeNull();
  });
});
