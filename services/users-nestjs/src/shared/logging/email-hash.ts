import { createHash } from "node:crypto";

// CONTRACT: This must stay byte-identical to Orders' EmailHash.cs — SHA-256 of the
// trimmed, lowercased email, hex, first 16 chars. If the two drift, filtering one
// user across both services returns nothing at all: no error, just no results. The
// Orders test asserts a literal value produced by this function.
// See [[logging-context]]
const HASH_LENGTH = 16;

/**
 * A stable, non-reversible id for an email address. Safe to log anywhere, and the
 * only email identifier outside the login/register flows, which log a masked form.
 */
export function hashEmail(email: string): string {
  return createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, HASH_LENGTH);
}
