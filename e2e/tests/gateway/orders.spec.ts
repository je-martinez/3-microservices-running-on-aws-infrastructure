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

// CONTRACT: Expect the gateway's own 404 `{"message":"Not Found"}`, not a 405. The
// gateway declares only `GET /v1/orders/{orderId}`, and API Gateway v2 matches exactly
// on method+path — an undeclared verb resolves to NO route and fails at the gateway
// before reaching nginx or the service, so Orders' own 405 never happens. This guards
// the class of bug that surfaces only at the gateway.
// See [[2026-08-25-route-works-in-process-but-404s-at-gateway]]
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

// The customer-facing order number, over the URL a user actually hits.
//
// CONTRACT: This is the layer that catches what the other two cannot. The
// in-process tests build the DTO directly and the internal E2E fakes the
// authorizer, so neither proves the field survives the gateway's serialization
// on the routes a browser reads. See [[testing]]

/** Both forms, exactly as services/orders/openapi.yaml declares OrderNumberDto. */
function expectWellFormedOrderNumber(orderNumber: unknown): { raw: string; formatted: string } {
  expect(
    orderNumber,
    "the order carries no orderNumber — a freshly created order must always have one, so " +
      "either CreateOrderService stopped minting it or the DTO stopped serializing it",
  ).toBeTruthy();

  const { raw, formatted } = orderNumber as { raw: string; formatted: string };

  // Canonical: 6 date digits + 6 Crockford base32, no separator, no I/L/O/U.
  expect(raw, `raw "${raw}" is not the canonical 12-character form`).toMatch(
    /^[0-9]{6}[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/,
  );
  // Displayed: one hyphen, in one place. The server owns this rule.
  expect(formatted, `formatted "${formatted}" is not YYMMDD-XXXXXX`).toBe(
    `${raw.slice(0, 6)}-${raw.slice(6)}`,
  );

  return { raw, formatted };
}

test("a created order carries its customer-facing number through the gateway", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);

  const products = await api.get("v1/products");
  const list = await products.json();
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  expect(product).toBeTruthy();

  const created = await api.post("v1/orders", {
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status()).toBe(201);
  const order = await created.json();

  const { raw } = expectWellFormedOrderNumber(order.orderNumber);

  // CONTRACT: The number is a LABEL and the id stays the identifier. A response
  // that returned the number as `id` would still look plausible here, so the two
  // are asserted to differ and `id` is asserted to keep its prefix.
  expect(order.id).toMatch(/^ord_/);
  expect(order.id).not.toBe(raw);

  // The date half is derived from the order's own creation instant, in UTC. A
  // generator reading the host's local zone drifts by a day either side of
  // midnight, which is invisible for most of the day and wrong for the rest.
  const createdAt = new Date(order.createdAt);
  const expectedPrefix =
    String(createdAt.getUTCFullYear() % 100).padStart(2, "0") +
    String(createdAt.getUTCMonth() + 1).padStart(2, "0") +
    String(createdAt.getUTCDate()).padStart(2, "0");
  expect(
    raw.slice(0, 6),
    `the number's date half is ${raw.slice(0, 6)} but the order was created at ` +
      `${order.createdAt} (UTC ${expectedPrefix}) — the prefix is being derived from the ` +
      "host's local zone rather than UTC",
  ).toBe(expectedPrefix);
});

test("the same order number comes back on both read routes", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);

  const products = await api.get("v1/products");
  const list = await products.json();
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock > 0);
  const created = await api.post("v1/orders", {
    data: { lines: [{ productId: product.id, quantity: 1 }] },
  });
  expect(created.status()).toBe(201);
  const order = await created.json();
  const minted = expectWellFormedOrderNumber(order.orderNumber);

  // CONTRACT: Creation maps the in-memory order and the reads map a re-queried
  // row, through two SEPARATE mappers that can silently diverge. The visible
  // symptom is a customer quoting a number the detail page does not show.
  const detail = await api.get(`v1/orders/${order.id}?includeTracking=true`);
  expect(detail.status()).toBe(200);
  const detailNumber = expectWellFormedOrderNumber((await detail.json()).order.orderNumber);
  expect(
    detailNumber.raw,
    "the detail read returned a DIFFERENT order number than creation did — the two mappers " +
      "have diverged, or the number is being re-minted on read instead of persisted",
  ).toBe(minted.raw);

  const mine = await api.get("v1/orders/my-orders");
  expect(mine.status()).toBe(200);
  const listed = (await mine.json()).find((o: { id: string }) => o.id === order.id);
  expect(listed).toBeTruthy();
  expect(expectWellFormedOrderNumber(listed.orderNumber).raw).toBe(minted.raw);
});

test("two orders placed on the same day get different numbers", async () => {
  const { token } = await getGatewayToken();
  const api = await gatewayClient(token);

  const products = await api.get("v1/products");
  const list = await products.json();
  const product = list.find((p: { unitsInStock: number }) => p.unitsInStock > 1);
  expect(product).toBeTruthy();

  const numbers: string[] = [];
  for (let i = 0; i < 2; i++) {
    const created = await api.post("v1/orders", {
      data: { lines: [{ productId: product.id, quantity: 1 }] },
    });
    expect(created.status()).toBe(201);
    numbers.push(expectWellFormedOrderNumber((await created.json()).orderNumber).raw);
  }

  // They share a date prefix (same day) and must differ in the random half. Equal
  // numbers would mean the suffix is not random — the unique index would then be
  // rejecting real orders rather than the rare collision it exists for.
  expect(numbers[0].slice(0, 6)).toBe(numbers[1].slice(0, 6));
  expect(
    numbers[0],
    `two orders on the same day both got ${numbers[0]} — the random suffix is not random`,
  ).not.toBe(numbers[1]);
});
