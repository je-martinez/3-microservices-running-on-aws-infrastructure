// The local stack (Floci + terraform apply + generated .env + docker compose)
// is provisioned by `make bootstrap` from the repo root — a multi-minute
// process that includes a full terraform apply. Re-running it implicitly on
// every `playwright test` invocation would make the E2E suite unpredictably
// slow, so global-setup only asserts the stack is already healthy and fails
// fast with an actionable message otherwise.
export default async function globalSetup() {
  const base = process.env.USERS_BASE_URL ?? "http://localhost:3000";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/v1/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `Users service is not healthy at ${base}/v1/health. ` +
      "Run `make bootstrap` from the repo root to provision Floci + terraform + docker compose, " +
      "then re-run the E2E suite.",
  );
}
