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
  E2E_TESTING_ENABLED: "true",
  METRICS_INTERVAL_MS: "60000",
});

const { describe, expect, it } = await import("vitest");
const { Global, Module } = await import("@nestjs/common");
const { Test } = await import("@nestjs/testing");
const { AppConfigModule } = await import("#config/config.module");
const { MetricsModule } = await import("#shared/metrics/metrics.module");
const { BusinessMetricsPoller } = await import("#shared/metrics/business-metrics");
const { DB } = await import("#shared/tokens");

@Global()
@Module({ providers: [{ provide: DB, useValue: {} }], exports: [DB] })
class FakeDbModule {}

// CONTRACT: main.ts starts the poller with app.get(BusinessMetricsPoller). A wrong
// inject token in the factory fails only at bootstrap — no unit test of the class
// sees it — and the dashboard's users_total cards go "Search stream not found".
describe("MetricsModule", () => {
  it("provides the BusinessMetricsPoller main.ts starts", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, FakeDbModule, MetricsModule],
    }).compile();

    expect(moduleRef.get(BusinessMetricsPoller)).toBeInstanceOf(BusinessMetricsPoller);
    await moduleRef.close();
  });
});
