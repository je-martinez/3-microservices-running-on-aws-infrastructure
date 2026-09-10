package redis

import (
	"context"
	"encoding/json"
)

// IdentityCache resolves an identifier to the internal usr_ id via Redis. Every
// response key carries user_id, which only Users knows, so without this a cache
// hit still pays a gRPC round trip.
//
// CONTRACT: One person can own MORE THAN ONE entry — the key comes off the raw
// x-user-id header and a client may authenticate with either identifier — so the
// cascade must delete BOTH. TTL-only invalidation is otherwise correct: a sub
// never resolves to a different usr_ id while the account exists.
// See [[user-id-vs-cognito-sub-ownership-key]]
type IdentityCache struct{ gateway Gateway }

// NewIdentityCache builds the cache over gw.
func NewIdentityCache(gw Gateway) *IdentityCache { return &IdentityCache{gateway: gw} }

// Resolve returns the cached mapping, falling back to loader on a miss, and
// answers "" when the identity cannot be resolved. loader may fail; an error
// becomes "", since this is an optimization that must never fail a request.
//
// CONTRACT: NEVER cache a negative. "" means Users has no record, was
// unreachable, or no client existed, and caching it disables the response cache
// for that caller for the whole hour after the cause cleared.
//
// CONTRACT: VALIDATE a hit — the payload must decode as a non-empty JSON string.
// null, "", a number or an object is corrupt, and returning it puts an empty
// user_id into every key the request builds. An unusable hit falls through to
// the loader like a miss. See [[x-cache-response-header]]
func (c *IdentityCache) Resolve(ctx context.Context, cognitoSub string, loader func(context.Context) (string, error)) string {
	key := IdentityKey(cognitoSub)

	if entry := c.gateway.Get(ctx, key); entry.Hit {
		var userID string
		// The value is a bare JSON string, so redis-cli shows "usr_abc".
		if err := json.Unmarshal(entry.Value, &userID); err == nil && userID != "" {
			return userID
		}
	}

	userID, err := loader(ctx)
	if err != nil || userID == "" {
		return ""
	}
	// No index key: the identity entry is deleted BY NAME in the cascade, so
	// indexing it would add a SET whose only member is a key already swept
	// directly — and one keyed on the same raw identifier, so it would carry no
	// information the cascade does not already have.
	c.gateway.Set(ctx, key, userID, IdentityTTL, "")
	return userID
}
