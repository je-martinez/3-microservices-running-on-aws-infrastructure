import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "#shared/": fileURLToPath(new URL("./src/shared/", import.meta.url)),
      "#features/": fileURLToPath(new URL("./src/features/", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Registers the in-memory tracer provider before any test module loads —
    // a provider registered later never reaches module-scope tracers. See the
    // comment in tests/setup-tracing.ts.
    setupFiles: ["./tests/setup-tracing.ts"],
    env: {
      DATABASE_WRITER_URL: "postgres://user:pass@localhost:5432/users",
      DATABASE_READER_URL: "postgres://user:pass@localhost:5432/users",
      E2E_TESTING_ENABLED: "false",
      PORT: "3000",
      COGNITO_USER_POOL_ID: "us-east-1_dummy",
      COGNITO_CLIENT_ID: "dummy_client",
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AWS_REGION: "us-east-1",
      EVENTS_QUEUE_URL: "http://localhost:4566/000000000000/3mrai-local-events",
      NODE_ENV: "test",
      WEBHOOK_SECRET: "test-webhook-secret",
      GRPC_PORT: "50051",
      GRPC_API_KEY: "test-grpc-key",
      // Required by the env schema, so the whole suite fails to import without
      // them. No Redis is contacted here: the reset-code store is exercised
      // against an in-memory fake, and nothing under test constructs the real
      // ioredis client (it is built lazily by the Awilix SINGLETON).
      REDIS_HOST: "localhost",
      REDIS_PORT: "6379",
      METRICS_INTERVAL_MS: "15000",
    },
  },
});
