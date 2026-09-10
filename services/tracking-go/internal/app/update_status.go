package app

import (
	"context"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// StatusWriter is this use case's own narrow port, declared here by its consumer.
//
// CONTRACT: GetByOrderID is UNSCOPED and a DIFFERENT method from the reads'
// GetByOrderIDScoped, never one method with an empty scope argument. This
// endpoint has no caller identity — the gateway route carries no authorizer — so
// the ownership filter would 404 every carrier call. And Go's zero string is "",
// so an optional argument silently means "scoped to the empty string".
// See [[user-id-vs-cognito-sub-ownership-key]]
type StatusWriter interface {
	GetByOrderID(ctx context.Context, orderID string) (domain.Tracking, error)

	// CONTRACT: ApplyTransition updates the parent, appends the history row and
	// RE-READS the history in one transaction, stamped from `now`. The re-read
	// is this method's job, not the caller's — a caller holding a pre-append
	// slice cannot know it is stale, and the returned value is both the 200 body
	// and the published event.
	ApplyTransition(ctx context.Context, t domain.Tracking, to domain.Status, actor audit.Actor, now time.Time) (domain.TrackingWithHistory, error)
}

// CONTRACT: EventPublisher returns no error, so a notification failure cannot
// fail a committed write. The actor is a PARAMETER, never a constant inside the
// publisher — a hardcoded one relabels automatic progressions as carrier
// updates. See [[audit-fields]]
type EventPublisher interface {
	PublishTrackingStatusChanged(ctx context.Context, t domain.TrackingWithHistory, previousStatus string, actor audit.Actor)
}

// CacheInvalidator clears a tracking's cache entries. Also returns nothing: a
// cache is an optimization, and an optimization that can fail a request is a
// liability.
type CacheInvalidator interface {
	InvalidateTracking(ctx context.Context, orderID, cognitoSub, userID string)
}

// UpdateStatus is the SINGLE write path behind BOTH the carrier PUT and TestMode
// progression. The ONLY thing that differs between its two callers is the actor.
type UpdateStatus struct {
	writer      StatusWriter
	publisher   EventPublisher
	invalidator CacheInvalidator
	clock       func() time.Time
}

// NewUpdateStatus wires the transition. A nil clock takes the production one.
func NewUpdateStatus(
	writer StatusWriter,
	publisher EventPublisher,
	invalidator CacheInvalidator,
	clock func() time.Time,
) *UpdateStatus {
	if clock == nil {
		// UTC and TRUNCATED to whole seconds. The DATETIME columns here have
		// fsp 0 and MySQL ROUNDS fractional seconds rather than truncating them,
		// so an untruncated 15:00:00.7 persists as 15:00:01 — one second ahead of
		// the value the response and the event report.
		clock = func() time.Time { return time.Now().UTC().Truncate(time.Second) }
	}
	return &UpdateStatus{
		writer:      writer,
		publisher:   publisher,
		invalidator: invalidator,
		clock:       clock,
	}
}

// Execute advances a tracking to `requested`, appending the transition to its
// history. `actor` is the ONLY difference between its two callers; everything
// else is shared so the two cannot disagree on what a transition means.
//
// CONTRACT: The step order is load-bearing. 1) Find UNSCOPED by order_id.
// 2) Guard; a rejection writes NOTHING and carries its reason. 3) Persist parent
// and history in one unit of work, then RE-READ. 4) Only after the commit,
// publish then invalidate. Steps 1 and 2 stay separate so a rejection is never
// confused with a missing tracking. See [[tracking-service-design]]
func (uc *UpdateStatus) Execute(
	ctx context.Context, orderID string, requested domain.Status, actor audit.Actor,
) (domain.TrackingWithHistory, error) {
	if actor == "" {
		actor = audit.CarrierStatusUpdate
	}

	tracking, err := uc.writer.GetByOrderID(ctx, orderID)
	if err != nil {
		return domain.TrackingWithHistory{}, err
	}

	// Captured BEFORE the write: the row's status is already the new one by the
	// time the event is built, so previous_status cannot be read off the entity.
	previous := tracking.Status

	if err := domain.AssertCanTransition(previous, requested); err != nil {
		return domain.TrackingWithHistory{}, err
	}

	now := uc.clock()

	// ApplyTransition commits, and the re-read of the history happens INSIDE it —
	// so the returned slice contains the transition being announced rather than
	// the stale pre-update list. The Python expires that collection for exactly
	// this reason: the carrier PUT once reported the NEW status alongside a
	// history that did not contain it.
	updated, err := uc.writer.ApplyTransition(ctx, tracking, requested, actor, now)
	if err != nil {
		return domain.TrackingWithHistory{}, err
	}

	// CONTRACT: Both of these run AFTER the commit and cannot fail the request.
	// Invalidating first opens a window where a concurrent read misses, sees the
	// pre-update row, and writes that stale body back under the key just
	// cleared — serving a superseded status for a full TTL. Identities come off
	// the PERSISTED ROW; the carrier sends none. See [[x-cache-response-header]]
	uc.publish(ctx, updated, string(previous), actor)
	uc.invalidate(ctx, updated)

	return updated, nil
}

// ContinueDeletedTestMode publishes one remaining TestMode transition after E2E
// cleanup has soft-deleted the tracking mid-run.
//
// CONTRACT: This is NOT a persistence path — the tombstone stays untouched and
// no live history row is recreated. It advances the last committed snapshot the
// progression captured, keeping the event chain complete for the fixture while
// soft-delete semantics hold. See [[soft-delete]]
func (uc *UpdateStatus) ContinueDeletedTestMode(
	ctx context.Context,
	current domain.TrackingWithHistory,
	requested domain.Status,
) (domain.TrackingWithHistory, error) {
	previous := current.Tracking.Status
	if err := domain.AssertCanTransition(previous, requested); err != nil {
		return domain.TrackingWithHistory{}, err
	}

	now := uc.clock()
	updatedTracking := current.Tracking
	updatedTracking.Status = requested
	updatedTracking.Datetime = now
	updatedTracking.UpdatedBy = string(audit.TestModeProgression)
	updatedTracking.UpdatedAt = now

	history := make([]domain.TrackingHistory, 0, len(current.History)+1)
	history = append(history, current.History...)
	history = append(history, domain.TrackingHistory{
		TrackingID: current.Tracking.ID,
		Status:     requested,
		UserID:     current.Tracking.UserID,
		OrderID:    current.Tracking.OrderID,
		CognitoSub: current.Tracking.CognitoSub,
		Datetime:   now,
		CreatedBy:  string(audit.TestModeProgression),
		CreatedAt:  now,
		UpdatedBy:  string(audit.TestModeProgression),
		UpdatedAt:  now,
	})
	updatedTracking.History = history
	updated := domain.TrackingWithHistory{
		Tracking: updatedTracking,
		History:  history,
	}

	uc.publish(ctx, updated, string(previous), audit.TestModeProgression)
	return updated, nil
}

// publish is best-effort and swallows everything, panics included.
//
// CONTRACT: A notification must not break the committed write it describes. A
// 500 makes the carrier retry a change we recorded, which the forward-only
// guard rejects as 400 — a permanent-looking failure for something that
// succeeded. See [[events-pipeline-design]]
func (uc *UpdateStatus) publish(
	ctx context.Context, t domain.TrackingWithHistory, previous string, actor audit.Actor,
) {
	defer func() {
		// Deliberately swallowed, not re-raised and not logged here: the
		// publisher owns its own failure logging with a machine-readable reason,
		// and this use case has no logger by design (it is transport-free).
		_ = recover()
	}()
	if uc.publisher == nil {
		return
	}
	uc.publisher.PublishTrackingStatusChanged(ctx, t, previous, actor)
}

// invalidate is the second best-effort step, and it is DELIBERATELY separate
// from publish rather than sharing one recover: a publisher panic must not skip
// the invalidation that follows it, or a Users outage would leave the cache
// serving the superseded status for a full TTL.
func (uc *UpdateStatus) invalidate(ctx context.Context, t domain.TrackingWithHistory) {
	defer func() { _ = recover() }()
	if uc.invalidator == nil {
		return
	}
	uc.invalidator.InvalidateTracking(ctx,
		t.Tracking.OrderID, t.Tracking.CognitoSub, t.Tracking.UserID)
}
