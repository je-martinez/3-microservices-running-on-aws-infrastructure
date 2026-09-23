import "reflect-metadata";

// CONTRACT: Seed env, INCLUDING E2E_TESTING_ENABLED=true and NO STRIPE_ENABLED,
// BEFORE any import of #config/config.module or app.module.ts — both are
// evaluated at import time (ConfigModule.forRoot parses env; app.module.ts and
// users.module.ts read process.env to decide which conditional pieces to
// mount, per R11). This state is split into its own file (paired with
// e2e-cleanup-stripe-client-mounted.test.ts) because vitest gives each test
// FILE a fresh module registry — re-importing app.module.ts twice in one
// process via vi.resetModules() re-runs every top-level `z.globalRegistry.add`
// call and throws "ID already exists in the registry" (see the sibling
// payment-methods-*-mounted-*.test.ts files for the same constraint).
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
delete process.env.STRIPE_ENABLED;
delete process.env.STRIPE_SECRET_KEY;

const { afterAll, beforeAll, describe, expect, it } = await import("vitest");
const { Test } = await import("@nestjs/testing");
const { FastifyAdapter } = await import("@nestjs/platform-fastify");
type NestFastifyApplication = import("@nestjs/platform-fastify").NestFastifyApplication;
const { AppModule } = await import("../../src/app.module.ts");
const { E2eCleanupCommand } = await import("#features/users/http/e2e-cleanup");

// IMPORTANT: This boots the REAL DI graph (AppModule -> UsersModule's
// factory provider), unlike e2e-cleanup.command.test.ts (which constructs
// E2eCleanupCommand by hand) and users-routes.test.ts (which stubs it) —
// neither exercises the `{ token: STRIPE_CLIENT, optional: true }` inject in
// users.module.ts. See [[dependency-injection]]
describe("E2eCleanupCommand DI (R28) — STRIPE_ENABLED unset", () => {
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

  it("resolves from the real container with its Stripe dependency undefined", async () => {
    const command = app.get(E2eCleanupCommand);
    expect(command).toBeInstanceOf(E2eCleanupCommand);
    expect((command as unknown as { stripe?: unknown }).stripe).toBeUndefined();
  });
});
