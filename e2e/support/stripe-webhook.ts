import type { APIRequestContext } from "@playwright/test";
import Stripe from "stripe";

// The two Stripe webhooks, `POST /v1/{users|orders}/stripe/webhook/{token}`. Each service
// checks, in order: source-IP allowlist → its OWN URL token → the Stripe-Signature, made
// with the one webhook secret both services share.

// CONTRACT: Send every webhook call through postWebhook() and assert only on what it
// returns. Playwright's request errors and Users' 404 body (`Cannot POST …/webhook/<token>`)
// echo the URL, so a raw one in a failure message prints the live token.
// See [[2026-09-19-stripe-payments-design]]

export type WebhookService = "users" | "orders";

// WHY: Users' token arrives under its own name via `.env.local.users`; Orders' uses the
// same name in `.env.local.orders`, so playwright.config.ts renames it on the way in.
const TOKEN_ENV: Record<WebhookService, string> = {
  users: "STRIPE_WEBHOOK_URL_TOKEN",
  orders: "ORDERS_STRIPE_WEBHOOK_URL_TOKEN",
};

export const WRONG_TOKEN = "e2e-not-the-webhook-token";

export function webhookToken(service: WebhookService): string {
  const token = process.env[TOKEN_ENV[service]];
  if (!token) throw new Error(`${TOKEN_ENV[service]} is not set — ${webhookUnavailableReason()}`);
  return token;
}

export function webhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error(`STRIPE_WEBHOOK_SECRET is not set — ${webhookUnavailableReason()}`);
  return secret;
}

// Null when every value the webhook specs need is present, else the reason to skip.
export function missingWebhookConfig(): string | null {
  const missing = ["STRIPE_WEBHOOK_SECRET", ...Object.values(TOKEN_ENV)].filter((name) => !process.env[name]);
  return missing.length === 0 ? null : `${missing.join(", ")} not set — ${webhookUnavailableReason()}`;
}

function webhookUnavailableReason(): string {
  return (
    "all three live in the CUSTOM boxes of .env.local.users / .env.local.orders per " +
    "docs/infrastructure/runbooks/stripe-sandbox-setup.md, and playwright.config.ts loads them."
  );
}

// Relative on purpose: gatewayClient()'s baseURL carries a path a leading slash would drop.
function webhookPath(service: WebhookService, token: string): string {
  return `v1/${service}/stripe/webhook/${encodeURIComponent(token)}`;
}

export function redactSecrets(text: string): string {
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET, ...Object.values(TOKEN_ENV).map((name) => process.env[name])];
  return secrets.reduce<string>(
    (out, secret) => (secret ? out.split(secret).join("[REDACTED]").split(encodeURIComponent(secret)).join("[REDACTED]") : out),
    text,
  );
}

export type SignedEvent = { payload: string; signature: string };

// A Stripe event signed with the shared secret, exactly as Stripe would sign it.
export function signedEvent(type: string, object: Record<string, unknown>): SignedEvent {
  const payload = JSON.stringify({
    id: `evt_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    object: "event",
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
  return { payload, signature: Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret() }) };
}

export const BAD_SIGNATURE = "t=1,v1=deadbeef";

export type WebhookResponse = { status: number; body: string };

export async function postWebhook(
  api: APIRequestContext,
  service: WebhookService,
  token: string,
  event: { payload: string; signature: string },
): Promise<WebhookResponse> {
  try {
    const res = await api.post(webhookPath(service, token), {
      headers: { "stripe-signature": event.signature, "content-type": "application/json" },
      data: event.payload,
    });
    return { status: res.status(), body: redactSecrets(await res.text()) };
  } catch (error) {
    throw new Error(`POST ${service} webhook failed: ${redactSecrets(String(error))}`);
  }
}
