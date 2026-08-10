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
  EVENTS_QUEUE_URL: "http://localhost:4566/000000000000/3mrai-local-events",
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

  it("requires EVENTS_QUEUE_URL", () => {
    const { EVENTS_QUEUE_URL: _omit, ...without } = base;
    expect(() => parseEnv(without)).toThrow();
  });

  it("rejects a non-URL EVENTS_QUEUE_URL", () => {
    expect(() => parseEnv({ ...base, EVENTS_QUEUE_URL: "not-a-url" })).toThrow();
  });

  it("parses EVENTS_QUEUE_URL", () => {
    expect(parseEnv(base).EVENTS_QUEUE_URL).toBe("http://localhost:4566/000000000000/3mrai-local-events");
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
