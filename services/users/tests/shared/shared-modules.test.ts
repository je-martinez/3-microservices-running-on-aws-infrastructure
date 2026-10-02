import "reflect-metadata";

// WHY: Seeded before any import of #config/config.module or app.module.ts —
// both read process.env at import time.
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
});

const { afterAll, beforeAll, describe, expect, it } = await import("vitest");
type TestingModule = import("@nestjs/testing").TestingModule;
type RedisClient = import("#shared/cache/redis").RedisClient;
const { Test } = await import("@nestjs/testing");
const { AppModule } = await import("../../src/app.module.ts");
const { AUTH_PROVIDER, DB, EVENT_PUBLISHER, REDIS } = await import("#shared/tokens");
const { CacheGateway } = await import("#shared/cache/cache-gateway");
const { ResetCodeStore } = await import("#shared/cache/reset-code-store");
const { MetricsPublisher } = await import("#shared/metrics/cloudwatch-metrics");
const { BusinessMetricsPoller } = await import("#shared/metrics/business-metrics");
const { CascadeClient } = await import("#shared/http/cascade-client");

// CONTRACT: Every handler injects these from the @Global shared modules. A
// provider dropped from its module's providers/exports compiles cleanly and
// fails only at bootstrap with "Nest can't resolve dependencies".
describe("shared infrastructure providers", () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  });

  afterAll(async () => {
    // WHY: The ioredis client dials eagerly and reconnects forever; Nest's
    // close() does not end it, so an open socket would outlive the suite.
    moduleRef?.get<RedisClient>(REDIS).disconnect();
    await moduleRef?.close();
  });

  it.each([
    ["DB", DB],
    ["AUTH_PROVIDER", AUTH_PROVIDER],
    ["EVENT_PUBLISHER", EVENT_PUBLISHER],
    ["REDIS", REDIS],
  ])("resolves the %s token", (_name, token) => {
    expect(moduleRef.get(token)).toBeDefined();
  });

  it.each([
    ["CacheGateway", CacheGateway],
    ["ResetCodeStore", ResetCodeStore],
    ["MetricsPublisher", MetricsPublisher],
    ["BusinessMetricsPoller", BusinessMetricsPoller],
    ["CascadeClient", CascadeClient],
  ] as const)("resolves %s by type", (_name, type) => {
    expect(moduleRef.get(type as never)).toBeInstanceOf(type);
  });
});
