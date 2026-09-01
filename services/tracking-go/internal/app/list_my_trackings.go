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
// Ids that do not exist — or exist but belong to another user — are OMITTED,
// never reported as a per-id error entry and never as a 404 for the request. A
// caller passing ten ids and owning three gets exactly three back, and cannot
// tell which of the missing seven exist. That is the same non-oracle property
// the single read's 404 has, expressed as a shorter list.
//
// Scoped by cognitoSub for the same reason GetMyTracking is: user_id would
// compare a sub against a usr_ id and return an empty list for every caller.
func (uc *ListMyTrackings) Execute(ctx context.Context, orderIDs []string, cognitoSub string) ([]domain.TrackingWithHistory, error) {
	// THE SHORT-CIRCUIT IS LOAD-BEARING, not an optimisation: sqlc renders
	// `IN (sqlc.slice('order_ids'))` by expanding the placeholder once per
	// element, so zero elements produces `IN ()` — a syntax error MySQL rejects
	// outright. The empty result is also the correct answer, so nothing is lost
	// by never asking.
	//
	// Non-nil, so the handler's response marshals as [] and never as null.
	if len(orderIDs) == 0 {
		return []domain.TrackingWithHistory{}, nil
	}
	return uc.lister.ListByOrderIDsScoped(ctx, orderIDs, cognitoSub)
}
