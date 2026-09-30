import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { apiClient, ordersClient } from "../support/api-client.js";
import { makeUser } from "../support/chance-factory.js";
import { pickProductWithStock } from "../support/catalogue.js";
import {
  chargeAttemptsForCustomer,
  customerIdForEmail,
  describeAttempts,
  missingStripeKeys,
} from "../support/stripe-charges.js";

// Internal E2E for Orders' Stripe payment path: `POST /v1/orders` on the service port
// (localhost:3001) with a saved card and an `Idempotency-Key`. Shapes come from
// services/orders/openapi.yaml; the card is attached through Users (localhost:3000) first,
// because Orders charges a `pm_` that already belongs to the buyer's Stripe customer.
// The gateway path is tests/gateway/'s.

// CONTRACT: Both clients already send `X-E2E-Source: true` (see api-client.ts), so every
// user, order and Stripe customer here is tagged for e2e-cleanup. Do NOT send
// `x-test-mode` — no spec in this file asserts on a delivery.

// CONTRACT: Attaches to a Customer and then FAILS at charge. `pm_card_visa_chargeDeclined`
// and its siblings cannot stand in: Stripe refuses to attach an issuer-decline card at all,
// so Users answers 402 payment_method_declined and the charge path is never reached.
// See https://docs.stripe.com/testing#declined-payments
const DECLINE_AT_CHARGE = "pm_card_chargeCustomerFail";

type Buyer = { userId: string; email: string; paymentMethodId: string };

/** A registered user with `pm` attached to their Stripe customer. */
async function makeBuyer(pm = "pm_card_visa"): Promise<Buyer> {
  const users = await apiClient();
  const user = makeUser();
  const registered = await users.post("/v1/users/register", { data: user });
  expect(registered.status(), await registered.text()).toBe(201);
  const { id } = await registered.json();

  const attached = await users.post("/v1/users/me/payment-methods", {
    headers: { "x-user-id": id },
    data: { paymentMethodId: pm },
  });
  expect(attached.status(), await attached.text()).toBe(200);
  const { id: paymentMethodId } = await attached.json();

  return { userId: id, email: user.email, paymentMethodId };
}

async function orderableProductId(orders: APIRequestContext, userId: string, minStock = 1): Promise<string> {
  const res = await orders.get("/v1/products", { headers: { "x-user-id": userId } });
  expect(res.status()).toBe(200);
  return pickProductWithStock(await res.json(), { minStock }).id;
}

type CreateOptions = { idempotencyKey?: string | null; paymentMethodId?: string | null; card?: unknown };

function createOrder(
  orders: APIRequestContext,
  userId: string,
  productId: string,
  quantity: number,
  options: CreateOptions,
) {
  const headers: Record<string, string> = { "x-user-id": userId };
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  const data: Record<string, unknown> = { lines: [{ productId, quantity }] };
  if (options.paymentMethodId) data.paymentMethodId = options.paymentMethodId;
  if (options.card !== undefined) data.card = options.card;

  return orders.post("/v1/orders", { headers, data });
}

// Module-scoped: probed once in beforeAll, read by every test's test.skip().
let unavailableReason: string | null = null;

test.beforeAll(async () => {
  // Probe: with STRIPE_ENABLED off, Orders takes `paymentMethodId` as optional and the 400
  // never fires, so every assertion below would be asserting the wrong branch. A 201 here
  // IS that state — nothing is created, because the request carries no product.
  const orders = await ordersClient();
  const { userId } = await makeBuyer();
  const probe = await createOrder(orders, userId, "prd_flag_probe", 1, { idempotencyKey: randomUUID() });
  if (probe.status() !== 400) {
    unavailableReason =
      `STRIPE_ENABLED is off in Orders — a paymentMethodId-less create answered ${probe.status()} ` +
      "instead of 400, so the Stripe charge path is not mounted.";
  }
});

test.beforeEach(() => {
  test.skip(unavailableReason !== null, unavailableReason ?? "");
});

