// Package notify adapts the post-commit side effects of a status transition —
// the SQS event and the cache invalidation — to the narrow ports
// internal/app declares for them.
//
// It is its own package rather than part of internal/adapter/http because
// NEITHER side effect is a transport concern of the carrier webhook: TestMode
// progression runs the same transition with no HTTP request behind it at all,
// and would otherwise have to import the HTTP adapter to publish an event.
package notify

import (
	"context"
	"log/slog"

	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/sqs"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// The two adapters below sit between the use case's narrow ports and the
// concrete publisher and cache gateway.
//
// They live in the ADAPTER layer, never in internal/app: a port is declared by
// its consumer and kept to what that consumer needs, so the use case must not
// learn the shape of an SQS envelope or of a Redis gateway to be wired to them.
// Both are also the reason app.EventPublisher and app.CacheInvalidator can stay
// two-argument, error-free interfaces that a test satisfies in three lines.

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
		// The event's SUBJECT — the order's owner. Travels at the envelope root,
		// never inside author.
		UserID:         t.Tracking.UserID,
		Status:         string(t.Tracking.Status),
		PreviousStatus: previousStatus,
		TrackingNumber: t.Tracking.TrackingNumber,
		// The TRANSITION's own timestamp, not updated_at, which moves on any
		// write.
		ChangedAt: t.Tracking.Datetime,
		// An EXPLICIT nil check, never truthiness: only a NULL column means "no
		// address", and the downstream Zod schema REJECTS a null — a violation is
		// a PermanentError that consumes the record and loses the email and the
		// WebSocket push, with nothing upstream noticing.
		ShippingAddress: shippingAddressPtr(t.Tracking.ShippingAddress),
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

// shippingAddressPtr returns nil for a NULL column and a pointer to the raw JSON
// otherwise.
//
// nil means the key is OMITTED from the envelope. It is never sent as null and
// never as "": a "shipping_address": null would make the pipeline's template
// branch on two spellings of "no address" instead of one, and the Zod schema
// rejects the null outright.
func shippingAddressPtr(raw []byte) *string {
	if raw == nil {
		return nil
	}
	value := string(raw)
	return &value
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
