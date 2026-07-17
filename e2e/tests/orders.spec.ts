import { test, expect } from "@playwright/test";
import { apiClient, ordersClient } from "../support/api-client.js";
import { makeUser } from "../support/chance-factory.js";

// Drives the Orders service directly (localhost:3001, bypassing the gateway),
// with a faked x-user-id standing in for the authorizer's output — the
// internal counterpart to users.spec.ts. Orders resolves x-user-id as a
// Cognito sub via gRPC to Users for any endpoint that needs the internal
// usr_ id (order creation, ownership checks). Users' gRPC GetUserById
// resolves by usr_ id OR Cognito sub, so the usr_ id returned by
// POST /v1/users/register (via apiClient(), the Users service) works
// directly as x-user-id against Orders — verified live against the running
// stack. The gateway path (JWT authorizer, njs sub-extraction, real Cognito
// tokens) is exercised separately by e2e/tests/gateway/orders*.spec.ts.

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
  const userId = await registerCaller();

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

  const created = await api.post("/v1/orders", {
    headers: { "x-user-id": userId },
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status()).toBe(201);
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
  const userId = await registerCaller();

  const products = await api.get("/v1/products", { headers: { "x-user-id": userId } });
  expect(products.status()).toBe(200);
  const list = await products.json();
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product).toBeTruthy();

  const created = await api.post("/v1/orders", {
    headers: { "x-user-id": userId },
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status()).toBe(201);
  const order = await created.json();
  expect(order.id).toMatch(/^ord_/);
  expect(order.userId).toBe(userId);
  expect(Array.isArray(order.lines)).toBe(true);
  expect(order.lines).toHaveLength(1);
  expect(order.lines[0]).toMatchObject({ productId: product.id, quantity: 1 });
  expect(order.totalCents).toBe(order.subtotalCents + order.taxCents);

  const fetched = await api.get(`/v1/orders/${order.id}`, { headers: { "x-user-id": userId } });
  expect(fetched.status()).toBe(200);
  const fetchedOrder = await fetched.json();
  expect(fetchedOrder.id).toBe(order.id);
  expect(fetchedOrder.lines).toEqual(order.lines);
});

test("GET /v1/orders/{id} for another caller's order returns 404 (ownership)", async () => {
  const api = await ordersClient();
  const ownerId = await registerCaller();
  const otherId = await registerCaller();

  const products = await api.get("/v1/products", { headers: { "x-user-id": ownerId } });
  const list = await products.json();
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product).toBeTruthy();

  const created = await api.post("/v1/orders", {
    headers: { "x-user-id": ownerId },
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status()).toBe(201);
  const order = await created.json();

  const asOther = await api.get(`/v1/orders/${order.id}`, { headers: { "x-user-id": otherId } });
  expect(asOther.status()).toBe(404);
});

test("POST /v1/orders with a nonexistent product returns 404 unknown_product", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();

  const res = await api.post("/v1/orders", {
    headers: { "x-user-id": userId },
    data: { lines: [{ productId: "prd_doesnotexist", quantity: 1 }] },
  });
  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(body.error).toBe("unknown_product");
});

test("POST /v1/orders with an over-stock quantity returns 409 insufficient_stock", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();

  const products = await api.get("/v1/products", { headers: { "x-user-id": userId } });
  const list = await products.json();
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product).toBeTruthy();

  const res = await api.post("/v1/orders", {
    headers: { "x-user-id": userId },
    data: { lines: [{ productId: product.id, quantity: product.unitsInStock + 1_000_000 }] },
  });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.error).toBe("insufficient_stock");
});

// Two lines for the same product must consolidate into a single order line
// with the combined quantity, rather than persisting two separate lines.
test("POST /v1/orders consolidates two lines of the same product into one line with the combined quantity", async () => {
  const api = await ordersClient();
  const userId = await registerCaller();

  const products = await api.get("/v1/products", { headers: { "x-user-id": userId } });
  const list = await products.json();
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock >= 5);
  expect(product).toBeTruthy();

  const created = await api.post("/v1/orders", {
    headers: { "x-user-id": userId },
    data: {
      lines: [
        { productId: product.id, quantity: 2 },
        { productId: product.id, quantity: 3 },
      ],
    },
  });
  expect(created.status()).toBe(201);
  const order = await created.json();
  expect(order.lines).toHaveLength(1);
  expect(order.lines[0]).toMatchObject({ productId: product.id, quantity: 5 });
});
