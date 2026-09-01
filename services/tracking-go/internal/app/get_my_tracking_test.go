package app_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// stubScopedReader records what the use case asked for, so a test can assert
// WHICH identity travelled to the port — the whole point of this task.
type stubScopedReader struct {
	// owned maps order_id -> the cognito_sub that owns it.
	owned map[string]string

	gotOrderID    string
	gotCognitoSub string
	calls         int
}

func (s *stubScopedReader) GetByOrderIDScoped(_ context.Context, orderID, cognitoSub string) (domain.TrackingWithHistory, error) {
	s.calls++
	s.gotOrderID = orderID
	s.gotCognitoSub = cognitoSub

	// The ownership predicate lives in the SQL for the real adapter; the stub
	// reproduces it so "not mine" and "not there" collapse here too.
	if owner, exists := s.owned[orderID]; !exists || owner != cognitoSub {
		return domain.TrackingWithHistory{}, domain.ErrTrackingNotFound
	}
	return domain.TrackingWithHistory{
		Tracking: domain.Tracking{
			ID:         "trk_1",
			OrderID:    orderID,
			UserID:     "usr_internal_abc",
			CognitoSub: cognitoSub,
			Status:     domain.StatusPlaced,
		},
		History: []domain.TrackingHistory{{TrackingID: "trk_1", Status: domain.StatusPlaced}},
	}, nil
}

func TestGetMyTrackingPassesTheCallersSubToThePort(t *testing.T) {
	// user_id and cognito_sub are DIFFERENT strings, deliberately: with one
	// value for both, this test could not fail on the ownership bug.
	reader := &stubScopedReader{owned: map[string]string{"ord_1": "sub-owner"}}
	uc := app.NewGetMyTracking(reader)

	got, err := uc.Execute(t.Context(), "ord_1", "sub-owner")
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if reader.gotCognitoSub != "sub-owner" {
		t.Errorf("the port received cognito_sub %q, want %q", reader.gotCognitoSub, "sub-owner")
	}
	if reader.gotCognitoSub == got.Tracking.UserID {
		t.Error("the use case scoped by the internal usr_ id — ownership filters by " +
			"cognito_sub, never by user_id")
	}
	if len(got.History) == 0 {
		t.Error("the read must return the tracking TOGETHER with its history")
	}
}

func TestGetMyTrackingReturnsNotFoundForSomeoneElsesTracking(t *testing.T) {
	reader := &stubScopedReader{owned: map[string]string{"ord_1": "sub-owner"}}
	uc := app.NewGetMyTracking(reader)

	_, err := uc.Execute(t.Context(), "ord_1", "sub-intruder")
	if !errors.Is(err, domain.ErrTrackingNotFound) {
		t.Fatalf("err = %v, want ErrTrackingNotFound — 'not yours' and 'not there' "+
			"are one indistinguishable answer", err)
	}
}

// The error travels verbatim: the use case adds no wrapping that would break the
// handler's errors.Is check and downgrade a 404 into a 500.
func TestGetMyTrackingPropagatesArbitraryErrors(t *testing.T) {
	boom := errors.New("connection refused")
	uc := app.NewGetMyTracking(readerFunc(func(context.Context, string, string) (domain.TrackingWithHistory, error) {
		return domain.TrackingWithHistory{}, boom
	}))

	if _, err := uc.Execute(t.Context(), "ord_1", "sub-owner"); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the port's error unwrapped", err)
	}
}

type readerFunc func(ctx context.Context, orderID, cognitoSub string) (domain.TrackingWithHistory, error)

func (f readerFunc) GetByOrderIDScoped(ctx context.Context, orderID, cognitoSub string) (domain.TrackingWithHistory, error) {
	return f(ctx, orderID, cognitoSub)
}