test("a valid paymentMethodId and Idempotency-Key create the order and charge Stripe once for its exact total", async () => {
  const orders = await ordersClient();
  const buyer = await makeBuyer();
  const productId = await orderableProductId(orders, buyer.userId);

  const res = await createOrder(orders, buyer.userId, productId, 1, {
    idempotencyKey: randomUUID(),
    paymentMethodId: buyer.paymentMethodId,
  });
  expect(res.status(), await res.text()).toBe(201);
  const order = await res.json();
  expect(order.id).toMatch(/^ord_/);
  expect(order.total.cents).toBe(order.subtotal.cents + order.tax.cents + order.shipping.cents);

  // CONTRACT: Assert the payment snapshot in STRIPE, not in the response. OrderDto carries
  // no payment fields (services/orders/src/Orders.Application/Orders/OrderDto.cs), so a
  // body-only assertion would pass against a service that charged nothing at all.
  const missing = missingStripeKeys();
  test.skip(missing !== null, missing ?? "");

  const customerId = await customerIdForEmail(buyer.email);
  expect(customerId, `no Stripe customer for ${buyer.email} — the attach never reached Stripe`).not.toBeNull();
  const attempts = await chargeAttemptsForCustomer(customerId as string);

  expect(attempts.length, `charge attempts for this buyer:\n${describeAttempts(attempts)}`).toBe(1);
  expect(attempts[0], describeAttempts(attempts)).toMatchObject({
    status: "succeeded",
    amountCents: order.total.cents,
    currency: order.total.currency.toLowerCase(),
    orderId: order.id,
    cardBrand: "visa",
    cardLast4: "4242",
  });
});

test("with the flag on, omitting paymentMethodId returns 400 invalid_request and charges nothing", async () => {
  const orders = await ordersClient();
  const buyer = await makeBuyer();
  const productId = await orderableProductId(orders, buyer.userId);

  const res = await createOrder(orders, buyer.userId, productId, 1, { idempotencyKey: randomUUID() });
  expect(res.status(), await res.text()).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid_request" });

  const myOrders = await orders.get("/v1/orders/my-orders", { headers: { "x-user-id": buyer.userId } });
  expect(await myOrders.json()).toEqual([]);
});

test("with the flag on, omitting the Idempotency-Key header returns 400 idempotency_key_required", async () => {
  const orders = await ordersClient();
  const buyer = await makeBuyer();
  const productId = await orderableProductId(orders, buyer.userId);

  const res = await createOrder(orders, buyer.userId, productId, 1, {
    paymentMethodId: buyer.paymentMethodId,
  });
  expect(res.status(), await res.text()).toBe(400);
  expect(await res.json()).toMatchObject({ error: "idempotency_key_required" });

  const myOrders = await orders.get("/v1/orders/my-orders", { headers: { "x-user-id": buyer.userId } });
  expect(await myOrders.json()).toEqual([]);
});

// The key is part of the Stripe idempotency key and a varchar(64) column, so a key the
// column cannot hold and one outside the printable range must both be refused. A space
// (0x20) sits just below the validator's `!` bound and is the shortest case that proves it.
test("an Idempotency-Key over 64 characters, or carrying a space, returns 400 idempotency_key_required", async () => {
  const orders = await ordersClient();
  const buyer = await makeBuyer();
  const productId = await orderableProductId(orders, buyer.userId);

  for (const key of ["k".repeat(65), "has space"]) {
    const res = await createOrder(orders, buyer.userId, productId, 1, {
      idempotencyKey: key,
      paymentMethodId: buyer.paymentMethodId,
    });
    const body = await res.text();
    expect(res.status(), `key ${JSON.stringify(key)}: ${body}`).toBe(400);
    expect(JSON.parse(body), `key ${JSON.stringify(key)}`).toMatchObject({ error: "idempotency_key_required" });
  }

  const myOrders = await orders.get("/v1/orders/my-orders", { headers: { "x-user-id": buyer.userId } });
  expect(await myOrders.json()).toEqual([]);
});

// CONTRACT: A non-ASCII Idempotency-Key never reaches Orders' validator — Kestrel rejects the
// header value itself, so the answer is a BODILESS 400, not the handler's
// `idempotency_key_required` JSON. Asserting that JSON shape here fails with "Unexpected end
// of JSON input", which reads as a broken error handler rather than a transport-level refusal.
test("a non-ASCII Idempotency-Key is refused by the server with a bodiless 400", async () => {
  const orders = await ordersClient();
  const buyer = await makeBuyer();
  const productId = await orderableProductId(orders, buyer.userId);

  const res = await createOrder(orders, buyer.userId, productId, 1, {
    idempotencyKey: "clave-ñ",
    paymentMethodId: buyer.paymentMethodId,
  });
  const body = await res.text();
  expect(res.status(), body).toBe(400);
  expect(body).toBe("");

  const myOrders = await orders.get("/v1/orders/my-orders", { headers: { "x-user-id": buyer.userId } });
  expect(await myOrders.json()).toEqual([]);
});

