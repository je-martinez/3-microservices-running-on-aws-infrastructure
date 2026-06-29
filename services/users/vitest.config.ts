import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: {
      DATABASE_WRITER_URL: "postgres://user:pass@localhost:5432/users",
      DATABASE_READER_URL: "postgres://user:pass@localhost:5432/users",
      E2E_TESTING_ENABLED: "false",
      PORT: "3000",
      COGNITO_USER_POOL_ID: "us-east-1_dummy",
      COGNITO_CLIENT_ID: "dummy_client",
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AWS_REGION: "us-east-1",
    },
  },
});
