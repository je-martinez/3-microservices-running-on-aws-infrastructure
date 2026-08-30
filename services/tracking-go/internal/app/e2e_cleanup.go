package app

import (
	"context"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// TagSoftDeleter is the E2E teardown's port. It is unscoped by any identity, and
// that is the design: the harness's teardown runs once, globally, with no user
// session, so a route requiring a caller would 401 its only real caller.
//
// The safety that scoping would have provided moved rather than disappeared — a
// row is tagged only when the request sent x-e2e-source AND E2E_TESTING_ENABLED
// was on, and this route does not exist unless that same flag is on. Every row a
// real user created is untagged and therefore untouchable here.
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

// Execute soft-deletes every live tracking carrying the E2E Source tag.
//
// The tag comes from the domain constant, never a literal spelled here: Users'
// teardown selects on the same string, and a near-miss would clean up nothing
// while looking perfectly correct.
//
// Idempotent: a second call stamps nothing and returns 0, which is a success. The
// count travels to the client so a teardown that quietly matched nothing is
// visible in the harness's own output rather than only in this service's logs.
func (uc *E2ECleanup) Execute(ctx context.Context) (int64, error) {
	return uc.ExecuteScoped(ctx, "")
}

// ExecuteScoped soft-deletes the E2E rows belonging to ONE run.
//
// An empty runTag deletes every E2E row, which is Execute's behaviour and the
// contract the load tests and manual teardown rely on.
//
// Scoping exists because the unscoped sweep is destructive to CONCURRENT work,
// not because the rows are precious: it deletes every E2E-tagged tracking on the
// machine, so with parallel or overlapping suite runs one teardown lands inside
// another run's live TestMode progression. That progression's next tick reads
// tracking_not_found and aborts, and its remaining statuses are never published
// — the events never exist, which is why the resulting failure looks like a lost
// message rather than a deleted row.
func (uc *E2ECleanup) ExecuteScoped(ctx context.Context, runTag string) (int64, error) {
	return uc.deleter.SoftDeleteByTags(ctx, domain.E2ESourceTag, runTag, audit.E2ECleanup, uc.clock())
}
