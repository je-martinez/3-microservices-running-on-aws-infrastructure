import { test, expect } from "@playwright/test";
import Stripe from "stripe";
import { apiClient } from "../support/api-client.js";
import { makeUser } from "../support/chance-factory.js";

// CONTRACT: Every request goes through apiClient(), which already sends
// `X-E2E-Source: true` (see api-client.ts) — every user and Stripe customer
// this file creates is tagged for e2e-cleanup, which also deletes the Stripe
// customer (services/users/src/features/users/http/e2e-cleanup.ts).

async function registerAndIdentify(): Promise<{ id: string }> {
  const api = await apiClient();
  const user = makeUser();
  const res = await api.post("/v1/users/register", { data: user });
  expect(res.status()).toBe(201);
  return res.json();
}

async function attach(userId: string, paymentMethodId: string) {
  const api = await apiClient();
  return api.post("/v1/users/me/payment-methods", {
    headers: { "x-user-id": userId },
    data: { paymentMethodId },
  });
}

async function list(userId: string) {
  const api = await apiClient();
  return api.get("/v1/users/me/payment-methods", { headers: { "x-user-id": userId } });
}

// Module-scoped: probed once in beforeAll, read by every test's test.skip().
// Mirrors email-templates.spec.ts's unavailableReason pattern.
let unavailableReason: string | null = null;

test.beforeAll(async () => {
  // Probe: with STRIPE_ENABLED=false the payment-methods module never mounts
  // (app.module.ts gates it), so the route does not exist and the framework's
  // own 404 answers — distinct from the handler's own 404 {error:"not_found"}
  // shape, which only a mounted route can produce. A registered user with a
  // real x-user-id is required so a mounted route would answer 200, not 404
  // for an unrelated reason (e.g. missing identity).
  const { id } = await registerAndIdentify();
  const res = await list(id);
  if (res.status() === 404) {
    unavailableReason = "STRIPE_ENABLED is off — payment-methods routes are not mounted.";
  }
});

test.beforeEach(() => {
  test.skip(unavailableReason !== null, unavailableReason ?? "");
});

