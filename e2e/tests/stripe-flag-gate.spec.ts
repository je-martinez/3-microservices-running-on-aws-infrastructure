// The `STRIPE_ENABLED` kill switch, PROVED rather than assumed, for both services.
//
// CONTRACT: Assert the contract for the position FOUND, never skip both ways. A
// file that only asserts the flag-off shape is vacuous on a Stripe-enabled stack,
// and the gate must hold in each position.
// See [[2026-09-19-stripe-payments-design]]
//
// CONTRACT: Discriminate on the BODY, never the status. Users answers 404 in both
// positions — `{"error":"not_found"}` from a mounted route that resolved no user,
// and Nest's `{"message":"Cannot GET …"}` when `app.module.ts` never mounted the
// module — so a status-only check reads a missing user as a working gate.

import { test, expect, type APIRequestContext } from "@playwright/test";
import { apiClient, ordersClient } from "../support/api-client.js";
import { makeUser } from "../support/chance-factory.js";
import { pickProductWithStock } from "../support/catalogue.js";

const PAYMENT_METHODS = "/v1/users/me/payment-methods";

/** Registers a caller whose `usr_` id both services accept as `x-user-id`. */
async function registerCaller(): Promise<string> {
  const users = await apiClient();
  const res = await users.post("/v1/users/register", { data: makeUser() });
  expect(res.status(), `register failed: ${await res.text()}`).toBe(201);
  const { id } = await res.json();
  return id as string;
}

async function pickProductId(api: APIRequestContext, userId: string): Promise<string> {
  const res = await api.get("/v1/products", { headers: { "x-user-id": userId } });
  expect(res.status(), `GET /v1/products failed: ${await res.text()}`).toBe(200);
  return pickProductWithStock(await res.json()).id;
}

/**
 * What the two services report about their own flag, read from behaviour rather
 * than from an env file the suite cannot see.
 */
type FlagState = {
  readonly usersMounted: boolean;
  readonly ordersEnabled: boolean;
  readonly usersBody: string;
  readonly ordersBody: string;
};

let flags: FlagState;

test.beforeAll(async () => {
  const userId = await registerCaller();

  // Users: a REGISTERED caller, so a mounted route answers 200 with a list. A
  // fabricated x-user-id would 404 from a mounted route too and read as off.
  const users = await apiClient();
  const listed = await users.get(PAYMENT_METHODS, { headers: { "x-user-id": userId } });
  const usersBody = await listed.text();
  const usersMounted = listed.status() === 200 || !usersBody.includes('"Cannot GET');

  // Orders: lines present and no paymentMethodId. With the flag ON this is the
  // 400 the endpoint returns before touching the database; with it OFF the order
  // is created for real, which is why the row is tagged for e2e-cleanup.
  const orders = await ordersClient();
  const productId = await pickProductId(orders, userId);
  const created = await orders.post("/v1/orders", {
    headers: { "x-user-id": userId, "x-e2e-source": "true" },
    data: { lines: [{ productId, quantity: 1 }] },
  });
  const ordersBody = await created.text();
  const ordersEnabled = created.status() === 400 && ordersBody.includes("paymentMethodId");

  flags = { usersMounted, ordersEnabled, usersBody, ordersBody };

  expect(
    usersMounted,
    `Users' payment-method routes and Orders' flag disagree: Users mounted=${usersMounted} ` +
      `(${usersBody.slice(0, 200)}), Orders enabled=${ordersEnabled} ` +
      `(${ordersBody.slice(0, 200)}). Both read the same STRIPE_ENABLED, so one service is ` +
      "configured differently from the other",
  ).toBe(ordersEnabled);
});

/**
 * CONTRACT: With the flag OFF, an order needs no payment method at all. This is
 * the pre-Stripe contract the kill switch has to restore — a flag that turns the
 * Stripe routes off while leaving `paymentMethodId` mandatory takes checkout down
 * with it. See [[2026-09-19-stripe-payments-design]]
 */
