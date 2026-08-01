import { test, expect } from "@playwright/test";
import { request } from "@playwright/test";
import { makeUser } from "../../support/chance-factory.js";
import { gatewayClient } from "../../support/gateway-client.js";

// The full cross-service journey, through the gateway only, in the order a real
// client would walk it:
//
//   register (with an address) → login → list products → create order (x-test-mode)
//     → read the tracking → poll it to DELIVERED
//
// The load-bearing step is order creation. A client never calls Tracking to create
// anything: `POST /v1/orders` is what brings a tracking into existence, because
// Orders calls Tracking's `POST /v1/trackings/init-tracking` AFTER its own
// transaction commits, forwarding the `x-user-id` it received from the gateway and
// the `shipping_address` it resolved from Users. Three services and two hops
// participate in producing the row this spec then reads — which is exactly why it
// belongs at the gateway layer and cannot be faked with a direct service call.
//
// Every request path is RELATIVE (no leading slash) — see gateway-client.ts: a
// leading slash replaces the whole baseURL path under WHATWG URL joining, so the
// request would land on Floci's S3 root instead of the gateway integration.

//: How long to wait for TestMode progression to reach DELIVERED.
//
// The design specifies one transition every 10s over four statuses
// (SHIPPED → ON_THE_WAY → OUT_FOR_DELIVERY → DELIVERED), so ~30s from creation.
// 75s is that budget with room for a slow local stack, and it is BOUNDED on
// purpose: an unbounded poll on a progression that can legitimately never finish
// (see the restart caveat below) would hang the suite instead of failing it.
const DELIVERY_TIMEOUT_MS = 75_000;

//: Gap between polls. Well under the 10s cadence, so the poller observes each
// intermediate status rather than skipping straight from SHIPPED to DELIVERED.
const POLL_INTERVAL_MS = 2_000;

//: The forward-only progression from the design. Index = position in the chain,
// which is what makes "is this history in forward order" and "did it overshoot"
// checkable as integer comparisons rather than string juggling.
const PROGRESSION = ["SHIPPED", "ON_THE_WAY", "OUT_FOR_DELIVERY", "DELIVERED"] as const;

type TrackingHistoryEntry = {
  tracking_id: string;
  user_id: string;
  order_id: string;
  status: string;
  datetime: string;
};

type TrackingPayload = {
  id: string;
  user_id: string;
  order_id: string;
  status: string;
  datetime: string;
  history: TrackingHistoryEntry[];
};

// Registers a user through the gateway and logs them in, returning BOTH the token
// and the internal `usr_` id from the register response.
//
// The existing `getGatewayToken()` helper returns only the token — enough for the
// Orders specs, not enough here. The `usr_` id is the whole point of step 5's
// assertion: the tracking's `user_id` must equal it, which proves Tracking resolved
// sub → `usr_` through Users' gRPC `GetUserById`. Without the id from register there
// is nothing to compare against, and the sub→`usr_` resolution would be untested.
//
// The address is passed deliberately: Users stores it, Orders reads it back during
// order creation, and it becomes the tracking's `shipping_address` snapshot. The
// snapshot is never rendered on any Tracking response (it is PII — see
// schemas.py), so this spec cannot assert on its value; supplying it exercises the
// path rather than verifying the payload.
async function registerAndLogin(): Promise<{ token: string; userId: string; email: string }> {
  const rawBaseURL = process.env.API_GATEWAY_URL;
  if (!rawBaseURL) throw new Error("API_GATEWAY_URL is not set — run `make bootstrap`.");
  // Trailing-slash baseURL + relative paths, same rule as gateway-client.ts.
  const baseURL = rawBaseURL.endsWith("/") ? rawBaseURL : `${rawBaseURL}/`;
  const ctx = await request.newContext({
    baseURL,
    extraHTTPHeaders: { "X-E2E-Source": "true" },
  });

  const user = makeUser();
  const reg = await ctx.post("v1/users/register", { data: user });
  expect(reg.status(), `register failed: ${await reg.text()}`).toBe(201);
  const registered = await reg.json();
  expect(registered.id).toMatch(/^usr_/);

  const login = await ctx.post("v1/users/login", {
    data: { email: user.email, password: user.password },
  });
  expect(login.status(), `login failed: ${await login.text()}`).toBe(200);
  const body = await login.json();
  // Field name taken from what auth.ts already does: accessToken, with idToken as
  // the fallback. Both were verified to pass the JWT authorizer.
  const token = body.accessToken ?? body.idToken;
  expect(token, `login returned no token: ${JSON.stringify(body)}`).toBeTruthy();

  await ctx.dispose();
  return { token, userId: registered.id as string, email: user.email };
}

