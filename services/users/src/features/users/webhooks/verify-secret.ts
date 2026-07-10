import { timingSafeEqual } from "node:crypto";

// Spec D1. `timingSafeEqual` throws when the buffers differ in length, which
// would itself leak length — so compare lengths first and return false, and only
// then do the constant-time comparison on equal-length buffers. This leaks the
// secret's length via timing, which is the accepted trade-off for a fixed-length,
// operator-rotated shared secret (not a user password).
//
// `provided` is typed `string | string[]` because HTTP allows a repeated header,
// and Fastify surfaces that as an array. A non-string (missing, or repeated →
// array) can never be the secret, so reject it up front rather than relying on
// Buffer.from's coercion of an array to a differing length.
export function verifyWebhookSecret(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
