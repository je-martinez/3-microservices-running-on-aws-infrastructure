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
});
