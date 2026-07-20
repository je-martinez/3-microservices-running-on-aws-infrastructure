// Partial masking for the auth flows. Register and login are the only places
// that log an email at all (no user_id exists yet, so it is the sole diagnostic
// key) — this keeps them useful for support without putting a full address in
// OpenObserve, CloudWatch, and every backup.
//
//   john.doe@gmail.com  ->  jo******@gm***.com
//
// Enough to recognize an address you already know, not enough to harvest one
// you don't. The exact-match key stays `email_hash`, which is unaffected.

const VISIBLE_LOCAL = 2;
const VISIBLE_DOMAIN = 2;

/** Mask a segment, keeping the first `visible` characters. */
function maskSegment(segment: string, visible: number): string {
  if (segment.length === 0) return segment;
  // A segment at or below the visible budget would otherwise be revealed
  // whole (a 2-char local part like "jo@..." would leak entirely), so keep
  // only its first character and star the rest.
  const keep = segment.length <= visible ? 1 : visible;
  return segment.slice(0, keep) + "*".repeat(Math.max(segment.length - keep, 1));
}

/**
 * Partially mask an email for logging: `john.doe@gmail.com` → `jo******@gm***.com`.
 *
 * The TLD is preserved (it carries no identifying information on its own and
 * makes the masked value readable). Anything that does not look like an email
 * is masked wholesale rather than passed through, so a malformed body can never
 * leak a raw value into the log stream.
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");

  // Not an email shape: mask everything. Being conservative here matters —
  // this runs on unvalidated request bodies.
  if (at <= 0 || at === trimmed.length - 1) {
    return "*".repeat(Math.max(trimmed.length, 1));
  }

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  const dot = domain.lastIndexOf(".");
  if (dot <= 0) {
    // Domain with no dot (e.g. "localhost") — mask it as one segment.
    return `${maskSegment(local, VISIBLE_LOCAL)}@${maskSegment(domain, VISIBLE_DOMAIN)}`;
  }

  const domainName = domain.slice(0, dot);
  const tld = domain.slice(dot); // includes the leading dot

  return `${maskSegment(local, VISIBLE_LOCAL)}@${maskSegment(domainName, VISIBLE_DOMAIN)}${tld}`;
}
