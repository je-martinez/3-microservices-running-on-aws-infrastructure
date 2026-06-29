import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./support/global-setup.ts",
  globalTeardown: "./support/global-teardown.ts",
  use: { baseURL: process.env.API_INVOKE_URL },
  reporter: "list",
});