test("a card that declines at charge returns 402 payment_declined, persists no order, and leaves an unpaid intent", async () => {
  const orders = await ordersClient();
  const buyer = await makeBuyer(DECLINE_AT_CHARGE);
  const productId = await orderableProductId(orders, buyer.userId);

  const res = await createOrder(orders, buyer.userId, productId, 1, {
    idempotencyKey: randomUUID(),
    paymentMethodId: buyer.paymentMethodId,
  });
  expect(res.status(), await res.text()).toBe(402);
  expect(await res.json()).toMatchObject({ error: "payment_declined", code: "card_declined" });

  // WHY: An order row without a payment would consume an order number and show up in "my
  // orders" with no stock reserved, so a decline must leave nothing behind (spec Decision 5).
  const myOrders = await orders.get("/v1/orders/my-orders", { headers: { "x-user-id": buyer.userId } });
  expect(await myOrders.json()).toEqual([]);

  const missing = missingStripeKeys();
  test.skip(missing !== null, missing ?? "");

  // The declined attempt is not lost: its unpaid PaymentIntent carries an `ord_` id with no
  // row behind it, which is what keeps a decline auditable in Stripe.
  const customerId = await customerIdForEmail(buyer.email);
  const attempts = await chargeAttemptsForCustomer(customerId as string);
  expect(attempts.length, describeAttempts(attempts)).toBe(1);
  expect(attempts[0], describeAttempts(attempts)).toMatchObject({
    status: "requires_payment_method",
    declineCode: "generic_decline",
  });
  expect(attempts[0].orderId, describeAttempts(attempts)).toMatch(/^ord_/);
});

test("replaying the same (user, Idempotency-Key) returns the existing order 200 and charges Stripe exactly once", async () => {
  const orders = await ordersClient();
  const buyer = await makeBuyer();
  const productId = await orderableProductId(orders, buyer.userId);
  const key = randomUUID();

  const first = await createOrder(orders, buyer.userId, productId, 1, {
    idempotencyKey: key,
    paymentMethodId: buyer.paymentMethodId,
  });
  expect(first.status(), await first.text()).toBe(201);
  const created = await first.json();

  const replay = await createOrder(orders, buyer.userId, productId, 1, {
    idempotencyKey: key,
    paymentMethodId: buyer.paymentMethodId,
  });
  expect(replay.status(), await replay.text()).toBe(200);
  expect(await replay.json()).toEqual(created);

  const myOrders = await orders.get("/v1/orders/my-orders", { headers: { "x-user-id": buyer.userId } });
  expect((await myOrders.json()).map((o: { id: string }) => o.id)).toEqual([created.id]);

  // CONTRACT: The matching body is not the assertion — a service that charged twice and
  // returned the first order's DTO would satisfy it. Stripe's own intent list is.
  const missing = missingStripeKeys();
  test.skip(missing !== null, missing ?? "");

  const customerId = await customerIdForEmail(buyer.email);
  const attempts = await chargeAttemptsForCustomer(customerId as string);
  expect(attempts.length, `charge attempts after one create and one replay:\n${describeAttempts(attempts)}`).toBe(1);
  expect(attempts[0], describeAttempts(attempts)).toMatchObject({ status: "succeeded", orderId: created.id });
});

test("the same Idempotency-Key with a different purchase returns 422 idempotency_key_mismatch and charges once", async () => {
  const orders = await ordersClient();
  const buyer = await makeBuyer();
  const productId = await orderableProductId(orders, buyer.userId, 3);
  const key = randomUUID();

  const first = await createOrder(orders, buyer.userId, productId, 1, {
    idempotencyKey: key,
    paymentMethodId: buyer.paymentMethodId,
  });
  expect(first.status(), await first.text()).toBe(201);
  const created = await first.json();

  const mismatch = await createOrder(orders, buyer.userId, productId, 2, {
    idempotencyKey: key,
    paymentMethodId: buyer.paymentMethodId,
  });
  expect(mismatch.status(), await mismatch.text()).toBe(422);
  expect(await mismatch.json()).toMatchObject({ error: "idempotency_key_mismatch" });

  const missing = missingStripeKeys();
  test.skip(missing !== null, missing ?? "");

  const customerId = await customerIdForEmail(buyer.email);
  const attempts = await chargeAttemptsForCustomer(customerId as string);
  expect(attempts.length, `charge attempts after a rejected mismatch:\n${describeAttempts(attempts)}`).toBe(1);
  expect(attempts[0].orderId, describeAttempts(attempts)).toBe(created.id);
});

