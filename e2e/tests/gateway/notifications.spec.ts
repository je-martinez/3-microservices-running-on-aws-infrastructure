import { test, expect } from "@playwright/test";
import { getGatewayToken } from "../../support/auth.js";
import { pickProductWithStock } from "../../support/catalogue.js";
import { gatewayClient } from "../../support/gateway-client.js";
import { openSocket } from "../../support/ws-client.js";

// Gateway E2E for the notification surface — the only layer exercising the WHOLE
// chain: API Gateway route map → JWT authorizer → nginx → Users, and separately
// Cognito → Users → SNS → the notifications queue → the consumer → publishToUser →
// the socket. Nothing here is faked. The exhaustive cases (filters, the id cap, the
// single-id 404) live in the internal spec; this one must stay small because every
// test costs a real Cognito round trip. See [[testing]]
const WS_URL = process.env.WS_URL;

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

/** The frame Users pushes after storing a row. */
interface NotificationFrame {
  type: "NOTIFICATION_CREATED";
  notification: NotificationItem;
  unread_count: number;
}

type SocketFrame = NotificationFrame | { type: string; [key: string]: unknown };

async function newGatewayUser(): Promise<{
  token: string;
  api: Awaited<ReturnType<typeof gatewayClient>>;
}> {
  const { token } = await getGatewayToken();
  return { token, api: await gatewayClient(token) };
}