test("the full journey through the gateway: user → order → tracking → DELIVERED", async () => {
  // Owns a ~30s progression plus a full register/login/order chain, so it needs
  // more than Playwright's 30s default. Set from the poll budget rather than a
  // magic number, so the two cannot drift apart.
  test.setTimeout(DELIVERY_TIMEOUT_MS + 60_000);

  // --- 1. Register, with an address ----------------------------------------
  const { token, userId } = await registerAndLogin();
  const api = await gatewayClient(token);

  // --- 3. Pick a product ----------------------------------------------------
  const products = await api.get("v1/products");
  expect(products.status()).toBe(200);
  const catalogue = await products.json();
  expect(Array.isArray(catalogue)).toBe(true);
  const product = catalogue.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product, "no product with stock in the catalogue").toBeTruthy();

  // --- 4. Create the order — THIS is what creates the tracking --------------
  // `x-test-mode: true` is a header on the ORDERS request, not a Tracking field:
  // Orders reads it, applies its own `E2E_TESTING_ENABLED` guard, and forwards the
  // resulting boolean to `init-tracking`. Only the exact string "true" activates it.
  const created = await api.post("v1/orders", {
    headers: { "x-test-mode": "true" },
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status(), `order creation failed: ${await created.text()}`).toBe(201);
  const order = await created.json();
  expect(order.id).toMatch(/^ord_/);

  // --- 5. Read the tracking -------------------------------------------------
  // `init-tracking` is called by Orders after its transaction commits, so the row
  // may not be visible on the very first attempt. Retry briefly rather than
  // sleeping a fixed amount: a fixed sleep is either flaky or slow, and this
  // distinguishes "not there yet" from "never arrives".
  const tracking = await waitForTracking(api, order.id);

  expect(tracking.order_id).toBe(order.id);
  expect(tracking.id).toMatch(/^trk_/);
  // Starts at SHIPPED, per the design's t=0 row.
  expect(tracking.status).toBe("SHIPPED");
  expect(tracking.history.length).toBeGreaterThanOrEqual(1);
  expect(tracking.history[0].status).toBe("SHIPPED");

  // The sub → `usr_` resolution, and the single most valuable assertion in this
  // file. The gateway injects `x-user-id` as the JWT's **sub**, never a `usr_` id
  // (`proxy_set_header x-user-id $jwt_sub`). For `tracking.user_id` to be the
  // `usr_` id that register returned, Tracking must have called Users' gRPC
  // `GetUserById` with that sub and persisted what came back. If it had simply
  // stored the header, this would be a Cognito UUID and would not match — which is
  // precisely the class of bug that reads as "correctly implemented" while being
  // wrong (services/tracking/CLAUDE.md §5b).
  expect(tracking.user_id).toBe(userId);
  expect(tracking.user_id).toMatch(/^usr_/);
  for (const entry of tracking.history) {
    expect(entry.user_id).toBe(userId);
    expect(entry.tracking_id).toBe(tracking.id);
    expect(entry.order_id).toBe(order.id);
  }

  // --- 6. Poll to DELIVERED -------------------------------------------------
  const delivered = await pollUntilDelivered(api, order.id);

  expect(delivered.status).toBe("DELIVERED");
  // Four statuses, one history row each — the design's completed-run count.
  expect(delivered.history).toHaveLength(PROGRESSION.length);
  expect(delivered.history.map((h) => h.status)).toEqual([...PROGRESSION]);

  // Forward order, asserted on progression POSITION rather than on the array
  // happening to look right: each row must sit strictly later in the chain than
  // the one before it. This also catches the ordering bug schemas.py documents —
  // same-second transitions tie on a bare timestamp sort and MySQL falls back to
  // PK order, which is alphabetical and would put DELIVERED first.
  const positions = delivered.history.map((h) => PROGRESSION.indexOf(h.status as never));
  expect(positions).not.toContain(-1); // no status outside the four valid values
  for (let i = 1; i < positions.length; i += 1) {
    expect(
      positions[i],
      `history is not in forward order: ${delivered.history.map((h) => h.status).join(" → ")}`,
    ).toBeGreaterThan(positions[i - 1]);
  }

  // No overshoot past the terminal state. DELIVERED is the last status and there is
  // nothing beyond it, so a fifth transition — or any repeat of DELIVERED — would
  // mean the progression kept running after it should have stopped.
  const deliveredRows = delivered.history.filter((h) => h.status === "DELIVERED");
  expect(deliveredRows).toHaveLength(1);

  // Terminal means terminal: it must still be DELIVERED with the same four rows a
  // moment later, not have advanced or grown.
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS * 2));
  const settled = await readTracking(api, order.id);
  expect(settled.status).toBe("DELIVERED");
  expect(settled.history).toHaveLength(PROGRESSION.length);
});

