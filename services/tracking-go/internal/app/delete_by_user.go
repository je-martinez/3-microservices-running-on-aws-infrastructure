package app

import (
	"context"
	"errors"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// ErrEmptyIdentity guards the row-selection point.
//
// CONTRACT: A second guard beside the HTTP boundary's 422, deliberately. This
// use case is exported, and the predicate is an OR: one empty value matches
// every row with an empty string in that column — someone else's trackings.
// See [[soft-delete]]
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

// invalidateQuietly runs the eviction so nothing it does can fail the response.
//
// CONTRACT: The deletion has already COMMITTED, so a Redis outage escaping here
// tells Users the cascade did not happen when it did and fails the whole account
// deletion. The recover makes even a violation of the invalidator's no-error
// contract non-fatal.
func (uc *DeleteByUser) invalidateQuietly(ctx context.Context, cognitoSub, userID string) {
	defer func() {
		_ = recover()
	}()
	uc.invalidator.InvalidateUser(ctx, cognitoSub, userID)
}
