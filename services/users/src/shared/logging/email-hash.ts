import { createHash } from "node:crypto";

// Truncated to 16 hex chars: far beyond collision-relevant at our scale, while
// keeping log lines readable.
//
// CROSS-SERVICE CONTRACT: Orders computes this identically in
// Orders.Api/Logging/EmailHash.cs (SHA-256 of the trimmed, lowercased email,
// hex, first 16 chars). If the two ever drift, filtering one user across both
// services silently returns nothing — no error, just no results — so the Orders
// test asserts a literal value produced by this function.
const HASH_LENGTH = 16;

/**
 * A stable, non-reversible id for an email address. Safe to log anywhere.
 *
 * Lets an operator filter every log line for one user without the email itself
 * being replicated across OpenObserve, CloudWatch, and every backup. Plaintext
 * email is confined to the login/register flows, where no user_id exists yet.
 */
export function hashEmail(email: string): string {
  return createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, HASH_LENGTH);
}
