package app_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

type stubScopedLister struct {
	owned map[string]string // order_id -> owning cognito_sub

	gotOrderIDs   []string
	gotCognitoSub string
	calls         int
}

func (s *stubScopedLister) ListByOrderIDsScoped(_ context.Context, orderIDs []string, cognitoSub string) ([]domain.TrackingWithHistory, error) {
	s.calls++
	s.gotOrderIDs = orderIDs
	s.gotCognitoSub = cognitoSub

	out := make([]domain.TrackingWithHistory, 0, len(orderIDs))
	for _, id := range orderIDs {
		if owner, exists := s.owned[id]; !exists || owner != cognitoSub {
			continue // omitted, never an error entry
		}
		out = append(out, domain.TrackingWithHistory{
			Tracking: domain.Tracking{
				ID: "trk_" + id, OrderID: id, UserID: "usr_internal_abc",
				CognitoSub: cognitoSub, Status: domain.StatusPlaced,
			},
			History: []domain.TrackingHistory{{TrackingID: "trk_" + id, Status: domain.StatusPlaced}},
		})
	}
	return out, nil
}

func TestListMyTrackingsOmitsUnknownAndNonOwnedIDs(t *testing.T) {
	// Two DIFFERENT subs, and a user_id that is neither: without that the test
	// could not distinguish a cognito_sub filter from a user_id one.
	lister := &stubScopedLister{owned: map[string]string{
		"ord_mine":   "sub-owner",
		"ord_theirs": "sub-other",
	}}
	uc := app.NewListMyTrackings(lister)

	got, err := uc.Execute(t.Context(), []string{"ord_mine", "ord_theirs", "ord_nope"}, "sub-owner")
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(got) != 1 || got[0].Tracking.OrderID != "ord_mine" {
		t.Fatalf("got %d trackings %v, want exactly [ord_mine]", len(got), got)
	}
	if lister.gotCognitoSub != "sub-owner" {
		t.Errorf("the port received %q, want the caller's sub", lister.gotCognitoSub)
	}
	if lister.gotCognitoSub == got[0].Tracking.UserID {
		t.Error("the list scoped by the internal usr_ id instead of cognito_sub")
	}
}

// THE SHORT-CIRCUIT IS LOAD-BEARING, not an optimisation: sqlc renders
// `IN (sqlc.slice('order_ids'))` as `IN ()` for an empty slice, which MySQL
// rejects outright.
func TestListMyTrackingsEmptyInputNeverReachesThePort(t *testing.T) {
	lister := &stubScopedLister{}
	uc := app.NewListMyTrackings(lister)

	for _, input := range [][]string{nil, {}} {
		got, err := uc.Execute(t.Context(), input, "sub-owner")
		if err != nil {
			t.Fatalf("Execute(%v): %v", input, err)
		}
		if got == nil {
			t.Errorf("Execute(%v) returned nil; an empty result must be a non-nil "+
				"slice so it marshals as [] and never as null", input)
		}
		if len(got) != 0 {
			t.Errorf("Execute(%v) = %v, want empty", input, got)
		}
	}
	if lister.calls != 0 {
		t.Fatalf("the port was called %d times for an empty id list — sqlc's "+
			"IN (sqlc.slice()) generates invalid SQL for an empty slice", lister.calls)
	}
}

func TestListMyTrackingsPropagatesErrors(t *testing.T) {
	boom := errors.New("connection refused")
	uc := app.NewListMyTrackings(listerFunc(func(context.Context, []string, string) ([]domain.TrackingWithHistory, error) {
		return nil, boom
	}))

	if _, err := uc.Execute(t.Context(), []string{"ord_1"}, "sub-owner"); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the port's error unwrapped", err)
	}
}

type listerFunc func(ctx context.Context, orderIDs []string, cognitoSub string) ([]domain.TrackingWithHistory, error)

func (f listerFunc) ListByOrderIDsScoped(ctx context.Context, orderIDs []string, cognitoSub string) ([]domain.TrackingWithHistory, error) {
	return f(ctx, orderIDs, cognitoSub)
}
