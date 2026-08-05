import { createHash } from "node:crypto";

// Truncated to 16 hex chars: far beyond collision-relevant at our scale, while
// keeping log lines readable.
//
// CROSS-SERVICE CONTRACT: Users computes this identically in
// services/users/src/shared/logging/email-hash.ts, and Orders in
// Orders.Api/Logging/EmailHash.cs (SHA-256 of the trimmed, lowercased email,
// hex, first 16 chars). If any of the three drift, filtering one user across
// services silently returns nothing — no error, just no results — so the test
// beside this file pins the same literal the other services pin.
const HASH_LENGTH = 16;

/**
 * A stable, non-reversible id for an email address. Safe to log anywhere.
 *
 * This pipeline sends email but must never log a recipient: the address is the
 * PII the logging convention forbids in plaintext
 * (docs/shared/conventions/logging-context.md). `email_hash` is what lets an
 * operator trace one recipient's failed sends across services.
 */
export function hashEmail(email: string): string {
  return createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, HASH_LENGTH);
}
