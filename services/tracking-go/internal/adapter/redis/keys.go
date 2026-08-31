// Package redis is the cache adapter: key construction, the Redis gateway, the
// identity cache and invalidation.
//
// # Why every response key carries TWO identities
//
// cognito_sub is the ownership key every user-scoped read filters by; user_id is
// the internal usr_ id. Both travel so a key is unambiguous under either identity
// model, and so the per-user index can be reconstructed from either.
//
// # The cognitoSub parameter is the RAW header, not always a Cognito sub
//
// Read this before writing anything that INVALIDATES a key. Every builder here is
// called with the x-user-id header verbatim — whichever identifier the client
// chose to send. Clients legitimately send either: Users' GetUserById resolves the
// Cognito sub and the internal usr_ id alike, which is why the E2E suite sends the
// usr_ id on the direct path. So these are all live key shapes for ONE person:
//
//	tracking:order:v1:<uuid-sub>:usr_abc:ord_1
//	tracking:order:v1:usr_abc:usr_abc:ord_1
//	identity:sub-to-user:v1:<uuid-sub>
//	identity:sub-to-user:v1:usr_abc
//
// The user_id segment is stable (always the resolved usr_ id); the FIRST segment
// is not. Assuming otherwise is what let a deleted account's entries survive
// their full TTL — see InvalidateUser.
//
// # Why a builder may answer "no key"
//
// user_id is resolved lazily over gRPC to Users, and that resolution is allowed to
// fail: enriching a log line must never fail a request. So a fully authenticated
// caller can reach a handler with no user_id. Formatting an empty segment would
// produce a key that LIES about what it is scoped by, and the per-user index keyed
// on the same empty value would collapse. Answering "no key" makes the route skip
// caching for that request entirely: it pays a MISS, serves from MySQL, and writes
// nothing.
//
// # Why the list key is a hash
//
// order_ids is an arbitrary caller-supplied list of up to 100 ids. Keying on the
// raw list would make the key length proportional to the request and the key SPACE
// combinatorial. Sorting and deduplicating first, then hashing, collapses every
// ordering and every repetition of one set onto one fixed-length key.
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
//
// Required because a list key embeds a HASH of an arbitrary id list and therefore
// cannot be reconstructed at invalidation time. KEYS and SCAN are the wrong
// answer: both are O(N) over the whole keyspace, and KEYS blocks the server while
// it runs.
//
// Same warning as IdentityKey: the first segment is the RAW header value, so one
// person can own more than one index.
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
// The newline join is a separator that cannot appear inside an order id, so
// ["ab","c"] and ["a","bc"] cannot collide.
//
// sha256 rather than a runtime hash: Go's maphash is explicitly per-process
// seeded (as Python's str hash is under PYTHONHASHSEED), so two replicas would
// compute DIFFERENT keys for the same request and the cache would never hit
// across them. Never use maphash here.
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
