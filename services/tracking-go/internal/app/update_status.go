package app

import (
	"context"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// StatusWriter is this use case's own narrow port, declared here by its consumer
// rather than in a shared repository interface.
//
// # GetByOrderID is the UNSCOPED read, and that is structural
//
// It is a DIFFERENT METHOD from the reads' GetByOrderIDScoped, never the same
// method with an empty scope argument. This endpoint has no caller identity to
// scope by: its gateway route carries no Cognito authorizer, so no x-user-id ever
// reaches the service, and the carrier is a third party with no account here.
// Reusing the reads' ownership filter would compare a Cognito sub that was never
// sent against every row and 404 EVERY carrier call — the endpoint would look
// implemented and never once work.
//
// The optional-parameter shape is barred for a second reason: Go's zero value for
// string is "", not nil, so `GetByOrderID(ctx, orderID, sub)` called with no sub
// would silently mean "scoped to the empty string" rather than "unscoped". Two
// methods cannot be confused this way.
type StatusWriter interface {
	GetByOrderID(ctx context.Context, orderID string) (domain.Tracking, error)

	// ApplyTransition updates the parent, appends the history row, and RE-READS
	// the history — all in one transaction, all stamped from `now`.
	//
	// The re-read is part of THIS method's contract rather than a caller's
	// responsibility, because a caller holding a pre-append slice has no way to
	// know it is stale. The value returned is the one that is both rendered as
	// the 200 body and embedded in the published event.
	ApplyTransition(ctx context.Context, t domain.Tracking, to domain.Status, actor audit.Actor, now time.Time) (domain.TrackingWithHistory, error)
}

// EventPublisher is best-effort by CONTRACT, not by accident: it returns no error
// at all, so a notification failure is structurally incapable of failing a write
// that has already committed.
//
// The actor is a PARAMETER rather than a constant chosen inside the publisher.
// This use case serves both the carrier webhook and TestMode progression, and a
// hardcoded actor would relabel every automatic progression as a real carrier
// update in the envelope the pipeline receives.
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
// history.
//
// `actor` is the ONLY thing that differs between this function's two callers: the
// carrier PUT passes the zero value and takes the default below, and TestMode
// progression passes audit.TestModeProgression so an automatic run stays
// identifiable from tracking_history.created_by after the fact. Everything else —
// the lookup, the guards, the persistence, the emission, the invalidation — is
// deliberately shared. A second implementation for the automatic path is how the
// two would start disagreeing about what a transition means.
//
// The order is load-bearing:
//
//  1. Find the tracking, UNSCOPED, by order_id alone. Missing -> ErrTrackingNotFound.
//  2. Guard the transition. A rejection carries its machine-readable reason and
//     NOTHING is written.
//  3. Persist: update the parent and append the history row in one unit of work,
//     both stamped from one `now`, then RE-READ the history.
//  4. Only AFTER the commit: publish, then invalidate.
//
// Steps 1 and 2 are separate so a rejected transition on an existing tracking is
// never confused with a missing one — different causes, different status codes.
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

	// Everything below is AFTER the commit and cannot fail the request.
	//
	// Both read their identities off the PERSISTED ROW: the carrier sends no
	// caller identity at all, so the row is the only possible source. And both
	// must run after the commit — clearing the cache first opens the window where
	// a concurrent read misses, sees the pre-update row (its transaction cannot
	// see an uncommitted change), and writes that stale body back under the key
	// just cleared, serving a superseded status for a full 60s TTL. Invalidating
	// before the write lands is worse than not invalidating, because it looks
	// correct.
	uc.publish(ctx, updated, string(previous), actor)
	uc.invalidate(ctx, updated)

	return updated, nil
}

// publish is best-effort and swallows everything, panics included. A notification
// must not break the write that caused it: the transition is already committed,
// and a 500 would make the carrier retry a status change we actually recorded —
// which the forward-only guard then rejects as a 400, so the carrier would see a
// permanent-looking failure for something that succeeded.
//
// The recover() guards the layer BENEATH the publisher's own reason-logged
// failures: obtaining or calling it at all.
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
