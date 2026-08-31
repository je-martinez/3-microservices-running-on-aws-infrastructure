package grpcusers

import (
	"context"
	"errors"
	"fmt"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// ErrEmptyInternalID means Users answered successfully but with no id.
//
// Declared beside the type that produces it, never in a shared errors package.
var ErrEmptyInternalID = errors.New("grpcusers: users returned an empty internal id")

// userLookup is the one call InternalIDResolver makes, declared HERE by its
// consumer. *Client satisfies it; so does a three-line test double, which is why
// this adapter is testable without a gRPC server.
type userLookup interface {
	Resolve(ctx context.Context, identifier string) (ResolvedUser, error)
}

// InternalIDResolver adapts this package's Resolve to app.UserResolver.
//
// # It exists to do exactly two translations, and both are load-bearing
//
//  1. ResolvedUser -> the INTERNAL usr_ id. The caller is identified to us by
//     their Cognito sub, and what tracking.user_id stores is the usr_ id. These
//     are different strings for the same person, and putting the sub where the
//     usr_ id belongs writes a row no ownership predicate can match.
//  2. ErrUnknownUser -> domain.ErrUserNotFound. The use case answers 404 on the
//     domain sentinel and 500 on everything else, and it must not import this
//     package to tell the two apart.
//
// EVERY OTHER ERROR PROPAGATES UNCHANGED, wrapped. An Unavailable or a
// DeadlineExceeded rendered as "unknown user" would answer 404 to a perfectly
// valid request and blame the caller for someone else's outage.
type InternalIDResolver struct {
	users userLookup
}

// NewInternalIDResolver wires the adapter over a client.
func NewInternalIDResolver(users userLookup) *InternalIDResolver {
	return &InternalIDResolver{users: users}
}

// ResolveInternalUserID returns the caller's usr_ id for their Cognito sub.
func (r *InternalIDResolver) ResolveInternalUserID(ctx context.Context, cognitoSub string) (string, error) {
	if r.users == nil {
		// A process wired without a Users client. Reported rather than panicked:
		// creation is the only route that needs this, and the rest of the service
		// must keep serving.
		return "", fmt.Errorf("resolving %q: no users client is wired", cognitoSub)
	}

	user, err := r.users.Resolve(ctx, cognitoSub)
	if err != nil {
		if errors.Is(err, ErrUnknownUser) {
			// Wrapped, so the cause survives for a log line while errors.Is finds
			// the domain sentinel the use case switches on.
			return "", fmt.Errorf("%w: %w", domain.ErrUserNotFound, err)
		}
		return "", fmt.Errorf("resolving the caller through users: %w", err)
	}

	if user.InternalID == "" {
		// NOT translated to ErrUserNotFound: Users said this person EXISTS. A 404
		// would be a lie, and returning "" would persist a tracking whose user_id
		// is empty — an orphan no ownership predicate can ever match.
		return "", ErrEmptyInternalID
	}

	return user.InternalID, nil
}
