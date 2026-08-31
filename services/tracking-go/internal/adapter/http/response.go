package http

import (
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// isoLayout renders the way Python's datetime.isoformat() does: no zone suffix of
// its own (the "Z" is appended), and a fractional part that disappears entirely
// when it is zero.
//
// RFC3339 is NOT equivalent — it emits "+00:00" or a fixed fractional width, and
// a client parsing the Python service's output would see a different string. The
// ".999999" verb drops trailing zeros exactly as isoformat() does.
const isoLayout = "2006-01-02T15:04:05.999999"

// ISO renders a timestamp as the wire string.
//
// A nil or zero moment renders as "", never null: the field is typed as a string
// on the contract, and a string-typed field that can also be null would force
// every consumer to handle a case that never occurs in practice. Omitted, never
// null.
//
// The moment is CONVERTED to UTC before formatting, not merely labelled: the
// columns are naive MySQL DATETIME holding UTC, but a value that reached this
// function in another zone would otherwise be stamped "Z" while naming a
// different instant.
func ISO(t *time.Time) string {
	if t == nil || t.IsZero() {
		return ""
	}
	return t.UTC().Format(isoLayout) + "Z"
}

// HistoryEntryResponse is one immutable transition.
//
// It carries no shipping_address and no cognito_sub, and it is a DISTINCT type
// from domain.TrackingHistory for exactly that reason: reusing the domain type
// would make leaking those fields a one-line json tag away.
type HistoryEntryResponse struct {
	TrackingID string `json:"tracking_id"`
	UserID     string `json:"user_id"`
	OrderID    string `json:"order_id"`
	Status     string `json:"status"`
	Datetime   string `json:"datetime"`
}

// TrackingResponse is a tracking together with its ordered history.
//
// History is part of the payload rather than a separate endpoint because every
// caller of these reads wants both. Like HistoryEntryResponse, it is
// PHYSICALLY incapable of carrying shipping_address (PII) or cognito_sub
// (identity): neither field exists on the type.
type TrackingResponse struct {
	ID       string                 `json:"id"`
	UserID   string                 `json:"user_id"`
	OrderID  string                 `json:"order_id"`
	Status   string                 `json:"status"`
	Datetime string                 `json:"datetime"`
	History  []HistoryEntryResponse `json:"history"`
}

// NewTrackingResponse maps a domain value onto the wire shape.
//
// History is expected to already be ordered by domain.SortHistory; this function
// does not re-sort, so the caller stays in charge of where the ordering came
// from.
func NewTrackingResponse(t domain.TrackingWithHistory) TrackingResponse {
	// Non-nil slice: an empty history must marshal as [] and never as null.
	history := make([]HistoryEntryResponse, 0, len(t.History))
	for _, entry := range t.History {
		history = append(history, HistoryEntryResponse{
			TrackingID: entry.TrackingID,
			UserID:     entry.UserID,
			OrderID:    entry.OrderID,
			Status:     string(entry.Status),
			Datetime:   ISO(&entry.Datetime),
		})
	}
	return TrackingResponse{
		ID:       t.Tracking.ID,
		UserID:   t.Tracking.UserID,
		OrderID:  t.Tracking.OrderID,
		Status:   string(t.Tracking.Status),
		Datetime: ISO(&t.Tracking.Datetime),
		History:  history,
	}
}

// InitTrackingResponse is the 201 body — WRAPPED under "tracking". The reads are
// FLAT; the difference is observable by a shipped client, so it is preserved
// rather than tidied away.
type InitTrackingResponse struct {
	Tracking TrackingResponse `json:"tracking"`
}

// TrackingListResponse is the batch read's body: an object, never a bare array.
//
// A bare array has nowhere to add a field later without a breaking change, and
// is the shape most REST clients handle worst. Declared here, with the type it
// wraps; the read handlers use it and must not redeclare it.
type TrackingListResponse struct {
	Trackings []TrackingResponse `json:"trackings"`
}

// DeletedResponse is the body of both delete routes.
type DeletedResponse struct {
	Deleted int64 `json:"deleted"`
}
