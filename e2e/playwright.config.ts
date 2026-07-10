import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./support/global-setup.ts",
  globalTeardown: "./support/global-teardown.ts",
  use: { baseURL: process.env.USERS_BASE_URL ?? "http://localhost:3000" },
  reporter: "list",
});