// Reads the tracking, asserting a 200. Separate from the pollers so a caller that
// expects the row to exist gets a clean failure if it does not.
async function readTracking(
  api: Awaited<ReturnType<typeof gatewayClient>>,
  orderId: string,
): Promise<TrackingPayload> {
  const res = await api.get(`v1/trackings/${orderId}`);
  expect(res.status(), `GET v1/trackings/${orderId} failed: ${await res.text()}`).toBe(200);
  return (await res.json()) as TrackingPayload;
}

// Waits for the tracking to appear at all. Bounded, with a message that names the
// hop that failed: if this times out, Orders never reached `init-tracking` (or the
// call failed silently), which is a different defect from a progression that
// stalls.
async function waitForTracking(
  api: Awaited<ReturnType<typeof gatewayClient>>,
  orderId: string,
): Promise<TrackingPayload> {
  const deadline = Date.now() + 20_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const res = await api.get(`v1/trackings/${orderId}`);
    lastStatus = res.status();
    if (lastStatus === 200) return (await res.json()) as TrackingPayload;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `No tracking for ${orderId} after 20s (last status ${lastStatus}). ` +
      "The tracking is created by Orders calling POST /v1/trackings/init-tracking after its " +
      "own transaction commits — so this means that call never happened or failed. Check the " +
      "Orders logs for the init-tracking request and TRACKING_BASE_URL in .env.local.orders.",
  );
}

