import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import { apiClient } from "./api-client.js";
import { pickProductWithStock } from "./catalogue.js";
import { makeUser } from "./chance-factory.js";

// Registering a buyer and posting `POST /v1/orders` in the one form that works with
// STRIPE_ENABLED in EITHER position. Shapes come from services/orders/openapi.yaml and
// services/users/openapi.yaml; the flag's effect is read off
// services/orders/src/Orders.Api/Endpoints/CreateOrderEndpoint.cs, which requires
// `paymentMethodId` and an `Idempotency-Key` only while `stripe.Enabled`.

/** A registered user, with `paymentMethodId` set only when Orders charges Stripe. */
export type Buyer = {
  /** The `usr_` id, used verbatim as `x-user-id` against all three services. */
  userId: string;
  email: string;
  paymentMethodId: string | null;
};

// Probed once per worker process and reused: the flag is a property of the running
// stack, and re-probing per buyer would add a request to every spec that builds one.
let stripeEnabled: boolean | null = null;

/**
 * Whether Orders runs with STRIPE_ENABLED on, asked of the service rather than of the
 * environment.
 *
 * CONTRACT: Probe with a NONEXISTENT product id and no `paymentMethodId`. The payment
 * check precedes the catalogue lookup, so the flag's two positions answer differently
 * (400 `invalid_request` vs 404 `unknown_product`) while NOTHING is created and no card
 * is charged. Reading `process.env.STRIPE_ENABLED` instead would answer for the harness,
 * which never loads `.env.local.orders`. See [[env-files]]
 */
export async function ordersChargesStripe(orders: APIRequestContext): Promise<boolean> {
  if (stripeEnabled !== null) return stripeEnabled;

  const users = await apiClient();
  const registered = await users.post("/v1/users/register", { data: makeUser() });
  expect(registered.status(), await registered.text()).toBe(201);
  const { id } = await registered.json();

  const probe = await orders.post("/v1/orders", {
    headers: { "x-user-id": id },
    data: { lines: [{ productId: "prd_flag_probe", quantity: 1 }] },
  });
  const body = await probe.text();
  if (probe.status() === 400) {
    stripeEnabled = true;
  } else if (probe.status() === 404) {
    stripeEnabled = false;
  } else {
    throw new Error(
      `cannot tell whether Orders charges Stripe: a paymentMethodId-less create for an ` +
        `unknown product answered ${probe.status()} ${body}, expected 400 (flag on) or ` +
        "404 unknown_product (flag off).",
    );
  }
  return stripeEnabled;
}

/**
 * The `pm_` Stripe minted for this buyer, with a bounded retry on `404` only.
 *
 * CONTRACT: Do NOT accept the `404` as success, and do NOT drop the retry. Users resolves
 * the caller through its READER replica (shared/db/prisma.ts) while register writes to the
 * writer, so a buyer built in one round trip can be answered
 * `{"error":"not_found"}` for an id Users just minted. Each attempt still demands `200`
 * and exhausting them fails. See [[testing]]
 */
async function attachWithReplicaRetry(
  users: APIRequestContext,
  userId: string,
  pm: string,
  attempts = 4,
): Promise<string> {
  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await users.post("/v1/users/me/payment-methods", {
      headers: { "x-user-id": userId },
      data: { paymentMethodId: pm },
    });
    lastStatus = res.status();
    lastBody = await res.text();
    if (lastStatus === 200) return JSON.parse(lastBody).id as string;
    if (lastStatus !== 404 || attempt === attempts) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }

  expect(
    lastStatus,
    `attaching ${pm} to ${userId} failed after ${attempts} attempt(s): ${lastStatus} ${lastBody}`,
  ).toBe(200);
  throw new Error("unreachable: the expect above fails on any non-200");
}

/**
 * A registered user who can place an order, with `pm` attached to their Stripe customer
 * when — and only when — Orders charges Stripe.
 *
 * CONTRACT: Do NOT attach unconditionally. `pm_card_visa` reaches the real sandbox
 * through Users, so a flag-off run spends an API call per buyer on a card nothing charges.
 * See [[stripe-sandbox-setup]]
 */
export async function makeBuyer(
  orders: APIRequestContext,
  pm = "pm_card_visa",
): Promise<Buyer> {
  const users = await apiClient();
  const user = makeUser();
  const registered = await users.post("/v1/users/register", { data: user });
  expect(registered.status(), await registered.text()).toBe(201);
  const { id } = await registered.json();

  if (!(await ordersChargesStripe(orders))) {
    return { userId: id, email: user.email, paymentMethodId: null };
  }

  // Stripe mints a new `pm_` on attach, so the charge must use THIS id and not the
  // `pm_card_visa` token that produced it.
  const paymentMethodId = await attachWithReplicaRetry(users, id, pm);

  return { userId: id, email: user.email, paymentMethodId };
}

/** One in-stock product id from `GET /v1/products`, picked as [[testing]] requires. */
export async function orderableProductId(
  orders: APIRequestContext,
  userId: string,
  minStock = 1,
): Promise<string> {
  const res = await orders.get("/v1/products", { headers: { "x-user-id": userId } });
  expect(res.status(), await res.text()).toBe(200);
  return pickProductWithStock(await res.json(), { minStock }).id;
}

/** Overrides for the payment fields, so a spec can omit one deliberately. */
export type CreateOptions = {
  idempotencyKey?: string | null;
  paymentMethodId?: string | null;
  card?: unknown;
};

/**
 * `POST /v1/orders` with the payment header and field present only when supplied.
 *
 * Used directly by the specs that assert on the payment path itself, which pass each
 * field explicitly — including omitting one to assert its 400.
 */
export function createOrder(
  orders: APIRequestContext,
  userId: string,
  lines: Array<{ productId: string; quantity: number }>,
  options: CreateOptions = {},
) {
  const headers: Record<string, string> = { "x-user-id": userId };
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  const data: Record<string, unknown> = { lines };
  if (options.paymentMethodId) data.paymentMethodId = options.paymentMethodId;
  if (options.card !== undefined) data.card = options.card;

  return orders.post("/v1/orders", { headers, data });
}

/**
 * `POST /v1/orders` for a buyer, paid however the running stack demands — the form the
 * specs whose subject is NOT payment want: ownership, caching, cascades, consolidation.
 *
 * CONTRACT: Never send `card` from here. With the flag OFF that block IS validated
 * (CreateOrderEndpoint gates `CardMetadataValidator` on `!stripe.Enabled`), so a metadata
 * default would turn every create of a flag-off run into a 400.
 * See [[2026-09-19-stripe-payments-design]]
 */
export function placeOrder(
  orders: APIRequestContext,
  buyer: Buyer,
  lines: Array<{ productId: string; quantity: number }>,
) {
  return createOrder(orders, buyer.userId, lines, {
    idempotencyKey: buyer.paymentMethodId ? randomUUID() : null,
    paymentMethodId: buyer.paymentMethodId,
  });
}
