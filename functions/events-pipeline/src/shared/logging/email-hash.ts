import { createHash } from "node:crypto";

// CONTRACT: SHA-256 of the trimmed, lowercased email, hex, first 16 chars —
// Users and Orders compute it identically. If the three drift, filtering one
// user across services silently returns nothing, with no error.
// See [[logging-context]]
const HASH_LENGTH = 16;

/**
 * A stable, non-reversible id for an email address. Safe to log anywhere.
 * WARNING: PII. Never log a recipient in plaintext; `email_hash` is how an
 * operator traces one recipient's failed sends across services.
 * See [[logging-context]]
 */
export function hashEmail(email: string): string {
  return createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, HASH_LENGTH);
}
