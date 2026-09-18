import { test, expect, type APIRequestContext } from "@playwright/test";
import { apiClient } from "../support/api-client.js";
import { makeUser } from "../support/chance-factory.js";
import { publishEvent, newEventId } from "../support/sns-publisher.js";

// Internal E2E for the three notification endpoints, hitting Users' own port with a
// faked `x-user-id` the way the authorizer would supply it. This is the layer that
// carries the EXHAUSTIVE cases — filters, the 50-id cap, the single-id 404, cross-user
// isolation — because it needs no Cognito round trip and runs in seconds. The gateway
// spec covers the route map and the socket, and deliberately does not repeat these.
// See [[testing]]

/** How long a seeded event may take to travel topic → queue → consumer → row. */
const SEED_TIMEOUT_MS = 45_000;

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

interface NotificationsPage {
  items: NotificationItem[];
  unread_count: number;
  window_total: number;
  window_days: number;
}

async function listNotifications(
  api: APIRequestContext,
  userId: string,
  filter?: "all" | "unread" | "read",
): Promise<NotificationsPage> {
  const path = filter ? `/v1/notifications?filter=${filter}` : "/v1/notifications";
  const res = await api.get(path, { headers: { "x-user-id": userId } });
  expect(res.status(), `GET ${path} failed: ${await res.text()}`).toBe(200);
  return res.json();
}

/**
 * Registers a user and waits for the WELCOME row registration itself emits.
 *
 * CONTRACT: Do NOT assert an EMPTY page for a fresh user. Register publishes
 * USER_CREATED in-process and the welcome row lands within ~2s, so "a new user has no
 * notifications" is a race on consumer latency, not a behaviour.
 * See [[2026-09-10-in-app-notifications-design]]
 */
async function registerUserWithWelcome(
  api: APIRequestContext,
): Promise<{ userId: string; welcomeId: string }> {
  const res = await api.post("/v1/users/register", { data: makeUser() });
  expect(res.status(), `register failed: ${await res.text()}`).toBe(201);
  const { id } = await res.json();

  const page = await waitForTitles(api, id, ["Welcome to 3MRAI!"]);
  const welcome = page.items.find((item) => item.type === "WELCOME");
  expect(welcome, "the WELCOME row is missing after it was awaited").toBeTruthy();
  return { userId: id, welcomeId: welcome!.id };
}

/**
 * Polls the list until every expected title is present.
 *
 * CONTRACT: Print the titles that ARRIVED on timeout, never only how many. "got 2 of
 * 3" reads the same whether the consumer dropped an event or the expectation is wrong.
 */
async function waitForTitles(
  api: APIRequestContext,
  userId: string,
  expected: string[],
  timeoutMs = SEED_TIMEOUT_MS,
): Promise<NotificationsPage> {
  const deadline = Date.now() + timeoutMs;
  let page: NotificationsPage = { items: [], unread_count: 0, window_total: 0, window_days: 90 };

  while (Date.now() < deadline) {
    page = await listNotifications(api, userId);
    const titles = page.items.map((item) => item.title);
    if (expected.every((title) => titles.includes(title))) return page;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `timed out after ${timeoutMs}ms waiting for [${expected.join(", ")}]; ` +
      `arrived: ${JSON.stringify(page.items.map((i) => ({ title: i.title, type: i.type, metadata: i.metadata })))}`,
  );
}

/** An ORDER_CREATED envelope shaped as the pipeline's OrderCreatedPayloadSchema. */
function orderCreatedEvent(
  userId: string,
  orderId: string,
  orderNumberFormatted?: string,
) {
  return {
    event_id: newEventId(),
    type: "ORDER_CREATED",
    source: "orders",
    user_id: userId,
    order_id: orderId,
    author: { actor: "orders_api:create_order", user_id: userId },
    payload: {
      order_id: orderId,
      user_id: userId,
      created_at: new Date().toISOString(),
      // Spread-or-nothing: the key is OMITTED for an order with no number, which
      // is exactly the case the bare-sentence body test below exercises.
      ...(orderNumberFormatted ? { order_number: { formatted: orderNumberFormatted } } : {}),
    },
  };
}

/** A TRACKING_STATUS_CHANGED envelope carrying one of the four transition statuses. */
function trackingEvent(userId: string, orderId: string, status: string) {
  return {
    event_id: newEventId(),
    type: "TRACKING_STATUS_CHANGED",
    source: "tracking",
    user_id: userId,
    order_id: orderId,
    author: { actor: "tracking_api:transition", user_id: userId },
    payload: {
      status,
      changed_at: new Date().toISOString(),
      order_number: { formatted: "ORD-3MRAI-40001" },
    },
  };
}

