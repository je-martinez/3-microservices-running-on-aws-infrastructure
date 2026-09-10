package app

import (
	"context"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// ScopedTrackingLister is the batch read's own port.
//
// Declared HERE, beside its only consumer, and kept to one method. There is no
// shared repository interface: a wide one would let this use case reach the
// unscoped lookup, and the whole point of the scoped/unscoped split is that this
// path cannot.
type ScopedTrackingLister interface {
	// ListByOrderIDsScoped returns the subset of orderIDs owned by cognitoSub,
	// each together with its ordered history. Ids that do not exist, are
	// soft-deleted, or belong to someone else are simply absent from the result.
	ListByOrderIDsScoped(ctx context.Context, orderIDs []string, cognitoSub string) ([]domain.TrackingWithHistory, error)
}

// ListMyTrackings answers GET /v1/trackings?order_ids=<csv>.
type ListMyTrackings struct{ lister ScopedTrackingLister }

// NewListMyTrackings wires the use case to its one port.
func NewListMyTrackings(lister ScopedTrackingLister) *ListMyTrackings {
	return &ListMyTrackings{lister: lister}
}

// Execute returns the caller's trackings among orderIDs.
//
// CONTRACT: Omit ids that do not exist or belong to someone else — no per-id
// error, no 404. A caller owning three of ten gets three back and cannot tell
// which of the seven exist. Scoped by cognitoSub, since user_id compares a sub
// against a usr_ id and returns an empty list for everyone.
// See [[user-id-vs-cognito-sub-ownership-key]]
func (uc *ListMyTrackings) Execute(ctx context.Context, orderIDs []string, cognitoSub string) ([]domain.TrackingWithHistory, error) {
	// CONTRACT: Keep this short-circuit. sqlc expands the slice placeholder once
	// per element, so zero elements renders `IN ()` — a syntax error MySQL
	// rejects. The result is non-nil so the response marshals as [], not null.
	if len(orderIDs) == 0 {
		return []domain.TrackingWithHistory{}, nil
	}
	return uc.lister.ListByOrderIDsScoped(ctx, orderIDs, cognitoSub)
}
