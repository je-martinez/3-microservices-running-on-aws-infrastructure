package notify

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/sqs"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/outbox"
)

// FailableStatusPublisher is this adapter's own narrow port, declared here by its
// consumer — one method, the only one it calls.
//
// CONTRACT: The ERROR-RETURNING form, never sqs.Publisher. The poller's whole
// retry mechanism IS that error: without it every message is deleted on the first
// SNS outage and delivery drops back to at-most-once. See [[cqrs]]
type FailableStatusPublisher interface {
	TryPublishTrackingStatusChanged(ctx context.Context, in sqs.StatusChanged) error
}

// OutboxSNSPublisher turns one stored outbox message back into an SNS publish.
//
// It is the seam between the two halves of the outbox: the transition wrote a
// payload, this rebuilds the publisher's input from it and nothing else.
type OutboxSNSPublisher struct {
	publisher FailableStatusPublisher
}

// NewOutboxSNSPublisher wires the bridge.
func NewOutboxSNSPublisher(publisher FailableStatusPublisher) *OutboxSNSPublisher {
	return &OutboxSNSPublisher{publisher: publisher}
}

// Publish sends one stored message and reports whether it went out.
//
// CONTRACT: Build the input from the STORED PAYLOAD only — no database read here.
// The row this message describes may have advanced since, so a re-read would
// announce the CURRENT status under an older transition's event id, and
// previous_status could not be recovered at all.
func (p *OutboxSNSPublisher) Publish(ctx context.Context, msg outbox.Message) error {
	payload, err := mysql.DecodeOutboxPayload(msg.Payload)
	if err != nil {
		// Retained and retried rather than dropped. A payload nothing can parse
		// will not start parsing, so it ends at the attempt limit — but it ends
		// there with the discard log line naming it, which is the only record
		// anybody gets that a notification was lost.
		return fmt.Errorf("notify: outbox message %s: %w", msg.ID, err)
	}

	history := make([]sqs.HistoryEntry, 0, len(payload.History))
	for _, entry := range payload.History {
		history = append(history, sqs.HistoryEntry{
			Status:   entry.Status,
			Datetime: entry.Datetime,
		})
	}

	return p.publisher.TryPublishTrackingStatusChanged(ctx, sqs.StatusChanged{
		OrderID:     payload.OrderID,
		OrderNumber: payload.OrderNumber,
		// The event's SUBJECT — the order's owner, travelling at the envelope root.
		UserID:         payload.UserID,
		Status:         payload.Status,
		PreviousStatus: payload.PreviousStatus,
		TrackingNumber: payload.TrackingNumber,
		ChangedAt:      payload.ChangedAt,
		// CONTRACT: Forward the raw bytes. Narrowing to *string re-encodes the
		// object as a JSON string, which the pipeline's z.record rejects as a
		// PermanentError — the record is consumed and the email and push are lost.
		// See [[events-pipeline-design]]
		ShippingAddress: json.RawMessage(payload.ShippingAddress),
		History:         history,
		// Captured at write time, never chosen here: this path serves both the
		// carrier webhook and TestMode, and a constant would relabel every
		// automatic progression as a real carrier update.
		Actor: payload.Actor,
		// The key the pipeline routes the WebSocket push by. It came off the
		// persisted row when the message was written.
		CognitoSub: payload.CognitoSub,
	})
}
