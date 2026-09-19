import { timingSafeEqual } from "node:crypto";

// CONTRACT: Compare lengths first and return false, THEN do the constant-time
// comparison — `timingSafeEqual` throws on differing lengths, which leaks length by
// exception instead. Leaking the length via timing is the accepted trade-off for a
// fixed-length, operator-rotated shared secret. `provided` is `string | string[]`
// because HTTP allows a repeated header; a non-string can never be the secret, so
// reject it up front rather than relying on Buffer.from's coercion.
export function verifyWebhookSecret(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
