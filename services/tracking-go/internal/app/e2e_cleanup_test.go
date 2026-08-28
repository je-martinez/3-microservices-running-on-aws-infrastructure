package app_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

type stubTagDeleter struct {
	count  int64
	err    error
	called bool
	tag    string
	actor  audit.Actor
	now    time.Time
}

func (s *stubTagDeleter) SoftDeleteByTag(
	_ context.Context, tag string, actor audit.Actor, now time.Time,
) (int64, error) {
	s.called = true
	s.tag, s.actor, s.now = tag, actor, now
	return s.count, s.err
}

func TestE2ECleanup(t *testing.T) {
	now := time.Date(2026, 8, 27, 16, 0, 0, 0, time.UTC)

	// The tag is the ONLY thing standing between this unauthenticated teardown
	// and a real user's data, and it must be the exact literal Users' teardown
	// also selects on. A near-miss ("e2e-source") would clean up nothing while
	// looking perfectly correct.
	t.Run("selects on the exact E2E Source tag with the harness's own actor", func(t *testing.T) {
		d := &stubTagDeleter{count: 7}
		uc := app.NewE2ECleanup(d, fixedClock(now))

		got, err := uc.Execute(context.Background())
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if got != 7 {
			t.Errorf("deleted = %d, want 7", got)
		}
		if d.tag != "E2E Source" {
			t.Errorf("tag = %q, want the exact literal %q", d.tag, "E2E Source")
		}
		if d.tag != domain.E2ESourceTag {
			t.Errorf("tag = %q, want domain.E2ESourceTag", d.tag)
		}
		// The harness, not any caller identity: a row swept by the test harness
		// must stay distinguishable from one a real flow removed.
		if d.actor != audit.E2ECleanup {
			t.Errorf("actor = %q, want tracking_api:e2e_cleanup", d.actor)
		}
		if !d.now.Equal(now) {
			t.Errorf("now = %s, want %s", d.now, now)
		}
	})

	// Idempotent. A teardown re-run is a success, not a failure: "no tagged
	// trackings remain" is the state the caller asked for whether this call
	// stamped ten rows or zero.
	t.Run("zero matches is not an error", func(t *testing.T) {
		uc := app.NewE2ECleanup(&stubTagDeleter{count: 0}, fixedClock(now))

		got, err := uc.Execute(context.Background())
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if got != 0 {
			t.Errorf("deleted = %d, want 0", got)
		}
	})

	t.Run("a db error propagates untouched", func(t *testing.T) {
		boom := errors.New("mysql: gone away")
		uc := app.NewE2ECleanup(&stubTagDeleter{err: boom}, fixedClock(now))
		if _, err := uc.Execute(context.Background()); !errors.Is(err, boom) {
			t.Fatalf("err = %v, want the underlying error", err)
		}
	})
}
