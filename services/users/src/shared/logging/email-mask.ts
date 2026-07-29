// Partial masking for the auth flows. Register and login are the only places
// that log an email at all (no user_id exists yet, so it is the sole diagnostic
// key) — this keeps them useful for support without putting a full address in
// OpenObserve, CloudWatch, and every backup.
//
//   john.doe@gmail.com  ->  jo*****e@gmail.com
//
// The DOMAIN is kept fully visible on purpose: it is the part with real
// operational value (telling a corporate customer from a consumer signup at a
// glance) and it identifies no one on its own. The local part — the part that
// names a person — is what gets masked.
//
// Enough to recognize an address you already know, not enough to harvest one
// you don't. The exact-match key stays `email_hash`, which is unaffected.

const VISIBLE_PREFIX = 2;
const VISIBLE_SUFFIX = 1;

/**
 * Mask the local part, keeping the first two characters and the last one.
 *
 * Short inputs are handled deliberately: a 2-character local part would be
 * revealed whole by a naive "keep the first two" rule, and one short enough
 * that prefix+suffix covers it would pass through unmasked. Both collapse to
 * one visible character plus a star.
 */
function maskLocal(local: string): string {
  if (local.length === 0) return local;

  // 1-2 chars: one visible character, padded so the result never equals the
  // input and never reveals whether it was 1 or 2 characters long.
  if (local.length <= 2) return `${local[0]}*`;

  // 3-4 chars: prefix + suffix would leave nothing masked, so mask the tail
  // entirely and keep only the prefix.
  if (local.length <= VISIBLE_PREFIX + VISIBLE_SUFFIX + 1) {
    return local.slice(0, VISIBLE_PREFIX) + "*".repeat(local.length - VISIBLE_PREFIX);
  }

  const stars = local.length - VISIBLE_PREFIX - VISIBLE_SUFFIX;
  return local.slice(0, VISIBLE_PREFIX) + "*".repeat(stars) + local.slice(-VISIBLE_SUFFIX);
}

/**
 * Partially mask an email for logging: `john.doe@gmail.com` → `jo*****e@gmail.com`.
 *
 * Anything that does not look like an email is masked wholesale rather than
 * passed through, so a malformed body can never leak a raw value into the log
 * stream — this runs on unvalidated request bodies.
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");

  // Not an email shape (no @, nothing before it, or nothing after it): mask
  // everything. Being conservative here is the point.
  if (at <= 0 || at === trimmed.length - 1) {
    return "*".repeat(Math.max(trimmed.length, 1));
  }

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  return `${maskLocal(local)}@${domain}`;
}
