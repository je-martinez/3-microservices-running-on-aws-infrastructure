package redis

import (
	"context"
	"log/slog"
)

// InvalidateTracking evicts everything a status change on orderID could have made
// stale.
//
// Never fails the caller: the gateway swallows its own failures, and a missed
// eviction costs at most the 60s TTL of the entries it failed to clear — which is
// precisely why the TTL is short.
//
// # The webhook has no caller identity
//
// PUT /v1/trackings/{order_id}/status authenticates with x-api-key and receives
// no x-user-id at all, so it cannot build a key from the request. The owner comes
// off the PERSISTED ROW instead — the same value the reads' ownership filter
// compares against. That is the only identity in play here, and it is the right
// one.
func InvalidateTracking(ctx context.Context, gw Gateway, log *slog.Logger, orderID, cognitoSub, userID string) {
	if log == nil {
		log = slog.Default()
	}

	if cognitoSub == "" {
		// The column is nullable: a row with a NULL sub is UNREACHABLE over both
		// user-scoped reads (the filter compares against a sub, and NULL matches
		// nobody, including the rightful owner). A row that can never be read can
		// never have been cached, so there is nothing to evict.
		log.DebugContext(ctx, "cache_invalidation_skipped",
			slog.String("app_event", "cache_invalidation_skipped"),
			slog.String("reason", "no_owner_sub"),
			slog.String("order_id", orderID),
		)
		return
	}

	if userID == "" {
		// Both key shapes embed user_id, so without one there is nothing
		// addressable to delete. Building tracking:index:v1:<sub>: would delete a
		// key nobody ever wrote, which reads as a successful invalidation while
		// evicting nothing.
		log.DebugContext(ctx, "cache_invalidation_skipped",
			slog.String("app_event", "cache_invalidation_skipped"),
			slog.String("reason", "no_owner_user_id"),
			slog.String("order_id", orderID),
		)
		return
	}

	if key, ok := TrackingOrderKey(cognitoSub, userID, orderID); ok {
		gw.Invalidate(ctx, key)
	}
	// The list keys are not reconstructible at any price — each embeds a sha256
	// of an arbitrary caller-supplied id list — so they are cleared through the
	// per-user index. Not KEYS and not SCAN: both are O(N) over the entire
	// keyspace, KEYS blocks the server for the duration, and putting either on a
	// write path makes every carrier callback pay for the size of the whole cache.
	gw.InvalidateIndex(ctx, UserIndexKey(cognitoSub, userID))

	log.InfoContext(ctx, "cache_invalidated",
		slog.String("app_event", "cache_invalidated"),
		slog.String("order_id", orderID),
		slog.String("cognito_sub", cognitoSub),
	)
}

// InvalidateUser evicts everything the account-deletion cascade leaves behind:
// every response entry through the per-user index, and the identity mapping.
//
// # Why BOTH identifiers are swept, not just the canonical pair
//
// This is the bug that made a deleted account's data readable for its full TTL,
// and it comes from the two paths disagreeing about what "the caller's identity"
// is.
//
// A response key is built from the RAW x-user-id header — whatever the client
// happened to send — plus the usr_ id resolved from it. Users' GetUserById accepts
// BOTH identifiers, so a client authenticating with the usr_ id resolves exactly
// as well as one sending the Cognito sub, and the E2E suite does precisely that
// on the direct path. The usr_ id therefore lands in the SUB POSITION of a live
// key:
//
//	tracking:index:v1:usr_abc:usr_abc          (header = usr_ id)
//	tracking:index:v1:<uuid-sub>:usr_abc       (header = cognito sub)
//	identity:sub-to-user:v1:usr_abc            (header = usr_ id)
//	identity:sub-to-user:v1:<uuid-sub>         (header = cognito sub)
//
// The cascade, by contrast, receives the CANONICAL pair. Sweeping only
// UserIndexKey(sub, userID) and IdentityKey(sub) therefore deletes keys that were
// never written whenever the client authenticated with the usr_ id, and leaves
// the live ones to expire on their own. Verified live in Orders, which has the
// identical design: the cascade logged success, the deletion returned 204, the
// key count did not move, and a re-read answered X-Cache: HIT with the deleted
// user's data.
//
// user_id is always the canonical usr_ id in the SECOND position, so the first
// position is the only one that varies.
//
// # KNOWN LIMITATION — keys are not normalized to a canonical identity
//
// Sweeping both identifiers fixes the leak but not its cause: the same person
// still gets a SEPARATE set of entries depending on which identifier they
// authenticated with. That is wasted memory and a lower hit rate than the design
// assumes. Normalizing every key onto the canonical sub would fix both, and was
// considered and deliberately not chosen. An accepted trade-off, not an oversight.
//
// Never fails the caller: the deletion has already COMMITTED by the time this
// runs, so failing would tell Users the cascade failed when it did not, and would
// fail the whole account deletion for the person.
func InvalidateUser(ctx context.Context, gw Gateway, log *slog.Logger, cognitoSub, userID string) {
	if log == nil {
		log = slog.Default()
	}

	identifiers := distinct(cognitoSub, userID)

	indexKeys := make([]string, 0, len(identifiers))
	for _, identifier := range identifiers {
		indexKeys = append(indexKeys, UserIndexKey(identifier, userID))
	}
	for _, indexKey := range distinct(indexKeys...) {
		gw.InvalidateIndex(ctx, indexKey)
	}

	for _, identifier := range identifiers {
		gw.Invalidate(ctx, IdentityKey(identifier))
	}

	log.InfoContext(ctx, "cache_invalidated",
		slog.String("app_event", "cache_invalidated"),
		slog.String("reason", "account_deleted"),
		slog.String("cognito_sub", cognitoSub),
	)
}

// distinct returns the non-empty values, deduplicated, IN THE ORDER GIVEN.
//
// A slice rather than a set so the sweep is deterministic — a test asserting
// which keys were deleted, and a log or trace read afterwards, both see a stable
// order. Empty values are dropped rather than formatted into a key:
// UserIndexKey("", "") is a real, well-formed key that some other caller could own.
func distinct(values ...string) []string {
	seen := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		duplicate := false
		for _, already := range seen {
			if already == value {
				duplicate = true
				break
			}
		}
		if !duplicate {
			seen = append(seen, value)
		}
	}
	return seen
}
