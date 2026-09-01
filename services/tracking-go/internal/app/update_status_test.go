package app_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// stubStatusWriter stands in for the repository. It models the ONE behaviour the
// use case cannot be allowed to work around: ApplyTransition RE-READS the
// history, so the value it hands back already contains the row it just appended.
type stubStatusWriter struct {
	current domain.Tracking
	getErr  error
	getCall int

	// staleHistory is the history as it stood BEFORE the append. The stub
	// returns current-plus-the-new-row, so a use case that published this
	// pre-append slice instead of the writer's answer is caught.
	staleHistory []domain.TrackingHistory

	applied      bool
	appliedTo    domain.Status
	appliedActor audit.Actor
	appliedNow   time.Time
	applyErr     error

	// committed flips at the end of ApplyTransition. The invalidator records it,
	// which is how "invalidated before the commit" becomes an assertion.
	committed bool
}

func (s *stubStatusWriter) GetByOrderID(_ context.Context, orderID string) (domain.Tracking, error) {
	s.getCall++
	if s.getErr != nil {
		return domain.Tracking{}, s.getErr
	}
	tracking := s.current
	tracking.OrderID = orderID
	tracking.History = s.staleHistory
	return tracking, nil
}

func (s *stubStatusWriter) ApplyTransition(
	_ context.Context, t domain.Tracking, to domain.Status, actor audit.Actor, now time.Time,
) (domain.TrackingWithHistory, error) {
	s.applied = true
	s.appliedTo = to
	s.appliedActor = actor
	s.appliedNow = now
	if s.applyErr != nil {
		return domain.TrackingWithHistory{}, s.applyErr
	}

	updated := t
	updated.Status = to
	updated.Datetime = now
	updated.UpdatedBy = string(actor)

	// The RE-READ: the pre-append rows plus the transition just written.
	history := make([]domain.TrackingHistory, 0, len(s.staleHistory)+1)
	history = append(history, s.staleHistory...)
	history = append(history, domain.TrackingHistory{
		TrackingID: t.ID,
		OrderID:    t.OrderID,
		UserID:     t.UserID,
		CognitoSub: t.CognitoSub,
		Status:     to,
		Datetime:   now,
		CreatedBy:  string(actor),
	})
	updated.History = history

	s.committed = true
	return domain.TrackingWithHistory{Tracking: updated, History: history}, nil
}

type publishedEvent struct {
	tracking domain.TrackingWithHistory
	previous string
	actor    audit.Actor
}

type recordingPublisher struct {
	calls []publishedEvent
}

func (p *recordingPublisher) PublishTrackingStatusChanged(
	_ context.Context, t domain.TrackingWithHistory, previous string, actor audit.Actor,
) {
	p.calls = append(p.calls, publishedEvent{tracking: t, previous: previous, actor: actor})
}

type panickingPublisher struct{}

func (panickingPublisher) PublishTrackingStatusChanged(
	context.Context, domain.TrackingWithHistory, string, audit.Actor,
) {
	panic("the publisher could not be obtained")
}

type stubInvalidator struct {
	called             bool
	orderID            string
	cognitoSub         string
	userID             string
	calledBeforeCommit bool

	// writer, when set, is consulted at call time so the invalidation can assert
	// it ran AFTER the transaction committed.
	writer *stubStatusWriter
}

func (s *stubInvalidator) InvalidateTracking(_ context.Context, orderID, cognitoSub, userID string) {
	s.called = true
	s.orderID = orderID
	s.cognitoSub = cognitoSub
	s.userID = userID
	if s.writer != nil && !s.writer.committed {
		s.calledBeforeCommit = true
	}
}

type panickingInvalidator struct{}

func (panickingInvalidator) InvalidateTracking(context.Context, string, string, string) {
	panic("redis client unavailable")
}

