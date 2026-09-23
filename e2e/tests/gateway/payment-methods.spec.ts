import { test, expect, type APIRequestContext } from "@playwright/test";
import { getGatewayToken } from "../../support/auth.js";
import { gatewayClient } from "../../support/gateway-client.js";

// Gateway E2E for the Users payment-method routes and the Stripe webhook, with a real
// Cognito JWT through API_GATEWAY_URL. Proves each route resolves, carries the JWT
// identity through to Users, and returns the service's shape; the exhaustive cases
// (declines, cross-user attach, signed webhooks) live in ../payment-methods.spec.ts.
// Shapes come from services/users/openapi.yaml. gatewayClient() sends X-E2E-Source,
// so e2e-cleanup deletes each user AND its Stripe customer.

type PaymentMethodView = { id: string; type: string; brand: string | null; last4: string | null; isDefault: boolean };

async function newAuthedClient(): Promise<APIRequestContext> {
  const { token } = await getGatewayToken();
  return gatewayClient(token);
}

async function listPaymentMethods(api: APIRequestContext): Promise<PaymentMethodView[]> {
  const res = await api.get("v1/users/me/payment-methods");
  expect(res.status(), `GET payment-methods failed: ${await res.text()}`).toBe(200);
  return res.json();
}

let unavailableReason: string | null = null;

test.beforeAll(async () => {
  // WHY: With STRIPE_ENABLED=false Users never mounts these routes and its framework
  // 404 answers. The gateway's own {"message":"Not Found"} is a missing route and must
  // FAIL the suite, so only a 404 that reached Users skips it.
  const res = await (await newAuthedClient()).get("v1/users/me/payment-methods");
  if (res.status() !== 404) return;
  const body = await res.json().catch(() => ({}));
  if (body.message !== "Not Found") {
    unavailableReason = "STRIPE_ENABLED is off — payment-methods routes are not mounted in Users.";
  }
});

test.describe("payment methods", () => {
  test.beforeEach(() => {
    test.skip(unavailableReason !== null, unavailableReason ?? "");
  });

  test("a fresh user lists none and gets a SetupIntent client secret", async () => {
    const api = await newAuthedClient();
    expect(await listPaymentMethods(api)).toEqual([]);

    const res = await api.post("v1/users/me/payment-methods/setup-intent");
    expect(res.status(), `POST setup-intent failed: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.clientSecret).toMatch(/^seti_.+_secret_/);
  });

  test("attach, set default and detach a test card, each visible in the list", async () => {
    const api = await newAuthedClient();

    const attached = await api.post("v1/users/me/payment-methods", {
      data: { paymentMethodId: "pm_card_visa" },
    });
    expect(attached.status(), `POST payment-methods failed: ${await attached.text()}`).toBe(200);
    const { id: pmId } = await attached.json();
    expect(pmId).toMatch(/^pm_/);

    await test.step("list shows the card, not yet default", async () => {
      const rows = await listPaymentMethods(api);
      expect(rows.map((r) => r.id)).toEqual([pmId]);
      expect(rows[0]).toMatchObject({ type: "card", brand: "visa", last4: "4242", isDefault: false });
    });

    await test.step("another user's JWT does not see it", async () => {
      const other = await newAuthedClient();
      expect(await listPaymentMethods(other)).toEqual([]);
    });

    await test.step("PUT {id}/default carries the path param and flips isDefault", async () => {
      const res = await api.put(`v1/users/me/payment-methods/${pmId}/default`);
      expect(res.status(), `PUT default failed: ${await res.text()}`).toBe(204);
      const rows = await listPaymentMethods(api);
      expect(rows.find((r) => r.id === pmId)?.isDefault).toBe(true);
    });

    await test.step("DELETE {id} removes it from the list", async () => {
      const res = await api.delete(`v1/users/me/payment-methods/${pmId}`);
      expect(res.status(), `DELETE payment-method failed: ${await res.text()}`).toBe(204);
      expect(await listPaymentMethods(api)).toEqual([]);
    });
  });

  test("GET payment-methods without a Bearer token is 401 at the gateway", async () => {
    const api = await gatewayClient();
    const res = await api.get("v1/users/me/payment-methods");
    expect(res.status(), `expected 401, got ${res.status()}: ${await res.text()}`).toBe(401);
    expect(await res.json()).toEqual({ message: "Unauthorized" });
  });
});

test("POST v1/users/stripe/webhook is public and reaches Users", async () => {
  // CONTRACT: Accept only Users' {error} shape — 400 invalid_signature with a webhook
  // secret configured, 503 stripe_unavailable without one. Do NOT widen this to any
  // 4xx: the gateway's own 404 {"message":"Not Found"} (route missing) or a 401
  // (route marked auth = true) would then pass. Signed events are covered internally.
  const api = await gatewayClient();
  const res = await api.post("v1/users/stripe/webhook", {
    headers: { "stripe-signature": "t=1,v1=deadbeef", "content-type": "application/json" },
    data: { id: "evt_gateway_probe", type: "charge.succeeded" },
  });
  const body = await res.text();
  const expected: Record<number, string> = { 400: "invalid_signature", 503: "stripe_unavailable" };
  expect(Object.keys(expected).map(Number), `unexpected ${res.status()}: ${body}`).toContain(res.status());
  expect(JSON.parse(body), `status ${res.status()}`).toEqual({ error: expected[res.status()] });
});
