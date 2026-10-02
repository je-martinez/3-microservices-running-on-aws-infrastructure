import "reflect-metadata";

// CONTRACT: Seed env BEFORE importing main.ts. The env schema, the Stripe mount
// (app.module.ts) and the e2e controller mount (users.module.ts) are all read at
// import time, and both gates must be ON — the E2E stack runs with them on and
// calls routes behind each. Placeholders only: nothing here reaches a network.
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
  METRICS_INTERVAL_MS: "60000",
  E2E_TESTING_ENABLED: "true",
  STRIPE_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_boot_smoke",
  STRIPE_WEBHOOK_SECRET: "whsec_boot_smoke",
  STRIPE_WEBHOOK_URL_TOKEN: "tok_boot_smoke",
  STRIPE_WEBHOOK_ALLOWED_CIDRS: "127.0.0.0/8",
});

const { afterAll, beforeAll, describe, expect, it } = await import("vitest");
type NestFastifyApplication = import("@nestjs/platform-fastify").NestFastifyApplication;
const { createNestApp } = await import("../src/main.ts");
const { BusinessMetricsPoller } = await import("#shared/metrics/business-metrics");
const { MetricsPublisher } = await import("#shared/metrics/cloudwatch-metrics");

// Every Users route the E2E specs (e2e/tests/**, e2e/support/**) call, in Fastify's
// route-pattern form. `GET /v1/users/health` is absent on purpose: nginx rewrites
// that gateway path to `/v1/health`, so the service never registers it.
const E2E_ROUTES: ReadonlyArray<readonly [method: string, url: string]> = [
  ["GET", "/v1/health"],
  ["POST", "/v1/users/register"],
  ["POST", "/v1/users/register/passwordless"],
  ["POST", "/v1/users/login"],
  ["POST", "/v1/users/refresh"],
  ["POST", "/v1/users/logout"],
  ["POST", "/v1/users/otp/start"],
  ["POST", "/v1/users/otp/verify"],
  ["POST", "/v1/users/password/forgot"],
  ["POST", "/v1/users/password/confirm"],
  ["GET", "/v1/users/me"],
  ["PATCH", "/v1/users/me"],
  ["DELETE", "/v1/users/me"],
  ["PATCH", "/v1/users/me/password"],
  ["POST", "/v1/webhooks/cognito"],
  ["DELETE", "/v1/users/e2e-cleanup"],
  ["GET", "/v1/users/e2e-identity"],
  ["GET", "/v1/notifications"],
  ["GET", "/v1/notifications/unread-count"],
  ["PATCH", "/v1/notifications/read"],
  ["GET", "/v1/users/me/payment-methods"],
  ["POST", "/v1/users/me/payment-methods"],
  ["POST", "/v1/users/me/payment-methods/setup-intent"],
  ["DELETE", "/v1/users/me/payment-methods/:id"],
  ["PUT", "/v1/users/me/payment-methods/:id/default"],
  ["POST", "/v1/users/stripe/webhook/:token"],
];

// CONTRACT: Boot the WHOLE app through main.ts's createNestApp(), never a
// per-feature testing module. A provider missing from a module's
// providers/imports surfaces only at bootstrap — a unit test mocks the dependency
// away and stays green while the service dies on boot. See [[dependency-injection]]
describe("application bootstrap", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createNestApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("resolves the factory-built MetricsPublisher and the BusinessMetricsPoller main.ts starts", () => {
    expect(app.get(MetricsPublisher)).toBeInstanceOf(MetricsPublisher);
    expect(app.get(BusinessMetricsPoller)).toBeInstanceOf(BusinessMetricsPoller);
  });

  // CONTRACT: The poller owns a live DB interval; only main.ts's bootstrap()
  // may start it. A constructor or lifecycle hook would start one in every
  // compile of the suite. The start()/stop() pair proves `timer` is the field
  // start() assigns, so a rename cannot turn the first assertion vacuous.
  it("does NOT start the business-metrics poller when the app initialises", () => {
    const poller = app.get(BusinessMetricsPoller) as unknown as {
      timer: unknown;
      start(): void;
      stop(): void;
    };
    expect(poller.timer).toBeUndefined();

    poller.start();
    expect(poller.timer).toBeDefined();
    poller.stop();
  });

  // A route missing here 404s at the gateway with its own {"message":"Not Found"}
  // while the service looks healthy.
  it("registers every route the E2E specs call", () => {
    const fastify = app.getHttpAdapter().getInstance();
    const missing = E2E_ROUTES.filter(([method, url]) => !fastify.hasRoute({ method, url })).map(
      ([method, url]) => `${method} ${url}`,
    );

    expect(missing).toEqual([]);
  });
});
