package app

import (
	"context"
	"errors"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// ErrEmptyIdentity guards the row-selection point.
//
// The HTTP boundary already rejects empties with a 422, but this use case is
// exported and a future caller reaching it another way must not be able to widen
// the blast radius: the predicate is an OR, so an empty value on either side
// matches every row carrying an empty string in that column — someone else's
// trackings. Two guards for one rule, deliberately, because only one of them sits
// on the line that actually decides which rows die.
//
// Declared beside the type that produces it rather than in a shared errors
// package, so the adapter maps it at the boundary and this layer stays unaware of
// HTTP.
var ErrEmptyIdentity = errors.New("soft delete by user requires both identities to be non-empty")

// UserSoftDeleter is the account-deletion cascade's write port, declared here by
// its consumer and kept to the one method this use case calls.
type UserSoftDeleter interface {
	// SoftDeleteByUser stamps deleted_at/deleted_by on the user's live trackings
	// and their live history, and returns the PARENT statement's rowcount.
	SoftDeleteByUser(ctx context.Context, cognitoSub, userID string, actor audit.Actor, now time.Time) (int64, error)
}

// UserCacheInvalidator clears the user's whole cache footprint — every response
// entry of theirs plus their cognito_sub -> user_id identity mapping.
//
// It returns NO error, and that is the contract rather than an omission: by the
// time it runs the deletion has committed, so there is no failure this caller
// could act on.
type UserCacheInvalidator interface {
	InvalidateUser(ctx context.Context, cognitoSub, userID string)
}

// DeleteByUser is the Tracking leg of the account-deletion cascade.
type DeleteByUser struct {
	deleter     UserSoftDeleter
	invalidator UserCacheInvalidator
	clock       func() time.Time
}

// NewDeleteByUser wires the use case. A nil clock falls back to the single
// minting rule this service uses everywhere: UTC, truncated to the second,
// because MySQL DATETIME here has fsp 0 and ROUNDS rather than truncates, so an
// untruncated value disagrees with the row it just wrote.
func NewDeleteByUser(deleter UserSoftDeleter, invalidator UserCacheInvalidator, clock func() time.Time) *DeleteByUser {
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC().Truncate(time.Second) }
	}
	return &DeleteByUser{deleter: deleter, invalidator: invalidator, clock: clock}
}

// Execute soft-deletes every live tracking belonging to the user and, through the
// FK, their history. It returns how many `tracking` rows were stamped.
//
// The actor is the cascade, not the user: deleted_by records what PRODUCED the
// change, and "this account was deleted" is a different fact from "the carrier
// updated this" or "the test harness swept this".
func (uc *DeleteByUser) Execute(ctx context.Context, cognitoSub, userID string) (int64, error) {
	if cognitoSub == "" || userID == "" {
		return 0, ErrEmptyIdentity
	}

	deleted, err := uc.deleter.SoftDeleteByUser(ctx, cognitoSub, userID, audit.DeleteByUser, uc.clock())
	if err != nil {
		// No eviction on a failed write. Structural rather than a status check to
		// keep in sync: a deletion that never landed has no cache footprint to
		// clear, and evicting anyway would report a cascade that did not happen.
		return 0, err
	}

	// After the write, never before. Evicting earlier would reopen the
	// stale-repopulation window: a concurrent read misses, queries MySQL, still
	// sees the not-yet-deleted rows, and writes that soon-to-be-wrong body back
	// under the key just cleared.
	uc.invalidateQuietly(ctx, cognitoSub, userID)
	return deleted, nil
}

// invalidateQuietly runs the eviction so that nothing it does can fail the
// response.
//
// This is load-bearing rather than merely tidy. The deletion has already
// COMMITTED, so a Redis outage that propagated out of here would tell Users the
// cascade did not happen when it did, and fail the whole account deletion for the
// person. The recover is the last line of that defence: the invalidator's
// contract already forbids returning an error, and this makes a violation of that
// contract non-fatal too.
func (uc *DeleteByUser) invalidateQuietly(ctx context.Context, cognitoSub, userID string) {
	defer func() {
		_ = recover()
	}()
	uc.invalidator.InvalidateUser(ctx, cognitoSub, userID)
}