// The HTTP counterpart of Orders' unit test
// CreateOrder_FiredConcurrentlyWithTheSameKey_PersistsOneOrderAndChargesOnce
// (services/orders/tests/Orders.Tests/Api/CreateOrderIdempotencyTests.cs). That one drives
// the service in-process with a fake Stripe; this one proves the same guarantee survives
// three real sockets and one real PaymentIntent.
test("three concurrent creates with one Idempotency-Key yield one order, one 201, and one charge", async () => {
  const orders = await ordersClient();
  const buyer = await makeBuyer();
  const productId = await orderableProductId(orders, buyer.userId, 3);
  const key = randomUUID();

  const responses = await Promise.all(
    [0, 1, 2].map(() =>
      createOrder(orders, buyer.userId, productId, 1, {
        idempotencyKey: key,
        paymentMethodId: buyer.paymentMethodId,
      }),
    ),
  );

  const bodies = await Promise.all(responses.map((r) => r.text()));
  const outcome = responses.map((r, i) => `${r.status()} ${bodies[i]}`).join("\n");

  // CONTRACT: Assert on the SET of statuses, not on which request won. Any of the three
  // may commit first; only "exactly one 201 and two 200s" is the guarantee.
  expect(
    responses.map((r) => r.status()).sort(),
    `expected one 201 and two 200s, got:\n${outcome}`,
  ).toEqual([200, 200, 201]);

  const ids = bodies.map((b) => JSON.parse(b).id as string);
  expect(new Set(ids), `every response must carry ONE order id, got ${ids.join(", ")}`).toEqual(new Set([ids[0]]));

  const myOrders = await orders.get("/v1/orders/my-orders", { headers: { "x-user-id": buyer.userId } });
  expect((await myOrders.json()).map((o: { id: string }) => o.id)).toEqual([ids[0]]);

  const missing = missingStripeKeys();
  test.skip(missing !== null, missing ?? "");

  const customerId = await customerIdForEmail(buyer.email);
  const attempts = await chargeAttemptsForCustomer(customerId as string);
  expect(attempts.length, `charge attempts after three concurrent creates:\n${describeAttempts(attempts)}`).toBe(1);
  expect(attempts[0], describeAttempts(attempts)).toMatchObject({ status: "succeeded", orderId: ids[0] });
});

// CONTRACT: The metadata-only card validation (a known brand, a 4-digit last4, an unexpired
// expiry) runs ONLY with STRIPE_ENABLED=false — CreateOrderEndpoint gates it on `!stripe.Enabled`,
// because the Payment Element validates the card on the Stripe branch and a saved `pm_` carries
// no client-supplied metadata to check. Its cases therefore belong to a flag-off run; what this
// spec can prove with the flag ON is that the field is IGNORED rather than half-enforced.
// See [[2026-09-19-stripe-payments-design]]
test("with the flag on, a card metadata block that would fail every validation rule is ignored", async () => {
  const orders = await ordersClient();
  const buyer = await makeBuyer();
  const productId = await orderableProductId(orders, buyer.userId);

  const res = await createOrder(orders, buyer.userId, productId, 1, {
    idempotencyKey: randomUUID(),
    paymentMethodId: buyer.paymentMethodId,
    card: { brand: "not-a-brand", last4: "nope", expMonth: 13, expYear: 1999 },
  });
  expect(res.status(), await res.text()).toBe(201);

  const missing = missingStripeKeys();
  test.skip(missing !== null, missing ?? "");

  // The charge still reads its brand and last4 from Stripe's own charge, never from the
  // ignored block — the strongest available evidence that the field went nowhere.
  const customerId = await customerIdForEmail(buyer.email);
  const attempts = await chargeAttemptsForCustomer(customerId as string);
  expect(attempts.length, describeAttempts(attempts)).toBe(1);
  expect(attempts[0], describeAttempts(attempts)).toMatchObject({ cardBrand: "visa", cardLast4: "4242" });
});
