import { test, expect } from "@playwright/test";
import { getGatewayToken } from "../../support/auth.js";
import { gatewayClient } from "../../support/gateway-client.js";

// Gateway E2E for the cart endpoints (GET/PUT/DELETE /v1/cart), added
// alongside the checkout flow. Real Cognito JWT through API_GATEWAY_URL —
// this is the layer that catches a missing route, a dropped verb, or a
// method mismatch, which the in-process/internal specs structurally cannot
// see because they fake the authorizer. gatewayClient() already sends
// X-E2E-Source on every request (see support/gateway-client.ts), so the
// order created in scenario 6 below is tagged for the existing teardown
// without any extra header.
//
// Wire format is camelCase throughout (productId, quantity, items, unitPrice,
// unitsInStock, unavailableReason, canCheckout) — verified against
// services/orders/openapi.yaml, not inferred from field-name guesses.

async function newAuthedClient(): Promise<Awaited<ReturnType<typeof gatewayClient>>> {
  const { token } = await getGatewayToken();
  return gatewayClient(token);
}

async function firstProductWithStock(
  api: Awaited<ReturnType<typeof gatewayClient>>,
): Promise<{ id: string; unitsInStock: number }> {
  const products = await api.get("v1/products");
  expect(products.status(), `GET v1/products failed: ${await products.text()}`).toBe(200);
  const catalogue = await products.json();
  const product = catalogue.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product, "no product with stock in the catalogue").toBeTruthy();
  return product;
}

test("GET v1/cart with no cart returns 200 with an empty cart", async () => {
  const api = await newAuthedClient();
  const res = await api.get("v1/cart");
  expect(res.status(), `GET v1/cart failed: ${await res.text()}`).toBe(200);
  const cart = await res.json();
  expect(cart.id).toBeNull();
  expect(cart.items).toEqual([]);
});

test("PUT v1/cart with one line returns 200 with a priced, checkable cart", async () => {
  const api = await newAuthedClient();
  const product = await firstProductWithStock(api);

  const res = await api.put("v1/cart", {
    data: { items: [{ productId: product.id, quantity: 2 }] },
  });
  expect(res.status(), `PUT v1/cart failed: ${await res.text()}`).toBe(200);
  const cart = await res.json();

  expect(cart.id).toMatch(/^crt_/);
  expect(cart.items).toHaveLength(1);

  const [line] = cart.items;
  expect(line.productId).toBe(product.id);
  expect(line.quantity).toBe(2);
  expect(line.available).toBe(true);
  expect(typeof line.name).toBe("string");
  expect(line.name.length).toBeGreaterThan(0);
  expect(line.image).toBeTruthy();
  // Money shape: both the raw cents view and the dollar view must be present
  // and agree — the whole point of the change was that clients stop dividing
  // cents by 100, so `.amount` needs its own coverage, not just `.cents`.
  expect(typeof line.unitPrice.cents).toBe("number");
  expect(typeof line.unitPrice.amount).toBe("string");
  expect(Number(line.unitPrice.amount)).toBeCloseTo(line.unitPrice.cents / 100, 2);

  expect(cart.canCheckout).toBe(true);
});

test("PUT v1/cart with quantity 0 on the only line empties and deletes the cart", async () => {
  const api = await newAuthedClient();
  const product = await firstProductWithStock(api);

  const created = await api.put("v1/cart", {
    data: { items: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status(), `PUT v1/cart failed: ${await created.text()}`).toBe(200);
  const cart = await created.json();
  expect(cart.id).toMatch(/^crt_/);

  const emptied = await api.put("v1/cart", {
    data: { items: [{ productId: product.id, quantity: 0 }] },
  });
  expect(emptied.status(), `PUT v1/cart (quantity 0) failed: ${await emptied.text()}`).toBe(200);
  const emptiedCart = await emptied.json();
  expect(emptiedCart.id).toBeNull();
  expect(emptiedCart.items).toEqual([]);
});

test("DELETE v1/cart returns 204 and is idempotent on a second call", async () => {
  const api = await newAuthedClient();
  const product = await firstProductWithStock(api);

  const created = await api.put("v1/cart", {
    data: { items: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status(), `PUT v1/cart failed: ${await created.text()}`).toBe(200);

  const first = await api.delete("v1/cart");
  expect(first.status(), `DELETE v1/cart failed: ${await first.text()}`).toBe(204);

  // No cart left to delete — must still be 204, not 404.
  const second = await api.delete("v1/cart");
  expect(second.status(), `second DELETE v1/cart should be idempotent: ${await second.text()}`).toBe(204);
});

test("PUT v1/cart with a negative quantity returns 400", async () => {
  const api = await newAuthedClient();
  const product = await firstProductWithStock(api);

  const res = await api.put("v1/cart", {
    data: { items: [{ productId: product.id, quantity: -1 }] },
  });
  expect(res.status(), `expected 400, got ${res.status()}: ${await res.text()}`).toBe(400);
});

test("creating an order consumes the cart: PUT, POST v1/orders, then GET v1/cart is empty", async () => {
  const api = await newAuthedClient();
  const product = await firstProductWithStock(api);

  const putRes = await api.put("v1/cart", {
    data: { items: [{ productId: product.id, quantity: 1 }] },
  });
  expect(putRes.status(), `PUT v1/cart failed: ${await putRes.text()}`).toBe(200);
  const cart = await putRes.json();
  expect(cart.id).toMatch(/^crt_/);

  // gatewayClient() already sends X-E2E-Source on every request, so this order
  // is tagged for the existing teardown the same as every other gateway spec.
  const created = await api.post("v1/orders", {
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status(), `POST v1/orders failed: ${await created.text()}`).toBe(201);

  const afterOrder = await api.get("v1/cart");
  expect(afterOrder.status(), `GET v1/cart failed: ${await afterOrder.text()}`).toBe(200);
  const emptiedCart = await afterOrder.json();
  expect(emptiedCart.id).toBeNull();
  expect(emptiedCart.items).toEqual([]);
});
