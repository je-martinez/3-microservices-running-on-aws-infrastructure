import { test, expect } from "@playwright/test";
import { getGatewayToken } from "../../support/auth.js";
import { pickProductWithStock } from "../../support/catalogue.js";
import { gatewayClient } from "../../support/gateway-client.js";
import { openSocket, tryOpen } from "../../support/ws-client.js";

// Gateway E2E for realtime WebSocket delivery of tracking status changes — the only
// layer exercising the WHOLE chain: WS $connect → authorizer (real Cognito JWT) →
// connections table → Orders → Tracking TestMode → SQS → events-pipeline Lambda →
// publishToUser (keyed by cognito_sub) → the socket. Nothing here is faked. WS_URL is
// generated into .env.local.debug, which playwright.config.ts loads.
const WS_URL = process.env.WS_URL;

// Registers a user through the gateway (getGatewayToken — the established
// helper, see support/auth.ts) and returns both the token and a ready
// gatewayClient for placing orders. Does NOT write a second auth path.
async function newGatewayUser(): Promise<{
  token: string;
  api: Awaited<ReturnType<typeof gatewayClient>>;
}> {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);
  return { token, api };
}

// Creates an order in TestMode (x-test-mode: true), which is what drives
// Tracking's four-step progression at ~10s intervals (~30s total) and is what
// makes Orders call Tracking's init-tracking in the first place — see
// tests/gateway/orders-flow.spec.ts for the full chain rationale. Tagged with
// X-E2E-Source via gatewayClient, so global-teardown's soft-delete sweep
// covers these rows the same as every other gateway spec.
async function createTestModeOrder(api: Awaited<ReturnType<typeof gatewayClient>>): Promise<string> {
  const products = await api.get("v1/products");
  expect(products.status(), `GET v1/products failed: ${await products.text()}`).toBe(200);
  const catalogue = await products.json();
  const product = pickProductWithStock(catalogue);

  const created = await api.post("v1/orders", {
    headers: { "x-test-mode": "true" },
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status(), `order creation failed: ${await created.text()}`).toBe(201);
  const order = await created.json();
  expect(order.id).toMatch(/^ord_/);
  return order.id as string;
}

test.describe("realtime tracking events over websocket", () => {
  test.skip(!WS_URL, "WS_URL is not set — run `make bootstrap` (Task 9's realtime infra).");

  test("delivers every status transition to the owner", async () => {
    // TestMode progression is ~40s end to end (measured), plus headroom for
    // SQS + Lambda per record and for the setup that runs before the
    // progression even starts. Not the whole suite's default 30s.
    test.setTimeout(180_000);

    const { token, api } = await newGatewayUser();
    const socket = await openSocket(WS_URL!, token);

    // x-test-mode drives the progression — every transition emits, DELIVERED
    // included, with no suppression.
    const orderId = await createTestModeOrder(api);

    // CONTRACT: Expect FOUR messages for FIVE statuses. `PLACED` is the state the
    // record is CREATED in, not a transition, and events are emitted only from the
    // transition path. Asking for five fails with "got 4 of 5", which reads exactly
    // like a fan-out dropping a message — so `waitForCount` reports WHICH messages
    // arrived, because a count alone cannot separate a broken system from a wrong
    // expectation. 120s is measured: ~40s of progression, and this clock starts before
    // it (user creation, auth, catalogue, order) plus four SQS/Lambda round trips.
    // See [[testing]]
    await socket.waitForCount(4, 120_000);
    socket.close();

    // CONTRACT: Assert the SET, never the sequence — the pipeline processes SQS records
    // in batches with no cross-record ordering guarantee, so demanding order is flaky
    // whether or not the feature works. PLACED stays absent: it is the creation state,
    // never emitted, and asserting it would demand a message the system never sends.
    const statuses = (socket.messages as Array<{ status: string }>).map((m) => m.status).sort();
    expect(statuses).toEqual(
      ["DELIVERED", "OUT_FOR_DELIVERY", "PROCESSING", "SHIPPED"].sort(),
    );

    for (const message of socket.messages as Array<{ type: string; order_id: string }>) {
      expect(message.type).toBe("TRACKING_STATUS_CHANGED");
      expect(message.order_id).toBe(orderId);
    }
  });

  test("rejects an invalid token at the handshake", async () => {
    // CONTRACT: Keep this guard. A $connect succeeding regardless of the token looks
    // identical to a working feature, and this emulator has a documented case of
    // native USER_AUTH/EMAIL_OTP returning tokens with NO challenge at all — so a
    // happy-path-only test would pass with authentication skipped entirely.
    // "not-a-real-jwt" fails aws-jwt-verify's structural parsing before signature or
    // claims are checked, so this passes only if the Deny path genuinely runs.
    expect(await tryOpen(WS_URL!, "not-a-real-jwt")).toBe(false);
  });

  test("does not deliver one user's events to another user", async () => {
    // Same measured budget as the delivery test above, and this one has even
    // more setup ahead of the progression: two users, two tokens, two sockets.
    test.setTimeout(180_000);

    const alice = await newGatewayUser();
    const bob = await newGatewayUser();

    const aliceSocket = await openSocket(WS_URL!, alice.token);
    const bobSocket = await openSocket(WS_URL!, bob.token);

    const orderId = await createTestModeOrder(alice.api);

    // Four, not five — see the delivery test above: PLACED is the creation
    // state and is never emitted as a transition.
    await aliceSocket.waitForCount(4, 120_000);
    aliceSocket.close();
    bobSocket.close();

    // The only test that actually exercises the cognito_sub scoping
    // (publishToUser queries the connections GSI by author.cognito_sub — see
    // functions/events-pipeline/src/handlers/tracking-status-changed.ts). If
    // the pipeline pushed to every open connection instead of the owner's,
    // bob's socket would have received all three messages here too.
    expect(bobSocket.messages).toHaveLength(0);
    expect(
      (aliceSocket.messages as Array<{ order_id: string }>).every((m) => m.order_id === orderId),
    ).toBe(true);
  });
});
