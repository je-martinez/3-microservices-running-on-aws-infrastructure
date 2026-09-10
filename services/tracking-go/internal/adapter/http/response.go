package http

import (
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// CONTRACT: isoLayout carries no zone suffix of its own (the "Z" is appended)
// and drops a zero fractional part entirely. RFC3339 is NOT equivalent — it
// emits "+00:00" or a fixed fractional width, a different string for the same
// instant. See [[openapi-specs]]
const isoLayout = "2006-01-02T15:04:05.999999"

// ISO renders a timestamp as the wire string.
//
// CONTRACT: A nil or zero moment renders as "", never null — the contract types
// the field as a string. CONVERT to UTC before formatting, never merely label: a
// value arriving in another zone is otherwise stamped "Z" while naming a
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
