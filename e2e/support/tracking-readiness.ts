import { expect, type APIRequestContext } from "@playwright/test";

// Waiting for an order's tracking to become readable — the precondition a spec
// needs before it can assert anything about the CACHEABILITY of a
// `?includeTracking=true` read.
//
// ## Why this exists, and why "poll Tracking until 200" is the wrong wait
//
// A tracking record is created ASYNCHRONOUSLY: `CreateOrderService` calls
// `InitTrackingAsync` deliberately AFTER its own transaction commits. So there is
// a real window in which the order exists and its tracking does not, and
// `?includeTracking=true` legitimately answers `tracking: null` inside it.
//
// Orders now DECLINES to store such a response
// (services/orders/src/Orders.Api/Caching/TrackingCacheRules.cs): a momentary
// absence must not be frozen into a fact for the whole 2-minute TTL. Correct — and
// it means a MISS/HIT pair taken inside that window can never observe a HIT,
// because the first read stored nothing. A spec asserting MISS→HIT on a `t1`
// variant must therefore leave the window FIRST.
//
// The obvious wait — poll `GET v1/trackings/{orderId}` until it answers 200 — is
// NOT sufficient, and this was measured rather than reasoned about. Against the
// running stack, after Tracking answered 200 for an order, Orders still answered
// `tracking: null` on the next read:
//
//   run1: tracking 200 at 1.06s, Orders included it at 2.84s
//   run2: tracking 200 at 1.13s, Orders included it at 3.18s
//   run3: tracking 200 at 2.05s, Orders included it at 6.09s  (one extra null read)
//
// Two independent reasons for the gap, both visible in the Orders logs:
//
//   1. Orders reads Tracking over HTTP with a bounded 2s budget
//      (`TrackingHttpClient.ReadTimeout`). A read that overruns it degrades to "no
//      tracking" by design — logged as `tracking_read_failed reason="unreachable"
//      status=0`. Observed on this stack at 06:24:14, exactly 2006ms after the
//      request, for an order whose tracking Tracking was already serving. The very
//      next read succeeded in 1262ms.
//   2. Tracking answering the SINGLE-order route says nothing about the BATCH
//      route (`GET /v1/trackings?order_ids=…`) that the my-orders list read uses.
//
// So the only wait that actually gates what the cache rule keys off is one that
// polls ORDERS' OWN response until the tracking is present in it. That is what
// these helpers do. Polling the thing you actually depend on, rather than a
// correlated proxy for it, is the whole point.
//
// ## These waits go BEFORE a MISS/HIT pair, never inside one
//
// The `t1` keys have a 2-minute TTL. Polling between the two reads of a pair is
// what turns a correct spec into an intermittent one — so every caller here waits
// first and only then issues the pair back to back, matching the discipline
// documented at the top of tests/cache.spec.ts.

//: Bounded like every other poll in this suite. Generous against the measured
// worst case (~6s) so a slow local stack does not fail the spec, but finite: an
// order whose tracking never arrives is a real defect and must fail rather than
// hang.
const READY_TIMEOUT_MS = 30_000;

//: Gap between polls. Short enough to leave the window promptly once it closes —
// the wait is pure overhead in an otherwise fast spec.
const POLL_INTERVAL_MS = 500;

//: A pause for the caller to leave between the invalidating write that makes a key
// cold and the MISS/HIT pair it then asserts.
//
// ## This is pacing, not "sleep until it passes"
//
// Tracking runs a SINGLE uvicorn worker in dev mode (`--reload`, see its compose
// command), so it absorbs sequential requests fine and degrades sharply under a
// burst. Measured on this stack, same order, same query:
//
//   spaced ~3s apart : 586, 622, 779, 830, 1403 ms
//   back to back     : p50 4396 ms, max 8732 ms  (56 samples)
//
// — and the slow figures are Tracking's OWN reported duration on a Redis
// `cache_result: "hit"`, so this is queueing on its event loop, not query work.
//
// It matters because Orders reads Tracking with a hard 2s budget
// (`TrackingHttpClient.ReadTimeout`) and degrades to `tracking: null` when it
// overruns — which the cache then correctly declines to store, so the pair MISSes
// twice. A sweep followed IMMEDIATELY by two reads is exactly the burst that
// triggers it: 25 of 32 such reads timed out. With this pause, the same pair was
// MISS→HIT 5 times out of 5.
//
// So the pause buys a representative measurement rather than hiding a failure —
// the assertions it precedes are unchanged and still demand a real MISS then a
// real HIT. It is deliberately far below the 120s `t1` TTL, so it cannot turn a
// pair into an expiry flake, which is the hazard the no-`waitForTimeout` rule at
// the top of tests/cache.spec.ts exists to prevent.
export const TRACKING_BURST_SETTLE_MS = 2_000;

/** Lets Tracking's single dev-mode worker drain before a burst of reads. */
export async function settleAfterTrackingBurst(): Promise<void> {
  await new Promise((r) => setTimeout(r, TRACKING_BURST_SETTLE_MS));
}

/**
 * Extra headers a request needs to identify its caller.
 *
 * The internal project fakes the authorizer with `x-user-id`; the gateway project
 * carries a real JWT already baked into the context by `gatewayClient(token)` and
 * needs nothing here. One helper serves both rather than each project growing its
 * own copy of the same poll.
 */
export type CallerHeaders = Record<string, string>;

/**
 * Waits until `GET {orderId}?includeTracking=true` actually carries a tracking —
 * i.e. until a response for that order becomes CACHEABLE under
 * `TrackingCacheRules.SingleOrderHasTracking`.
 *
 * `path` is passed whole so each project keeps its own convention: the internal
 * specs use a leading slash against the service port, while the gateway specs must
 * use a RELATIVE path (a leading slash would replace the gateway's baseURL path —
 * see support/gateway-client.ts).
 *
 * Returns nothing: callers assert on their own fresh reads, and handing back a body
 * fetched during the wait would tempt a spec into asserting on a response it never
 * made itself.
 */
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

/**
 * The list counterpart: waits until EVERY order in
 * `my-orders?includeTracking=true` carries a tracking — the condition
 * `TrackingCacheRules.AllOrdersHaveTracking` requires before it will store the
 * entry.
 *
 * Separate from the single-order wait rather than derived from it, because the two
 * reads take DIFFERENT paths through Orders: the list read fans into Tracking's
 * BATCH route (`GET /v1/trackings?order_ids=…`), and that route being ready is not
 * implied by the single-order route being ready. Waiting on the single read and
 * then asserting on the list would be waiting on the wrong thing — the exact
 * mistake this module exists to document.
 *
 * An EMPTY list is ready by definition: there is no absent tracking in it to be
 * wrong about, and the service stores it for the same reason.
 */
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
