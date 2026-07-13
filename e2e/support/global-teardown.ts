export default async function globalTeardown() {
  const base = process.env.USERS_BASE_URL ?? "http://localhost:3000";
  // Soft-deletes every user tagged "E2E Source" (flag-gated endpoint).
  await fetch(`${base}/v1/users/e2e-cleanup`, { method: "DELETE" });
}
