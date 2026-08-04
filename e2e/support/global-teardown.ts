// Soft-deletes everything this suite created, in every service that stores rows.
//
// Each service exposes a flag-guarded `e2e-cleanup` route that deletes by TAG
// ("E2E Source"), not by caller: the rows were created by many different
// throwaway users across the run, and teardown holds no identity for any of
// them. Tagging is what makes a caller-less cleanup possible — the suite's HTTP
// clients send `X-E2E-Source: true` on every request (support/api-client.ts and
// support/gateway-client.ts), and each service honors it only when its own
// E2E_TESTING_ENABLED is set.
//
// Order matters: Tracking and Orders first, Users last. Users is the one whose
// rows the other two reference (their `user_id` is a `usr_` id), so deleting it
// first would leave the others pointing at a soft-deleted parent mid-teardown.
//
// Cleanup is best-effort by design. A failure here means leftover local rows,
// which is untidy but harmless (every spec creates its own caller and its own
// synthetic ids, so nothing collides across runs). Throwing would fail an
// otherwise green run and hide the real result, so each call is reported and
// swallowed.

type CleanupTarget = { name: string; url: string };

const TARGETS: CleanupTarget[] = [
  {
    name: "tracking",
    url: `${process.env.TRACKING_BASE_URL ?? "http://localhost:3002"}/v1/trackings/e2e-cleanup`,
  },
  {
    name: "orders",
    url: `${process.env.ORDERS_BASE_URL ?? "http://localhost:3001"}/v1/orders/e2e-cleanup`,
  },
  {
    name: "users",
    url: `${process.env.USERS_BASE_URL ?? "http://localhost:3000"}/v1/users/e2e-cleanup`,
  },
];

async function cleanup({ name, url }: CleanupTarget): Promise<void> {
  try {
    const res = await fetch(url, { method: "DELETE" });

    // 404/405 both mean "the route is not mounted", i.e. E2E_TESTING_ENABLED is
    // off for that service. Tracking answers 405 specifically because
    // /v1/trackings/e2e-cleanup still matches GET /v1/trackings/{order_id} as a
    // path when the cleanup route is absent — only the method fails to match.
    // That is a configuration state worth naming, not a failure to retry.
    if (res.status === 404 || res.status === 405) {
      console.warn(
        `[teardown] ${name}: cleanup route not mounted (${res.status}) — ` +
          "E2E_TESTING_ENABLED is off for that service, so its rows were left behind.",
      );
      return;
    }

    if (!res.ok) {
      console.warn(`[teardown] ${name}: cleanup failed with ${res.status} ${await res.text()}`);
      return;
    }

    // Every service reports how many rows it soft-deleted. Logged rather than
    // asserted: a run that created nothing legitimately deletes nothing.
    const body = (await res.json().catch(() => null)) as { deleted?: number } | null;
    console.log(`[teardown] ${name}: soft-deleted ${body?.deleted ?? "?"} row(s).`);
  } catch (err) {
    console.warn(`[teardown] ${name}: cleanup could not be reached — ${(err as Error).message}`);
  }
}

export default async function globalTeardown() {
  // Sequential, not Promise.all: the ordering above is the point.
  for (const target of TARGETS) {
    await cleanup(target);
  }
}
