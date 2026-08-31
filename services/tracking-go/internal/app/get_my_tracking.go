package app

import (
	"context"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// ScopedTrackingReader is THE only read port this use case knows about, and it
// has no unscoped variant.
//
// # Scoped and unscoped reads are separate METHODS, never one optional parameter
//
// The internal/gRPC path needs an UNSCOPED lookup and this one needs an
// ownership-scoped lookup. In Python those are one function with
// `cognito_sub=None` meaning "unscoped". That translation does not survive
// contact with Go: the zero value of a string is "", not nil, so a caller that
// forgets the argument — or a struct field that was never set — silently asks
// for "scoped to the empty string" instead of "unscoped", or the reverse. There
// is no compiler error and no test failure; the read simply matches nothing, or
// matches rows whose cognito_sub is empty, which are somebody else's.
//
// Two methods on two ports makes the mistake unrepresentable: this use case
// cannot express an unscoped read at all.
type ScopedTrackingReader interface {
	// GetByOrderIDScoped returns the tracking for orderID owned by cognitoSub,
	// together with its ordered history.
	//
	// It returns domain.ErrTrackingNotFound for "no such tracking" AND for
	// "belongs to someone else" — indistinguishably, by design.
	GetByOrderIDScoped(ctx context.Context, orderID, cognitoSub string) (domain.TrackingWithHistory, error)
}

// GetMyTracking answers GET /v1/trackings/{order_id}.
type GetMyTracking struct{ reader ScopedTrackingReader }

// NewGetMyTracking wires the use case to its one port.
func NewGetMyTracking(reader ScopedTrackingReader) *GetMyTracking {
	return &GetMyTracking{reader: reader}
}

// Execute returns one of the CALLER'S trackings.
//
// # cognitoSub, never the internal usr_ id
//
// The caller passes the value of the x-user-id header, which despite its name
// carries the JWT `sub`. tracking.user_id holds the internal usr_ id Orders
// resolved through Users — a DIFFERENT string for the same person. Scoping by
// user_id compares a sub against a usr_ id, matches nothing, and answers 404 for
// every caller INCLUDING the rightful owner, while looking perfectly
// implemented. That shipped once in the Python service and 253 tests missed it,
// because they created and read with the same value.
//
// # The 404 is deliberately ambiguous
//
// domain.ErrTrackingNotFound covers both "no such tracking" and "exists but
// belongs to another user". The ownership predicate is inside the SQL, so a
// non-owned row never exists in this process to be leaked by a later change —
// and the handler has nothing to distinguish, which is what stops the endpoint
// becoming an oracle for other people's order ids.
//
// No wrapping: the sentinel travels verbatim so the handler's errors.Is check
// keeps mapping it to 404 rather than 500.
func (uc *GetMyTracking) Execute(ctx context.Context, orderID, cognitoSub string) (domain.TrackingWithHistory, error) {
	return uc.reader.GetByOrderIDScoped(ctx, orderID, cognitoSub)
}
