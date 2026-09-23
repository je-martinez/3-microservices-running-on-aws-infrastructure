import { createHash, timingSafeEqual } from "node:crypto";

// CONTRACT: Compare fixed-length digests with timingSafeEqual, never the raw
// strings with `===` — an early exit on the first differing byte lets a caller
// recover the token one character at a time from response timing. Digesting
// also hides the token's length. See [[2026-09-19-stripe-payments-design]]
export function urlTokenMatches(provided: string | undefined, expected: string): boolean {
  const a = createHash("sha256").update(provided ?? "").digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) && provided !== undefined;
}
