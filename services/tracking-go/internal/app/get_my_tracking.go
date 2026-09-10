package app

import (
	"context"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// ScopedTrackingReader is THE only read port this use case knows, with no
// unscoped variant.
//
// CONTRACT: Scoped and unscoped reads are separate METHODS on separate ports,
// never one optional parameter. Go's zero string is "", so a forgotten argument
// silently asks for "scoped to the empty string" — no compiler error, no test
// failure, and the read matches nothing or matches somebody else's empty-sub
// rows. See [[user-id-vs-cognito-sub-ownership-key]]
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
// CONTRACT: cognitoSub, never the internal usr_ id. x-user-id carries the JWT
// sub despite its name, and scoping by user_id 404s every caller including the
// owner while looking implemented — a test creating and reading with one value
// cannot catch it. See [[user-id-vs-cognito-sub-ownership-key]]
//
// CONTRACT: The 404 stays ambiguous. ErrTrackingNotFound covers both "no such
// tracking" and "someone else's", so the endpoint is no oracle for other
// people's order ids. The sentinel travels unwrapped for the handler's
// errors.Is check.
func (uc *GetMyTracking) Execute(ctx context.Context, orderID, cognitoSub string) (domain.TrackingWithHistory, error) {
	return uc.reader.GetByOrderIDScoped(ctx, orderID, cognitoSub)
}