func TestUpdateStatus(t *testing.T) {
	now := time.Date(2026, 8, 27, 15, 0, 0, 0, time.UTC)

	t.Run("advances and publishes exactly one event", func(t *testing.T) {
		// Two DIFFERENT identity values throughout: a fixture reusing one string
		// for both cannot fail on the cognito_sub/user_id confusion.
		w := &stubStatusWriter{current: domain.Tracking{
			ID: "trk_1", OrderID: "ord_1", UserID: "usr_1",
			CognitoSub: "sub-1", Status: domain.StatusPlaced,
		}}
		pub := &recordingPublisher{}
		inv := &stubInvalidator{writer: w}
		uc := app.NewUpdateStatus(w, pub, inv, fixedClock(now))

		got, err := uc.Execute(context.Background(), "ord_1", domain.StatusProcessing, "")
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if got.Tracking.Status != domain.StatusProcessing {
			t.Errorf("status = %q, want PROCESSING", got.Tracking.Status)
		}
		if !w.appliedNow.Equal(now) {
			t.Errorf("stamped %v, want the single minted now %v", w.appliedNow, now)
		}
		if len(pub.calls) != 1 {
			t.Fatalf("published %d events, want exactly 1", len(pub.calls))
		}
		if pub.calls[0].previous != "PLACED" {
			t.Errorf("previous_status = %q, want PLACED — the row already holds "+
				"the NEW status by the time the event is built", pub.calls[0].previous)
		}
		if pub.calls[0].actor != audit.CarrierStatusUpdate {
			t.Errorf("actor = %q, want the carrier default", pub.calls[0].actor)
		}
	})

	t.Run("the lookup is UNSCOPED — order_id alone, no ownership filter", func(t *testing.T) {
		// The carrier webhook carries no x-user-id at all. Applying the reads'
		// cognito_sub filter here would 404 every carrier call while looking
		// perfectly implemented, so the port exposes only the unscoped method.
		port := reflect.TypeOf((*app.StatusWriter)(nil)).Elem()
		if _, scoped := port.MethodByName("GetByOrderIDScoped"); scoped {
			t.Error("StatusWriter exposes a SCOPED read; this endpoint has no " +
				"caller identity to scope by")
		}
		method, ok := port.MethodByName("GetByOrderID")
		if !ok {
			t.Fatal("StatusWriter has no GetByOrderID")
		}
		// ctx + orderID and nothing else: a third string parameter would be the
		// optional-scope shape, in which Go's zero value silently turns
		// "unscoped" into "scoped to the empty string".
		if got := method.Type.NumIn(); got != 2 {
			t.Errorf("GetByOrderID takes %d parameters, want ctx + orderID only", got)
		}
	})

	t.Run("the actor is a parameter, and only the actor differs", func(t *testing.T) {
		w := &stubStatusWriter{current: domain.Tracking{
			OrderID: "ord_1", UserID: "usr_1", CognitoSub: "sub-1",
			Status: domain.StatusPlaced,
		}}
		pub := &recordingPublisher{}
		uc := app.NewUpdateStatus(w, pub, &stubInvalidator{}, fixedClock(now))

		if _, err := uc.Execute(context.Background(), "ord_1",
			domain.StatusProcessing, audit.TestModeProgression); err != nil {
			t.Fatal(err)
		}
		if w.appliedActor != audit.TestModeProgression {
			t.Errorf("history stamped %q, want the test-mode actor", w.appliedActor)
		}
		if pub.calls[0].actor != audit.TestModeProgression {
			t.Errorf("event actor = %q — the actor must travel to the envelope, "+
				"never be fixed in the publisher", pub.calls[0].actor)
		}
	})

	t.Run("the published history CONTAINS the transition being announced", func(t *testing.T) {
		// The mutation this catches: publishing the slice loaded BEFORE the
		// append. The event would then announce PROCESSING while carrying a
		// history that stops at PLACED.
		w := &stubStatusWriter{
			current: domain.Tracking{
				ID: "trk_1", OrderID: "ord_1", UserID: "usr_1", CognitoSub: "sub-1",
				Status: domain.StatusPlaced,
			},
			staleHistory: []domain.TrackingHistory{{
				TrackingID: "trk_1", Status: domain.StatusPlaced,
				Datetime: now.Add(-time.Minute),
			}},
		}
		pub := &recordingPublisher{}
		uc := app.NewUpdateStatus(w, pub, &stubInvalidator{}, fixedClock(now))
		if _, err := uc.Execute(context.Background(), "ord_1", domain.StatusProcessing, ""); err != nil {
			t.Fatal(err)
		}

		published := pub.calls[0].tracking.History
		if len(published) == 0 || published[len(published)-1].Status != domain.StatusProcessing {
			t.Fatalf("published history = %+v — it must be RE-READ after the append, "+
				"not a slice loaded before it", published)
		}
		// The same rule on the value returned to the caller: the 200 body must
		// not contradict the status it reports either.
		returned := pub.calls[0].tracking
		if len(returned.History) != 2 {
			t.Errorf("returned history has %d rows, want the pre-existing row plus "+
				"the new transition", len(returned.History))
		}
	})

	t.Run("the state machine guards, in their load-bearing order", func(t *testing.T) {
		cases := []struct {
			name       string
			current    domain.Status
			requested  domain.Status
			wantReason domain.RejectionReason
		}{
			{"terminal beats backward", domain.StatusDelivered, domain.StatusPlaced, domain.ReasonAlreadyDelivered},
			{"terminal beats equal", domain.StatusDelivered, domain.StatusDelivered, domain.ReasonAlreadyDelivered},
			{"backward", domain.StatusShipped, domain.StatusPlaced, domain.ReasonBackwardTransition},
			{"equal is not forward", domain.StatusShipped, domain.StatusShipped, domain.ReasonNotStrictlyForward},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				w := &stubStatusWriter{current: domain.Tracking{
					OrderID: "ord_1", UserID: "usr_1", CognitoSub: "sub-1",
					Status: tc.current,
				}}
				pub := &recordingPublisher{}
				inv := &stubInvalidator{}
				uc := app.NewUpdateStatus(w, pub, inv, fixedClock(now))

				_, err := uc.Execute(context.Background(), "ord_1", tc.requested, "")
				var invalid *domain.InvalidTransitionError
				if !errors.As(err, &invalid) {
					t.Fatalf("err = %v, want InvalidTransitionError", err)
				}
				if invalid.Reason != tc.wantReason {
					t.Errorf("reason = %q, want %q", invalid.Reason, tc.wantReason)
				}
				if w.applied {
					t.Error("a rejected transition wrote to the database")
				}
				if len(pub.calls) != 0 {
					t.Error("a rejected transition published an event")
				}
				if inv.called {
					t.Error("a rejected transition invalidated the cache")
				}
			})
		}
	})

	t.Run("a missing tracking is ErrTrackingNotFound and writes nothing", func(t *testing.T) {
		w := &stubStatusWriter{getErr: domain.ErrTrackingNotFound}
		pub := &recordingPublisher{}
		uc := app.NewUpdateStatus(w, pub, &stubInvalidator{}, fixedClock(now))

		_, err := uc.Execute(context.Background(), "ord_gone", domain.StatusShipped, "")
		if !errors.Is(err, domain.ErrTrackingNotFound) {
			t.Fatalf("err = %v, want ErrTrackingNotFound", err)
		}
		if w.applied {
			t.Error("nothing was found but a write ran")
		}
		if len(pub.calls) != 0 {
			t.Error("nothing was found but an event was published")
		}
	})

	t.Run("a deleted TestMode fixture publishes from its last committed snapshot", func(t *testing.T) {
		w := &stubStatusWriter{}
		pub := &recordingPublisher{}
		uc := app.NewUpdateStatus(w, pub, &stubInvalidator{}, fixedClock(now))
		current := domain.TrackingWithHistory{
			Tracking: domain.Tracking{
				ID:             "trk_1",
				OrderID:        "ord_1",
				UserID:         "usr_1",
				CognitoSub:     "sub-1",
				TrackingNumber: "3MRAI-0000-0000-0001",
				Status:         domain.StatusShipped,
			},
			History: []domain.TrackingHistory{{
				TrackingID: "trk_1",
				OrderID:    "ord_1",
				Status:     domain.StatusShipped,
			}},
		}

		got, err := uc.ContinueDeletedTestMode(
			context.Background(),
			current,
			domain.StatusOutForDelivery,
		)
		if err != nil {
			t.Fatalf("ContinueDeletedTestMode: %v", err)
		}
		if w.getCall != 0 || w.applied {
			t.Error("continuing a deleted fixture must not read, write, or resurrect its tombstone")
		}
		if got.Tracking.Status != domain.StatusOutForDelivery {
			t.Errorf("status = %q, want OUT_FOR_DELIVERY", got.Tracking.Status)
		}
		if len(got.History) != 2 || got.History[1].Status != domain.StatusOutForDelivery {
			t.Fatalf("history = %+v, want the synthetic transition appended", got.History)
		}
		if len(pub.calls) != 1 {
			t.Fatalf("published = %d, want exactly 1", len(pub.calls))
		}
		if pub.calls[0].previous != string(domain.StatusShipped) {
			t.Errorf("previous_status = %q, want SHIPPED", pub.calls[0].previous)
		}
		if pub.calls[0].actor != audit.TestModeProgression {
			t.Errorf("actor = %q, want TestMode progression", pub.calls[0].actor)
		}
	})

	t.Run("a persistence failure propagates and publishes nothing", func(t *testing.T) {
		boom := errors.New("mysql: deadlock found")
		w := &stubStatusWriter{
			current:  domain.Tracking{OrderID: "ord_1", Status: domain.StatusPlaced},
			applyErr: boom,
		}
		pub := &recordingPublisher{}
		inv := &stubInvalidator{}
		uc := app.NewUpdateStatus(w, pub, inv, fixedClock(now))

		if _, err := uc.Execute(context.Background(), "ord_1", domain.StatusShipped, ""); !errors.Is(err, boom) {
			t.Fatalf("err = %v, want the underlying persistence error", err)
		}
		if len(pub.calls) != 0 {
			t.Error("the write failed but an event announced it anyway")
		}
		if inv.called {
			t.Error("the write failed but the cache was cleared anyway")
		}
	})

	t.Run("a publisher panic never fails the transition", func(t *testing.T) {
		w := &stubStatusWriter{current: domain.Tracking{
			OrderID: "ord_1", UserID: "usr_1", CognitoSub: "sub-1",
			Status: domain.StatusPlaced,
		}}
		inv := &stubInvalidator{}
		uc := app.NewUpdateStatus(w, panickingPublisher{}, inv, fixedClock(now))

		got, err := uc.Execute(context.Background(), "ord_1", domain.StatusProcessing, "")
		if err != nil {
			t.Fatalf("a notification failure broke the write: %v", err)
		}
		if got.Tracking.Status != domain.StatusProcessing {
			t.Error("the transition did not land")
		}
		if !inv.called {
			t.Error("a publisher failure skipped the invalidation that follows it; " +
				"the cache would serve the superseded status for a full TTL")
		}
	})

	t.Run("an invalidator panic never fails the transition either", func(t *testing.T) {
		w := &stubStatusWriter{current: domain.Tracking{
			OrderID: "ord_1", UserID: "usr_1", CognitoSub: "sub-1",
			Status: domain.StatusPlaced,
		}}
		uc := app.NewUpdateStatus(w, &recordingPublisher{}, panickingInvalidator{}, fixedClock(now))

		if _, err := uc.Execute(context.Background(), "ord_1", domain.StatusProcessing, ""); err != nil {
			t.Fatalf("a cache failure broke a committed write: %v", err)
		}
	})

	t.Run("invalidation reads its identities off the PERSISTED row", func(t *testing.T) {
		// The carrier request carries no identity at all, so the row is the only
		// possible source. Two DIFFERENT values, so swapping them fails.
		w := &stubStatusWriter{current: domain.Tracking{
			ID: "trk_1", OrderID: "ord_1", UserID: "usr_persisted",
			CognitoSub: "sub-persisted", Status: domain.StatusPlaced,
		}}
		inv := &stubInvalidator{writer: w}
		uc := app.NewUpdateStatus(w, &recordingPublisher{}, inv, fixedClock(now))
		if _, err := uc.Execute(context.Background(), "ord_1", domain.StatusProcessing, ""); err != nil {
			t.Fatal(err)
		}
		if inv.cognitoSub != "sub-persisted" || inv.userID != "usr_persisted" {
			t.Errorf("invalidated with sub=%q user=%q, want the persisted row's values",
				inv.cognitoSub, inv.userID)
		}
		if inv.orderID != "ord_1" {
			t.Errorf("invalidated order %q, want ord_1", inv.orderID)
		}
		if inv.calledBeforeCommit {
			t.Error("the cache was cleared before the commit — a concurrent read " +
				"would repopulate it with the pre-update row for a full TTL")
		}
	})

	t.Run("the default clock truncates to whole UTC seconds", func(t *testing.T) {
		// MySQL DATETIME here has fsp 0 and ROUNDS fractional seconds rather than
		// truncating them, so a sub-second now can land on the NEXT second.
		w := &stubStatusWriter{current: domain.Tracking{
			OrderID: "ord_1", Status: domain.StatusPlaced,
		}}
		uc := app.NewUpdateStatus(w, &recordingPublisher{}, &stubInvalidator{}, nil)
		if _, err := uc.Execute(context.Background(), "ord_1", domain.StatusShipped, ""); err != nil {
			t.Fatal(err)
		}
		if w.appliedNow.Nanosecond() != 0 {
			t.Errorf("now = %v, want whole seconds", w.appliedNow)
		}
		if w.appliedNow.Location() != time.UTC {
			t.Errorf("now is in %v, want UTC", w.appliedNow.Location())
		}
	})

	t.Run("the transition function is what Wave 2.5 consumes, unchanged", func(t *testing.T) {
		// Execute's signature IS the contract with the TestMode progression.
		// Task 24 declares a Transitioner interface with exactly this method; if
		// it drifts, the progression grows a second transition path and the two
		// begin disagreeing about what a transition means.
		var _ interface {
			Execute(ctx context.Context, orderID string, requested domain.Status, actor audit.Actor) (domain.TrackingWithHistory, error)
		} = app.NewUpdateStatus(&stubStatusWriter{}, &recordingPublisher{}, &stubInvalidator{}, fixedClock(now))
	})
}
