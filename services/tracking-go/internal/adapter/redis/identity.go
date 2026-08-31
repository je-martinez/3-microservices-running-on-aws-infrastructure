package redis

import (
	"context"
	"encoding/json"
)

// IdentityCache resolves an identifier to the internal usr_ id, consulting Redis
// first.
//
// # Why this exists at all
//
// Every response key carries user_id as well as cognito_sub. user_id is not on
// the request — it is an internal usr_ id that only Users knows, obtained with a
// gRPC call. So building a response key requires resolving it FIRST, on every
// request, cache hit included. Without this, a "fast" cache hit would still pay a
// network round trip to another service, which is most of the latency the
// response cache was supposed to remove.
//
// # Why TTL-only invalidation is correct here, not a gap
//
// A sub never resolves to a DIFFERENT usr_ id while the account exists, so a
// stale entry cannot serve a WRONG answer — only a late one. The one case that
// CAN, an account that has stopped existing, is handled explicitly by
// InvalidateUser; the 1h TTL is the backstop for the path where that eviction
// could not run (a Redis outage during the cascade, which fails open by design).
//
// ONE PERSON CAN OWN MORE THAN ONE ENTRY here, because the key is built from the
// raw x-user-id header and a client may authenticate with either identifier. The
// values agree, so a duplicate cannot serve a wrong answer — but the cascade has
// to delete BOTH or the leftover one keeps resolving a deleted account for the
// rest of its hour.
type IdentityCache struct{ gateway Gateway }

// NewIdentityCache builds the cache over gw.
func NewIdentityCache(gw Gateway) *IdentityCache { return &IdentityCache{gateway: gw} }

// Resolve returns the cached mapping, falling back to loader on a miss. Answers
// "" when the identity cannot be resolved.
//
// NEGATIVES ARE NEVER CACHED. A "" answer means one of: Users has no record,
// Users was unreachable, or no client could be built. Caching that would keep a
// real user's user_id out of their keys for an hour after the cause cleared — and
// because the key builders skip caching entirely without a user_id, it would
// quietly disable the response cache for that caller for the whole hour.
// Re-asking each request costs exactly the call the request would have made
// anyway.
//
// A HIT is VALIDATED before it is trusted: the payload must decode as a non-empty
// JSON string. A key holding null, "", a number or an object is a corrupt entry,
// not a resolution, and returning it would put an empty user_id into every key
// the request builds — silently disabling caching for that caller. An
// unusable hit therefore falls through to the loader, exactly as a miss does.
//
// loader is allowed to fail; anything it returns as an error becomes "", because
// this whole mechanism is an optimization on top of an enrichment that must never
// fail a request.
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
