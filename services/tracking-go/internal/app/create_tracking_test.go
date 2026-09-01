package app_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

type stubResolver struct {
	userID string
	err    error
	calls  int
	gotSub string
}

func (s *stubResolver) ResolveInternalUserID(_ context.Context, sub string) (string, error) {
	s.calls++
	s.gotSub = sub
	return s.userID, s.err
}

type stubWriter struct {
	exists     bool
	existsErr  error
	created    domain.NewTracking
	createNow  time.Time
	createErr  error
	createCall int
	existsCall int
}

func (s *stubWriter) ExistsByOrderID(_ context.Context, _ string) (bool, error) {
	s.existsCall++
	return s.exists, s.existsErr
}

func (s *stubWriter) Create(
	_ context.Context, in domain.NewTracking, now time.Time,
) (domain.TrackingWithHistory, error) {
	s.createCall++
	s.created = in
	s.createNow = now
	if s.createErr != nil {
		return domain.TrackingWithHistory{}, s.createErr
	}
	return domain.TrackingWithHistory{
		Tracking: domain.Tracking{
			ID: "trk_1", OrderID: in.OrderID, UserID: in.UserID,
			CognitoSub: in.CognitoSub, Status: domain.StatusPlaced, Datetime: now,
		},
		History: []domain.TrackingHistory{{
			TrackingID: "trk_1", OrderID: in.OrderID, UserID: in.UserID,
			Status: domain.StatusPlaced, Datetime: now,
		}},
	}, nil
}

func fixedClock(t time.Time) func() time.Time { return func() time.Time { return t } }

