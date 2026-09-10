import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "@playwright/test";
import { WEB_TIMEZONES } from "./support/web-projects";

// CONTRACT: Load these generated env files explicitly — `playwright test` run from
// e2e/ does NOT pick up a repo-root .env, and without them API_GATEWAY_URL is
// undefined and the gateway health check throws.
// CONTRACT: Do NOT add `dotenv-expand`. API_GATEWAY_URL carries a literal `$default`
// segment (Floci's REST stage) that expansion would eat.
// See [[env-files]]
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// .env.local.debug carries WS_URL, the realtime WebSocket API's host-reachable
// endpoint. Its other names collide with nothing in the two files above.
for (const file of [".env.local.infra", ".env.local.users", ".env.local.debug"]) {
  dotenv.config({ path: path.join(repoRoot, file) });
}

// CONTRACT: Strip the compose-network values of ORDERS_BASE_URL and TRACKING_BASE_URL
// that `.env.local.users` injects. The host-side clients read the same two names, so
// keeping them points the whole suite at hostnames the host cannot resolve and
// global-setup fails EVERY project with "Tracking service is not healthy at
// http://tracking:8000/v1/health" — which reads as a down stack, not an env collision.
// Only the FILE's values are cleared; dotenv never overwrites a pre-set shell override.
// See [[env-files]]
for (const containerOnly of ["ORDERS_BASE_URL", "TRACKING_BASE_URL"]) {
  const value = process.env[containerOnly];
  // Matches the compose-network form only (`http://orders:8080`), so a real
  // host-side override like `http://localhost:3001` survives untouched.
  if (value && /^https?:\/\/(orders|tracking):/.test(value)) {
    delete process.env[containerOnly];
  }
}

// CONTRACT: Do NOT `dotenv.config` `.env.local.tracking` or `.env.local.orders` — take
// TRACKING_CARRIER_API_KEY by name instead. Tracking shares TWELVE names with
// `.env.local.users` (DATABASE_*_URL, PORT, GRPC_API_KEY, the AWS_*/OTEL_* quartets),
// so loading it wholesale hands the suite Tracking's MySQL DSN as DATABASE_WRITER_URL
// the day someone reorders the list; Orders redefines TRACKING_BASE_URL as the
// container-internal host. A missing file is fine — only the carrier specs need the
// key, and they fail with their own actionable message (see tracking-carrier-key.ts).
// See [[env-files]]
const trackingEnvPath = path.join(repoRoot, ".env.local.tracking");
if (fs.existsSync(trackingEnvPath)) {
  const trackingEnv = dotenv.parse(fs.readFileSync(trackingEnvPath, "utf8"));
  if (trackingEnv.TRACKING_CARRIER_API_KEY) {
    process.env.TRACKING_CARRIER_API_KEY ??= trackingEnv.TRACKING_CARRIER_API_KEY;
  }
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
  // CONTRACT: Name the files literally here. This branch only runs when the var is
  // unset, so a reference to a non-existent binding stays green at runtime and fails
  // only under `tsc --noEmit` (TS2304).
  console.warn(
    `[playwright.config] API_GATEWAY_URL is not set after loading .env.local.infra ` +
      `and .env.local.users from ${repoRoot} — the gateway project will fail its own ` +
      "health check; internal-only runs are unaffected.",
  );
}

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./support/global-setup.ts",
  globalTeardown: "./support/global-teardown.ts",
  reporter: "list",
  // CONTRACT: Do NOT retune this on a single run. Whole-suite failures range 4-15
  // across runs of the SAME commit, because this machine also hosts the stack under
  // test, so one sample cannot rank two worker counts. 10 beats Playwright's default
  // (half the cores) because the suite is I/O-bound and its failures are mostly 30s
  // timeouts from specs starving behind a busy worker; 12 leaves Docker no headroom.
  // See [[testing]]
  workers: process.env.CI ? 4 : 10,
  projects: [
    {
      name: "internal",
      testDir: "./tests",
      // CONTRACT: Every subdirectory with its own project must be listed here.
      // `testDir: "./tests"` is RECURSIVE, so an unlisted one runs its specs
      // twice — under its own project and again under `internal`.
      // See [[testing]]
      testIgnore: [
        "**/gateway/**",
        "**/observability/**",
        "**/web/**",
        "**/otp.spec.ts",
        "**/password-reset.spec.ts",
      ],
      use: { baseURL: process.env.USERS_BASE_URL ?? "http://localhost:3000" },
    },
    {
      name: "gateway",
      testDir: "./tests/gateway",
      // Same split as `internal`: these three assert on delivered email.
      testIgnore: [
        "**/otp-flow.spec.ts",
        "**/password-reset-flow.spec.ts",
        "**/delivered-emails.spec.ts",
      ],
      use: { baseURL: process.env.API_GATEWAY_URL },
    },
    {
      // Asserts the committed OpenObserve dashboards still name fields the services
      // emit. Needs `make observability-up` (OpenObserve on :5080) on top of
      // `make bootstrap`; the spec skips with a named reason when it is unreachable.
      // baseURL is unused — the spec drives traffic through support/api-client.ts.
      name: "observability",
      testDir: "./tests/observability",
      use: { baseURL: process.env.USERS_BASE_URL ?? "http://localhost:3000" },
    },
    {
      // CONTRACT: Keep the email specs in their own single-worker project, and give it
      // NO `dependencies`. Every email crosses the shared SQS queue the emulator drains
      // at ~1 event/s, so racing them multiplies contention for that one cadence
      // (inlined: 3.1 min/11 failed vs 2.7 min/10 here). And Playwright CANCELS a
      // project whose dependency fails — two unrelated gateway failures once left all
      // 30 email specs unexecuted, reported as 151 tests instead of 181.
      // See [[2026-08-29-the-emulator-was-the-ceiling-not-the-code]]
      name: "email",
      testDir: "./tests",
      testMatch: [
        "**/otp.spec.ts",
        "**/password-reset.spec.ts",
        "**/gateway/otp-flow.spec.ts",
        "**/gateway/password-reset-flow.spec.ts",
        "**/gateway/delivered-emails.spec.ts",
      ],
      fullyParallel: false,
      workers: 1,
      // The gateway specs here resolve relative paths off the gateway; the two
      // internal ones carry their own base URLs through api-client.ts.
      use: { baseURL: process.env.API_GATEWAY_URL },
    },
    // Every route mounts and renders clean, and every rendered date reads the same in
    // both zones. The only projects needing NO BACKEND (the app renders fixtures), but
    // they do need `pnpm web:dev` on WEB_BASE_URL — which is why global-setup skips
    // its health checks for a web-only run.
    //
    // CONTRACT: One project per entry in WEB_TIMEZONES, and `web-projects.ts`
    // is the single list — global-setup reads it to decide whether to skip the
    // health checks. Adding a zone here only, or renaming one, silently makes a
    // web-only run demand a backend it never touches. See [[testing]]
    ...Object.entries(WEB_TIMEZONES).map(([name, timezoneId]) => ({
      name,
      testDir: "./tests/web",
      use: {
        baseURL: process.env.WEB_BASE_URL ?? "http://localhost:4200",
        timezoneId,
      },
    })),
  ],
});