// Polls to DELIVERED with a hard deadline. Never unbounded: TestMode progression is
// an in-process asyncio task, and a process restart mid-run loses it permanently,
// leaving the tracking frozen at whatever status it reached with nothing logged
// (services/tracking/CLAUDE.md §5c — accepted limitation, not a bug). Waiting
// forever on that would hang the whole suite, so it fails with a message that says
// which status it got stuck on and names the known cause.
async function pollUntilDelivered(
  api: Awaited<ReturnType<typeof gatewayClient>>,
  orderId: string,
): Promise<TrackingPayload> {
  const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
  const seen: string[] = [];
  let latest: TrackingPayload | undefined;

  while (Date.now() < deadline) {
    latest = await readTracking(api, orderId);
    if (seen[seen.length - 1] !== latest.status) seen.push(latest.status);
    if (latest.status === "DELIVERED") return latest;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Tracking for ${orderId} did not reach DELIVERED within ${DELIVERY_TIMEOUT_MS}ms. ` +
      `Statuses observed: ${seen.join(" → ") || "none"}; last history had ` +
      `${latest?.history.length ?? 0} row(s). TestMode progression is an in-process asyncio ` +
      "task — if the tracking container restarted mid-run (docker-watch rebuild, crash) the " +
      "pending task is LOST and the tracking stays frozen, with nothing logged. That is an " +
      "expected limitation, not a service bug: re-run against a stable stack. A freeze with no " +
      "restart, on the other hand, is a real defect.",
  );
}

// The other half of the contract guard. Orders maps Tracking's payload into a DTO it
// owns (Orders.Application.Tracking.TrackingDto), and the unit tests pin that DTO
// against a committed fixture. A fixture only catches drift once somebody remembers to
// update it, so this asserts the same shape against a tracking Tracking ACTUALLY
// produced, end to end through the gateway. If Tracking renames or drops a field, the
// mapped value arrives null here and this fails — which is the whole point of paying
// for a typed DTO instead of forwarding opaque JSON.
test("includeTracking returns Tracking's payload mapped onto the shape Orders declares", async () => {
  test.setTimeout(120_000);

  const { token } = await registerAndLogin();
  const api = await gatewayClient(token);

  const products = await api.get("v1/products");
  expect(products.status()).toBe(200);
  const catalogue = await products.json();
  const product = catalogue.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product, "no product with stock in the catalogue").toBeTruthy();

  const created = await api.post("v1/orders", {
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status(), `order creation failed: ${await created.text()}`).toBe(201);
  const order = await created.json();

  // Orders calls init-tracking after its own transaction commits, so give the row a
  // moment to exist before asking for it.
  await waitForTracking(api, order.id);

  // --- The default must stay untouched -------------------------------------
  // Every existing caller reads this endpoint without the parameter, and their payload
  // must not have changed shape. A bare order, not { order, tracking }.
  const withoutParam = await api.get(`v1/orders/${order.id}`);
  expect(withoutParam.status()).toBe(200);
  const bare = await withoutParam.json();
  expect(bare.id).toBe(order.id);
  expect(bare.tracking).toBeUndefined();
  expect(bare.order).toBeUndefined();

  // --- includeTracking=true -------------------------------------------------
  const withTracking = await api.get(`v1/orders/${order.id}?includeTracking=true`);
  expect(withTracking.status(), await withTracking.text()).toBe(200);
  const wrapped = await withTracking.json();

  expect(wrapped.order.id).toBe(order.id);
  expect(wrapped.tracking, "tracking was not included").toBeTruthy();

  // Every member Orders declares, asserted individually. A blanket toBeTruthy on the
  // object would pass with every field null, which is exactly what a rename produces.
  const t = wrapped.tracking;
  expect(t.id, "tracking.id — renamed or dropped in Tracking?").toMatch(/^trk_/);
  expect(t.user_id, "tracking.user_id — renamed or dropped?").toMatch(/^usr_/);
  expect(t.order_id).toBe(order.id);
  expect(typeof t.status, "tracking.status — renamed or dropped?").toBe("string");
  expect(typeof t.datetime, "tracking.datetime — renamed or dropped?").toBe("string");
  expect(Array.isArray(t.history), "tracking.history — renamed or no longer a list?").toBe(true);

  // The history entry names the tracking `tracking_id`, not `id` — the one place the
  // two shapes differ, and the easiest to get wrong.
  expect(t.history.length, "a new tracking should have at least one history row").toBeGreaterThan(0);
  const entry = t.history[0];
  expect(entry.tracking_id, "history[].tracking_id — renamed or dropped?").toBe(t.id);
  expect(entry.order_id).toBe(order.id);
  expect(typeof entry.status).toBe("string");
  expect(typeof entry.datetime).toBe("string");

  // --- The batch path, which is the one that can fan out -------------------
  const list = await api.get("v1/orders/my-orders?includeTracking=true");
  expect(list.status()).toBe(200);
  const wrappedList = await list.json();
  expect(Array.isArray(wrappedList)).toBe(true);

  const mine = wrappedList.find((o: { order: { id: string } }) => o.order.id === order.id);
  expect(mine, "the created order is missing from my-orders").toBeTruthy();
  expect(mine.tracking?.order_id).toBe(order.id);
});
