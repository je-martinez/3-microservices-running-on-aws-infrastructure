import { test, expect } from "@playwright/test";
import { getGatewayToken } from "../../support/auth.js";
import { gatewayClient } from "../../support/gateway-client.js";

// Full gateway coverage of the remaining current Orders endpoints (beyond the
// happy-path flow already covered by orders-flow.spec.ts): health, my-orders,
// products auth gating, the gateway-observable error paths on order creation,
// and a method-mismatch guard on the {orderId} param route. Each authed spec
// uses its own isolated E2E user via getGatewayToken().

test("GET v1/orders/health is public and returns 200 with no auth", async () => {
  const api = await gatewayClient(); // no token
  const res = await api.get("v1/orders/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("GET v1/orders/my-orders returns 200 and lists the caller's orders with a Bearer token", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);

  // Create an order for this caller first, so the list is non-empty.
  const products = await api.get("v1/products");
  expect(products.status()).toBe(200);
  const list = await products.json();
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product).toBeTruthy();
  const created = await api.post("v1/orders", { data: { lines: [{ productId: product.id, quantity: 1 }] } });
  expect(created.status()).toBe(201);
  const order = await created.json();

  const res = await api.get("v1/orders/my-orders");
  expect(res.status()).toBe(200);
  const orders = await res.json();
  expect(Array.isArray(orders)).toBe(true);
  expect(orders.some((o: { id: string }) => o.id === order.id)).toBe(true);
});

test("GET v1/orders/my-orders is 401 without a Bearer token", async () => {
  const api = await gatewayClient(); // no token
  const res = await api.get("v1/orders/my-orders");
  expect(res.status()).toBe(401);
});

test("GET v1/products returns 200 with a Bearer token", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);
  const res = await api.get("v1/products");
  expect(res.status()).toBe(200);
  const list = await res.json();
  expect(Array.isArray(list)).toBe(true);
  expect(list.length).toBeGreaterThan(0);
});

test("GET v1/products is 401 without a Bearer token (it's a protected route)", async () => {
  const api = await gatewayClient(); // no token
  const res = await api.get("v1/products");
  expect(res.status()).toBe(401);
});

test("GET v1/products serves the eight seeded products with categories and artwork", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);
  const res = await api.get("v1/products");
  expect(res.status()).toBe(200);
  const list = await res.json();

  // Assert on the NAMES, not just the count: "expected 8, got 3" cannot tell a
  // broken system from a stale seed, whereas the actual list names the problem.
  expect(list.map((p: { name: string }) => p.name).sort()).toEqual([
    "Everyday Backpack",
    "Field Tote 18L",
    "Leather Card Holder",
    "Linen Cap",
    "Runner Low Canvas",
    "Steel Bottle 750ml",
    "Trail Shell Jacket",
    "Wool Runner Mid",
  ]);

  for (const p of list) {
    expect(p.categories, `${p.name} has no categories`).not.toHaveLength(0);
    expect(p.image, `${p.name} has no image`).toBeTruthy();
    // ABSOLUTE url: the row stores a bucket-relative key and the service composes
    // this from ASSETS_BASE_URL. A relative value here means that wiring is broken.
    expect(p.image.uri, `${p.name} image uri is not absolute`).toMatch(
      /^https?:\/\/.+\/products\/.+\.jpg$/,
    );
    expect(p.image.blurhash, `${p.name} has no blurhash`).toBeTruthy();
    expect(p.image.width).toBeGreaterThan(0);
    expect(p.image.height).toBeGreaterThan(0);
  }
});

test("the image URL v1/products advertises actually serves a JPEG", async () => {
  // The ONLY layer that proves the seeded key, the uploaded object and the base URL
  // all agree — a seed typo passes every in-process test and 404s only here.
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);
  const res = await api.get("v1/products");
  const [first] = await res.json();

  // Fetched directly, not through the gateway client: image.uri is an absolute
  // bucket URL, not an API route.
  const image = await fetch(first.image.uri);
  expect(
    image.status,
    `${first.image.uri} did not serve an image — run \`make post-infra && make assets-sync\``,
  ).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/jpeg");
});

test("POST v1/orders with a nonexistent product returns 404 unknown_product", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);
  const res = await api.post("v1/orders", {
    data: { lines: [{ productId: "prd_doesnotexist", quantity: 1 }] },
  });
  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(body.error).toBe("unknown_product");
});

test("POST v1/orders with an over-stock quantity returns 409 insufficient_stock", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);

  const products = await api.get("v1/products");
  expect(products.status()).toBe(200);
  const list = await products.json();
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product).toBeTruthy();

  const res = await api.post("v1/orders", {
    data: { lines: [{ productId: product.id, quantity: product.unitsInStock + 1_000_000 }] },
  });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.error).toBe("insufficient_stock");
});

// Method-mismatch guard: the gateway only declares `GET /v1/orders/{orderId}`
// (see infra/modules/api-gateway/main.tf — no POST/PATCH/DELETE route key
// exists for that path). API Gateway v2 route matching is exact on
// method+path, so a method with no matching route key simply doesn't resolve
// to ANY route (not even Orders' own 405 for an unmapped verb) — it fails at
// the gateway itself before reaching nginx/the service. Verified live: the
// gateway returns 404 `{"message":"Not Found"}` (its own body, not the
// service's JSON error shape), not a 405. This guards the class of bug where
// a route/method mismatch surfaces only at the gateway (see the {orderId}
// path-param fix in orders-flow.spec.ts for the sibling GET-side bug).
test("POST v1/orders/{orderId} (method not declared on the param route) is gateway 404, not 405", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);
  const res = await api.post("v1/orders/ord_doesnotexist", { data: {} });
  expect(res.status()).toBe(404);
  const body = await res.json();
  // The gateway's own "no matching route" body — distinct from the Orders
  // service's `{ error: "..." }` contract — confirming this never reached nginx.
  expect(body).toEqual({ message: "Not Found" });
});
