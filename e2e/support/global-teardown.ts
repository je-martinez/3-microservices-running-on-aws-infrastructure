export default async function globalTeardown() {
  const base = process.env.API_INVOKE_URL;
  if (!base) return;
  // Soft-deletes every user tagged "E2E Source" (flag-gated endpoint).
  await fetch(`${base}/v1/users/e2e-cleanup`, { method: "DELETE" });
}
