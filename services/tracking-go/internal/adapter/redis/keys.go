// Package redis is the cache adapter: keys, gateway, identity cache, and eviction.
// CONTRACT: Do NOT treat cognitoSub as canonical; it is raw x-user-id and may be
// either a Cognito sub or usr_ id. Assuming only the sub leaves deleted-account
// entries readable until TTL expiry. Response keys carry both that raw identity
// and the resolved usr_ id; unresolved user_id makes a request unkeyable rather
// than collapsing callers into an empty segment. List IDs are normalized and
// hashed to keep equivalent sets on one bounded key.
// See [[tracking-service-design]]
package redis

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
)

// Version is bumped when a cached DTO's shape changes, which mass-invalidates
// every entry of that shape without touching Redis: the old keys simply stop
// being read and expire on their own TTL.
const Version = "v1"

// prefixSegments is how many colon-separated segments make up a key's PREFIX —
// the only part of a key that may appear in a span attribute, a metric dimension
// or a log line. Everything after it is identity.
const prefixSegments = 3

// digestLength in hex characters. 64 bits, which for a keyspace of at most a few
// million live list entries makes a collision negligible, while keeping the key
// short enough to read in redis-cli.
const digestLength = 16

// TrackingOrderKey builds the key for GET /v1/trackings/{order_id}. The second
// return is false when the request is unkeyable — see the package docstring.
func TrackingOrderKey(cognitoSub, userID, orderID string) (string, bool) {
	if userID == "" {
		return "", false
	}
	return "tracking:order:" + Version + ":" + cognitoSub + ":" + userID + ":" + orderID, true
}

// TrackingListKey builds the key for GET /v1/trackings?order_ids=. Normalizes
// (sort + dedup) BEFORE hashing, so ?order_ids=b,a and ?order_ids=a,b,a are one
// key.
func TrackingListKey(cognitoSub, userID string, orderIDs []string) (string, bool) {
	if userID == "" {
		return "", false
	}
	return "tracking:list:" + Version + ":" + cognitoSub + ":" + userID + ":" + hashOrderIDs(orderIDs), true
}

// IdentityKey builds the key for the identifier -> user_id mapping.
//
// Never answers "no key": this is the cache consulted to OBTAIN a user_id, so it
// cannot require one. That identity is whatever the caller sent, not necessarily
// a Cognito sub — an invalidator must not assume this key is reachable under the
// canonical sub only.
func IdentityKey(cognitoSub string) string {
	return "identity:sub-to-user:" + Version + ":" + cognitoSub
}

// UserIndexKey builds the key of the Redis SET holding this user's live response
// keys.
// CONTRACT: Do NOT replace the per-user index with KEYS or SCAN; whole-keyspace
// work blocks or scales every invalidation with cache size. The first segment is
// raw x-user-id, so one person can own multiple indexes.
// See [[tracking-service-design]]
func UserIndexKey(cognitoSub, userID string) string {
	return "tracking:index:" + Version + ":" + cognitoSub + ":" + userID
}

// PrefixOf returns the telemetry-safe prefix: everything up to and including v1.
//
// A full key carries cognito_sub and user_id. A span is an export destination
// like any other, and a CloudWatch dimension VALUE is cardinality the account is
// billed for, so neither ever sees more than this.
func PrefixOf(key string) string {
	parts := strings.Split(key, ":")
	if len(parts) <= prefixSegments {
		return key
	}
	return strings.Join(parts[:prefixSegments], ":")
}

// hashOrderIDs normalizes then hashes: sorted, deduplicated, newline-joined,
// sha256, truncated.
//
// CONTRACT: Do NOT use a process-seeded runtime hash; replicas would compute
// different keys and never share cache hits. Newlines prevent ambiguous joins,
// and sha256 keeps the digest deterministic.
// See [[tracking-service-design]]
func hashOrderIDs(orderIDs []string) string {
	seen := make(map[string]struct{}, len(orderIDs))
	unique := make([]string, 0, len(orderIDs))
	for _, id := range orderIDs {
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
	}
	sort.Strings(unique)

	sum := sha256.Sum256([]byte(strings.Join(unique, "\n")))
	return hex.EncodeToString(sum[:])[:digestLength]
}
