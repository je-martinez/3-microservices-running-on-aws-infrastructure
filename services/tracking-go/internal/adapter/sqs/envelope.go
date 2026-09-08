package sqs

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// The envelope's type and source. type must match the key the pipeline's handler
// map dispatches on — an unknown type dead-ends in FAILED "Unknown event type".
const (
	EventType   = "TRACKING_STATUS_CHANGED"
	EventSource = "tracking"
)

const (
	eventIDPrefix     = "evt_"
	eventIDHashLength = 16
)

// timestampLayout renders a timestamp the way Python's datetime.isoformat() does
// for the naive DATETIME values this service persists: no zone suffix, second
// precision. The wire shape is the CONTRACT with the pipeline's Zod schema, which
// validates a non-empty string and hands it to a template — so it is pinned here
// rather than left to an encoder default (time.Time would marshal as RFC3339Nano
// with a Z, a different string for the same instant).
const timestampLayout = "2006-01-02T15:04:05"

// HistoryEntry is one transition in the published timeline: status and datetime
// only. The other row columns are identical across entries and already at the
// envelope root, and cognito_sub is an ownership key that must not leave here.
type HistoryEntry struct {
	Status   string
	Datetime time.Time
}

// StatusChanged is everything the publisher needs about one transition. Every
// subject-side field comes off the PERSISTED ROW; none comes from the request,
// because the carrier webhook carries no caller identity at all.
type StatusChanged struct {
	OrderID string
	// OrderNumber is the canonical customer-facing label, off the PERSISTED ROW.
	// "" when the order has none, in which case the key is omitted entirely and
	// the templates fall back to the order id. See [[friendly-order-number]]
	OrderNumber string
	// UserID is the event's SUBJECT (the order's owner) and travels at the
	// envelope ROOT — never inside author.
	UserID string
	Status string
	// PreviousStatus is the one field that cannot come off the entity: the row's
	// status is already the NEW one by the time this runs.
	PreviousStatus string
	TrackingNumber string
	// ChangedAt is the transition's own timestamp, NOT updated_at, which moves on
	// any write.
	ChangedAt time.Time
	// CONTRACT: json.RawMessage, NOT *string. The consumer's schema is
	// z.record(...).optional(), an OBJECT; a *string re-encodes the bytes as a
	// JSON string containing JSON, which is a PermanentError — the record is
	// consumed, the email and push are lost, and this producer logs success.
	// See [[events-pipeline-design]]
	ShippingAddress json.RawMessage
	History         []HistoryEntry
	// Actor is what ORIGINATED the transition, threaded down from the command.
	// Never a constant chosen here: this publisher serves both the carrier
	// webhook and TestMode progression, and a constant would relabel every
	// automatic progression as a real carrier update.
	Actor audit.Actor
	// CognitoSub comes off the PERSISTED ROW, never the request. It becomes the
	// optional author.cognito_sub, which the pipeline uses to route the realtime
	// WebSocket push — handing that index a usr_ id returns an empty list with no
	// error, so the push would silently reach nobody.
	CognitoSub string
}

// CONTRACT: Every omitempty here implements a downstream Zod rule. That schema
// rejects nulls — a violation is a PermanentError that consumes the record and
// loses the email and the push, with nothing upstream noticing.
// See [[events-pipeline-design]]
type envelope struct {
	EventID string `json:"event_id"`
	Type    string `json:"type"`
	Source  string `json:"source"`
	UserID  string `json:"user_id"`
	OrderID string `json:"order_id"`
	// Omitted when empty, never null, never "" — the schema declares it
	// .optional() with .min(1).
	RequestID string  `json:"request_id,omitempty"`
	Author    author  `json:"author"`
	Payload   payload `json:"payload"`
}

// author carries ONLY actor and an optional cognito_sub. user_id and source are
// absent structurally, not conditionally: no write path has a human author and
// the root source already names the producer.
type author struct {
	Actor      string `json:"actor"`
	CognitoSub string `json:"cognito_sub,omitempty"`
}

type payload struct {
	Status         string `json:"status"`
	PreviousStatus string `json:"previous_status"`
	// ISO-8601 string, not a time.Time: the wire shape is the contract, and a
	// marshalling default is not something to leave to the encoder.
	ChangedAt string `json:"changed_at"`
	Email     string `json:"email"`
	// ALWAYS present, "" when unknown — deliberately different from
	// ShippingAddress. An absent address means the notification cannot be
	// delivered at all; an absent name is cosmetic, the mail still sends, and the
	// template interpolates a plain string.
	FullName string `json:"full_name"`
	OrderID  string `json:"order_id"`
	// CONTRACT: A POINTER with omitempty, so an order without a number omits the
	// key rather than sending an object of empty strings. The consumer's schema is
	// .optional(), not .nullable(), so a null would be a PermanentError — the
	// record is consumed and the email and push are lost. Same shape Orders sends
	// on ORDER_CREATED, so one Zod schema validates both.
	// See [[friendly-order-number]]
	OrderNumber    *orderNumber `json:"order_number,omitempty"`
	TrackingNumber string       `json:"tracking_number"`
	// CONTRACT: Do NOT rely on omitempty alone. It drops nil and zero-length
	// bytes, but a JSON column can hold the literal document `null`, whose
	// non-empty bytes marshal through as "shipping_address": null — a rejection
	// under a schema that is .optional() and not .nullable(). buildEnvelope
	// normalizes those bytes to nil first. See [[events-pipeline-design]]
	ShippingAddress json.RawMessage `json:"shipping_address,omitempty"`
	History         []historyEntry  `json:"history"`
}

// orderNumber carries BOTH forms, exactly as Orders does. The producer owns the
// display rule; templates render `formatted` verbatim rather than inserting their
// own separator, or the six of them drift and a customer reads out a number
// support cannot find. See [[friendly-order-number]]
type orderNumber struct {
	Raw       string `json:"raw"`
	Formatted string `json:"formatted"`
}

type historyEntry struct {
	Status   string `json:"status"`
	Datetime string `json:"datetime"`
}

// DeriveEventID is the idempotency key for one transition.
//
// CONTRACT: Keep this deterministic — never a fresh id per attempt. The pipeline
// dedupes on a unique index over event_id, so a random id slips past it and
// sends a SECOND notification email for a transition that already succeeded.
// (order_id, status) is a natural key: the state machine is forward-only and
// tracking_history is keyed on (tracking_id, status), so an order enters each
// status at most once. The pair is hashed for a fixed id shape, not for secrecy.
// See [[events-pipeline-design]]
func DeriveEventID(orderID, status string) string {
	sum := sha256.Sum256([]byte(orderID + "|" + status))
	return eventIDPrefix + hex.EncodeToString(sum[:])[:eventIDHashLength]
}
