import { randomInt, createHash, timingSafeEqual } from "node:crypto";

// Six digits, matching the OTP login code the user already sees in this product
// — one code shape to recognize, not two.
export const RESET_CODE_LENGTH = 6;

// 10 minutes. This is NOT a free parameter: the forgot-password email template
// renders `ttlMinutes: 10` (functions/events-pipeline emails/forgot-password),
// and the envelope carries `ttlSeconds` so the two cannot silently drift. If
// this changes, the number the user READS changes with it, because it is
// computed from this one value rather than written twice.
export const RESET_CODE_TTL_SECONDS = 600;

// `randomInt` is crypto-grade (rejection-sampled, uniform), unlike
// `Math.random()`. This is a credential: a predictable code is a takeover, and
// with only a million possibilities there is no room to also make them guessable
// in order.
export function generateResetCode(): string {
  return String(randomInt(0, 10 ** RESET_CODE_LENGTH)).padStart(RESET_CODE_LENGTH, "0");
}

// Plain SHA-256, not bcrypt/argon2 — deliberate. The threat this defends against
// is a leaked database row (backup, replica, log dump) being replayed as a live
// credential, and a hash defeats that. The usual reason to add a work factor —
// an offline brute force against a long-lived secret — does not apply: the
// secret lives for ten minutes, is single-use, and is consumed on first success.
// A work factor here would only buy CPU cost on a hot auth path.
export function hashResetCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

// Constant-time comparison. A plain `===` on hashes leaks, through timing, how
// many leading characters matched — enough, with sufficient samples, to
// reconstruct the stored hash byte by byte. `timingSafeEqual` throws on
// length-mismatched buffers, so the lengths are checked first (that check is
// safe to short-circuit: the length of a SHA-256 hex digest is public and
// constant).
export function resetCodeMatches(code: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashResetCode(code), "utf8");
  const stored = Buffer.from(storedHash, "utf8");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
