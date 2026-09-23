import { test, expect } from "@playwright/test";
import { gatewayClient } from "../../support/gateway-client.js";
import {
  BAD_SIGNATURE,
  WRONG_TOKEN,
  missingWebhookConfig,
  postWebhook,
  signedEvent,
  webhookToken,
} from "../../support/stripe-webhook.js";

// Gateway E2E for Orders' Stripe webhook (`auth = false`, so no JWT): the {token} route
// resolves, nginx sends it to Orders rather than Users, and the raw body survives for the
// signature. Cross-service tokens are covered in ../orders-stripe-webhook.spec.ts. Shapes
// from services/orders/openapi.yaml; only ignored event types — no charge or refund.

// WHY: The 403 forbidden_source path is unit-tested only. Every local caller is a private
// address the allowlist admits, and X-Forwarded-For is ignored at 0 trusted hops.

test.beforeEach(() => {
  const missing = missingWebhookConfig();
  test.skip(missing !== null, missing ?? "");
});

const ignoredEvent = () => signedEvent("customer.created", { id: `cus_e2e_${Date.now()}`, object: "customer" });

test("right token, correctly signed event Orders ignores is acknowledged 200 received:true", async () => {
  const res = await postWebhook(await gatewayClient(), "orders", webhookToken("orders"), ignoredEvent());
  expect(res.status, res.body).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ received: true });
});

test("right token, bad stripe-signature reaches Orders: 400 invalid_signature", async () => {
  const res = await postWebhook(await gatewayClient(), "orders", webhookToken("orders"), {
    ...ignoredEvent(),
    signature: BAD_SIGNATURE,
  });
  expect(res.status, res.body).toBe(400);
  expect(JSON.parse(res.body)).toEqual({ error: "invalid_signature" });
});

// CONTRACT: Prove the route IS mapped (right token → 400) before asserting the 404. ASP.NET
// answers an unmapped route with the same bodiless 404, so without the control this passes
// with STRIPE_ENABLED off or the route deleted.
test("a wrong token is Orders' bodiless 404, not the gateway's", async () => {
  const api = await gatewayClient();
  const event = ignoredEvent();
  const control = await postWebhook(api, "orders", webhookToken("orders"), { ...event, signature: BAD_SIGNATURE });
  expect(control.status, `control with the right token: ${control.body}`).toBe(400);

  const res = await postWebhook(api, "orders", WRONG_TOKEN, event);
  expect(res.status, res.body).toBe(404);
  expect(res.body).toBe("");
});
