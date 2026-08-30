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
// Tracking additionally scopes cleanup by run id when one is available (see
// `buildCleanupUrl` below). An unscoped sweep there soft-deletes EVERY
// E2E-tagged row globally; with `workers: 10` one run's teardown can land
// inside another run's live TestMode progression and abort it mid-chain.
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

type CleanupTarget = { name: string; url: string; scopeByRunId?: boolean };

const TARGETS: CleanupTarget[] = [
  {
    name: "tracking",
    url: `${process.env.TRACKING_BASE_URL ?? "http://localhost:3002"}/v1/trackings/e2e-cleanup`,
    // Tracking alone: TestMode progressions tick for ~20s after creation and
    // abort on tracking_not_found when another run's unscoped sweep deletes
    // their row. Orders and Users have no equivalent in-flight work.
    // OFF, and the measurement is why. Scoping the FINAL teardown to this run
    // leaves every earlier run's rows alive, and they accumulate: one run
    // soft-deleted 20 trackings against 25 orders, and whole-suite failures went
    // from 1-2 to 7 and 9 across paired runs. The sweep is the only thing that
    // clears them, so narrowing it trades a rare mid-run collision for permanent
    // contamination.
    //
    // The service-side scoping stays and is worth keeping: `?run_id=` is
    // implemented and tested, so a FUTURE per-spec or per-worker cleanup — which
    // is where a scoped delete actually belongs — can use it without touching
    // Tracking again. What does not belong is scoping the one global sweep whose
    // job is to leave the database empty.
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
 * Builds the DELETE URL for one cleanup target.
 *
 * When `scopeByRunId` is set and `E2E_RUN_ID` is present and valid, Tracking's
 * teardown is scoped to this invocation via `?run_id=`. Without a run id (an
 * internal-only run, or a spec outside the harness) the call stays unscoped —
 * the load-test / manual-teardown behaviour the service already implements.
 *
 * TRANSPORT ASSUMPTION: query param `run_id`. The Go service worker may instead
 * read `x-e2e-run-id`; if so, switch this to a request header and keep the
 * fallback-to-unscoped rule unchanged.
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
