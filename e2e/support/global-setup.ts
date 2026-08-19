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
  // The `web` project is the one project that needs NO BACKEND: the phase-1 web
  // app renders fixtures and makes no gateway call. globalSetup is a top-level
  // option, so it runs for EVERY invocation including `--project=web` — without
  // this guard a machine that has never run `make bootstrap` sees a web-only run
  // die on a Users health check it does not depend on, which reads as "the web
  // suite is broken" when nothing about the web app is.
  //
  // Read from argv, NOT from globalSetup's `config.projects`: that argument holds
  // every project DECLARED in the config regardless of --project (verified — it
  // logs ["internal","gateway","observability","web"] on a `--project=web` run),
  // so filtering on it silently never matches and the guard does nothing.
  //
  // Requiring EVERY --project to be `web` keeps a mixed run
  // (`--project=web --project=internal`) doing the checks, and an unfiltered
  // `pnpm e2e` (no --project at all) does them too.
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
}
