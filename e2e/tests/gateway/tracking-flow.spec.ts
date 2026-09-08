import { test, expect } from "@playwright/test";
import { request } from "@playwright/test";
import { makeUser } from "../../support/chance-factory.js";
import { gatewayClient } from "../../support/gateway-client.js";
import {
  assertMailpitReachable,
  getMessage,
  waitForEmailTo,
  type MailpitMessage,
} from "../../support/mailpit-client.js";
import {
  waitForMyOrdersTrackingReadable,
  waitForOrderTrackingReadable,
} from "../../support/tracking-readiness.js";

// The full cross-service journey through the gateway: register (with an address) →
// login → list products → create order (x-test-mode) → read the tracking → poll to
// DELIVERED. Order creation is the load-bearing step — `POST /v1/orders` is what
// brings a tracking into existence, so three services and two hops produce the row
// this spec reads, which is why it cannot be faked with a direct service call.
// CONTRACT: Keep every request path RELATIVE (no leading slash). A leading slash
// replaces the whole baseURL path under WHATWG URL joining and the request lands on
// Floci's S3 root instead of the gateway integration. See [[testing]]

//: TestMode progression is five statuses at one transition per 10s, so ~40s; 90s
// leaves room for a slow local stack. BOUNDED on purpose — the progression can
// legitimately never finish (see pollUntilDelivered), and an unbounded poll would
// hang the whole suite instead of failing this one spec.
const DELIVERY_TIMEOUT_MS = 90_000;

//: Gap between polls. Well under the 10s cadence, so the poller observes each
// intermediate status rather than skipping straight from PLACED to DELIVERED.
const POLL_INTERVAL_MS = 2_000;

//: How long to wait for the pipeline's emails once the journey is complete.
// Locally the whole chain (producer → SQS → Lambda → SES → Mailpit) settles in a
// few seconds; 45s is that with generous room for a cold Lambda, and bounded for
// the same reason the delivery poll is.
const EMAIL_TIMEOUT_MS = 45_000;

//: The forward-only progression from the design. Index = position in the chain,
// which is what makes "is this history in forward order" and "did it overshoot"
// checkable as integer comparisons rather than string juggling.
const PROGRESSION = [
  "PLACED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
] as const;

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

