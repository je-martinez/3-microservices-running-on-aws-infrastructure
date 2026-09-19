// CONTRACT: Auth flows log the MASKED email, never the plaintext one —
// `john.doe@gmail.com` -> `jo*****e@gmail.com`. Register and login are the only
// places that log an email at all, because no user_id exists yet. The domain stays
// visible (operationally useful, identifies no one); the local part is masked. Every
// other surface uses `email_hash`. See [[logging-context]]

const VISIBLE_PREFIX = 2;
const VISIBLE_SUFFIX = 1;

/**
 * Mask the local part, keeping the first two characters and the last one. Short
 * inputs are special-cased: a naive "keep the first two" reveals a 2-character local
 * part whole, and prefix+suffix alone leaves a short one unmasked.
 */
function maskLocal(local: string): string {
  if (local.length === 0) return local;

  // 1-2 chars: one visible character, padded so the result never equals the input
  // nor reveals whether it was 1 or 2 characters long.
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
 * CONTRACT: Anything not email-shaped is masked wholesale, never passed through —
 * this runs on unvalidated request bodies, so a malformed one would otherwise leak a
 * raw value into the log stream.
 * See [[logging-context]]
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
