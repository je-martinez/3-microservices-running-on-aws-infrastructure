package grpcusers_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// idStubResolver stands in for *grpcusers.Client. The adapter under test takes
// the narrow lookup interface rather than the concrete client, which is what lets
// this test exist without a gRPC server.
type idStubResolver struct {
	user grpcusers.ResolvedUser
	err  error

	gotIdentifier string
}

func (s *idStubResolver) Resolve(_ context.Context, identifier string) (grpcusers.ResolvedUser, error) {
	s.gotIdentifier = identifier
	return s.user, s.err
}

func TestInternalIDResolverReturnsTheUsrID(t *testing.T) {
	stub := &idStubResolver{user: grpcusers.ResolvedUser{
		// TWO DIFFERENT VALUES. A fixture reusing one string for both could not
		// fail if the adapter returned the sub where the usr_ id belongs — which
		// is the exact confusion this whole seam exists to keep straight.
		InternalID: "usr_abc123",
		CognitoSub: "sub-xyz789",
	}}

	got, err := grpcusers.NewInternalIDResolver(stub).ResolveInternalUserID(t.Context(), "sub-xyz789")
	if err != nil {
		t.Fatalf("ResolveInternalUserID: %v", err)
	}
	if got != "usr_abc123" {
		t.Fatalf("got %q, want the internal usr_ id %q", got, "usr_abc123")
	}
	if stub.gotIdentifier != "sub-xyz789" {
		t.Fatalf("looked up %q, want the caller's sub %q", stub.gotIdentifier, "sub-xyz789")
	}
}

// TestInternalIDResolverTranslatesUnknownUser is the load-bearing case.
//
// app.CreateTracking answers 404 on domain.ErrUserNotFound and 500 on anything
// else. Leaking grpcusers.ErrUnknownUser through would make an unknown user a
// 500 — an outage for a caller who simply does not exist.
func TestInternalIDResolverTranslatesUnknownUser(t *testing.T) {
	stub := &idStubResolver{err: grpcusers.ErrUnknownUser}

	_, err := grpcusers.NewInternalIDResolver(stub).ResolveInternalUserID(t.Context(), "sub-missing")

	if !errors.Is(err, domain.ErrUserNotFound) {
		t.Fatalf("err = %v, want it to satisfy errors.Is(domain.ErrUserNotFound)", err)
	}
}

// TestInternalIDResolverPropagatesEveryOtherFailure is the other half, and the
// direction that is easy to get wrong.
//
// An Unavailable or DeadlineExceeded rendered as "unknown user" would answer 404
// and BLAME THE CALLER for somebody else's downtime, on a request that was
// perfectly valid. Only NotFound may become ErrUserNotFound.
func TestInternalIDResolverPropagatesEveryOtherFailure(t *testing.T) {
	outage := errors.New("rpc error: code = Unavailable")
	stub := &idStubResolver{err: outage}

	_, err := grpcusers.NewInternalIDResolver(stub).ResolveInternalUserID(t.Context(), "sub-1")

	if errors.Is(err, domain.ErrUserNotFound) {
		t.Fatal("a transport outage was translated to ErrUserNotFound; it would answer 404 " +
			"and blame the caller for someone else's downtime")
	}
	if !errors.Is(err, outage) {
		t.Fatalf("err = %v, want the original error to be wrapped", err)
	}
}

// TestInternalIDResolverRejectsAnEmptyInternalID guards the case where Users
// answers OK with no id.
//
// "" would be persisted into tracking.user_id — a row whose owner column is
// empty, which no ownership predicate can ever match. Failing here is the only
// answer that does not create an orphan.
func TestInternalIDResolverRejectsAnEmptyInternalID(t *testing.T) {
	stub := &idStubResolver{user: grpcusers.ResolvedUser{InternalID: "", CognitoSub: "sub-1"}}

	_, err := grpcusers.NewInternalIDResolver(stub).ResolveInternalUserID(t.Context(), "sub-1")

	if err == nil {
		t.Fatal("an empty internal id was accepted; it would persist a tracking whose " +
			"user_id no ownership predicate can match")
	}
}
