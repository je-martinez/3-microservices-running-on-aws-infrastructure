import { fileURLToPath } from "node:url";
import fs from "node:fs";
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
// two files this suite loads WHOLESALE:
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
// .env.local.debug is loaded too, alongside the other two — it is where
// `make env-file` (Task 9) writes WS_URL, the realtime WebSocket API's
// HOST-reachable endpoint. Nothing else in this file's own vars collides
// with the other two (see its own header: "loaded by nothing — copy the
// value you need"), so adding it here is additive, not a behavior change
// for existing specs.
for (const file of [".env.local.infra", ".env.local.users", ".env.local.debug"]) {
  dotenv.config({ path: path.join(repoRoot, file) });
}

// `.env.local.tracking` is NOT loaded wholesale — only the one variable the suite
// needs is copied out of it. TRACKING_CARRIER_API_KEY is the sole credential that
// authenticates `PUT /v1/trackings/{orderId}/status`: that gateway route is declared
// `auth = false` (no Cognito authorizer, no `x-user-id`), so a spec cannot derive the
// key from a JWT and must read the real value — while never hardcoding it in test
// source.
//
// Cherry-picked rather than `dotenv.config`'d because that file shares TWELVE names
// with `.env.local.users` (DATABASE_WRITER_URL, DATABASE_READER_URL, PORT,
// GRPC_API_KEY, the AWS_* quartet, the OTEL_* quartet). dotenv does not overwrite an
// already-set variable, so today load order alone keeps Users' values winning —
// a silent dependency on array order that would hand the suite Tracking's MySQL DSN
// as `DATABASE_WRITER_URL` the day someone reorders the list. Parsing and taking one
// key by name removes the hazard instead of relying on it not firing.
//
// `.env.local.orders` is likewise not loaded: it defines TRACKING_BASE_URL as the
// container-internal `http://tracking:8000`, unreachable from the host, which would
// override the localhost:3002 default the internal Tracking specs need.
// A missing file is not fatal: it only means `make env-file` has not run yet, and
// every non-carrier spec is unaffected. The carrier specs fail loudly on their own
// with an actionable message (see tracking-carrier-key.ts).
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
  // Named the files actually loaded rather than a `repoRootEnvPath` variable that
  // never existed — it was a leftover from when this loaded a single monolithic
  // `.env`, and referencing it made `tsc --noEmit` fail (TS2304) while the runtime
  // path stayed green, because this branch only executes when the var is unset.
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
  projects: [
    {
      name: "internal",
      testDir: "./tests",
      // `testDir: "./tests"` is RECURSIVE, so every subdirectory that has its own
      // project must also be ignored here or its specs run twice — once under
      // their own project and once under `internal`. `gateway` established the
      // pattern; `observability` follows it.
      testIgnore: ["**/gateway/**", "**/observability/**", "**/web/**"],
      use: { baseURL: process.env.USERS_BASE_URL ?? "http://localhost:3000" },
    },
    {
      name: "gateway",
      testDir: "./tests/gateway",
      use: { baseURL: process.env.API_GATEWAY_URL },
    },
    {
      // Asserts the committed OpenObserve dashboards still reference fields the
      // services actually emit. Unlike the other two projects this one needs the
      // OBSERVABILITY STACK (`make observability-up`) on top of `make bootstrap`
      // — OpenObserve on :5080. The spec skips with an explicit, named reason
      // when that is unreachable, so a run without it reads as "prerequisite
      // missing" rather than as a confusing connection failure.
      //
      // baseURL is the Users service because the spec generates its traffic
      // through the direct-service clients (support/api-client.ts), which carry
      // their own base URLs; nothing here resolves a relative path off baseURL.
      name: "observability",
      testDir: "./tests/observability",
      use: { baseURL: process.env.USERS_BASE_URL ?? "http://localhost:3000" },
    },
    {
      // Phase-1 web verification: every route mounts and renders clean.
      //
      // Unlike every other project this one needs NO BACKEND — the app renders
      // fixtures and phase 1 makes no gateway call at all (spec's phase-1
      // boundary). What it does need is the Angular dev server on WEB_BASE_URL:
      // `pnpm web:dev`. That asymmetry is also why global-setup skips its
      // service health checks for a web-only run — see support/global-setup.ts.
      name: "web",
      testDir: "./tests/web",
      use: { baseURL: process.env.WEB_BASE_URL ?? "http://localhost:4200" },
    },
  ],
});
