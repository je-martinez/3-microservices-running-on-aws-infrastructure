// Package notify adapts the post-commit side effects of a status transition —
// the SQS event and the cache invalidation — to the narrow ports internal/app
// declares. Its own package because neither is a transport concern: TestMode
// runs the same transition with no HTTP request behind it.
package notify

import (
	"context"
	"log/slog"

	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/sqs"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// CONTRACT: These adapters stay in the ADAPTER layer, never internal/app. A port
// is declared by its consumer, so the use case must not learn the shape of an
// SQS envelope or a Redis gateway — that is what keeps app.EventPublisher and
// app.CacheInvalidator error-free interfaces a test satisfies in three lines.
// See [[screaming-architecture]]

// StatusEventPublisher adapts the SQS publisher to app.EventPublisher.
//
// It assembles sqs.StatusChanged from the PERSISTED entity. Every subject-side
// field comes off the row rather than off the request, because the carrier
// webhook carries no caller identity at all — there is nowhere else to get them.
type StatusEventPublisher struct {
	publisher sqs.Publisher
}

// NewStatusEventPublisher wires the adapter.
func NewStatusEventPublisher(publisher sqs.Publisher) *StatusEventPublisher {
	return &StatusEventPublisher{publisher: publisher}
}

// PublishTrackingStatusChanged emits one transition and NEVER returns an error —
// the transition is already committed, and a failure here must not fail a write
// that succeeded.
func (p *StatusEventPublisher) PublishTrackingStatusChanged(
	ctx context.Context, t domain.TrackingWithHistory, previousStatus string, actor audit.Actor,
) {
	if p.publisher == nil {
		return
	}

	// The history travels as (status, datetime) pairs only. The other columns are
	// identical across every row and already present at the envelope root, and
	// cognito_sub in particular is an ownership key with no business appearing
	// five times inside a payload.
	history := make([]sqs.HistoryEntry, 0, len(t.History))
	for _, entry := range t.History {
		history = append(history, sqs.HistoryEntry{
			Status:   string(entry.Status),
			Datetime: entry.Datetime,
		})
	}

	p.publisher.PublishTrackingStatusChanged(ctx, sqs.StatusChanged{
		OrderID: t.Tracking.OrderID,
		// The customer-facing label, mirrored from Orders onto our row so the
		// status emails can print it — the pipeline cannot look it up. "" when the
		// order has none, and the publisher then omits the key.
		// See [[friendly-order-number]]
		OrderNumber: t.Tracking.OrderNumber,
		// The event's SUBJECT — the order's owner. Travels at the envelope root,
		// never inside author.
		UserID:         t.Tracking.UserID,
		Status:         string(t.Tracking.Status),
		PreviousStatus: previousStatus,
		TrackingNumber: t.Tracking.TrackingNumber,
		// The TRANSITION's own timestamp, not updated_at, which moves on any
		// write.
		ChangedAt: t.Tracking.Datetime,
		// CONTRACT: Forward BYTE-FOR-BYTE, with no conversion here. Narrowing to
		// *string re-encodes the object as a JSON string, which the pipeline's
		// z.record rejects as a PermanentError — the record is consumed and the
		// email and push are lost while this service logs success. The publisher
		// owns the omit-vs-null decision. See [[events-pipeline-design]]
		ShippingAddress: t.Tracking.ShippingAddress,
		History:         history,
		// Threaded down from the use case, never chosen here: this publisher
		// serves both the carrier webhook and TestMode progression, and a
		// constant would relabel every automatic run as a real carrier update.
		Actor: actor,
		// Off the PERSISTED ROW. It becomes author.cognito_sub, which the
		// pipeline routes the realtime push by — handing that index a usr_ id
		// returns an empty list with no error, so the push would reach nobody.
		CognitoSub: t.Tracking.CognitoSub,
	})
}

// TrackingCacheInvalidator adapts the Redis invalidation to
// app.CacheInvalidator.
type TrackingCacheInvalidator struct {
	gateway cache.Gateway
	log     *slog.Logger
}

// NewTrackingCacheInvalidator wires the adapter. Pass cache.NewNullGateway() when
// CACHE_ENABLED is false — a null object rather than a flag, so the write path
// has exactly one branch-free shape.
func NewTrackingCacheInvalidator(gateway cache.Gateway, log *slog.Logger) *TrackingCacheInvalidator {
	if log == nil {
		log = slog.Default()
	}
	return &TrackingCacheInvalidator{gateway: gateway, log: log}
}

// InvalidateTracking clears everything a status change could have made stale. It
// returns nothing: the transition has already committed, so a Redis outage must
// not turn a successful write into a 500 the carrier would then retry.
func (i *TrackingCacheInvalidator) InvalidateTracking(ctx context.Context, orderID, cognitoSub, userID string) {
	if i.gateway == nil {
		return
	}
	cache.InvalidateTracking(ctx, i.gateway, i.log, orderID, cognitoSub, userID)
}
