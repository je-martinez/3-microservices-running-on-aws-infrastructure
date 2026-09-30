import { test, expect } from "@playwright/test";
import { apiClient, ordersClient } from "../support/api-client.js";
import { makeUser } from "../support/chance-factory.js";
import { makeBuyer, placeOrder } from "../support/orders-buyer.js";

// Drives Orders directly (localhost:3001), with a faked x-user-id standing in for the
// authorizer's output. Orders resolves it as a Cognito sub over gRPC when it needs the
// internal `usr_` id, and Users' `GetUserById` accepts either form, so register's id
// works directly here. The gateway path is exercised by tests/gateway/orders*.spec.ts.
//
// CONTRACT: Create through `placeOrder`, never with an inline `POST /v1/orders`. The
// subject here is stock, ownership and consolidation, and `placeOrder` pays for the
// order however the running stack demands, so these assertions hold with STRIPE_ENABLED
// in either position. An inline create answers `400 invalid_request` with the flag on.
// See [[2026-09-19-stripe-payments-design]]

// The GET-only cases need a caller and no card, so they register directly.
async function registerCaller(): Promise<string> {
  const users = await apiClient();
  const res = await users.post("/v1/users/register", { data: makeUser() });
  expect(res.status()).toBe(201);
  const { id } = await res.json();
  return id as string;
}

test("GET /v1/health is public and returns 200 with no auth", async () => {
  const api = await ordersClient();
  const res = await api.get("/v1/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("GET /v1/products returns 200 with x-user-id", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();
  const res = await api.get("/v1/products", { headers: { "x-user-id": userId } });
  expect(res.status()).toBe(200);
  const list = await res.json();
  expect(Array.isArray(list)).toBe(true);
  expect(list.length).toBeGreaterThan(0);
});

test("GET /v1/products without x-user-id returns 401 (middleware auth gate)", async () => {
  const api = await ordersClient();
  const res = await api.get("/v1/products");
  expect(res.status()).toBe(401);
});

test("GET /v1/orders/my-orders returns 200 and lists the caller's orders", async () => {
  const api = await ordersClient();
  const buyer = await makeBuyer(api);
  const userId = buyer.userId;

  // Empty before any order exists for this caller.
  const empty = await api.get("/v1/orders/my-orders", { headers: { "x-user-id": userId } });
  expect(empty.status()).toBe(200);
  const emptyList = await empty.json();
  expect(Array.isArray(emptyList)).toBe(true);
  expect(emptyList.length).toBe(0);

  const products = await api.get("/v1/products", { headers: { "x-user-id": userId } });
  const list = await products.json();
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product).toBeTruthy();

  const created = await placeOrder(api, buyer, [{ productId: product.id, quantity: 1 }]);
  expect(created.status(), await created.text()).toBe(201);
  const order = await created.json();

  const res = await api.get("/v1/orders/my-orders", { headers: { "x-user-id": userId } });
  expect(res.status()).toBe(200);
  const orders = await res.json();
  expect(Array.isArray(orders)).toBe(true);
  expect(orders.some((o: { id: string }) => o.id === order.id)).toBe(true);
});

test("GET /v1/orders/my-orders without x-user-id returns 401 (middleware auth gate)", async () => {
  const api = await ordersClient();
  const res = await api.get("/v1/orders/my-orders");
  expect(res.status()).toBe(401);
});

