import { test, expect } from "@playwright/test";
import { getGatewayToken } from "../../support/auth.js";
import { gatewayClient } from "../../support/gateway-client.js";

test("through the gateway: auth, list products, create order, get it by id", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);

  // products route resolves through the gateway (was a 404 — missing gateway route)
  const products = await api.get("v1/products");
  expect(products.status()).toBe(200);
  const list = await products.json();
  expect(Array.isArray(list)).toBe(true);
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product).toBeTruthy();

  // create order (returns the full OrderDto)
  const created = await api.post("v1/orders", {
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status()).toBe(201);
  const order = await created.json();
  expect(order.id).toMatch(/^ord_/);

  // get order by id — the {orderId} path param (was a 405: integration dropped the id)
  const fetched = await api.get(`v1/orders/${order.id}`);
  expect(fetched.status()).toBe(200);
  expect((await fetched.json()).id).toBe(order.id);
});

test("through the gateway: protected route without a token is 401", async () => {
  const api = await gatewayClient(); // no token
  const res = await api.get("v1/orders/my-orders");
  expect(res.status()).toBe(401);
});
