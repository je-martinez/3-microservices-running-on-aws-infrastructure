import { readEventsQueueDepth, EVENTS_QUEUE_WARN_DEPTH } from "./events-queue-depth.js";
import { restockCatalogue } from "./restock-catalogue.js";
import { purgeMailpit } from "./purge-mailpit.js";
import { randomUUID } from "node:crypto";

// The local stack (Floci + terraform apply + generated .env + docker compose)
// is provisioned by `make bootstrap` from the repo root — a multi-minute
// process that includes a full terraform apply. Re-running it implicitly on
// every `playwright test` invocation would make the E2E suite unpredictably
// slow, so global-setup only asserts the stack is already healthy and fails
// fast with an actionable message otherwise.

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
  // invocation, so without it a `--project=web` run on a machine that never ran
  // `make bootstrap` dies on a Users health check the web app does not use.
  // Requiring EVERY --project to be `web` keeps mixed and unfiltered runs
  // checking. See [[testing]]
  const selectedProjects = process.argv
    .flatMap((arg, i) =>
      arg === "--project" ? [process.argv[i + 1]] : arg.startsWith("--project=") ? [arg.slice("--project=".length)] : [],
    )
    .filter((name): name is string => Boolean(name));

  if (selectedProjects.length > 0 && selectedProjects.every((name) => name === "web")) {
    console.log(
      "[global-setup] Only the `web` project is selected — skipping the service health checks. " +
        "It renders fixtures and needs no backend, just the dev server (`pnpm web:dev`).",
    );
    return;
  }

  // ONE id per `playwright test` invocation, minted before any worker starts and
  // handed to them through the environment — globalSetup and the workers are
  // separate processes, so a module-level constant would give each worker its
  // own id and defeat the correlation this exists for.
  //
  // Timestamp first so ids sort chronologically when read straight out of the
  // fixture collection. The shape must satisfy /^run_[A-Za-z0-9_:.-]{1,64}$/,
  // which BOTH Users and the Cognito trigger re-validate independently — a value
  // accepted by one and rejected by the other would be silently dropped on
  // exactly one of the OTP paths.
  process.env.E2E_RUN_ID = `run_${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  console.log(`[global-setup] run id: ${process.env.E2E_RUN_ID}`);

  const base = process.env.USERS_BASE_URL ?? "http://localhost:3000";
  await waitForHealthy(`${base}/v1/health`, `Users service is not healthy at ${base}/v1/health.`);

  // Tracking, same fail-fast rationale. Its health route is served UNPREFIXED
  // internally (`/v1/health`) — the gateway publishes `/v1/tracking/health` and
  // nginx rewrites, so the prefixed spelling only exists on the gateway side.
  //
  // Worth checking separately rather than letting a spec discover it: Tracking's
  // TestMode progression is an in-process asyncio task, so a container that
  // restarted is exactly the condition under which the journey spec's poll times
  // out for a non-bug reason. Failing here names the cause instead.
  const trackingBase = process.env.TRACKING_BASE_URL ?? "http://localhost:3002";
  await waitForHealthy(
    `${trackingBase}/v1/health`,
    `Tracking service is not healthy at ${trackingBase}/v1/health.`,
  );

  // Also assert the gateway project's target is healthy — same fail-fast
  // rationale as the service check above. Uses a public route (no auth) so
  // this stays a pure connectivity check, independent of the JWT authorizer.
  //
  // This check is intentionally tolerant of a missing API_GATEWAY_URL: the
  // `internal` project doesn't use the gateway at all, so global-setup must
  // not hard-fail an internal-only run (e.g. `--project=internal`) just
  // because the gateway var isn't set. If the gateway project is actually
  // selected and needs it, its own specs/gateway-client will fail loudly.
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

  // Restore catalogue stock before anything runs. Placed AFTER the health checks
  // (it calls Orders, so an unhealthy stack should fail with the health message
  // that names `make bootstrap`, not with a cleanup error) and BEFORE the queue
  // warning, so the loud diagnostic stays the last thing on screen.
  //
  // Unlike the teardown's copy of this call, a failure here is FATAL — see
  // restock-catalogue.ts for why setup and teardown differ on that point.
  await restockCatalogue();

  // Empty the inbox before any worker starts. This is the ONLY safe point for a
  // destructive Mailpit call — see purge-mailpit.ts for why a mid-run purge
  // would delete a concurrent worker's email and cause the failure it prevents.
  await purgeMailpit();

  await warnOnEventsQueueBacklog();
}

// Warns when the shared events queue is backed up far enough that any email
// assertion in this run will time out for a reason that has nothing to do with
// the code under test.
//
// ## Why a warning and NOT a hard failure
//
// global-setup runs ONCE for the whole invocation, before any spec is selected,
// so it cannot tell an email-asserting run from the large majority of specs that
// never touch the pipeline at all. Failing here would let a transient load-test
// backlog block the ENTIRE suite — turning a narrow, self-healing problem into a
// total blocker. A loud warning gives the reader the diagnosis they would
// otherwise spend an hour deriving, without taking the decision out of their
// hands.
//
// It is also silent on `null` (see readEventsQueueDepth): a check that cannot
// read the depth says nothing rather than guessing.
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
