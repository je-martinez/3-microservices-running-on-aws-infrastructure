import { describe, it, expect } from "vitest";
import { parseEnv } from "#shared/config/env";

const base = {
  DATABASE_WRITER_URL: "postgres://w",
  DATABASE_READER_URL: "postgres://r",
  COGNITO_USER_POOL_ID: "pool",
  COGNITO_CLIENT_ID: "client",
  AWS_ENDPOINT_URL: "http://ministack:4566",
  AWS_REGION: "us-east-1",
  WEBHOOK_SECRET: "s3cret",
  GRPC_API_KEY: "local-dev-grpc-key",
  ORDERS_BASE_URL: "http://orders:8080",
  TRACKING_BASE_URL: "http://tracking:8000",
  EVENTS_TOPIC_ARN: "arn:aws:sns:us-east-1:000000000000:3mrai-local-events-topic",
  NOTIFICATIONS_QUEUE_URL: "http://localhost:4566/000000000000/3mrai-local-notifications",
  WS_MANAGEMENT_ENDPOINT: "http://floci:4566/execute-api/abc123/$default",
  WS_CONNECTIONS_TABLE: "3mrai-local-realtime-ws-connections",
  REDIS_HOST: "floci-valkey-cache-3mrai-local-cache-redis",
  REDIS_PORT: "6379",
};

describe("parseEnv", () => {
  it("coerces E2E_TESTING_ENABLED and PORT", () => {
    const env = parseEnv({
      ...base,
      E2E_TESTING_ENABLED: "true",
      PORT: "3000",
    });
    expect(env.E2E_TESTING_ENABLED).toBe(true);
    expect(env.PORT).toBe(3000);
  });

  it("defaults E2E_TESTING_ENABLED to false when absent", () => {
    const env = parseEnv({
      ...base,
      PORT: "3000",
    });
    expect(env.E2E_TESTING_ENABLED).toBe(false);
  });

  it("defaults CACHE_ENABLED to true when absent", () => {
    expect(parseEnv(base).CACHE_ENABLED).toBe(true);
  });

  it("reads CACHE_ENABLED as a boolean, not a truthy string", () => {
    // The trap this guards: env values are always strings, and z.coerce.boolean()
    // would read the string "false" as true because it is non-empty. A kill
    // switch that cannot be switched off is worse than no kill switch.
    expect(parseEnv({ ...base, CACHE_ENABLED: "false" }).CACHE_ENABLED).toBe(false);
    expect(parseEnv({ ...base, CACHE_ENABLED: "true" }).CACHE_ENABLED).toBe(true);
  });

  it("rejects a CACHE_ENABLED that is neither \"true\" nor \"false\"", () => {
    expect(() => parseEnv({ ...base, CACHE_ENABLED: "1" })).toThrow();
  });

  it("defaults NODE_ENV to development", () => {
    expect(parseEnv(base).NODE_ENV).toBe("development");
  });

  it("accepts production", () => {
    expect(parseEnv({ ...base, NODE_ENV: "production" }).NODE_ENV).toBe("production");
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => parseEnv({ ...base, NODE_ENV: "staging" })).toThrow();
  });

  it("requires WEBHOOK_SECRET", () => {
    const { WEBHOOK_SECRET: _omit, ...without } = base;
    expect(() => parseEnv(without)).toThrow();
  });

  it("parses GRPC_PORT and GRPC_API_KEY", () => {
    const env = parseEnv({
      ...base,
      GRPC_PORT: "50051",
      GRPC_API_KEY: "local-dev-grpc-key",
    });
    expect(env.GRPC_PORT).toBe(50051);
    expect(env.GRPC_API_KEY).toBe("local-dev-grpc-key");
  });

  it("defaults GRPC_PORT to 50051 when absent", () => {
    expect(parseEnv(base).GRPC_PORT).toBe(50051);
  });

  it("requires GRPC_API_KEY", () => {
    const { GRPC_API_KEY: _omit, ...without } = base;
    expect(() => parseEnv(without)).toThrow();
  });

  it("requires EVENTS_TOPIC_ARN", () => {
    const { EVENTS_TOPIC_ARN: _omit, ...without } = base;
    expect(() => parseEnv(without)).toThrow();
  });

  // Both cascade targets are required with no default. A missing one must fail at
  // boot rather than let DELETE /v1/users/me reach a half-configured cascade and
  // report success for orders it never deleted.
  it("requires ORDERS_BASE_URL", () => {
    const { ORDERS_BASE_URL: _omit, ...without } = base;
    expect(() => parseEnv(without)).toThrow();
  });

  it("requires TRACKING_BASE_URL", () => {
    const { TRACKING_BASE_URL: _omit, ...without } = base;
    expect(() => parseEnv(without)).toThrow();
  });

  it("rejects a non-URL NOTIFICATIONS_QUEUE_URL", () => {
    expect(() => parseEnv({ ...base, NOTIFICATIONS_QUEUE_URL: "not-a-url" })).toThrow();
  });

  it("parses EVENTS_TOPIC_ARN", () => {
    expect(parseEnv(base).EVENTS_TOPIC_ARN).toBe(
      "arn:aws:sns:us-east-1:000000000000:3mrai-local-events-topic",
    );
  });

  // REDIS_* has NO default on purpose (see the schema comment): the endpoint the
  // ElastiCache API reports locally is literally "localhost", so a default would
  // be a plausible-looking value that fails only later, on the first password
  // reset. Boot-time failure is the point of [[ADR-0014-env-validation-zod]].
  it("requires REDIS_HOST", () => {
    const { REDIS_HOST: _omit, ...without } = base;
    expect(() => parseEnv(without)).toThrow();
  });

  it("requires REDIS_PORT", () => {
    const { REDIS_PORT: _omit, ...without } = base;
    expect(() => parseEnv(without)).toThrow();
  });

  it("coerces REDIS_PORT to a number", () => {
    const env = parseEnv(base);
    expect(env.REDIS_PORT).toBe(6379);
    expect(env.REDIS_HOST).toBe("floci-valkey-cache-3mrai-local-cache-redis");
  });

  it("rejects a non-numeric REDIS_PORT", () => {
    expect(() => parseEnv({ ...base, REDIS_PORT: "not-a-port" })).toThrow();
  });
});

