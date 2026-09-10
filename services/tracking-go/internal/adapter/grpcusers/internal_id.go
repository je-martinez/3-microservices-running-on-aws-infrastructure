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

// InternalIDResolver adapts this package's Resolve to app.UserResolver, doing
// two load-bearing translations: ResolvedUser to the INTERNAL usr_ id, and
// ErrUnknownUser to domain.ErrUserNotFound.
//
// CONTRACT: Both are required and every OTHER error propagates unchanged. The
// sub and the usr_ id are different strings for one person, so putting the sub
// where the usr_ id belongs writes a row no ownership predicate matches; and an
// Unavailable rendered as "unknown user" 404s a valid request.
// See [[user-id-vs-cognito-sub-ownership-key]]
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
