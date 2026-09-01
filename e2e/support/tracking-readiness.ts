import { expect, type APIRequestContext } from "@playwright/test";

// CONTRACT: Poll Orders' includeTracking until tracking is non-null — NOT Tracking GET.
// Orders' 2s HTTP budget degrades to tracking:null on burst. Wait BEFORE MISS/HIT pairs.
// See [[testing]]

//: Bounded like every other poll in this suite. Generous against the measured
// worst case (~6s) so a slow local stack does not fail the spec, but finite: an
// order whose tracking never arrives is a real defect and must fail rather than
// hang.
const READY_TIMEOUT_MS = 30_000;

//: Gap between polls. Short enough to leave the window promptly once it closes —
// the wait is pure overhead in an otherwise fast spec.
const POLL_INTERVAL_MS = 500;

//: Pause after invalidating writes — Tracking's single dev worker queueing makes
// back-to-back reads overrun Orders' 2s budget and t1 MISS stores nothing.
export const TRACKING_BURST_SETTLE_MS = 2_000;

/** Lets Tracking's single dev-mode worker drain before a burst of reads. */
export async function settleAfterTrackingBurst(): Promise<void> {
  await new Promise((r) => setTimeout(r, TRACKING_BURST_SETTLE_MS));
}

/**
 * Caller headers: internal uses x-user-id; gateway JWT is already on the context.
 */
export type CallerHeaders = Record<string, string>;

/** Poll Orders until `?includeTracking=true` carries tracking (cacheable under TrackingCacheRules). */
export async function waitForOrderTrackingReadable(
  api: APIRequestContext,
  path: string,
  headers: CallerHeaders = {},
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastStatus = 0;
  let reads = 0;

  while (Date.now() < deadline) {
    const res = await api.get(path, { headers });
    lastStatus = res.status();
    reads++;
    if (lastStatus === 200 && (await res.json()).tracking !== null) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  expect(
    false,
    `Orders never included a tracking for ${path} within ${READY_TIMEOUT_MS}ms ` +
      `(${reads} reads, last status ${lastStatus}). The tracking is created by Orders calling ` +
      "POST /v1/trackings/init-tracking after its own transaction commits, and then read back " +
      "over HTTP with a 2s budget. A persistent null means either that init call never landed, " +
      "or every read to Tracking is overrunning the budget — check the Orders logs for " +
      "`init_tracking_succeeded` and for `tracking_read_failed`.",
  ).toBe(true);
}

/** Poll my-orders until every row has tracking (batch route, not implied by single-order wait). */
export async function waitForMyOrdersTrackingReadable(
  api: APIRequestContext,
  path: string,
  headers: CallerHeaders = {},
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastStatus = 0;
  let missing = -1;

  while (Date.now() < deadline) {
    const res = await api.get(path, { headers });
    lastStatus = res.status();
    if (lastStatus === 200) {
      const list = (await res.json()) as Array<{ tracking: unknown }>;
      missing = list.filter((o) => o.tracking === null).length;
      if (missing === 0) return;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  expect(
    false,
    `Not every order in ${path} had a tracking within ${READY_TIMEOUT_MS}ms ` +
      `(last status ${lastStatus}, ${missing} order(s) still null). The list read fans into ` +
      "Tracking's BATCH route with a 2s budget — check the Orders logs for `tracking_read_failed`.",
  ).toBe(true);
}