describe("notification env vars", () => {
  // The base of a valid environment, mirroring vitest.config.ts's test.env.
  function baseEnv(): Record<string, string> {
    return {
      DATABASE_WRITER_URL: "postgres://user:pass@localhost:5432/users",
      DATABASE_READER_URL: "postgres://user:pass@localhost:5432/users",
      COGNITO_USER_POOL_ID: "us-east-1_dummy",
      COGNITO_CLIENT_ID: "dummy_client",
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AWS_REGION: "us-east-1",
      WEBHOOK_SECRET: "test-webhook-secret",
      GRPC_API_KEY: "test-grpc-key",
      ORDERS_BASE_URL: "http://localhost:8080",
      TRACKING_BASE_URL: "http://localhost:8000",
      REDIS_HOST: "localhost",
      REDIS_PORT: "6379",
      EVENTS_TOPIC_ARN: "arn:aws:sns:us-east-1:000000000000:3mrai-local-events-topic",
      NOTIFICATIONS_QUEUE_URL: "http://localhost:4566/000000000000/3mrai-local-notifications",
      WS_MANAGEMENT_ENDPOINT: "http://floci:4566/execute-api/abc123/$default",
      WS_CONNECTIONS_TABLE: "3mrai-local-realtime-ws-connections",
      WS_CONNECTIONS_GSI: "by-cognito-sub",
    };
  }

  it("parses the five notification vars", () => {
    const env = parseEnv(baseEnv());
    expect(env.EVENTS_TOPIC_ARN).toContain("arn:aws:sns");
    expect(env.NOTIFICATIONS_QUEUE_URL).toContain("notifications");
    expect(env.WS_MANAGEMENT_ENDPOINT).toContain("execute-api");
    expect(env.WS_CONNECTIONS_TABLE).toContain("ws-connections");
    expect(env.WS_CONNECTIONS_GSI).toBe("by-cognito-sub");
  });

  // CONTRACT: Required with no default. A missing value must fail at BOOT with a
  // named Zod error — a defaulted topic ARN publishes into the void and every
  // notification is silently lost. See [[ADR-0014-env-validation-zod]]
  it.each([
    "EVENTS_TOPIC_ARN",
    "NOTIFICATIONS_QUEUE_URL",
    "WS_MANAGEMENT_ENDPOINT",
    "WS_CONNECTIONS_TABLE",
  ])("fails to boot without %s", (key) => {
    const source = baseEnv();
    delete source[key];
    expect(() => parseEnv(source)).toThrow(new RegExp(key));
  });

  // The one that MAY default: the GSI name is a Terraform constant, not a minted id.
  it("defaults WS_CONNECTIONS_GSI to by-cognito-sub", () => {
    const source = baseEnv();
    delete source.WS_CONNECTIONS_GSI;
    expect(parseEnv(source).WS_CONNECTIONS_GSI).toBe("by-cognito-sub");
  });
});
