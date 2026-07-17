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
  const base = process.env.USERS_BASE_URL ?? "http://localhost:3000";
  await waitForHealthy(`${base}/v1/health`, `Users service is not healthy at ${base}/v1/health.`);

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
