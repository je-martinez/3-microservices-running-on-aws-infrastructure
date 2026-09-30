import "reflect-metadata";

// CONTRACT: Seed env, INCLUDING STRIPE_ENABLED=true, BEFORE any import of
// #config/config.module or app.module.ts — both are evaluated at import time
// (ConfigModule.forRoot parses env; app.module.ts's `@Module` reads
// process.env.STRIPE_ENABLED to decide whether to import PaymentMethodsModule,
// per R11). This state is split into its own file (paired with
// payment-methods-not-mounted-when-disabled.test.ts) because vitest gives each
// test FILE a fresh module registry — re-importing app.module.ts twice in one
// process via vi.resetModules() re-runs every top-level `z.globalRegistry.add`
// call and throws "ID already exists in the registry".
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
  STRIPE_ENABLED: "true",
  STRIPE_SECRET_KEY: "rk_test_123",
});

const { afterAll, beforeAll, describe, expect, it } = await import("vitest");
const { Test } = await import("@nestjs/testing");
const { FastifyAdapter } = await import("@nestjs/platform-fastify");
type NestFastifyApplication = import("@nestjs/platform-fastify").NestFastifyApplication;
const { AppModule } = await import("../../src/app.module.ts");

describe("PaymentMethodsModule conditional mount (R11) — STRIPE_ENABLED=true", () => {
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

  it("mounts the payment-methods routes — a 401 (not 404) proves the route resolves", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/users/me/payment-methods" });
    expect(response.statusCode).toBe(401);
  });
});
