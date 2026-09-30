import Stripe from "stripe";

// Reads back, from Stripe itself, the charges an order produced. The HTTP response to
// `POST /v1/orders` carries no payment snapshot (OrderDto has no payment fields), so
// Stripe is the only surface where a spec can see whether money actually moved and how
// many times.

// CONTRACT: Two keys, never one. Each service holds a restricted key with a DIFFERENT
// policy: Users' grants Customers read and PaymentIntents NONE, Orders' the reverse.
// Resolving a customer with Orders' key answers 403, and so does listing PaymentIntents
// with Users' — a single key cannot do both halves of this lookup.
// See [[stripe-sandbox-setup]]
const USERS_KEY_ENV = "STRIPE_SECRET_KEY";
const ORDERS_KEY_ENV = "ORDERS_STRIPE_SECRET_KEY";

// Pinned to match both services (services/users/src/shared/stripe/stripe-client.provider.ts).
const API_VERSION = "2026-08-26.dahlia" as const;

/** Null when both keys are present, else the reason to skip. */
export function missingStripeKeys(): string | null {
  const missing = [USERS_KEY_ENV, ORDERS_KEY_ENV].filter((name) => !process.env[name]);
  if (missing.length === 0) return null;
  return (
    `${missing.join(", ")} not set — the restricted keys live in the CUSTOM boxes of ` +
    ".env.local.users / .env.local.orders per docs/infrastructure/runbooks/stripe-sandbox-setup.md, " +
    "and playwright.config.ts loads them (renaming Orders' to avoid the shared-name collision)."
  );
}

function client(env: string): Stripe {
  const key = process.env[env];
  if (!key) throw new Error(`${env} is not set — ${missingStripeKeys()}`);
  return new Stripe(key, { apiVersion: API_VERSION });
}

/**
 * The Stripe customer id Users minted for this address, or null when no card was ever
 * attached. `ensureStripeCustomer` creates the customer with the registered email, which
 * is unique per spec, so an exact-email list yields at most this run's customer.
 */
export async function customerIdForEmail(email: string): Promise<string | null> {
  const { data } = await client(USERS_KEY_ENV).customers.list({ email, limit: 3 });
  if (data.length > 1) {
    throw new Error(`${data.length} Stripe customers share ${email} — expected at most one per user`);
  }
  return data[0]?.id ?? null;
}

/** One PaymentIntent, reduced to what a payment assertion needs. */
export type ChargeAttempt = {
  id: string;
  status: string;
  amountCents: number;
  currency: string;
  orderId: string | undefined;
  declineCode: string | undefined;
  cardBrand: string | undefined;
  cardLast4: string | undefined;
};

// CONTRACT: List by CUSTOMER, never through `paymentIntents.search`. Search runs on an
// index Stripe updates asynchronously, so a just-created intent is routinely absent for
// up to a minute and "Stripe was charged once" reads as "never charged".
export async function chargeAttemptsForCustomer(customerId: string): Promise<ChargeAttempt[]> {
  const { data } = await client(ORDERS_KEY_ENV).paymentIntents.list({
    customer: customerId,
    limit: 100,
    expand: ["data.latest_charge"],
  });
  return data.map((intent) => {
    const charge = intent.latest_charge as Stripe.Charge | null;
    const card = charge?.payment_method_details?.card;
    return {
      id: intent.id,
      status: intent.status,
      amountCents: intent.amount,
      currency: intent.currency,
      orderId: intent.metadata?.order_id,
      declineCode: intent.last_payment_error?.decline_code ?? intent.last_payment_error?.code,
      cardBrand: card?.brand ?? undefined,
      cardLast4: card?.last4 ?? undefined,
    };
  });
}

/** Every charge attempt carrying this order id, in Stripe. */
export async function chargeAttemptsForOrder(email: string, orderId: string): Promise<ChargeAttempt[]> {
  const customerId = await customerIdForEmail(email);
  if (customerId === null) return [];
  const attempts = await chargeAttemptsForCustomer(customerId);
  return attempts.filter((a) => a.orderId === orderId);
}

/**
 * A one-line-per-intent rendering for a failure message.
 *
 * CONTRACT: Print WHAT arrived, never only how many. "expected 1, got 2" cannot tell a
 * double charge from a leftover intent belonging to another spec's order.
 * See [[count-only-assertions-hide-cause]]
 */
export function describeAttempts(attempts: ChargeAttempt[]): string {
  if (attempts.length === 0) return "no PaymentIntent at all";
  return attempts
    .map(
      (a) =>
        `${a.id} status=${a.status} amount=${a.amountCents}${a.currency} order=${a.orderId ?? "-"}` +
        `${a.declineCode ? ` decline=${a.declineCode}` : ""}` +
        `${a.cardBrand ? ` card=${a.cardBrand}/${a.cardLast4}` : ""}`,
    )
    .join("\n");
}
