package app

import (
	"context"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// TagSoftDeleter is the E2E teardown's port, unscoped by identity because the
// teardown runs once globally with no user session.
//
// CONTRACT: The scoping lives elsewhere and BOTH halves are required — a row is
// tagged only under x-e2e-source AND E2E_TESTING_ENABLED, and this route does
// not exist without that flag. A real user's rows are untagged.
// See [[testing]]
type TagSoftDeleter interface {
	SoftDeleteByTag(ctx context.Context, tag string, actor audit.Actor, now time.Time) (int64, error)
	// SoftDeleteByTags requires BOTH tags. An empty secondTag means "no scope"
	// and must behave exactly like SoftDeleteByTag.
	SoftDeleteByTags(ctx context.Context, tag, secondTag string, actor audit.Actor, now time.Time) (int64, error)
}

// E2ECleanup is the E2E suite's teardown.
type E2ECleanup struct {
	deleter TagSoftDeleter
	clock   func() time.Time
}

// NewE2ECleanup wires the use case. The nil-clock fallback mints the same
// whole-second UTC timestamp every write path in this service uses.
func NewE2ECleanup(deleter TagSoftDeleter, clock func() time.Time) *E2ECleanup {
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC().Truncate(time.Second) }
	}
	return &E2ECleanup{deleter: deleter, clock: clock}
}

// Execute soft-deletes every live tracking carrying the E2E Source tag. It is
// idempotent, and the count reaches the client so a teardown matching nothing
// shows in the harness's output.
//
// CONTRACT: The tag comes from the domain constant, never a literal here — a
// near-miss cleans up nothing while looking correct.
func (uc *E2ECleanup) Execute(ctx context.Context) (int64, error) {
	return uc.ExecuteScoped(ctx, "")
}

// ExecuteScoped soft-deletes the E2E rows of ONE run. An empty runTag deletes
// every E2E row, which is Execute's behaviour.
//
// CONTRACT: Scope a parallel run's teardown. The unscoped sweep deletes every
// E2E-tagged tracking on the machine, so one teardown lands inside another run's
// live progression, whose next tick reads tracking_not_found and aborts —
// the remaining statuses never publish, which reads as a lost message.
// See [[2026-08-30-a-global-teardown-cannot-be-scoped]]
func (uc *E2ECleanup) ExecuteScoped(ctx context.Context, runTag string) (int64, error) {
	return uc.deleter.SoftDeleteByTags(ctx, domain.E2ESourceTag, runTag, audit.E2ECleanup, uc.clock())
}