func TestCreateTracking(t *testing.T) {
	now := time.Date(2026, 8, 27, 14, 53, 1, 0, time.UTC)

	t.Run("resolves the caller and persists at PLACED with one history row", func(t *testing.T) {
		// Two DIFFERENT identity values: a test using one value cannot fail on the
		// cognito_sub/user_id confusion this repo has already shipped once.
		res := &stubResolver{userID: "usr_internal"}
		w := &stubWriter{}
		uc := app.NewCreateTracking(res, w, fixedClock(now))

		got, err := uc.Execute(context.Background(), app.CreateTrackingInput{
			OrderID:    "ord_1",
			CognitoSub: "sub-abc-123",
			E2ESource:  true,
		})
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if res.gotSub != "sub-abc-123" {
			t.Errorf("resolved with %q, want the header sub verbatim", res.gotSub)
		}
		if w.created.UserID != "usr_internal" {
			t.Errorf("user_id = %q, want the RESOLVED usr_ id", w.created.UserID)
		}
		if w.created.CognitoSub != "sub-abc-123" {
			t.Errorf("cognito_sub = %q, want the header value verbatim", w.created.CognitoSub)
		}
		if got.Tracking.Status != domain.StatusPlaced {
			t.Errorf("status = %q, want PLACED", got.Tracking.Status)
		}
		if len(got.History) != 1 {
			t.Errorf("history rows = %d, want 1", len(got.History))
		}
		if !w.createNow.Equal(now) {
			t.Errorf("create stamped %v, want the single minted now %v", w.createNow, now)
		}
		if len(w.created.Tags) != 1 || w.created.Tags[0] != domain.E2ESourceTag {
			t.Errorf("tags = %v, want [%q]", w.created.Tags, domain.E2ESourceTag)
		}
	})

	t.Run("the shipping address is forwarded as opaque bytes", func(t *testing.T) {
		w := &stubWriter{}
		uc := app.NewCreateTracking(&stubResolver{userID: "usr_1"}, w, fixedClock(now))
		raw := []byte(`{"street":"a","future_field":{"deep":1}}`)
		if _, err := uc.Execute(context.Background(), app.CreateTrackingInput{
			OrderID: "ord_addr", CognitoSub: "sub-1", ShippingAddress: raw,
		}); err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if string(w.created.ShippingAddress) != string(raw) {
			t.Errorf("shipping_address = %s, want the bytes verbatim %s",
				w.created.ShippingAddress, raw)
		}
	})

	t.Run("untagged when e2e source is false", func(t *testing.T) {
		w := &stubWriter{}
		uc := app.NewCreateTracking(&stubResolver{userID: "usr_1"}, w, fixedClock(now))
		if _, err := uc.Execute(context.Background(), app.CreateTrackingInput{
			OrderID: "ord_2", CognitoSub: "sub-1", E2ESource: false,
		}); err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if len(w.created.Tags) != 0 {
			t.Errorf("tags = %v, want empty", w.created.Tags)
		}
	})

	t.Run("unknown user maps to ErrUnknownUser and writes NOTHING", func(t *testing.T) {
		w := &stubWriter{}
		uc := app.NewCreateTracking(
			&stubResolver{err: domain.ErrUserNotFound}, w, fixedClock(now))

		_, err := uc.Execute(context.Background(), app.CreateTrackingInput{
			OrderID: "ord_3", CognitoSub: "sub-x",
		})
		if !errors.Is(err, app.ErrUnknownUser) {
			t.Fatalf("err = %v, want ErrUnknownUser", err)
		}
		if w.createCall != 0 {
			t.Error("resolution failed but a write was attempted")
		}
		// Resolution runs FIRST, so an unknown user costs no database work at all —
		// not even the pre-check SELECT.
		if w.existsCall != 0 {
			t.Error("resolution failed but the database was queried anyway")
		}
	})

	t.Run("a non-NotFound resolver error propagates, never as unknown user", func(t *testing.T) {
		boom := errors.New("users: connection refused")
		w := &stubWriter{}
		uc := app.NewCreateTracking(&stubResolver{err: boom}, w, fixedClock(now))

		_, err := uc.Execute(context.Background(), app.CreateTrackingInput{
			OrderID: "ord_4", CognitoSub: "sub-y",
		})
		if errors.Is(err, app.ErrUnknownUser) {
			t.Fatal("a Users outage was reported as an unknown user")
		}
		if !errors.Is(err, boom) {
			t.Fatalf("err = %v, want the underlying transport error", err)
		}
		if w.createCall != 0 {
			t.Error("resolution failed but a write was attempted")
		}
		if w.existsCall != 0 {
			t.Error("resolution failed but the database was queried anyway")
		}
	})

	t.Run("pre-existing tracking is rejected before any write", func(t *testing.T) {
		w := &stubWriter{exists: true}
		uc := app.NewCreateTracking(&stubResolver{userID: "usr_1"}, w, fixedClock(now))

		_, err := uc.Execute(context.Background(), app.CreateTrackingInput{
			OrderID: "ord_5", CognitoSub: "sub-1",
		})
		if !errors.Is(err, domain.ErrTrackingAlreadyExists) {
			t.Fatalf("err = %v, want ErrTrackingAlreadyExists", err)
		}
		if w.createCall != 0 {
			t.Error("pre-check found a tracking but the write still ran")
		}
	})

	t.Run("a racing INSERT losing the unique index is the SAME error, not a 500", func(t *testing.T) {
		w := &stubWriter{exists: false, createErr: domain.ErrTrackingAlreadyExists}
		uc := app.NewCreateTracking(&stubResolver{userID: "usr_1"}, w, fixedClock(now))

		_, err := uc.Execute(context.Background(), app.CreateTrackingInput{
			OrderID: "ord_6", CognitoSub: "sub-1",
		})
		if !errors.Is(err, domain.ErrTrackingAlreadyExists) {
			t.Fatalf("err = %v, want ErrTrackingAlreadyExists from the unique index", err)
		}
	})

	t.Run("a pre-check failure propagates and writes nothing", func(t *testing.T) {
		boom := errors.New("mysql: connection refused")
		w := &stubWriter{existsErr: boom}
		uc := app.NewCreateTracking(&stubResolver{userID: "usr_1"}, w, fixedClock(now))

		_, err := uc.Execute(context.Background(), app.CreateTrackingInput{
			OrderID: "ord_7", CognitoSub: "sub-1",
		})
		if !errors.Is(err, boom) {
			t.Fatalf("err = %v, want the underlying pre-check error", err)
		}
		if w.createCall != 0 {
			t.Error("the pre-check errored but the write still ran")
		}
	})

	t.Run("the default clock truncates to whole seconds", func(t *testing.T) {
		// MySQL DATETIME here has fsp 0 and ROUNDS fractional seconds rather than
		// truncating them, so a sub-second `now` can land on the NEXT second.
		w := &stubWriter{}
		uc := app.NewCreateTracking(&stubResolver{userID: "usr_1"}, w, nil)
		if _, err := uc.Execute(context.Background(), app.CreateTrackingInput{
			OrderID: "ord_8", CognitoSub: "sub-1",
		}); err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if w.createNow.Nanosecond() != 0 {
			t.Errorf("now = %v, want whole seconds", w.createNow)
		}
		if w.createNow.Location() != time.UTC {
			t.Errorf("now is in %v, want UTC", w.createNow.Location())
		}
	})
}
