// CONTRACT: `v1` is a mass-invalidation lever, not decoration. The cached value is
// the serialized `UserSchema` body, so any change to that DTO's shape makes every live
// entry wrong — bump to `v2` and the whole generation is orphaned at once, expiring on
// its own TTL instead of needing a flush.
export const ME_KEY_PREFIX = "users:me:v1";

// BOTH identity components, per [[x-cache-response-header]]. `cognito_sub`
// alone is what the caller presents; `user_id` is what the row actually is.
// Keying on both means a re-provisioned account (same sub, new usr_ id) cannot
// read the previous account's cached profile.
export function meCacheKey(cognitoSub: string, userId: string): string {
  return `${ME_KEY_PREFIX}:${cognitoSub}:${userId}`;
}
