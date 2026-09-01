package app_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// stubUserDeleter records what reached the row-selection point, so a test can
// assert both the arguments and — through called — that an invalid request never
// got there at all.
type stubUserDeleter struct {
	count  int64
	err    error
	called bool
	sub    string
	userID string
	actor  audit.Actor
	now    time.Time
	// writeSeq is the ordinal of this write against the shared counter the
	// invalidator also stamps, which is how "after the write" is proven rather
	// than assumed.
	writeSeq int
	seq      *int
}

func (s *stubUserDeleter) SoftDeleteByUser(
	_ context.Context, cognitoSub, userID string, actor audit.Actor, now time.Time,
) (int64, error) {
	s.called = true
	s.sub, s.userID, s.actor, s.now = cognitoSub, userID, actor, now
	if s.seq != nil {
		*s.seq++
		s.writeSeq = *s.seq
	}
	return s.count, s.err
}

type stubUserInvalidator struct {
	called bool
	sub    string
	userID string
	// calledBeforeWrite is true when this ran without the deleter having run
	// first — the ordering the design forbids, because evicting before the
	// commit reopens the stale-repopulation window.
	calledBeforeWrite bool
	deleter           *stubUserDeleter
	seq               *int
}

func (s *stubUserInvalidator) InvalidateUser(_ context.Context, cognitoSub, userID string) {
	s.called = true
	s.sub, s.userID = cognitoSub, userID
	if s.deleter != nil {
		s.calledBeforeWrite = !s.deleter.called
	}
	if s.seq != nil {
		*s.seq++
	}
}

func TestDeleteByUser(t *testing.T) {
	now := time.Date(2026, 8, 27, 16, 0, 0, 0, time.UTC)

	t.Run("returns the parent rowcount and invalidates after the write", func(t *testing.T) {
		seq := 0
		d := &stubUserDeleter{count: 3, seq: &seq}
		inv := &stubUserInvalidator{deleter: d, seq: &seq}
		uc := app.NewDeleteByUser(d, inv, fixedClock(now))

		got, err := uc.Execute(context.Background(), "sub-1", "usr_1")
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if got != 3 {
			t.Errorf("deleted = %d, want 3", got)
		}
		if d.actor != audit.DeleteByUser {
			t.Errorf("actor = %q, want tracking_api:delete_by_user", d.actor)
		}
		if !inv.called || inv.calledBeforeWrite {
			t.Error("the cache must be invalidated, and only after the write")
		}
		if d.writeSeq != 1 {
			t.Errorf("the write ran at position %d, want 1 — the eviction must "+
				"follow it, never precede the commit", d.writeSeq)
		}
	})

	// The identities the invalidator sweeps must be the SAME pair the rows were
	// selected by. Sweeping a different pair evicts keys nobody wrote while the
	// deleted user's entries serve their full TTL — verified live in Orders,
	// which has the identical design.
	t.Run("the invalidation sweeps the identities the rows were selected by", func(t *testing.T) {
		d := &stubUserDeleter{count: 1}
		inv := &stubUserInvalidator{deleter: d}
		uc := app.NewDeleteByUser(d, inv, fixedClock(now))

		if _, err := uc.Execute(context.Background(), "sub-1", "usr_1"); err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if d.sub != "sub-1" || d.userID != "usr_1" {
			t.Errorf("selected by (%q,%q), want (sub-1, usr_1)", d.sub, d.userID)
		}
		if inv.sub != "sub-1" || inv.userID != "usr_1" {
			t.Errorf("invalidated (%q,%q), want (sub-1, usr_1)", inv.sub, inv.userID)
		}
	})

	// One minted `now`, from the injected clock. MySQL DATETIME here has fsp 0
	// and ROUNDS rather than truncates, so a second time.Now() inside the
	// repository could land on a different second than the one the use case
	// reported.
	t.Run("stamps from the injected clock, never its own time.Now", func(t *testing.T) {
		d := &stubUserDeleter{count: 1}
		uc := app.NewDeleteByUser(d, &stubUserInvalidator{deleter: d}, fixedClock(now))

		if _, err := uc.Execute(context.Background(), "sub-1", "usr_1"); err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if !d.now.Equal(now) {
			t.Errorf("now = %s, want %s", d.now, now)
		}
	})

	t.Run("an empty identity is refused at the row-selection point too", func(t *testing.T) {
		// The HTTP boundary already 422s these, but this use case is public and a
		// future caller reaching it another way must not be able to widen the
		// blast radius: the predicate is an OR, so an empty value matches every
		// row carrying an empty string in that column.
		for _, tc := range []struct{ sub, user string }{
			{"", "usr_1"}, {"sub-1", ""}, {"", ""},
		} {
			d := &stubUserDeleter{}
			inv := &stubUserInvalidator{deleter: d}
			uc := app.NewDeleteByUser(d, inv, fixedClock(now))
			if _, err := uc.Execute(context.Background(), tc.sub, tc.user); !errors.Is(err, app.ErrEmptyIdentity) {
				t.Errorf("Execute(%q,%q) err = %v, want ErrEmptyIdentity", tc.sub, tc.user, err)
			}
			if d.called {
				t.Errorf("Execute(%q,%q) reached the database", tc.sub, tc.user)
			}
			// Nothing was deleted, so nothing may be evicted either.
			if inv.called {
				t.Errorf("Execute(%q,%q) evicted the cache for a deletion that never happened", tc.sub, tc.user)
			}
		}
	})

	t.Run("a db error propagates untouched", func(t *testing.T) {
		boom := errors.New("mysql: gone away")
		d := &stubUserDeleter{err: boom}
		inv := &stubUserInvalidator{deleter: d}
		uc := app.NewDeleteByUser(d, inv, fixedClock(now))
		if _, err := uc.Execute(context.Background(), "sub-1", "usr_1"); !errors.Is(err, boom) {
			t.Fatalf("err = %v, want the underlying error", err)
		}
		// The write did not land, so the eviction must not be scheduled: a
		// deletion that never happened has no cache footprint to clear, and
		// evicting anyway would report a cascade that did not occur.
		if inv.called {
			t.Error("the cache was evicted for a failed deletion")
		}
	})

	// The deletion has already COMMITTED by the time the eviction runs, so a
	// Redis outage must not fail the response: telling Users the cascade did not
	// happen when it did fails the whole account deletion for the person.
	t.Run("a panicking invalidator never fails the response", func(t *testing.T) {
		d := &stubUserDeleter{count: 2}
		uc := app.NewDeleteByUser(d, panickingUserInvalidator{}, fixedClock(now))

		got, err := uc.Execute(context.Background(), "sub-1", "usr_1")
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if got != 2 {
			t.Errorf("deleted = %d, want 2 — the committed count must still be reported", got)
		}
	})
}

type panickingUserInvalidator struct{}

func (panickingUserInvalidator) InvalidateUser(context.Context, string, string) {
	panic("redis is down")
}
