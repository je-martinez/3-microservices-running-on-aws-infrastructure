import type { StripeClientHolder } from "#shared/stripe/stripe-client.provider";
import { StripeUnavailableException } from "#shared/stripe/stripe-unavailable.exception";
import type { Db } from "#shared/db/prisma";
import { withStripeSpan } from "#shared/observability/stripe-tracing";
import { hashEmail } from "#shared/logging/email-hash";
import { appLogger } from "#shared/logging/app-logger";

export interface EnsureStripeCustomerInput {
  userId: string;
  email: string;
  /** True only when the x-e2e-source header is present AND E2E_TESTING_ENABLED. */
  e2eSource: boolean;
}

// CONTRACT: Called lazily from the payment-method routes, never from
// registration — a Stripe outage must never block sign-up (spec D2). Returns
// the existing stripeCustomerId when present, otherwise creates one and
// persists it before returning.
export async function ensureStripeCustomer(
  stripe: StripeClientHolder,
  db: Db,
  input: EnsureStripeCustomerInput,
): Promise<string> {
  if (!stripe.client) throw new StripeUnavailableException();

  // CONTRACT: Reads go to the PRIMARY (`$primary()`) — a replica lagging behind
  // a just-committed `stripeCustomerId` would read null here and mint a second
  // Stripe customer for the same user. See [[2026-09-19-stripe-payments-design]]
  const user = await db.$primary().user.findUniqueOrThrow({ where: { id: input.userId } });
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const metadata: Record<string, string> = { user_id: input.userId };
  if (input.e2eSource) metadata.e2e_source = "true";

  const client = stripe.client;
  const customer = await withStripeSpan(
    "stripe.customer.create",
    { "stripe.resource_type": "customer" },
    async (span) => {
      // CONTRACT: Keyed on userId alone, so two concurrent first calls for the
      // same user resolve to the SAME Stripe customer instead of creating two.
      // WARNING: Reusing this key within 24h with a different email returns a
      // Stripe error, not a customer — safe here since email is fixed per user.
      const created = await client.customers.create(
        { email: input.email, metadata },
        { idempotencyKey: `stripe-customer-create-${input.userId}` },
      );
      span.setAttribute("stripe.customer_id", created.id);
      return created;
    },
  );

  // CONTRACT: The `stripeCustomerId: null` guard makes this write conditional —
  // a concurrent loser matches 0 rows instead of overwriting the winner's id,
  // so every caller ends up returning the one persisted id (paired with the
  // idempotency key above, which keeps Stripe from creating two customers).
  const { count } = await db.user.updateMany({
    where: { id: input.userId, stripeCustomerId: null },
    data: { stripeCustomerId: customer.id, stripeCustomerData: customer as unknown as object },
  });

  if (count === 0) {
    const winner = await db.$primary().user.findUniqueOrThrow({ where: { id: input.userId } });
    if (!winner.stripeCustomerId) {
      throw new Error(`Lost the stripeCustomerId race for user ${input.userId} but the winner has none`);
    }
    return winner.stripeCustomerId;
  }

  appLogger.info(
    { app_event: "stripe_customer_created", user_id: input.userId, email_hash: hashEmail(input.email) },
    "Stripe customer created",
  );

  return customer.id;
}