// A TestMode order, which drives Tracking's four-step progression at ~10s intervals.
// Mirrors realtime-tracking.spec.ts rather than inventing a second path.
async function createTestModeOrder(
  api: Awaited<ReturnType<typeof gatewayClient>>,
): Promise<string> {
  const products = await api.get("v1/products");
  expect(products.status(), `GET v1/products failed: ${await products.text()}`).toBe(200);
  const product = pickProductWithStock(await products.json());

  const created = await api.post("v1/orders", {
    headers: { "x-test-mode": "true" },
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status(), `order creation failed: ${await created.text()}`).toBe(201);
  return (await created.json()).id as string;
}

/** Only the notification frames; the tracking ones share this socket. */
function notificationFrames(messages: unknown[]): NotificationFrame[] {
  return (messages as SocketFrame[]).filter(
    (m): m is NotificationFrame => m.type === "NOTIFICATION_CREATED",
  );
}

/** A one-line-per-frame digest, so a failure names WHAT arrived rather than a count. */
function describeFrames(messages: unknown[]): string {
  return JSON.stringify(
    (messages as SocketFrame[]).map((m) =>
      m.type === "NOTIFICATION_CREATED"
        ? {
            type: m.type,
            title: (m as NotificationFrame).notification.title,
            status: (m as NotificationFrame).notification.metadata.status,
            unread_count: (m as NotificationFrame).unread_count,
          }
        : { type: m.type, status: (m as { status?: string }).status },
    ),
  );
}

/**
 * CONTRACT: Waits on NOTIFICATION_CREATED frames only. Do NOT substitute
 * `socket.waitForCount` — it counts EVERY frame, and two message types share this
 * socket, so it resolves on a mix of five and asserts the wrong set. Timing out prints
 * each frame, since a count cannot separate a dropped push from a wrong expectation.
 */
async function waitForNotificationFrames(
  socket: Awaited<ReturnType<typeof openSocket>>,
  count: number,
  timeoutMs: number,
): Promise<NotificationFrame[]> {
  const deadline = Date.now() + timeoutMs;
  while (notificationFrames(socket.messages).length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${count} NOTIFICATION_CREATED ` +
          `frames; got ${notificationFrames(socket.messages).length}. ` +
          `Everything that arrived: ${describeFrames(socket.messages)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return notificationFrames(socket.messages);
}

/** Polls the list until every expected title is present, printing what arrived. */
async function waitForTitles(
  api: Awaited<ReturnType<typeof gatewayClient>>,
  expected: string[],
  timeoutMs: number,
): Promise<NotificationItem[]> {
  const deadline = Date.now() + timeoutMs;
  let items: NotificationItem[] = [];

  while (Date.now() < deadline) {
    const res = await api.get("v1/notifications");
    expect(res.status(), `GET v1/notifications failed: ${await res.text()}`).toBe(200);
    items = (await res.json()).items;
    const titles = items.map((item) => item.title);
    if (expected.every((title) => titles.includes(title))) return items;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `timed out after ${timeoutMs}ms waiting for [${expected.join(", ")}]; ` +
      `arrived: ${JSON.stringify(items.map((i) => ({ title: i.title, type: i.type })))}`,
  );
}

test.describe("notifications through the gateway", () => {
  test("guards all three routes at the authorizer, and serves them with a token", async () => {
    const anonymous = await gatewayClient();

    // CONTRACT: A 401 is the GOOD answer — it proves the route resolves and reached
    // the authorizer. A 404 carrying the gateway's own `{"message":"Not Found"}` means
    // the request never reached the service, i.e. the route is missing from
    // `infra/modules/api-gateway/main.tf`'s map. Assert the BODY, not just the status:
    // the service's own 404 shape is `{error: …}` and the two must stay separable.
    for (const call of [
      () => anonymous.get("v1/notifications"),
      () => anonymous.get("v1/notifications/unread-count"),
      () => anonymous.patch("v1/notifications/read", { data: { ids: [] } }),
    ]) {
      const res = await call();
      const body = await res.text();
      expect(res.status(), `expected 401, got ${res.status()}: ${body}`).toBe(401);
      expect(body).not.toContain("Not Found");
    }

    const { api } = await newGatewayUser();

    const list = await api.get("v1/notifications");
    expect(list.status(), `list failed: ${await list.text()}`).toBe(200);
    expect(await list.json()).toMatchObject({ window_days: 90 });

    const count = await api.get("v1/notifications/unread-count");
    expect(count.status(), `count failed: ${await count.text()}`).toBe(200);
    expect(typeof (await count.json()).unread_count).toBe("number");

    const marked = await api.patch("v1/notifications/read", { data: { ids: [] } });
    expect(marked.status(), `mark-read failed: ${await marked.text()}`).toBe(200);
    expect(await marked.json()).toMatchObject({ updated: 0 });
  });

  test("delivers the welcome notification end to end", async () => {
    // Cognito → Users → SNS → queue → consumer is not instantaneous, and the shared
    // queue's drain rate varies with what else is running.
    test.setTimeout(120_000);

    const { api } = await newGatewayUser();
    const items = await waitForTitles(api, ["Welcome to 3MRAI!"], 60_000);
    const welcome = items.find((item) => item.title === "Welcome to 3MRAI!")!;

    expect(welcome.type).toBe("WELCOME");
    // A WELCOME row has no order, and the key is OMITTED rather than set to null —
    // the web drives its "View order" CTA off the key's presence.
    expect(welcome.metadata).not.toHaveProperty("order_id");
    expect(welcome.read_at).toBeNull();
  });

  test.describe("realtime NOTIFICATION_CREATED frames", () => {
    test.skip(!WS_URL, "WS_URL is not set — run `make bootstrap` (the realtime infra).");

    test("pushes five frames over one order lifecycle", async () => {
      // TestMode progression is ~40s, and this clock starts before it: user creation,
      // auth, catalogue and the order all precede it, plus five SQS round trips.
      test.setTimeout(180_000);

      const { token, api } = await newGatewayUser();
      const socket = await openSocket(WS_URL!, token);
      const orderId = await createTestModeOrder(api);

      // CONTRACT: TWO DIFFERENT COUNTS OVER TWO DIFFERENT MESSAGE TYPES, and neither
      // is a typo for the other. FIVE NOTIFICATION_CREATED frames: one from
      // ORDER_CREATED (the PLACED variant) plus one per tracking transition. FOUR
      // TRACKING_STATUS_CHANGED frames, which `realtime-tracking.spec.ts` asserts and
      // continues to assert — PLACED is the state a tracking row is CREATED in, never
      // a transition, so no producer emits it. "Fixing" one count to match the other
      // breaks a working system. See [[2026-09-10-in-app-notifications-design]]
      const frames = await waitForNotificationFrames(socket, 5, 150_000);
      socket.close();

      // The SET, never the sequence: SQS records carry no cross-record ordering
      // guarantee, and PLACED arrives from a different producer than the other four.
      const statuses = frames.map((f) => f.notification.metadata.status).sort();
      expect(statuses, `frames that arrived: ${describeFrames(socket.messages)}`).toEqual(
        ["DELIVERED", "OUT_FOR_DELIVERY", "PLACED", "PROCESSING", "SHIPPED"].sort(),
      );

      for (const frame of frames) {
        expect(frame.notification.title.length).toBeGreaterThan(0);
        expect(frame.notification.id).toMatch(/^ntf_/);
        expect(frame.notification.read_at).toBeNull();
        expect(frame.notification.metadata.order_id).toBe(orderId);
        // The badge count rides every frame so the bell updates without a refetch;
        // a zero would blank the badge on the very push that should light it.
        expect(frame.unread_count).toBeGreaterThan(0);
      }

      // Each push carries the count AFTER its own insert, so the five are strictly
      // increasing however the transitions interleave.
      const counts = frames.map((f) => f.unread_count).sort((a, b) => a - b);
      expect(new Set(counts).size, `counts: ${JSON.stringify(counts)}`).toBe(counts.length);

      // CONTRACT: The push is BEST-EFFORT by contract — the row is stored whether or
      // not the socket delivers. So the list is asserted separately here rather than
      // being inferred from the frames, and a lost push cannot make persistence look
      // broken. See [[2026-09-10-in-app-notifications-design]]
      const stored = await waitForTitles(api, ["Order placed", "Delivered"], 30_000);
      const storedStatuses = stored
        .filter((item) => item.metadata.order_id === orderId)
        .map((item) => item.metadata.status)
        .sort();
      expect(storedStatuses).toEqual(
        ["DELIVERED", "OUT_FOR_DELIVERY", "PLACED", "PROCESSING", "SHIPPED"].sort(),
      );
    });

    test("does not push one user's notifications to another", async () => {
      test.setTimeout(180_000);

      const alice = await newGatewayUser();
      const bob = await newGatewayUser();

      const aliceSocket = await openSocket(WS_URL!, alice.token);
      const bobSocket = await openSocket(WS_URL!, bob.token);
      const orderId = await createTestModeOrder(alice.api);

      await waitForNotificationFrames(aliceSocket, 5, 150_000);
      aliceSocket.close();
      bobSocket.close();

      // The only test exercising the cognito_sub scoping on this push. A push keyed by
      // the internal usr_ id would query the connections GSI and reach NOBODY, which
      // looks identical to a working feature from Alice's side alone — so Bob's empty
      // socket is what separates "scoped correctly" from "broadcast to everyone".
      expect(
        notificationFrames(bobSocket.messages),
        `Bob received: ${describeFrames(bobSocket.messages)}`,
      ).toEqual([]);
      expect(
        notificationFrames(aliceSocket.messages).every(
          (f) => f.notification.metadata.order_id === orderId,
        ),
      ).toBe(true);
    });
  });

  test("marks notifications read through the gateway", async () => {
    test.setTimeout(120_000);

    const { api } = await newGatewayUser();
    const items = await waitForTitles(api, ["Welcome to 3MRAI!"], 60_000);
    const ids = items.filter((item) => item.read_at === null).map((item) => item.id);
    expect(ids.length).toBeGreaterThan(0);

    const before = await api.get("v1/notifications/unread-count");
    const beforeCount = (await before.json()).unread_count;

    const marked = await api.patch("v1/notifications/read", { data: { ids } });
    expect(marked.status(), `mark-read failed: ${await marked.text()}`).toBe(200);
    const result = await marked.json();
    expect(result.updated).toBe(ids.length);

    const after = await api.get("v1/notifications/unread-count");
    expect(after.status()).toBe(200);
    // The dedicated count must agree with the one the write returned; a disagreement
    // would show a stale badge over a freshly-read list.
    expect((await after.json()).unread_count).toBe(result.unread_count);
    expect(result.unread_count).toBe(beforeCount - ids.length);
  });
});
