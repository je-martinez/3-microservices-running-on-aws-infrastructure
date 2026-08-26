// Key namespace for the response cache, sibling to reset-code-store.ts's
// `password-reset:` prefix. Everything this service puts in Redis says what it
// is up front, so a shared instance stays legible.
//
// `v1` is a MASS-INVALIDATION LEVER, not decoration: the cached value is the
// serialized `UserSchema` body, so any change to that DTO's shape makes every
// live entry wrong. Bumping to `v2` orphans the whole generation at once
// (they expire on their own TTL) instead of requiring a flush.
export const ME_KEY_PREFIX = "users:me:v1";

// BOTH identity components, per [[x-cache-response-header]]. `cognito_sub`
// alone is what the caller presents; `user_id` is what the row actually is.
// Keying on both means a re-provisioned account (same sub, new usr_ id) cannot
// read the previous account's cached profile.
export function meCacheKey(cognitoSub: string, userId: string): string {
  return `${ME_KEY_PREFIX}:${cognitoSub}:${userId}`;
}
