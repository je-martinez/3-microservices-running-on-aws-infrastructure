import "reflect-metadata";

// CONTRACT: Seed env WITHOUT STRIPE_ENABLED (defaults to "false" per
// env.schema.ts) before any import of app.module.ts. See the sibling
// payment-methods-mounted-when-enabled.test.ts for why this state lives in
// its own file rather than sharing one via vi.resetModules(). See [[env-files]]
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
delete process.env.STRIPE_ENABLED;
delete process.env.STRIPE_SECRET_KEY;

const { afterAll, beforeAll, describe, expect, it } = await import("vitest");
const { Test } = await import("@nestjs/testing");
const { FastifyAdapter } = await import("@nestjs/platform-fastify");
type NestFastifyApplication = import("@nestjs/platform-fastify").NestFastifyApplication;
const { AppModule } = await import("../../src/app.module.ts");

describe("PaymentMethodsModule conditional mount (R11) — STRIPE_ENABLED unset", () => {
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

  it("does not mount any payment-methods route — the gateway's own 404 shape, not the service's", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/users/me/payment-methods" });
    expect(response.statusCode).toBe(404);
    // Nest's own "no matching route" 404 body, distinct from
    // `{ error: "not_found" }` the service throws for a routine miss — proves
    // the route genuinely does not exist rather than existing and 404ing.
    expect(response.json()).toMatchObject({ message: expect.stringContaining("Cannot GET") });
  });
});
