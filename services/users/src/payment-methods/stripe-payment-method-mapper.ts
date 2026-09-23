import type Stripe from "stripe";
import type { Prisma } from "../generated/prisma/client.ts";

/**
 * CONTRACT: The ONLY place a Stripe `PaymentMethod` object's card fields are
 * mapped into the local row shape — attach (command) and reconcile (webhook)
 * both call this so the two paths cannot drift into different defaults for a
 * card-less field. See [[2026-09-19-stripe-payments-design]]
 */
export function mapStripePaymentMethodFields(
  pm: Stripe.PaymentMethod,
): Omit<Prisma.StripePaymentMethodUncheckedCreateInput, "id" | "stripePaymentMethodId" | "userId" | "isDefault"> {
  return {
    type: pm.type,
    brand: pm.card?.brand ?? null,
    last4: pm.card?.last4 ?? null,
    expMonth: pm.card?.exp_month ?? null,
    expYear: pm.card?.exp_year ?? null,
    funding: pm.card?.funding ?? null,
    country: pm.card?.country ?? null,
    fingerprint: pm.card?.fingerprint ?? null,
    billingName: pm.billing_details?.name ?? null,
    billingEmail: pm.billing_details?.email ?? null,
    billingAddress: (pm.billing_details?.address ?? null) as never,
    rawPayload: pm as unknown as object,
  };
}
