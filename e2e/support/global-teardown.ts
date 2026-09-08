// Soft-deletes everything this suite created, in every service that stores rows.
//
// CONTRACT: Delete by TAG ("E2E Source"), never by caller. Teardown runs with NO
// identity — the rows belong to many throwaway users — so tagging is the only thing
// that makes a caller-less sweep possible. The clients send `X-E2E-Source: true` and
// each service honors it only under its own E2E_TESTING_ENABLED.
// CONTRACT: Keep this order — Tracking and Orders first, Users LAST. The other two
// reference Users rows by `usr_` id, so deleting Users first leaves them pointing at
// a soft-deleted parent mid-teardown.
// CONTRACT: Swallow every failure. Leftover local rows are harmless (every spec mints
// its own caller and ids); throwing would fail an otherwise green run and hide the
// real result. See [[2026-08-30-a-global-teardown-cannot-be-scoped]]

type CleanupTarget = { name: string; url: string; scopeByRunId?: boolean };

const TARGETS: CleanupTarget[] = [
  {
    name: "tracking",
    url: `${process.env.TRACKING_BASE_URL ?? "http://localhost:3002"}/v1/trackings/e2e-cleanup`,
    // CONTRACT: Keep this OFF. Scoping the FINAL sweep to one run leaves every earlier
    // run's rows alive and they accumulate — one run soft-deleted 20 trackings against
    // 25 orders, and whole-suite failures went from 1-2 to 7 and 9 across paired runs.
    // The service-side `?run_id=` support stays for a future per-spec cleanup, which is
    // where a scoped delete belongs; the one global sweep must leave the DB empty.
    // See [[2026-08-30-a-global-teardown-cannot-be-scoped]]
    scopeByRunId: false,
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

// Same shape Users and the Cognito trigger enforce — see global-setup.ts.
const RUN_ID_PATTERN = /^run_[A-Za-z0-9_:.-]{1,64}$/;

/**
 * Builds the DELETE URL for one cleanup target. With `scopeByRunId` and a valid
 * `E2E_RUN_ID`, Tracking's teardown is scoped via `?run_id=`; without one it stays
 * unscoped — the load-test and manual-teardown behaviour the service implements, and
 * the fallback to keep if the transport ever moves to an `x-e2e-run-id` header.
 */
function buildCleanupUrl(baseUrl: string, scopeByRunId: boolean | undefined): string {
  if (!scopeByRunId) return baseUrl;

  const runId = process.env.E2E_RUN_ID?.trim();
  if (!runId || !RUN_ID_PATTERN.test(runId)) return baseUrl;

  return `${baseUrl}?run_id=${encodeURIComponent(runId)}`;
}

async function cleanup({ name, url, scopeByRunId }: CleanupTarget): Promise<void> {
  const cleanupUrl = buildCleanupUrl(url, scopeByRunId);

  try {
    const res = await fetch(cleanupUrl, { method: "DELETE" });

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
