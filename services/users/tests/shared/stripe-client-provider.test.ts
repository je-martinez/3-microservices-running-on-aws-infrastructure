import "reflect-metadata";

// CONTRACT: Seed env BEFORE any import of #config/config.module. ConfigModule.forRoot
// parses env at import time. See [[env-files]]
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

const { describe, expect, it, vi } = await import("vitest");
const { Module } = await import("@nestjs/common");
const { Test } = await import("@nestjs/testing");
const { AppConfigService } = await import("#config/config.module");
const {
  STRIPE_CLIENT,
  buildStripeClientHolder,
  stripeClientProvider,
} = await import("#shared/stripe/stripe-client.provider");

describe("buildStripeClientHolder", () => {
  it("returns a client when enabled and a key is present", () => {
    const holder = buildStripeClientHolder(
      { STRIPE_ENABLED: true, STRIPE_SECRET_KEY: "rk_test_123" },
      { warn: vi.fn() },
    );
    expect(holder.enabled).toBe(true);
    expect(holder.client).not.toBeNull();
  });

  it("returns a null client and logs a warning when enabled with no key", () => {
    const warn = vi.fn();
    const holder = buildStripeClientHolder(
      { STRIPE_ENABLED: true, STRIPE_SECRET_KEY: undefined },
      { warn },
    );
    expect(holder.enabled).toBe(true);
    expect(holder.client).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns a null client with no warning when disabled", () => {
    const warn = vi.fn();
    const holder = buildStripeClientHolder(
      { STRIPE_ENABLED: false, STRIPE_SECRET_KEY: undefined },
      { warn },
    );
    expect(holder.enabled).toBe(false);
    expect(holder.client).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("stripeClientProvider (Nest wiring)", () => {
  it("reads STRIPE_ENABLED/STRIPE_SECRET_KEY off ConfigService via the factory", async () => {
    const fakeConfig = {
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "STRIPE_ENABLED") return true;
        if (key === "STRIPE_SECRET_KEY") return "rk_test_456";
        return fallback;
      }),
    };

    @Module({
      providers: [{ provide: AppConfigService, useValue: fakeConfig }, stripeClientProvider],
    })
    class ProbeModule {}

    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    await moduleRef.init();

    const holder = moduleRef.get(STRIPE_CLIENT);
    expect(fakeConfig.get).toHaveBeenCalledWith("STRIPE_ENABLED", false);
    expect(holder.enabled).toBe(true);
    expect(holder.client).not.toBeNull();

    await moduleRef.close();
  });

  it("produces a disabled holder when STRIPE_ENABLED is absent (defaulted false)", async () => {
    const fakeConfig = {
      get: vi.fn((_key: string, fallback?: unknown) => fallback),
    };

    @Module({
      providers: [{ provide: AppConfigService, useValue: fakeConfig }, stripeClientProvider],
    })
    class ProbeModule {}

    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    await moduleRef.init();

    const holder = moduleRef.get(STRIPE_CLIENT);
    expect(holder.enabled).toBe(false);
    expect(holder.client).toBeNull();

    await moduleRef.close();
  });
});
