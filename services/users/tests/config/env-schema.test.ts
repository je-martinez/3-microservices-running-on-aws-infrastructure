import { describe, expect, it } from "vitest";

import { envSchema } from "#config/env.schema";

// Minimal valid base: every required key with no default, so parse() only fails
// on what each test actually varies.
const baseEnv = {
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
};

describe("envSchema — Stripe keys treat empty/whitespace as absent", () => {
  it.each(["", "   "])("STRIPE_ENABLED=%j defaults to false", (value) => {
    const result = envSchema.parse({ ...baseEnv, STRIPE_ENABLED: value });
    expect(result.STRIPE_ENABLED).toBe(false);
  });

  it.each(["", "   "])("STRIPE_SECRET_KEY=%j becomes undefined", (value) => {
    const result = envSchema.parse({ ...baseEnv, STRIPE_SECRET_KEY: value });
    expect(result.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it.each(["", "   "])("STRIPE_WEBHOOK_SECRET=%j becomes undefined", (value) => {
    const result = envSchema.parse({ ...baseEnv, STRIPE_WEBHOOK_SECRET: value });
    expect(result.STRIPE_WEBHOOK_SECRET).toBeUndefined();
  });

  it("a real STRIPE_ENABLED=true still parses to true", () => {
    const result = envSchema.parse({ ...baseEnv, STRIPE_ENABLED: "true" });
    expect(result.STRIPE_ENABLED).toBe(true);
  });

  it("a real STRIPE_SECRET_KEY still parses through", () => {
    const result = envSchema.parse({ ...baseEnv, STRIPE_SECRET_KEY: "rk_test_x" });
    expect(result.STRIPE_SECRET_KEY).toBe("rk_test_x");
  });

  it("a real STRIPE_WEBHOOK_SECRET still parses through", () => {
    const result = envSchema.parse({ ...baseEnv, STRIPE_WEBHOOK_SECRET: "whsec_x" });
    expect(result.STRIPE_WEBHOOK_SECRET).toBe("whsec_x");
  });

  it("an invalid STRIPE_ENABLED value still fails validation", () => {
    expect(() => envSchema.parse({ ...baseEnv, STRIPE_ENABLED: "maybe" })).toThrow();
  });
});
