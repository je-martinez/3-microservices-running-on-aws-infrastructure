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
	count     int64
	err       error
	called    bool
	tag       string
	secondTag string
	actor     audit.Actor
	now       time.Time
}

// Records what the use case asked for, so a test can assert the SCOPE and not
// merely that a delete happened.
func (s *stubTagDeleter) SoftDeleteByTags(
	ctx context.Context, tag, secondTag string, actor audit.Actor, now time.Time,
) (int64, error) {
	s.secondTag = secondTag
	return s.SoftDeleteByTag(ctx, tag, actor, now)
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

// The scoping contract, which is the whole point of the change: a teardown must
// delete ITS OWN run's fixtures and leave every other run's alive.
//
// Why it matters beyond tidiness: the unscoped sweep deletes every E2E-tagged
// tracking on the machine, so with parallel workers one run's teardown lands
// inside another's live TestMode progression. That progression's next tick reads
// tracking_not_found and ABORTS, and its remaining statuses are never published
// — the events never exist, which is why the failure looked like a lost message
// for as long as it did.
func TestExecuteScopedPassesTheRunTagThrough(t *testing.T) {
	deleter := &stubTagDeleter{count: 3}
	uc := app.NewE2ECleanup(deleter, func() time.Time { return time.Unix(0, 0).UTC() })

	if _, err := uc.ExecuteScoped(context.Background(), "E2E Run run_abc"); err != nil {
		t.Fatalf("ExecuteScoped returned %v", err)
	}
	if deleter.secondTag != "E2E Run run_abc" {
		t.Errorf("second tag = %q, want the run tag — an unscoped delete here would "+
			"take out other runs' rows", deleter.secondTag)
	}
	if deleter.tag != domain.E2ESourceTag {
		t.Errorf("first tag = %q, want %q", deleter.tag, domain.E2ESourceTag)
	}
}

// Backward compatibility, and it is load-bearing: the load tests and any manual
// teardown call this route with no run id and expect the old sweep. Deleting
// nothing while reporting success would be the worse failure.
func TestExecuteIsStillUnscoped(t *testing.T) {
	deleter := &stubTagDeleter{count: 7}
	uc := app.NewE2ECleanup(deleter, func() time.Time { return time.Unix(0, 0).UTC() })

	count, err := uc.Execute(context.Background())
	if err != nil {
		t.Fatalf("Execute returned %v", err)
	}
	if deleter.secondTag != "" {
		t.Errorf("second tag = %q, want empty — Execute must not scope", deleter.secondTag)
	}
	if count != 7 {
		t.Errorf("count = %d, want 7", count)
	}
}
