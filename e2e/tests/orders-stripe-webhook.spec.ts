import { test, expect } from "@playwright/test";
import { ordersClient } from "../support/api-client.js";
import {
  BAD_SIGNATURE,
  WRONG_TOKEN,
  missingWebhookConfig,
  postWebhook,
  signedEvent,
  webhookToken,
} from "../support/stripe-webhook.js";

// Internal E2E for Orders' Stripe webhook, `POST /v1/orders/stripe/webhook/{token}` on the
// service port. Shapes come from services/orders/openapi.yaml. Only event types Orders
// acknowledges without reconciling are sent — no charge or refund is created here.
//
// WHY: The 403 forbidden_source path is unit-tested only. Every local caller is a private
// address the allowlist admits, and X-Forwarded-For is ignored at 0 trusted hops.

test.beforeEach(() => {
  const missing = missingWebhookConfig();
  test.skip(missing !== null, missing ?? "");
});

const ignoredEvent = () => signedEvent("customer.created", { id: `cus_e2e_${Date.now()}`, object: "customer" });

test("right token, correctly signed event Orders ignores is acknowledged 200 received:true", async () => {
  const res = await postWebhook(await ordersClient(), "orders", webhookToken("orders"), ignoredEvent());
  expect(res.status, res.body).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ received: true });
});

test("right token, bad stripe-signature is rejected 400 invalid_signature", async () => {
  const res = await postWebhook(await ordersClient(), "orders", webhookToken("orders"), {
    ...ignoredEvent(),
    signature: BAD_SIGNATURE,
  });
  expect(res.status, res.body).toBe(400);
  expect(JSON.parse(res.body)).toEqual({ error: "invalid_signature" });
});

// CONTRACT: Each 404 case first proves the route IS mapped (right token → 400). ASP.NET
// answers an unmapped route with the same bodiless 404, so without that control these
// pass with STRIPE_ENABLED off or the route deleted.
test("a wrong token answers a bodiless 404, even with a valid signature", async () => {
  const api = await ordersClient();
  const event = ignoredEvent();
  const control = await postWebhook(api, "orders", webhookToken("orders"), { ...event, signature: BAD_SIGNATURE });
  expect(control.status, `control with the right token: ${control.body}`).toBe(400);

  const res = await postWebhook(api, "orders", WRONG_TOKEN, event);
  expect(res.status, res.body).toBe(404);
  expect(res.body).toBe("");
});

test("Users' token on the Orders route is 404 — each service holds its own token", async () => {
  expect(webhookToken("orders") === webhookToken("users"), "Users and Orders share one URL token").toBe(false);
  const api = await ordersClient();
  const event = ignoredEvent();
  const control = await postWebhook(api, "orders", webhookToken("orders"), { ...event, signature: BAD_SIGNATURE });
  expect(control.status, `control with the right token: ${control.body}`).toBe(400);

  const res = await postWebhook(api, "orders", webhookToken("users"), event);
  expect(res.status, res.body).toBe(404);
  expect(res.body).toBe("");
});
