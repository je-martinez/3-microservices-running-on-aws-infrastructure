package mysql

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/oagudo/outbox"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// DefaultOutboxTable is the table name the migration creates and the poller reads.
const DefaultOutboxTable = "outbox"

// OutboxPayload is what one pending TRACKING_STATUS_CHANGED carries between the
// transition that recorded it and the poller that publishes it.
//
// CONTRACT: The FULLY RESOLVED transition, captured at write time — never an id
// for the poller to re-read. The row may have advanced by then, so a re-reading
// poller announces the CURRENT status under an older event's id, and
// previous_status cannot be recovered at all. See [[events-pipeline-design]]
//
// WARNING: shipping_address is PII and travels here. It reaches SNS and nowhere
// else — never a log line, never a span attribute. See [[logging-context]]
type OutboxPayload struct {
	OrderID         string          `json:"order_id"`
	OrderNumber     string          `json:"order_number,omitempty"`
	UserID          string          `json:"user_id"`
	Status          string          `json:"status"`
	PreviousStatus  string          `json:"previous_status"`
	TrackingNumber  string          `json:"tracking_number"`
	ChangedAt       time.Time       `json:"changed_at"`
	ShippingAddress json.RawMessage `json:"shipping_address,omitempty"`
	History         []OutboxHistory `json:"history"`
	Actor           audit.Actor     `json:"actor"`
	CognitoSub      string          `json:"cognito_sub,omitempty"`
	// RequestID correlates the eventual publish back to the request that caused
	// it. Omitted when absent — the TestMode progression has no request.
	RequestID string `json:"request_id,omitempty"`
}

// OutboxHistory is one transition in the stored timeline: status and datetime
// only, matching what the envelope carries.
type OutboxHistory struct {
	Status   string    `json:"status"`
	Datetime time.Time `json:"datetime"`
}

// DecodeOutboxPayload reads a stored payload back.
func DecodeOutboxPayload(raw []byte) (OutboxPayload, error) {
	var payload OutboxPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return OutboxPayload{}, fmt.Errorf("mysql: decode outbox payload: %w", err)
	}
	return payload, nil
}

// OutboxWriter stores one pending message inside a transaction the CALLER owns.
//
// CONTRACT: Unmanaged mode only. oagudo/outbox's managed Writer.Write opens and
// commits its own transaction, which would put the outbox row in a SECOND
// transaction — reintroducing the exact loss window this table closes. Unmanaged
// Store takes the *sql.Tx already open and does nothing else.
// See [[cqrs]]
type OutboxWriter struct {
	writer *outbox.UnmanagedWriter
}

// NewOutboxWriter builds a writer over the default table.
func NewOutboxWriter(db *sql.DB) *OutboxWriter {
	return NewOutboxWriterWithTable(db, DefaultOutboxTable)
}

// NewOutboxWriterWithTable builds a writer over a named table. The name is only
// variable so a test can point it at a missing table and observe a real failure;
// production uses DefaultOutboxTable.
func NewOutboxWriterWithTable(db *sql.DB, table string) *OutboxWriter {
	// SQLDialectMySQL selects `?` placeholders, UTC_TIMESTAMP() and — the one that
	// matters — a UUID marshalled to BINARY(16), which is what the migration's id
	// column holds.
	dbCtx := outbox.NewDBContext(db, outbox.SQLDialectMySQL, outbox.WithTableName(table))
	return &OutboxWriter{writer: outbox.NewWriter(dbCtx).Unmanaged()}
}

// Store writes one message for the transition inside tx.
//
// CONTRACT: Do NOT swallow the error. An outbox write that fails must fail the
// transition, or a committed status change is announced to nobody — the
// pre-outbox failure mode, restored silently while the happy-path tests stay
// green. The PUBLISH is best-effort; the RECORD of it is not.
func (w *OutboxWriter) Store(
	ctx context.Context,
	tx *sql.Tx,
	updated domain.TrackingWithHistory,
	previousStatus string,
	actor audit.Actor,
) error {
	history := make([]OutboxHistory, 0, len(updated.History))
	for _, entry := range updated.History {
		history = append(history, OutboxHistory{
			Status:   string(entry.Status),
			Datetime: entry.Datetime,
		})
	}

	payload, err := json.Marshal(OutboxPayload{
		OrderID:     updated.Tracking.OrderID,
		OrderNumber: updated.Tracking.OrderNumber,
		// The event's SUBJECT — the order's owner, off the persisted row. The
		// carrier webhook sends no identity at all, so there is nowhere else.
		UserID:          updated.Tracking.UserID,
		Status:          string(updated.Tracking.Status),
		PreviousStatus:  previousStatus,
		TrackingNumber:  updated.Tracking.TrackingNumber,
		ChangedAt:       updated.Tracking.Datetime,
		ShippingAddress: updated.Tracking.ShippingAddress,
		History:         history,
		Actor:           actor,
		CognitoSub:      updated.Tracking.CognitoSub,
		RequestID:       requestIDFrom(ctx),
	})
	if err != nil {
		return fmt.Errorf("mysql: encode outbox payload: %w", err)
	}

	// CONTRACT: The trace context is captured HERE, inside the request, and travels
	// in metadata. It is the only way the eventual publish joins this trace: the
	// poller runs on a different context in a different goroutine, so nothing
	// ambient connects the two. Without it the waterfall stops at the outbox write
	// and the publish appears as an unrelated root trace.
	// See [[ADR-0019-distributed-tracing-opentelemetry]]
	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	metadata, err := json.Marshal(carrier)
	if err != nil {
		return fmt.Errorf("mysql: encode outbox metadata: %w", err)
	}

	msg := outbox.NewMessage(payload, outbox.WithMetadata(metadata))
	if err := w.writer.Store(ctx, tx, msg); err != nil {
		return fmt.Errorf("mysql: store outbox message: %w", err)
	}
	return nil
}

// requestIDFrom lifts the request id off the log context, or "" when there is
// none. The TestMode progression runs on a timer and has no request.
func requestIDFrom(ctx context.Context) string {
	for _, field := range logging.LogFields(ctx) {
		if field.Key == logging.KeyRequestID {
			return field.Value.String()
		}
	}
	return ""
}
