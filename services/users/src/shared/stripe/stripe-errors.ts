import Stripe from "stripe";

// WARNING: Stripe answers a detach of an ALREADY-DETACHED payment method with
// NO `code` at all — only `type: invalid_request_error` and this sentence.
// Measured against the live API, not inferred: a detach of a NONEXISTENT id
// does carry `code: resource_missing`, and a genuinely malformed request
// carries its own code (e.g. `parameter_missing`), so matching on the absence
// of a code alone would swallow real errors.
const ALREADY_DETACHED = "is not attached to a customer";

// CONTRACT: The one place that recognizes Stripe's "already gone" signal —
// every caller that must treat a missing customer/payment method as success
// (not a failure) checks THIS, so the code isn't duplicated per call site.
export function isResourceMissing(err: unknown): boolean {
  if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) return false;
  if (err.code === "resource_missing") return true;
  return err.code === undefined && (err.message ?? "").includes(ALREADY_DETACHED);
}
