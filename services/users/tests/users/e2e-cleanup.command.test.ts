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

const { describe, expect, it, vi, beforeEach } = await import("vitest");
const { SpanStatusCode } = await import("@opentelemetry/api");
const { testSpanExporter } = await import("../setup.ts");
const { appLogger } = await import("#shared/logging/app-logger");
const Stripe = (await import("stripe")).default;
const { E2eCleanupCommand } = await import("#features/users/http/e2e-cleanup");

function fakeCacheGateway() {
  return { invalidate: vi.fn(async () => undefined) };
}

function stripeErrorResourceMissing(): Stripe.errors.StripeInvalidRequestError {
  return new Stripe.errors.StripeInvalidRequestError({
    message: "No such customer",
    code: "resource_missing",
  });
}

describe("E2eCleanupCommand — Stripe customer cleanup", () => {
  beforeEach(() => testSpanExporter.reset());

  it("deletes the Stripe customer for each tagged user that has one, skipping users with none", async () => {
    const del = vi.fn().mockResolvedValue({ id: "cus_1", deleted: true });
    const db = {
      user: {
        findMany: vi.fn().mockResolvedValue([
          { id: "usr_1", cognitoSub: "sub_1", stripeCustomerId: "cus_1" },
          { id: "usr_2", cognitoSub: "sub_2", stripeCustomerId: null },
        ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const command = new E2eCleanupCommand({
      db,
      cacheGateway: fakeCacheGateway(),
      stripe: { enabled: true, client: { customers: { del } } },
    });

    const result = await command.execute();

    expect(result).toEqual({ count: 2 });
    expect(del).toHaveBeenCalledOnce();
    expect(del).toHaveBeenCalledWith("cus_1");

    const spans = testSpanExporter.getFinishedSpans();
    const deleteSpan = spans.find((s) => s.name === "stripe.customer.delete");
    expect(deleteSpan).toBeDefined();
    expect(deleteSpan?.attributes["stripe.resource_type"]).toBe("customer");
    expect(deleteSpan?.status.code).toBe(SpanStatusCode.OK);
  });

  it("is a no-op when the Stripe client is absent (STRIPE_CLIENT not provided)", async () => {
    const db = {
      user: {
        findMany: vi.fn().mockResolvedValue([
          { id: "usr_1", cognitoSub: "sub_1", stripeCustomerId: "cus_1" },
        ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const command = new E2eCleanupCommand({ db, cacheGateway: fakeCacheGateway() });

    const result = await command.execute();

    expect(result).toEqual({ count: 1 });
  });

  it("is a no-op when the Stripe holder's client is null (STRIPE_ENABLED without a key)", async () => {
    const db = {
      user: {
        findMany: vi.fn().mockResolvedValue([
          { id: "usr_1", cognitoSub: "sub_1", stripeCustomerId: "cus_1" },
        ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const command = new E2eCleanupCommand({
      db,
      cacheGateway: fakeCacheGateway(),
      stripe: { enabled: true, client: null },
    });

    const result = await command.execute();

    expect(result).toEqual({ count: 1 });
  });

  it("treats resource_missing as success and continues past a failing delete to the rest", async () => {
    const del = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockRejectedValueOnce(stripeErrorResourceMissing())
      .mockResolvedValueOnce({ id: "cus_3", deleted: true });
    const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => appLogger);
    const db = {
      user: {
        findMany: vi.fn().mockResolvedValue([
          { id: "usr_1", cognitoSub: "sub_1", stripeCustomerId: "cus_1" },
          { id: "usr_2", cognitoSub: "sub_2", stripeCustomerId: "cus_2" },
          { id: "usr_3", cognitoSub: "sub_3", stripeCustomerId: "cus_3" },
        ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 3 }),
      },
    };
    const command = new E2eCleanupCommand({
      db,
      cacheGateway: fakeCacheGateway(),
      stripe: { enabled: true, client: { customers: { del } } },
    });

    const result = await command.execute();

    expect(result).toEqual({ count: 3 });
    expect(del).toHaveBeenCalledTimes(3);
    expect(del).toHaveBeenNthCalledWith(1, "cus_1");
    expect(del).toHaveBeenNthCalledWith(2, "cus_2");
    expect(del).toHaveBeenNthCalledWith(3, "cus_3");

    // The genuine failure is logged with a FIXED reason code, never
    // `err.message` (which could embed request/account details); resource_missing
    // (already gone in Stripe) is NOT logged as a failure — it is the desired
    // end state.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ reason: "stripe_customer_delete_failed" });

    warn.mockRestore();
  });
});
