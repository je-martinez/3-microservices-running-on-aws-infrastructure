import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "@playwright/test";

// Load the GENERATED env files (written by `make env-file`) so API_GATEWAY_URL,
// the Cognito ids, and the service ports are available to every project +
// global-setup + specs. `npx playwright test` run from e2e/ does NOT auto-load
// a repo-root .env, so without this a clean run has API_GATEWAY_URL undefined
// and the gateway health check throws.
//
// Loaded EXPLICITLY rather than via a monolithic `.env`, because those are the
// two files this suite actually needs:
//   .env.local.infra — API_GATEWAY_URL and the Cognito ids (gateway auth)
//   .env.local.users — the Users service environment (ports, GRPC_API_KEY)
// See docs/superpowers/specs/2026-07-20-env-file-generation-design.md.
//
// IMPORTANT: plain `dotenv` (no `dotenv-expand`) performs NO variable
// expansion. That matters because API_GATEWAY_URL contains a literal
// `$default` path segment (Floci's REST API stage), e.g.
// `http://localhost:4566/restapis/<id>/$default/_user_request_` — it must be
// preserved verbatim, not treated as a shell/env variable reference.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env.local.infra", ".env.local.users"]) {
  dotenv.config({ path: path.join(repoRoot, file) });
}

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