test("POST /v1/orders with x-user-id creates the order and GET /v1/orders/{id} round-trips it", async () => {
  const api = await ordersClient();
  const buyer = await makeBuyer(api);
  const userId = buyer.userId;

  const products = await api.get("/v1/products", { headers: { "x-user-id": userId } });
  expect(products.status()).toBe(200);
  const list = await products.json();
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product).toBeTruthy();

  const created = await placeOrder(api, buyer, [{ productId: product.id, quantity: 1 }]);
  expect(created.status(), await created.text()).toBe(201);
  const order = await created.json();
  expect(order.id).toMatch(/^ord_/);
  expect(order.userId).toBe(userId);
  expect(Array.isArray(order.lines)).toBe(true);
  expect(order.lines).toHaveLength(1);
  expect(order.lines[0]).toMatchObject({ productId: product.id, quantity: 1 });
  // Shipping is part of the order total: an order-level cost charged once per
  // shipment, read from the `shipping_cents` configuration key rather than
  // derived per line. The confirmation email prints all four figures, so a
  // total that excluded shipping would make the receipt fail its own
  // arithmetic in front of the buyer.
  expect(order.total.cents).toBe(order.subtotal.cents + order.tax.cents + order.shipping.cents);
  // Same invariant on the dollar view: the whole point of the Money shape is
  // that clients stop dividing cents by 100, so the `.amount` string needs its
  // own coverage rather than merely existing alongside `.cents`.
  expect(Number(order.total.amount)).toBeCloseTo(
    Number(order.subtotal.amount) + Number(order.tax.amount) + Number(order.shipping.amount),
    2,
  );

  const fetched = await api.get(`/v1/orders/${order.id}`, { headers: { "x-user-id": userId } });
  expect(fetched.status()).toBe(200);
  const fetchedOrder = await fetched.json();
  expect(fetchedOrder.id).toBe(order.id);
  expect(fetchedOrder.lines).toEqual(order.lines);
});

test("GET /v1/orders/{id} for another caller's order returns 404 (ownership)", async () => {
  const api = await ordersClient();
  const owner = await makeBuyer(api);
  const ownerId = owner.userId;
  const otherId = await registerCaller();

  const products = await api.get("/v1/products", { headers: { "x-user-id": ownerId } });
  const list = await products.json();
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product).toBeTruthy();

  const created = await placeOrder(api, owner, [{ productId: product.id, quantity: 1 }]);
  expect(created.status(), await created.text()).toBe(201);
  const order = await created.json();

  const asOther = await api.get(`/v1/orders/${order.id}`, { headers: { "x-user-id": otherId } });
  expect(asOther.status()).toBe(404);
});

// CONTRACT: This 404 and the 409 below both need a PAID request. Orders resolves the
// catalogue inside `PriceForChargeAsync`, before any charge, so an unknown product and
// short stock still fail there and cost nothing at Stripe — but the payment checks run
// FIRST, so an unpaid request never reaches either verdict.
test("POST /v1/orders with a nonexistent product returns 404 unknown_product", async () => {
  const api = await ordersClient();
  const buyer = await makeBuyer(api);

  const res = await placeOrder(api, buyer, [{ productId: "prd_doesnotexist", quantity: 1 }]);
  expect(res.status(), await res.text()).toBe(404);
  const body = await res.json();
  expect(body.error).toBe("unknown_product");
});

test("POST /v1/orders with an over-stock quantity returns 409 insufficient_stock", async () => {
  const api = await ordersClient();
  const buyer = await makeBuyer(api);
  const userId = buyer.userId;

  const products = await api.get("/v1/products", { headers: { "x-user-id": userId } });
  const list = await products.json();
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product).toBeTruthy();

  const res = await placeOrder(api, buyer, [
    { productId: product.id, quantity: product.unitsInStock + 1_000_000 },
  ]);
  expect(res.status(), await res.text()).toBe(409);
  const body = await res.json();
  expect(body.error).toBe("insufficient_stock");
});

// Two lines for the same product must consolidate into a single order line
// with the combined quantity, rather than persisting two separate lines.
test("POST /v1/orders consolidates two lines of the same product into one line with the combined quantity", async () => {
  const api = await ordersClient();
  const buyer = await makeBuyer(api);
  const userId = buyer.userId;

  const products = await api.get("/v1/products", { headers: { "x-user-id": userId } });
  const list = await products.json();
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock >= 5);
  expect(product).toBeTruthy();

  const created = await placeOrder(api, buyer, [
    { productId: product.id, quantity: 2 },
    { productId: product.id, quantity: 3 },
  ]);
  expect(created.status(), await created.text()).toBe(201);
  const order = await created.json();
  expect(order.lines).toHaveLength(1);
  expect(order.lines[0]).toMatchObject({ productId: product.id, quantity: 5 });
});
