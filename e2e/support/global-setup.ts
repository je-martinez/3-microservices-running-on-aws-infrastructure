import { readEventsQueueDepth, EVENTS_QUEUE_WARN_DEPTH } from "./events-queue-depth.js";
import { restockCatalogue } from "./restock-catalogue.js";
import { purgeMailpit } from "./purge-mailpit.js";
import { randomUUID } from "node:crypto";
import { isWebProject, WEB_PROJECT_NAMES } from "./web-projects.js";

// CONTRACT: Only assert the stack is healthy — never provision it. `make bootstrap`
// is a multi-minute terraform apply, and running it per `playwright test` invocation
// would make the suite unpredictably slow. Fail fast with an actionable message.
// See [[local-dev]]

async function waitForHealthy(url: string, notHealthyMessage: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `${notHealthyMessage} ` +
      "Run `make bootstrap` from the repo root to provision Floci + terraform + docker compose, " +
      "then re-run the E2E suite.",
  );
}

export default async function globalSetup() {
  // CONTRACT: Detect the selected projects from argv, NOT from globalSetup's
  // `config.projects` — that argument lists every project DECLARED in the
  // config regardless of --project, so filtering on it silently never matches
  // and this guard does nothing. globalSetup is top-level and runs for every
  // invocation, so without it a `--project=web-tokyo` run on a machine that never
  // ran `make bootstrap` dies on a Users health check the web app does not use.
  // Requiring EVERY --project to be a web project (the list lives in
  // web-projects.ts) keeps mixed and unfiltered runs checking. See [[testing]]
  const selectedProjects = process.argv
    .flatMap((arg, i) =>
      arg === "--project" ? [process.argv[i + 1]] : arg.startsWith("--project=") ? [arg.slice("--project=".length)] : [],
    )
    .filter((name): name is string => Boolean(name));

  if (selectedProjects.length > 0 && selectedProjects.every(isWebProject)) {
    console.log(
      `[global-setup] Only web projects are selected (${WEB_PROJECT_NAMES.join(", ")}) — skipping ` +
        "the service health checks. They render fixtures and need no backend, just the dev " +
        "server (`pnpm web:dev`).",
    );
    return;
  }

  // CONTRACT: Mint ONE id here and pass it through the environment — never a
  // module-level constant. globalSetup and the workers are separate processes, so a
  // constant gives each worker its own id and defeats the correlation. The shape must
  // satisfy /^run_[A-Za-z0-9_:.-]{1,64}$/, which Users and the Cognito trigger
  // re-validate independently: a value one accepts and the other rejects is silently
  // dropped on exactly one OTP path. See [[testing]]
  process.env.E2E_RUN_ID = `run_${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  console.log(`[global-setup] run id: ${process.env.E2E_RUN_ID}`);

  const base = process.env.USERS_BASE_URL ?? "http://localhost:3000";
  await waitForHealthy(`${base}/v1/health`, `Users service is not healthy at ${base}/v1/health.`);

  // Tracking's health route is UNPREFIXED internally (`/v1/health`); the prefixed
  // `/v1/tracking/health` exists only on the gateway side, where nginx rewrites.
  // Checked separately because TestMode progression is an in-process task, so a
  // restarted container is exactly what makes the journey spec's poll time out for a
  // non-bug reason — failing here names the cause instead.
  const trackingBase = process.env.TRACKING_BASE_URL ?? "http://localhost:3002";
  await waitForHealthy(
    `${trackingBase}/v1/health`,
    `Tracking service is not healthy at ${trackingBase}/v1/health.`,
  );

  // A public route (no auth), so this stays a pure connectivity check independent of
  // the JWT authorizer.
  // CONTRACT: Tolerate a missing API_GATEWAY_URL. The `internal` project never touches
  // the gateway, so hard-failing here would break an internal-only run; the gateway
  // project's own client fails loudly when it actually needs the var.
  const gatewayBase = process.env.API_GATEWAY_URL;
  if (!gatewayBase) {
    console.warn(
      "[global-setup] API_GATEWAY_URL is not set — skipping the gateway health check. " +
        "This is fine for an internal-only run; the gateway project needs it and will fail on its own if unset.",
    );
  } else {
    await waitForHealthy(
      `${gatewayBase}/v1/orders/health`,
      `API Gateway is not healthy at ${gatewayBase}/v1/orders/health.`,
    );
  }

  // CONTRACT: Keep this AFTER the health checks and BEFORE the queue warning. It calls
  // Orders, so an unhealthy stack must fail with the health message naming
  // `make bootstrap`, not a cleanup error — and the queue warning must stay the last
  // thing on screen. A failure here is FATAL, unlike the teardown's copy.
  await restockCatalogue();

  // Empty the inbox before any worker starts. This is the ONLY safe point for a
  // destructive Mailpit call — see purge-mailpit.ts for why a mid-run purge
  // would delete a concurrent worker's email and cause the failure it prevents.
  await purgeMailpit();

  await warnOnEventsQueueBacklog();
}

// CONTRACT: WARN here, never fail. global-setup runs once before any spec is selected,
// so it cannot tell an email-asserting run from the majority that never touch the
// pipeline — failing would let a transient, self-healing load-test backlog block the
// ENTIRE suite. Silent on `null` too: a check that cannot read the depth says nothing
// rather than guessing. See [[2026-08-29-the-emulator-was-the-ceiling-not-the-code]]
async function warnOnEventsQueueBacklog() {
  const depth = await readEventsQueueDepth();
  if (depth === null || depth <= EVENTS_QUEUE_WARN_DEPTH) return;

  // ~1 msg/s, so the depth doubles as a rough ETA in seconds.
  const etaMinutes = Math.ceil(depth / 60);

  console.warn(
    `[global-setup] WARNING: the events queue is ${depth} messages deep ` +
      `(warning above ${EVENTS_QUEUE_WARN_DEPTH}). The events-pipeline Lambda drains it at ` +
      `roughly 1 msg/s, so a newly published event waits behind that backlog for about ` +
      `${etaMinutes} minute(s) — well past the 45s budget every email-asserting spec uses. ` +
      "Those specs will fail reporting that NOTHING arrived; the emails are NOT lost, they " +
      "arrive far too late. This is what a Gatling load run leaves behind (see e2e/CLAUDE.md " +
      "§4). Wait for the queue to drain, or reset with `make clean && make bootstrap`. " +
      "Specs that assert no email are unaffected.",
  );
}