test("setup-intent returns a client secret for a real SetupIntent", async () => {
  const { id } = await registerAndIdentify();
  const api = await apiClient();
  const res = await api.post("/v1/users/me/payment-methods/setup-intent", {
    headers: { "x-user-id": id },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.clientSecret).toMatch(/^seti_/);
});

test("attach a test card, list shows it with brand/last4, then detach removes it and repeat-detach 404s", async () => {
  const { id } = await registerAndIdentify();

  const attached = await attach(id, "pm_card_visa");
  expect(attached.status()).toBe(200);
  const { id: pmId } = await attached.json();
  expect(pmId).toMatch(/^pm_/);

  const afterAttach = await list(id);
  expect(afterAttach.status()).toBe(200);
  const rows = await afterAttach.json();
  const row = rows.find((r: { id: string }) => r.id === pmId);
  expect(row).toMatchObject({ type: "card", brand: "visa", last4: "4242", isDefault: false });

  const api = await apiClient();
  const detached = await api.delete(`/v1/users/me/payment-methods/${pmId}`, {
    headers: { "x-user-id": id },
  });
  expect(detached.status()).toBe(204);

  const afterDetach = await list(id);
  expect((await afterDetach.json()).some((r: { id: string }) => r.id === pmId)).toBe(false);

  // Idempotency/ownership path (attach-payment-method.command.ts): the local
  // row is already soft-deleted, so a second detach finds no row and answers
  // the handled 404, not Stripe drift-recovery (that path only fires when the
  // LOCAL row still exists but Stripe already forgot the pm).
  const secondDetach = await api.delete(`/v1/users/me/payment-methods/${pmId}`, {
    headers: { "x-user-id": id },
  });
  expect(secondDetach.status()).toBe(404);
  expect(await secondDetach.json()).toEqual({ error: "not_found" });
});

test("set-default: attaching a second card and setting it default leaves exactly one isDefault=true", async () => {
  const { id } = await registerAndIdentify();

  const first = await attach(id, "pm_card_visa");
  const { id: firstId } = await first.json();
  const second = await attach(id, "pm_card_mastercard");
  const { id: secondId } = await second.json();

  const api = await apiClient();
  const setDefault = await api.put(`/v1/users/me/payment-methods/${secondId}/default`, {
    headers: { "x-user-id": id },
  });
  expect(setDefault.status()).toBe(204);

  const rows: Array<{ id: string; isDefault: boolean }> = await (await list(id)).json();
  const defaults = rows.filter((r) => r.isDefault);
  expect(defaults).toHaveLength(1);
  expect(defaults[0].id).toBe(secondId);
  expect(rows.find((r) => r.id === firstId)?.isDefault).toBe(false);
});

test("ownership: user B cannot detach or set-default user A's payment method, and cannot attach A's pm id as their own", async () => {
  const userA = await registerAndIdentify();
  const userB = await registerAndIdentify();

  const attached = await attach(userA.id, "pm_card_visa");
  const { id: pmId } = await attached.json();

  const api = await apiClient();

  const detachAsB = await api.delete(`/v1/users/me/payment-methods/${pmId}`, {
    headers: { "x-user-id": userB.id },
  });
  expect(detachAsB.status()).toBe(404);
  expect(await detachAsB.json()).toEqual({ error: "not_found" });

  const setDefaultAsB = await api.put(`/v1/users/me/payment-methods/${pmId}/default`, {
    headers: { "x-user-id": userB.id },
  });
  expect(setDefaultAsB.status()).toBe(404);
  expect(await setDefaultAsB.json()).toEqual({ error: "not_found" });

  // B attaches A's pm id as their own: Stripe's .attach() rejects it because
  // the pm is already attached to A's customer, and attach-payment-method.command.ts
  // maps that StripeInvalidRequestError to 403 payment_method_rejected — the
  // SAME code as "no such pm", so B cannot distinguish the two outcomes.
  const attachAsB = await attach(userB.id, pmId);
  expect(attachAsB.status()).toBe(403);
  expect(await attachAsB.json()).toEqual({ error: "payment_method_rejected" });
});

// Stripe declines pm_card_chargeDeclined at attach time (a Radar-style block on
// the PaymentMethod itself, not on a charge), and attach-payment-method.command.ts
// maps the resulting StripeCardError to 402 payment_method_declined.
test("pm_card_chargeDeclined is declined on attach: 402, and never appears in the list", async () => {
  const { id } = await registerAndIdentify();
  const res = await attach(id, "pm_card_chargeDeclined");
  expect(res.status()).toBe(402);
  expect(await res.json()).toEqual({ error: "payment_method_declined" });

  const rows = await (await list(id)).json();
  expect(rows).toEqual([]);
});

test.describe("stripe webhook", () => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const secretMissingReason =
    "STRIPE_WEBHOOK_SECRET is not set (or empty) — hand-injected into .env.local.users' " +
    "CUSTOM box per docs/infrastructure/runbooks/stripe-sandbox-setup.md. Both webhook " +
    "tests need it: without it the running Users instance answers 503 stripe_unavailable " +
    "before it ever checks the signature, for the bad-signature case too.";

  test.beforeEach(() => {
    test.skip(!secret, secretMissingReason);
  });

  test("bad stripe-signature is rejected 400 invalid_signature", async () => {
    const api = await apiClient();
    const res = await api.post("/v1/users/stripe/webhook", {
      headers: { "stripe-signature": "t=1,v1=deadbeef" },
      data: { id: "evt_bad", type: "charge.succeeded" },
    });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_signature" });
  });

  test("a correctly signed, non-reconciled event is accepted 200 received:true", async () => {
    // charge.succeeded is deliberately NOT in RECONCILED_TYPES
    // (reconcile-payment-method.command.ts) — it exercises the "received but
    // not dispatched to a command" branch, not reconciliation.
    const payload = JSON.stringify({
      id: `evt_${Date.now()}`,
      object: "event",
      type: "charge.succeeded",
      data: { object: { id: `ch_${Date.now()}` } },
    });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: secret! });

    const api = await apiClient();
    const res = await api.post("/v1/users/stripe/webhook", {
      headers: { "stripe-signature": header, "content-type": "application/json" },
      data: payload,
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });
});