// CONTRACT: Return the `usr_` id alongside the token — `getGatewayToken()` returns
// only the token, and without the id step 5 has nothing to compare against, leaving
// the sub → `usr_` gRPC resolution untested.
// The address is supplied so Users stores it, Orders reads it back, and it becomes
// the tracking's `shipping_address` snapshot. That snapshot is PII and never
// rendered on a Tracking response, so this exercises the path without asserting it.
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
  // Summed from the poll budgets, not a magic number, so they cannot drift apart.
  // EMAIL_TIMEOUT_MS belongs in the sum because step 7's inbox wait runs AFTER the
  // progression: leave it out and a missing email aborts on Playwright's generic
  // timeout instead of the diagnostic message waitForEmailTo raises.
  test.setTimeout(DELIVERY_TIMEOUT_MS + EMAIL_TIMEOUT_MS + 60_000);

  // Fail here, not 90s later inside an email poll, if the inbox is missing.
  await assertMailpitReachable();

  // --- 1. Register, with an address ----------------------------------------
  // `email` is captured because the email assertions at the end must target the
  // address THIS run generated — never a hardcoded one. That is what keeps them
  // from matching a previous run's mail in an inbox that is never cleared
  // (see mailpit-client.ts).
  const { token, userId, email } = await registerAndLogin();
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

  // CONTRACT: Do NOT pin the LIVE status to PLACED — assert PLACED on the first
  // HISTORY row instead. Progression starts the moment `init-tracking` returns, so
  // pinning the live value asserts the test is faster than the service: 0/5 passes
  // in the gateway project at the 5s cadence, 3/3 when run alone.
  // What is invariant: the live status is one of the five, at or after PLACED and
  // before DELIVERED. The forward-only walk and the exact five-row chain are proven
  // at step 6 on the settled history, where no race is possible. See [[testing]]
  const liveIndex = PROGRESSION.indexOf(tracking.status as never);
  expect(
    liveIndex,
    `tracking.status "${tracking.status}" is not one of the five progression statuses`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    liveIndex,
    `a freshly created tracking is already DELIVERED (status "${tracking.status}") — ` +
      "the progression cannot have legitimately completed before the first read",
  ).toBeLessThan(PROGRESSION.length - 1);

  expect(tracking.history.length).toBeGreaterThanOrEqual(1);
  expect(tracking.history[0].status).toBe("PLACED");

  // CONTRACT: The gateway injects `x-user-id` as the JWT **sub**, never a `usr_` id.
  // A `tracking.user_id` matching register's id proves Tracking resolved it through
  // Users' gRPC `GetUserById`; a service that stored the header raw yields a Cognito
  // UUID and fails here. See [[logging-context]]
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
  // Five statuses, one history row each — the design's completed-run count.
  expect(delivered.history).toHaveLength(PROGRESSION.length);
  expect(delivered.history.map((h) => h.status)).toEqual([...PROGRESSION]);

  // Forward order, asserted on progression POSITION rather than on the array
  // happening to look right: each row must sit strictly later in the chain than
  // the one before it. This also catches the ordering bug schemas.py documents —
  // same-second transitions tie on a bare timestamp sort and MySQL falls back to
  // PK order, which is alphabetical and would put DELIVERED first.
  const positions = delivered.history.map((h) => PROGRESSION.indexOf(h.status as never));
  expect(positions).not.toContain(-1); // no status outside the five valid values
  for (let i = 1; i < positions.length; i += 1) {
    expect(
      positions[i],
      `history is not in forward order: ${delivered.history.map((h) => h.status).join(" → ")}`,
    ).toBeGreaterThan(positions[i - 1]);
  }

  // No overshoot past the terminal state. DELIVERED is the last status and there is
  // nothing beyond it, so a sixth transition — or any repeat of DELIVERED — would
  // mean the progression kept running after it should have stopped.
  const deliveredRows = delivered.history.filter((h) => h.status === "DELIVERED");
  expect(deliveredRows).toHaveLength(1);

  // Terminal means terminal: it must still be DELIVERED with the same five rows a
  // moment later, not have advanced or grown.
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS * 2));
  const settled = await readTracking(api, order.id);
  expect(settled.status).toBe("DELIVERED");
  expect(settled.history).toHaveLength(PROGRESSION.length);

  // --- 7. The emails actually LANDED ---------------------------------------
  // This journey triggers all three email-bearing producers at ONE address, and this
  // is the first assertion touching SQS → Lambda → SES → Mailpit — a path on which
  // every earlier assertion stays green while the user receives nothing. One
  // `minCount` wait, not three sequential ones: they arrive in no guaranteed order.
  const inbox = await waitForEmailTo(email, {
    minCount: 3,
    timeoutMs: EMAIL_TIMEOUT_MS,
    description: "the welcome, order and tracking emails",
  });

  // Every message really is addressed to the user this test created. Cheap, and
  // it is what would catch the search accidentally widening to another run.
  for (const message of inbox) {
    expect(message.To.map((t) => t.Address)).toContain(email);
  }

  // 1. USER_CREATED → the welcome email.
  const welcome = findBySubject(inbox, "Welcome to 3MRAI");
  expect(welcome, `no welcome email among: ${subjectsOf(inbox)}`).toBeTruthy();
  // CONTRACT: Read the FULL body, not `Snippet`. Mailpit truncates the snippet to
  // ~150 chars and the template's header chrome pushes the address past that cut-off,
  // so a snippet assertion measures Mailpit's preview length, not the render. The
  // address itself proves the template got the event payload and not the catalog's
  // sampleProps ("ada@example.com"), which would pass a subject check.
  // See [[email-templates]]
  const welcomeBody = await getMessage(welcome!.ID);
  expect(welcomeBody.HTML).toContain(email);

  // 2. ORDER_CREATED → the confirmation, which must name THIS order.
  const confirmation = findBySubject(inbox, "Order confirmed");
  expect(confirmation, `no order confirmation among: ${subjectsOf(inbox)}`).toBeTruthy();
  expect(
    confirmation?.Snippet,
    "the order email does not name this order — rendered from sample props?",
  ).toContain(order.id);

  // 3. TRACKING_STATUS_CHANGED → at least the DELIVERED transition.
  //
  // CONTRACT: Match the DELIVERED subject; do NOT count five tracking emails. The
  // contract is "a status transition produces an email for it", so a count breaks the
  // day the progression cadence changes. DELIVERED is the one transition already
  // proven above, so demanding it races nothing. Subject is built as the handler
  // builds it (tracking-status-changed.ts): underscores to spaces, lowercased.
  // See [[email-templates]]
  const deliveredSubject = `Order ${order.id}: delivered`;
  const deliveredEmail = findBySubject(inbox, deliveredSubject);
  expect(
    deliveredEmail,
    `no "${deliveredSubject}" email among: ${subjectsOf(inbox)}. Tracking publishes ` +
      "TRACKING_STATUS_CHANGED on every transition, and the tracking above DID reach " +
      "DELIVERED — so the transition happened and the email for it did not arrive.",
  ).toBeTruthy();

  // All three came from the pipeline's configured sender, not from some other
  // producer that happened to mail this address.
  for (const message of [welcome, confirmation, deliveredEmail]) {
    expect(message?.From.Address).toBe("no-reply@3mrai.local");
  }
});

// Exact-match on subject. A helper so no assertion has to repeat the lookup, and
// so `undefined` (rather than a throw) reaches the expect() that reports it with
// the full subject list.
function findBySubject(messages: MailpitMessage[], subject: string): MailpitMessage | undefined {
  return messages.find((m) => m.Subject === subject);
}

// What the inbox actually held, for a failure message. The three assertions
// above are all "the right email is missing", and the subjects that DID arrive
// are the fastest way to tell which hop broke.
function subjectsOf(messages: MailpitMessage[]): string {
  return messages.length ? messages.map((m) => `"${m.Subject}"`).join(", ") : "(none)";
}

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

// CONTRACT: Assert Orders' TrackingDto shape against a tracking Tracking ACTUALLY
// produced, end to end. The unit tests pin the DTO against a committed fixture, which
// only catches drift once someone remembers to update it; here a renamed or dropped
// Tracking field arrives null and fails. See [[testing]]
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

  // CONTRACT: Do NOT rely on `waitForTracking` alone here. It proves the row exists in
  // TRACKING; this spec asserts on what ORDERS returns, and Orders reads Tracking with
  // a 2s budget that degrades to `tracking: null` when it overruns — measured lag of
  // 1.8-4.0s behind Tracking's own 200. So wait on ORDERS' response, separately for
  // the single read and the list read: they fan out through different routes into
  // Tracking (single vs. batch) and become ready independently. See [[testing]]
  await waitForTracking(api, order.id);
  await waitForOrderTrackingReadable(api, `v1/orders/${order.id}?includeTracking=true`);
  await waitForMyOrdersTrackingReadable(api, "v1/orders/my-orders?includeTracking=true");

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
