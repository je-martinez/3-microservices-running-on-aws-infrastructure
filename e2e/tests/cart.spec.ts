import { test, expect } from "@playwright/test";
import { apiClient, ordersClient } from "../support/api-client.js";
import { makeUser } from "../support/chance-factory.js";

// Drives the Orders service directly (localhost:3001, bypassing the gateway),
// with a faked x-user-id standing in for the authorizer's output — the
// internal counterpart to gateway/cart.spec.ts. Same registration trick as
// orders.spec.ts: Orders resolves x-user-id as a Cognito sub via gRPC to
// Users for any endpoint that needs the internal usr_ id, and Users' gRPC
// GetUserById resolves by usr_ id OR Cognito sub, so the usr_ id returned by
// POST /v1/users/register (via apiClient(), the Users service) works
// directly as x-user-id against Orders.
//
// Wire format is camelCase throughout (productId, quantity, items, unitPrice,
// unitsInStock, unavailableReason, canCheckout) — verified against
// services/orders/openapi.yaml, not inferred from field-name guesses.
//
// This layer's value over the gateway spec: it is fast, and it exercises
// cases the gateway spec should not spend time on — multiple 400 variants,
// the unknown-product line shape, and cross-user isolation.

async function registerCaller(): Promise<string> {
  const users = await apiClient();
  const res = await users.post("/v1/users/register", { data: makeUser() });
  expect(res.status()).toBe(201);
  const { id } = await res.json();
  return id as string;
}

async function firstProductWithStock(
  api: Awaited<ReturnType<typeof ordersClient>>,
  userId: string,
): Promise<{ id: string; unitsInStock: number }> {
  const products = await api.get("/v1/products", { headers: { "x-user-id": userId } });
  expect(products.status()).toBe(200);
  const list = await products.json();
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product, "no product with stock in the catalogue").toBeTruthy();
  return product;
}

test("GET /v1/cart with no cart returns 200 with id: null and items: []", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();

  const res = await api.get("/v1/cart", { headers: { "x-user-id": userId } });
  expect(res.status()).toBe(200);
  const cart = await res.json();
  expect(cart.id).toBeNull();
  expect(cart.items).toEqual([]);
});

test("PUT /v1/cart creates a cart, and GET returns the same cart id", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();
  const product = await firstProductWithStock(api, userId);

  const put = await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: { items: [{ productId: product.id, quantity: 1 }] },
  });
  expect(put.status()).toBe(200);
  const putCart = await put.json();
  expect(putCart.id).toMatch(/^crt_/);

  const get = await api.get("/v1/cart", { headers: { "x-user-id": userId } });
  expect(get.status()).toBe(200);
  const getCart = await get.json();
  expect(getCart.id).toBe(putCart.id);
});

test("PUT /v1/cart replaces the line set: a product absent from the second PUT is gone", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();

  const products = await api.get("/v1/products", { headers: { "x-user-id": userId } });
  const list = await products.json();
  const inStock = list.filter((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(inStock.length).toBeGreaterThanOrEqual(2);
  const [productA, productB] = inStock;

  const first = await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: {
      items: [
        { productId: productA.id, quantity: 1 },
        { productId: productB.id, quantity: 1 },
      ],
    },
  });
  expect(first.status()).toBe(200);
  const firstCart = await first.json();
  expect(firstCart.items.map((i: { productId: string }) => i.productId).sort()).toEqual(
    [productA.id, productB.id].sort(),
  );

  // Second PUT omits productA entirely — a replace, not a merge.
  const second = await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: { items: [{ productId: productB.id, quantity: 1 }] },
  });
  expect(second.status()).toBe(200);
  const secondCart = await second.json();
  expect(secondCart.items).toHaveLength(1);
  expect(secondCart.items[0].productId).toBe(productB.id);
});

test("PUT /v1/cart with quantity 0 removes one line while another survives", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();

  const products = await api.get("/v1/products", { headers: { "x-user-id": userId } });
  const list = await products.json();
  const inStock = list.filter((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(inStock.length).toBeGreaterThanOrEqual(2);
  const [productA, productB] = inStock;

  const created = await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: {
      items: [
        { productId: productA.id, quantity: 1 },
        { productId: productB.id, quantity: 1 },
      ],
    },
  });
  expect(created.status()).toBe(200);

  const updated = await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: {
      items: [
        { productId: productA.id, quantity: 0 },
        { productId: productB.id, quantity: 1 },
      ],
    },
  });
  expect(updated.status()).toBe(200);
  const updatedCart = await updated.json();
  expect(updatedCart.items).toHaveLength(1);
  expect(updatedCart.items[0].productId).toBe(productB.id);
});