test.describe("notification endpoints on the Users port", () => {
  test("seeds all three producing event types and lists them newest first", async () => {
    // Three events crossing SNS, the queue and the consumer, plus registration's own.
    test.setTimeout(120_000);

    const api = await apiClient();
    const { userId } = await registerUserWithWelcome(api);
    const orderId = `ord_e2e${Date.now().toString(36)}`;

    await publishEvent(orderCreatedEvent(userId, orderId, "ORD-3MRAI-40001"));
    await publishEvent(trackingEvent(userId, orderId, "SHIPPED"));

    const page = await waitForTitles(api, userId, [
      "Welcome to 3MRAI!",
      "Order placed",
      "Your order has shipped",
    ]);

    // The set, not the sequence of arrival: SNS gives no cross-message ordering
    // guarantee, so which of the two seeded rows was inserted first is not a
    // property of the feature.
    expect(page.items.map((item) => item.title).sort()).toEqual(
      ["Order placed", "Welcome to 3MRAI!", "Your order has shipped"].sort(),
    );

    // `created_at desc` IS a contract — the panel renders in this order.
    const timestamps = page.items.map((item) => Date.parse(item.created_at));
    expect(timestamps, `not newest-first: ${JSON.stringify(page.items.map((i) => i.title))}`)
      .toEqual([...timestamps].sort((a, b) => b - a));

    expect(page.window_days).toBe(90);
    expect(page.unread_count).toBe(3);
    expect(page.window_total).toBe(3);

    const placed = page.items.find((item) => item.title === "Order placed")!;
    expect(placed.type).toBe("ORDER_STATUS");
    expect(placed.metadata).toMatchObject({ status: "PLACED", order_id: orderId });

    const shipped = page.items.find((item) => item.title === "Your order has shipped")!;
    expect(shipped.metadata).toMatchObject({ status: "SHIPPED", order_id: orderId });

    // CONTRACT: A WELCOME row carries NO order_id — unknown fields are omitted, never
    // null, so the web can drive its "View order" CTA off the key's presence alone.
    // See [[logging-context]]
    const welcome = page.items.find((item) => item.type === "WELCOME")!;
    expect(welcome.metadata).not.toHaveProperty("order_id");
    expect(welcome.metadata).toHaveProperty("occurred_at");
  });

  test("renders the bare sentence when the order carries no number", async () => {
    test.setTimeout(120_000);

    const api = await apiClient();
    const { userId } = await registerUserWithWelcome(api);
    const orderId = `ord_e2e${Date.now().toString(36)}n`;

    await publishEvent(orderCreatedEvent(userId, orderId));
    const page = await waitForTitles(api, userId, ["Order placed"]);
    const placed = page.items.find((item) => item.title === "Order placed")!;

    // An order predating the number backfill omits the key entirely. The body must
    // degrade to the bare sentence — no leading separator, no literal "undefined".
    expect(placed.body).toBe("Received and confirmed. We'll email your receipt.");
    expect(placed.metadata).not.toHaveProperty("order_number");
  });

  test("keeps a non-notification event off the queue entirely", async () => {
    test.setTimeout(120_000);

    const api = await apiClient();
    const { userId } = await registerUserWithWelcome(api);

    // CONTRACT: AUTH_OTP_REQUESTED must produce NO row. The SNS filter policy matches
    // on the `type` message attribute and admits only the three producing types, and
    // the consumer discards unknown types as defence in depth — this asserts the pair
    // end to end rather than either alone.
    await publishEvent({
      event_id: newEventId(),
      type: "AUTH_OTP_REQUESTED",
      source: "users",
      user_id: userId,
      order_id: null,
      author: { actor: "users_api:otp_start", user_id: userId },
      payload: { email: "filtered@example.com", code: "000000", ttlSeconds: 300 },
    });

    // A marker published after it: once the marker has landed the OTP event has had
    // at least as long to travel the same path, so a still-absent row is absent by
    // policy rather than merely early.
    const orderId = `ord_e2e${Date.now().toString(36)}f`;
    await publishEvent(orderCreatedEvent(userId, orderId, "ORD-3MRAI-40009"));
    const page = await waitForTitles(api, userId, ["Order placed"]);

    expect(
      page.items.map((item) => item.title).sort(),
      "an OTP event produced a notification row",
    ).toEqual(["Order placed", "Welcome to 3MRAI!"].sort());
  });

  test("filters by read state while both counters ignore the filter", async () => {
    test.setTimeout(120_000);

    const api = await apiClient();
    const { userId, welcomeId } = await registerUserWithWelcome(api);
    const orderId = `ord_e2e${Date.now().toString(36)}s`;

    await publishEvent(orderCreatedEvent(userId, orderId, "ORD-3MRAI-40002"));
    await waitForTitles(api, userId, ["Order placed"]);

    const marked = await api.patch("/v1/notifications/read", {
      headers: { "x-user-id": userId },
      data: { ids: [welcomeId] },
    });
    expect(marked.status()).toBe(200);
    expect(await marked.json()).toEqual({ updated: 1, unread_count: 1 });

    const all = await listNotifications(api, userId, "all");
    expect(all.items.map((i) => i.title).sort()).toEqual(
      ["Order placed", "Welcome to 3MRAI!"].sort(),
    );

    const unread = await listNotifications(api, userId, "unread");
    expect(unread.items.map((i) => i.title)).toEqual(["Order placed"]);

    const read = await listNotifications(api, userId, "read");
    expect(read.items.map((i) => i.title)).toEqual(["Welcome to 3MRAI!"]);
    expect(read.items[0]!.read_at).not.toBeNull();

    // CONTRACT: Both counters are independent of `filter` — the pill on the Unread tab
    // reads the same totals as on All. A filter-scoped count would make this pass on
    // `all` and fail here, which is the whole reason it is asserted on every tab.
    for (const page of [all, unread, read]) {
      expect(page.unread_count).toBe(1);
      expect(page.window_total).toBe(2);
      expect(page.window_days).toBe(90);
    }

    // No filter at all behaves as `all`, which is what the web relies on.
    const defaulted = await listNotifications(api, userId);
    expect(defaulted.items.map((i) => i.title).sort()).toEqual(
      all.items.map((i) => i.title).sort(),
    );
  });

  test("rejects a filter outside the three values", async () => {
    const api = await apiClient();
    const { userId } = await registerUserWithWelcome(api);

    const res = await api.get("/v1/notifications?filter=archived", {
      headers: { "x-user-id": userId },
    });
    expect(res.status()).toBe(400);
  });

  test("the dedicated count agrees with the list's", async () => {
    test.setTimeout(120_000);

    const api = await apiClient();
    const { userId } = await registerUserWithWelcome(api);
    const orderId = `ord_e2e${Date.now().toString(36)}c`;

    await publishEvent(orderCreatedEvent(userId, orderId, "ORD-3MRAI-40003"));
    const page = await waitForTitles(api, userId, ["Order placed"]);

    const res = await api.get("/v1/notifications/unread-count", {
      headers: { "x-user-id": userId },
    });
    expect(res.status()).toBe(200);
    // The badge endpoint exists so the bell costs one COUNT rather than a page
    // fetch; the two disagreeing would show a stale badge over a fresh list.
    expect(await res.json()).toEqual({ unread_count: page.unread_count });
  });

  test("marks a list read idempotently and drops the unread count", async () => {
    test.setTimeout(120_000);

    const api = await apiClient();
    const { userId } = await registerUserWithWelcome(api);
    const orderId = `ord_e2e${Date.now().toString(36)}m`;

    await publishEvent(orderCreatedEvent(userId, orderId, "ORD-3MRAI-40004"));
    const page = await waitForTitles(api, userId, ["Order placed"]);
    const ids = page.items.map((item) => item.id);
    expect(ids).toHaveLength(2);

    const first = await api.patch("/v1/notifications/read", {
      headers: { "x-user-id": userId },
      data: { ids },
    });
    expect(first.status()).toBe(200);
    expect(await first.json()).toEqual({ updated: 2, unread_count: 0 });

    // CONTRACT: The repeat answers 200 `updated: 0`, not 404 — only rows with
    // `read_at IS NULL` are updated, and the single-id 404 rule does not apply to a
    // list of two. The web's mark-on-enter sends lists, so an Angular remount firing
    // it twice must be a no-op rather than an error.
    const repeat = await api.patch("/v1/notifications/read", {
      headers: { "x-user-id": userId },
      data: { ids },
    });
    expect(repeat.status()).toBe(200);
    expect(await repeat.json()).toEqual({ updated: 0, unread_count: 0 });

    const after = await listNotifications(api, userId, "unread");
    expect(after.items).toEqual([]);
    expect(after.unread_count).toBe(0);
  });

  test("accepts an empty id list as a 200, not a 400", async () => {
    const api = await apiClient();
    const { userId } = await registerUserWithWelcome(api);

    // Arriving on the All screen with nothing unread is the NORMAL case, so an empty
    // list is valid input rather than a client error.
    const res = await api.patch("/v1/notifications/read", {
      headers: { "x-user-id": userId },
      data: { ids: [] },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).updated).toBe(0);
  });

  test("caps the id list at fifty", async () => {
    const api = await apiClient();
    const { userId } = await registerUserWithWelcome(api);
    const ids = Array.from({ length: 51 }, (_, i) => `ntf_capprobe${i}`);

    const tooMany = await api.patch("/v1/notifications/read", {
      headers: { "x-user-id": userId },
      data: { ids },
    });
    expect(tooMany.status()).toBe(400);

    // Fifty is the boundary and must pass, so the cap is pinned from both sides —
    // an off-by-one that rejected 50 would leave a full page unmarkable.
    const atCap = await api.patch("/v1/notifications/read", {
      headers: { "x-user-id": userId },
      data: { ids: ids.slice(0, 50) },
    });
    expect(atCap.status()).toBe(200);
    expect((await atCap.json()).updated).toBe(0);
  });

  test("answers a single unmatched id with 404", async () => {
    const api = await apiClient();
    const { userId } = await registerUserWithWelcome(api);

    const res = await api.patch("/v1/notifications/read", {
      headers: { "x-user-id": userId },
      data: { ids: ["ntf_thisdoesnotexist00000"] },
    });
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("does not let one user mark another's notifications read", async () => {
    test.setTimeout(120_000);

    const api = await apiClient();
    const alice = await registerUserWithWelcome(api);
    const bob = await registerUserWithWelcome(api);

    const orderId = `ord_e2e${Date.now().toString(36)}x`;
    await publishEvent(orderCreatedEvent(alice.userId, orderId, "ORD-3MRAI-40005"));
    const alicePage = await waitForTitles(api, alice.userId, ["Order placed"]);
    const aliceIds = alicePage.items.map((item) => item.id);

    // CONTRACT: `user_id` IS the ownership check — Bob's UPDATE simply matches no row.
    // This is a 200 with `updated: 0`, NOT a 403: the endpoint has no way to say "that
    // is someone else's" without confirming it exists.
    const bulk = await api.patch("/v1/notifications/read", {
      headers: { "x-user-id": bob.userId },
      data: { ids: aliceIds },
    });
    expect(bulk.status()).toBe(200);
    expect((await bulk.json()).updated).toBe(0);

    const aliceAfter = await listNotifications(api, alice.userId, "unread");
    expect(
      aliceAfter.items.map((i) => i.title).sort(),
      "Bob's PATCH altered Alice's read state",
    ).toEqual(alicePage.items.map((i) => i.title).sort());
  });

  test("answers a single foreign id exactly as it answers an invented one", async () => {
    test.setTimeout(120_000);

    const api = await apiClient();
    const alice = await registerUserWithWelcome(api);
    const bob = await registerUserWithWelcome(api);

    // CONTRACT: The two responses must be byte-for-byte identical. A distinguishable
    // answer turns this endpoint into an oracle for whether a given id exists, which
    // is precisely what the single-id 404 is designed to prevent — so this compares
    // the raw bodies rather than asserting 404 twice.
    const foreign = await api.patch("/v1/notifications/read", {
      headers: { "x-user-id": bob.userId },
      data: { ids: [alice.welcomeId] },
    });
    const invented = await api.patch("/v1/notifications/read", {
      headers: { "x-user-id": bob.userId },
      data: { ids: ["ntf_neverexisted0000000"] },
    });

    expect(foreign.status()).toBe(404);
    expect(invented.status()).toBe(foreign.status());
    expect(await foreign.text()).toBe(await invented.text());
  });

  test("401s all three routes without an identity", async () => {
    const api = await apiClient();

    // CONTRACT: A 404 here would mean the request reached a handler and fell through
    // on an unresolved user — the auth gate bypassed rather than renamed. The three
    // routes are absent from `public-routes.ts`, and that absence is what makes the
    // onRequest hook short-circuit before any handler runs.
    const list = await api.get("/v1/notifications");
    expect(list.status()).toBe(401);
    expect(await list.json()).toEqual({ error: "unauthenticated" });

    const count = await api.get("/v1/notifications/unread-count");
    expect(count.status()).toBe(401);
    expect(await count.json()).toEqual({ error: "unauthenticated" });

    const marked = await api.patch("/v1/notifications/read", { data: { ids: [] } });
    expect(marked.status()).toBe(401);
    expect(await marked.json()).toEqual({ error: "unauthenticated" });
  });
});
