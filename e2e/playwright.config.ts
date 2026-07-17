import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "@playwright/test";

// Load the repo-root `.env` (written by `make env-file`) so API_GATEWAY_URL,
// USERS_BASE_URL, etc. are available to every project + global-setup + specs.
// `npx playwright test` run from e2e/ does NOT auto-load a repo-root .env, so
// without this a clean run has API_GATEWAY_URL undefined and the gateway
// health check throws.
//
// IMPORTANT: plain `dotenv` (no `dotenv-expand`) performs NO variable
// expansion. That matters because API_GATEWAY_URL contains a literal
// `$default` path segment (Floci's REST API stage), e.g.
// `http://localhost:4566/restapis/<id>/$default/_user_request_` — it must be
// preserved verbatim, not treated as a shell/env variable reference.
const repoRootEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
dotenv.config({ path: repoRootEnvPath });

// Sanity check: confirm the literal `$default` segment survived loading.
if (process.env.API_GATEWAY_URL) {
  console.log(`[playwright.config] API_GATEWAY_URL loaded: ${process.env.API_GATEWAY_URL}`);
  if (!process.env.API_GATEWAY_URL.endsWith("/$default/_user_request_")) {
    console.warn(
      "[playwright.config] WARNING: API_GATEWAY_URL does not end with the expected literal " +
        "'/$default/_user_request_' suffix — check for unwanted variable expansion in the .env loader.",
    );
  }
} else {
  console.warn(
    `[playwright.config] API_GATEWAY_URL is not set after loading ${repoRootEnvPath} — ` +
      "the gateway project will fail its own health check; internal-only runs are unaffected.",
  );
}

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./support/global-setup.ts",
  globalTeardown: "./support/global-teardown.ts",
  reporter: "list",
  projects: [
    {
      name: "internal",
      testDir: "./tests",
      testIgnore: "**/gateway/**",
      use: { baseURL: process.env.USERS_BASE_URL ?? "http://localhost:3000" },
    },
    {
      name: "gateway",
      testDir: "./tests/gateway",
      use: { baseURL: process.env.API_GATEWAY_URL },
    },
  ],
});