test("emptying the cart (items: []) deletes it — a following GET returns id: null", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();
  const product = await firstProductWithStock(api, userId);

  const created = await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: { items: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status()).toBe(200);
  const cart = await created.json();
  expect(cart.id).toMatch(/^crt_/);

  const emptied = await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: { items: [] },
  });
  expect(emptied.status()).toBe(200);
  const emptiedCart = await emptied.json();
  expect(emptiedCart.id).toBeNull();
  expect(emptiedCart.items).toEqual([]);

  const get = await api.get("/v1/cart", { headers: { "x-user-id": userId } });
  expect(get.status()).toBe(200);
  const getCart = await get.json();
  expect(getCart.id).toBeNull();
});

test("DELETE /v1/cart returns 204, and a second DELETE is idempotent (204)", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();
  const product = await firstProductWithStock(api, userId);

  const created = await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: { items: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status()).toBe(200);

  const first = await api.delete("/v1/cart", { headers: { "x-user-id": userId } });
  expect(first.status()).toBe(204);

  const second = await api.delete("/v1/cart", { headers: { "x-user-id": userId } });
  expect(second.status()).toBe(204);
});

test("PUT /v1/cart with a negative quantity returns 400", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();
  const product = await firstProductWithStock(api, userId);

  const res = await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: { items: [{ productId: product.id, quantity: -1 }] },
  });
  expect(res.status()).toBe(400);
});

test("PUT /v1/cart with a duplicated productId returns 400", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();
  const product = await firstProductWithStock(api, userId);

  const res = await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: {
      items: [
        { productId: product.id, quantity: 1 },
        { productId: product.id, quantity: 2 },
      ],
    },
  });
  expect(res.status()).toBe(400);
});

test("PUT /v1/cart with missing or null items returns 400", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();

  const missing = await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: {},
  });
  expect(missing.status()).toBe(400);

  const nullItems = await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: { items: null },
  });
  expect(nullItems.status()).toBe(400);
});

test("a cart line for a product that no longer exists comes back unavailable rather than 404ing the request", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();

  // No such product; the PUT itself must still succeed — the whole point of
  // "available: false" is that a stale line does not blow up the request.
  const res = await api.put("/v1/cart", {
    headers: { "x-user-id": userId },
    data: { items: [{ productId: "prd_doesnotexist", quantity: 1 }] },
  });
  expect(res.status()).toBe(200);
  const cart = await res.json();
  expect(cart.items).toHaveLength(1);

  const [line] = cart.items;
  expect(line.productId).toBe("prd_doesnotexist");
  expect(line.available).toBe(false);
  expect(line.unavailableReason).toBe("unknown_product");
  expect(line.unitPrice).toBeNull();
  expect(line.name).toBeNull();
  expect(line.image).toBeNull();
});

test("two different users' carts are independent", async () => {
  const api = await ordersClient();
  const userA = await registerCaller();
  const userB = await registerCaller();

  const products = await api.get("/v1/products", { headers: { "x-user-id": userA } });
  const list = await products.json();
  const inStock = list.filter((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(inStock.length).toBeGreaterThanOrEqual(2);
  const [productA, productB] = inStock;

  const putA = await api.put("/v1/cart", {
    headers: { "x-user-id": userA },
    data: { items: [{ productId: productA.id, quantity: 1 }] },
  });
  expect(putA.status()).toBe(200);

  const putB = await api.put("/v1/cart", {
    headers: { "x-user-id": userB },
    data: { items: [{ productId: productB.id, quantity: 1 }] },
  });
  expect(putB.status()).toBe(200);

  const getA = await api.get("/v1/cart", { headers: { "x-user-id": userA } });
  const cartA = await getA.json();
  expect(cartA.items).toHaveLength(1);
  expect(cartA.items[0].productId).toBe(productA.id);

  const getB = await api.get("/v1/cart", { headers: { "x-user-id": userB } });
  const cartB = await getB.json();
  expect(cartB.items).toHaveLength(1);
  expect(cartB.items[0].productId).toBe(productB.id);
});

test("an empty cart still reports the shipping charge, so total is non-zero", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();

  const res = await api.get("/v1/cart", { headers: { "x-user-id": userId } });
  expect(res.status()).toBe(200);
  const cart = await res.json();
  expect(cart.id).toBeNull();
  // total = subtotal + tax + shipping, no exceptions — shipping is charged
  // even with an empty cart, so total is NOT zero.
  expect(cart.total.cents).toBe(cart.subtotal.cents + cart.tax.cents + cart.shipping.cents);
  expect(cart.shipping.cents).toBeGreaterThan(0);
  expect(cart.total.cents).toBeGreaterThan(0);
});