test("POST /v1/orders with no paymentMethodId: 201 with the flag off, 400 with it on", async () => {
  const userId = await registerCaller();
  const orders = await ordersClient();
  const productId = await pickProductId(orders, userId);

  const res = await orders.post("/v1/orders", {
    headers: { "x-user-id": userId, "x-e2e-source": "true" },
    data: { lines: [{ productId, quantity: 1 }] },
  });
  const body = await res.text();

  if (!flags.ordersEnabled) {
    expect(
      res.status(),
      `STRIPE_ENABLED is off and POST /v1/orders answered ${res.status()}: ${body.slice(0, 300)}. ` +
        "With the flag off the endpoint must not require a payment method — a 400 here means " +
        "the requirement is unconditional and the kill switch breaks checkout",
    ).toBe(201);
    // No payment was taken, so the order carries no snapshot of one.
    const order = JSON.parse(body);
    expect(order.paymentMethodId ?? null, `order: ${body.slice(0, 300)}`).toBeNull();
    return;
  }

  expect(
    res.status(),
    `STRIPE_ENABLED is on and POST /v1/orders answered ${res.status()}: ${body.slice(0, 300)}. ` +
      "With the flag on a payment method is mandatory",
  ).toBe(400);
  expect(JSON.parse(body)).toEqual({
    error: "invalid_request",
    detail: "The 'paymentMethodId' field is required.",
  });
});

/**
 * CONTRACT: The flag-off answer is Nest's unmapped-route 404, NOT a 503.
 * `app.module.ts` spreads `PaymentMethodsModule` in only when `STRIPE_ENABLED ===
 * "true"`, so a `StripeUnavailableException` 503 here means the module mounted
 * after all. See [[2026-09-19-stripe-payments-design]]
 */
test("the payment-method routes are unmounted with the flag off and answer the service's own shape with it on", async () => {
  const userId = await registerCaller();
  const users = await apiClient();

  // Every route Decision 4 defines, so a partial mount cannot pass. The bodies
  // are irrelevant with the flag off: routing happens before any validation.
  const probes = [
    ["GET", PAYMENT_METHODS],
    ["POST", `${PAYMENT_METHODS}/setup-intent`],
    ["POST", PAYMENT_METHODS],
    ["PUT", `${PAYMENT_METHODS}/pm_probe/default`],
    ["DELETE", `${PAYMENT_METHODS}/pm_probe`],
  ] as const;

  for (const [method, path] of probes) {
    const res = await users.fetch(path, {
      method,
      headers: { "x-user-id": userId, "content-type": "application/json" },
      data: method === "POST" && path === PAYMENT_METHODS ? { paymentMethodId: "pm_probe" } : {},
    });
    const body = await res.text();

    if (!flags.usersMounted) {
      expect(
        res.status(),
        `${method} ${path} answered ${res.status()} with the flag off: ${body.slice(0, 200)}. ` +
          "An unmounted route is a 404; a 503 means the module mounted and threw " +
          "StripeUnavailableException, which contradicts app.module.ts's conditional import",
      ).toBe(404);
      expect(
        JSON.parse(body),
        `${method} ${path}: the body is not Nest's unmapped-route shape, so this 404 came from a ` +
          "HANDLER — the module is mounted and the gate is not doing what it claims",
      ).toMatchObject({
        statusCode: 404,
        error: "Not Found",
        message: `Cannot ${method} ${path}`,
      });
      continue;
    }

    // Flag on: the route resolves, so it answers the SERVICE's own shape. The
    // one thing it must never be is Nest's unmapped-route body.
    expect(
      body,
      `${method} ${path} answered ${res.status()} with the flag ON: ${body.slice(0, 200)}. ` +
        "Nest's unmapped-route body means the module did not mount despite the flag",
    ).not.toContain(`Cannot ${method} ${path}`);
    expect(
      res.status(),
      `${method} ${path} answered ${res.status()}: ${body.slice(0, 200)}`,
    ).toBeLessThan(500);
  }
});

/**
 * The gate's own boundary: the routes it does NOT cover stay up in both
 * positions. Without this, "everything 404s" would pass the flag-off assertions
 * above just as well as a working kill switch.
 */
test("the rest of the Users surface is unaffected by the flag", async () => {
  const userId = await registerCaller();
  const users = await apiClient();

  const me = await users.get("/v1/users/me", { headers: { "x-user-id": userId } });
  expect(me.status(), `GET /v1/users/me failed: ${await me.text()}`).toBe(200);

  const health = await users.get("/v1/health");
  expect(health.status(), `GET /v1/health failed: ${await health.text()}`).toBe(200);
});
