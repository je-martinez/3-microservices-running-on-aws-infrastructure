import Stripe from "stripe";

// CONTRACT: The one place that recognizes Stripe's "already gone" signal —
// every caller that must treat a missing customer/payment method as success
// (not a failure) checks THIS, so the code isn't duplicated per call site.
export function isResourceMissing(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeInvalidRequestError && err.code === "resource_missing";
}
