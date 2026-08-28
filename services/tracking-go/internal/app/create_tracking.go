// Package app holds the use cases: what this service DOES, expressed without
// reference to how a request arrived or where a row is stored.
//
// Each use case declares the narrow ports IT consumes, in its own file. There is
// no shared repository interface and no central ports.go: a consumer-declared
// port stays two methods wide, so a change to one use case's needs cannot ripple
// into every adapter that happens to implement a wide shared interface.
package app

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// ErrUnknownUser: the caller authenticated successfully (the gateway verified the
// JWT) but Users holds no record for that sub. The HTTP layer renders it 404, not
// 401 — the same valid token will produce the same missing record forever, so
// telling the client to re-authenticate would make it loop.
var ErrUnknownUser = errors.New("users has no record for this cognito sub")

// UserResolver resolves the caller's internal usr_ id from their Cognito sub.
//
// It returns domain.ErrUserNotFound, and ONLY that, for a sub Users has never
// seen. Every other failure — Unavailable, DeadlineExceeded, Unauthenticated —
// propagates unchanged, because an outage rendered as "unknown user" would blame
// the caller for someone else's downtime and answer 404 to a perfectly valid
// request.
type UserResolver interface {
	ResolveInternalUserID(ctx context.Context, cognitoSub string) (string, error)
}

// TrackingCreator persists a tracking and its first history row in ONE unit of
// work.
type TrackingCreator interface {
	// ExistsByOrderID reports whether a LIVE tracking OR any live history row
	// already exists for orderID.
	ExistsByOrderID(ctx context.Context, orderID string) (bool, error)
	// Create writes the tracking and its opening history row atomically, both
	// stamped from `now`. It returns domain.ErrTrackingAlreadyExists when the
	// unique index rejects a racing INSERT.
	Create(ctx context.Context, in domain.NewTracking, now time.Time) (domain.TrackingWithHistory, error)
}

// CreateTrackingInput is the caller-supplied half of a creation.
//
// It carries no id, no status and no audit actor: those are the service's to
// mint, not a caller's to choose. CognitoSub comes from the gateway-injected
// header and NEVER from the request body — a body field would be an
// unauthenticated string a client picks, so anyone could create a tracking
// attributed to anyone.
type CreateTrackingInput struct {
	OrderID    string
	CognitoSub string
	// ShippingAddress is opaque JSON, forwarded byte-for-byte. The shape is owned
	// by Orders/Users and this service only stores it; parsing it here would turn
	// an additive upstream field into a creation outage. nil means "absent", and
	// the column stays NULL. PII — never logged.
	ShippingAddress []byte
	// E2ESource is ALREADY the AND of the x-e2e-source header and
	// E2E_TESTING_ENABLED. The middleware evaluates both, so this use case cannot
	// tag a row on the header alone.
	E2ESource bool
}

// CreateTracking is the only path that brings a tracking into existence.
type CreateTracking struct {
	users  UserResolver
	writer TrackingCreator
	clock  func() time.Time
}

// NewCreateTracking wires the use case. A nil clock means the production one.
func NewCreateTracking(users UserResolver, writer TrackingCreator, clock func() time.Time) *CreateTracking {
	if clock == nil {
		// Truncate, NOT round: MySQL DATETIME here has fsp 0 and ROUNDS a
		// fractional second, so an untruncated 14:53:01.7 is stored as 14:53:02 —
		// a timestamp one second in the row's own future.
		clock = func() time.Time { return time.Now().UTC().Truncate(time.Second) }
	}
	return &CreateTracking{users: users, writer: writer, clock: clock}
}

// Execute resolves the caller, guards uniqueness, and persists the tracking at
// PLACED together with its first history row.
//
// It publishes NOTHING. Creation emits no SQS event — only status transitions
// do, which is why a TestMode run leaves five history rows and sends four events.
func (uc *CreateTracking) Execute(ctx context.Context, in CreateTrackingInput) (domain.TrackingWithHistory, error) {
	// Resolution FIRST: an unknown user must cost no write at all. Attempting the
	// INSERT first would consume the pre-check and the unique index for a request
	// that was always going to fail.
	userID, err := uc.users.ResolveInternalUserID(ctx, in.CognitoSub)
	if err != nil {
		if errors.Is(err, domain.ErrUserNotFound) {
			return domain.TrackingWithHistory{}, fmt.Errorf("%w: %s", ErrUnknownUser, in.CognitoSub)
		}
		// Every other status propagates unchanged. A Users outage rendered as
		// "unknown user" would write nothing and blame the caller.
		return domain.TrackingWithHistory{}, err
	}

	// Guard 1 — the explicit pre-check. This is what produces the ordinary,
	// entirely-expected 409 from a plain SELECT, with no failed INSERT and no
	// driver-specific error string to parse.
	exists, err := uc.writer.ExistsByOrderID(ctx, in.OrderID)
	if err != nil {
		return domain.TrackingWithHistory{}, err
	}
	if exists {
		return domain.TrackingWithHistory{}, fmt.Errorf("%w for order_id %s",
			domain.ErrTrackingAlreadyExists, in.OrderID)
	}

	var tags []string
	if in.E2ESource {
		tags = []string{domain.E2ESourceTag}
	}

	// ONE now for both rows. Two time.Now() calls can straddle a second boundary,
	// and a tracking whose datetime differs from its own opening history row
	// sorts unpredictably on every later read.
	now := uc.clock()

	// Guard 2 — the unique index, translated by the adapter into the SAME error.
	// The pre-check cannot be airtight: two concurrent requests can both SELECT
	// nothing before either INSERTs, and only the database can adjudicate that.
	// Both paths must produce a 409, never a 500.
	return uc.writer.Create(ctx, domain.NewTracking{
		OrderID:         in.OrderID,
		UserID:          userID,
		CognitoSub:      in.CognitoSub,
		ShippingAddress: in.ShippingAddress,
		Tags:            tags,
	}, now)
}
