package redis

import (
	"context"
	"log/slog"
)

// InvalidateTracking evicts everything a status change on orderID could have made
// stale.
//
// CONTRACT: Do NOT derive ownership from the carrier request; it has no caller
// identity. Use the persisted cognito_sub and user_id or invalidation targets no
// live key. Gateway failures remain non-fatal and expire at the short TTL.
// See [[tracking-service-design]]
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
// CONTRACT: Do NOT sweep only the canonical cognito_sub. x-user-id may contain
// either the sub or usr_ id, so both can occupy the first segment; missing either
// leaves deleted account data readable as X-Cache: HIT until TTL expiry.
// Keys remain unnormalized by design, so sweep both identifiers. Invalidation is
// non-fatal because the deletion is already committed.
// See [[tracking-service-design]]
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
