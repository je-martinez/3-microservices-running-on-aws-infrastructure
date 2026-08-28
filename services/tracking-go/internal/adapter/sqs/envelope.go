package sqs

import (
	"crypto/sha256"
	"encoding/hex"
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

// HistoryEntry is one transition in the published timeline.
//
// Only status and datetime: tracking_id, order_id, user_id and cognito_sub are on
// every row but are identical across all of them and already present at the
// envelope root, so repeating them per entry would be five copies of one fact —
// and cognito_sub in particular is an ownership key with no business leaving the
// service.
type HistoryEntry struct {
	Status   string
	Datetime time.Time
}

// StatusChanged is everything the publisher needs about one transition. Every
// subject-side field comes off the PERSISTED ROW; none comes from the request,
// because the carrier webhook carries no caller identity at all.
type StatusChanged struct {
	OrderID string
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
	// ShippingAddress is nil when the row holds NULL. The omission check is an
	// EXPLICIT nil check, never truthiness — an empty string is a value.
	ShippingAddress *string
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

// envelope is marshalled directly. Every omitempty here implements a rule from
// the downstream Zod schema, which REJECTS NULLS: a violation is a PermanentError
// that consumes the record and LOSES the email and the push, and nothing upstream
// notices.
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

// author carries ONLY actor and an optional cognito_sub.
//
// There is deliberately no user_id field and no source field, and their absence
// is structural rather than conditional: no write path here has a human author,
// and the root `source` already names the producer. A field that must never
// appear is best represented by not existing.
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
	FullName       string `json:"full_name"`
	OrderID        string `json:"order_id"`
	TrackingNumber string `json:"tracking_number"`
	// A POINTER, so omitempty drops the key on nil and KEEPS it on a pointer to
	// "": the key is OMITTED when the row's column is NULL, never sent as null,
	// and an explicit empty string still travels as a value. A
	// "shipping_address": null would make the template branch on two spellings of
	// "no address" instead of one.
	ShippingAddress *string        `json:"shipping_address,omitempty"`
	History         []historyEntry `json:"history"`
}

type historyEntry struct {
	Status   string `json:"status"`
	Datetime string `json:"datetime"`
}

// DeriveEventID is the idempotency key for one transition.
//
// DETERMINISTIC ON PURPOSE — never a fresh id per attempt. The pipeline dedupes
// on a unique index over event_id, so a redelivery is only collapsed if the
// retried message carries the SAME id. A randomly generated one would slip past
// that index and send a SECOND notification email for a transition that already
// succeeded.
//
// (order_id, status) is a genuine natural key, not a convenient one: the state
// machine is forward-only and tracking_history's primary key is
// (tracking_id, status), so a given order enters each status at most once. Two
// events with this id are therefore, by construction, the same transition.
//
// This matters most under TestMode, which walks all five statuses in ~40 seconds:
// a transient SQS error anywhere in that burst retries into the same id rather
// than into a duplicate email.
//
// The pair is HASHED rather than interpolated so the id has a fixed shape and
// length whatever an order id contains. The hash is not a security boundary; it
// is a formatting one.
func DeriveEventID(orderID, status string) string {
	sum := sha256.Sum256([]byte(orderID + "|" + status))
	return eventIDPrefix + hex.EncodeToString(sum[:])[:eventIDHashLength]
}
