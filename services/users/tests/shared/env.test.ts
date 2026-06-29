import { describe, it, expect } from "vitest";
import { parseEnv } from "../../src/shared/config/env.js";

describe("parseEnv", () => {
  it("coerces E2E_TESTING_ENABLED and PORT", () => {
    const env = parseEnv({
      DATABASE_WRITER_URL: "postgres://w",
      DATABASE_READER_URL: "postgres://r",
      E2E_TESTING_ENABLED: "true",
      PORT: "3000",
      COGNITO_USER_POOL_ID: "pool",
      COGNITO_CLIENT_ID: "client",
      AWS_ENDPOINT_URL: "http://ministack:4566",
      AWS_REGION: "us-east-1",
    });
    expect(env.E2E_TESTING_ENABLED).toBe(true);
    expect(env.PORT).toBe(3000);
  });

  it("defaults E2E_TESTING_ENABLED to false when absent", () => {
    const env = parseEnv({
      DATABASE_WRITER_URL: "postgres://w",
      DATABASE_READER_URL: "postgres://r",
      PORT: "3000",
      COGNITO_USER_POOL_ID: "pool",
      COGNITO_CLIENT_ID: "client",
      AWS_ENDPOINT_URL: "http://ministack:4566",
      AWS_REGION: "us-east-1",
    });
    expect(env.E2E_TESTING_ENABLED).toBe(false);
  });
});
