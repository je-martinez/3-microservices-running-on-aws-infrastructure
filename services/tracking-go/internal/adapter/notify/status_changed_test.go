package notify_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/notify"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/sqs"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

type recordingSQS struct {
	calls []sqs.StatusChanged
}

func (r *recordingSQS) PublishTrackingStatusChanged(_ context.Context, in sqs.StatusChanged) {
	r.calls = append(r.calls, in)
}

func sample(t *testing.T) domain.TrackingWithHistory {
	t.Helper()
	at := time.Date(2026, 8, 27, 15, 4, 5, 0, time.UTC)
	// TWO DIFFERENT identity values, so a swap between them fails.
	tracking := domain.Tracking{
		ID: "trk_1", OrderID: "ord_1", UserID: "usr_internal", CognitoSub: "sub-uuid",
		TrackingNumber: "3MRAI-1111-2222-3333",
		Status:         domain.StatusShipped, Datetime: at,
		UpdatedAt: at.Add(time.Hour),
	}
	history := []domain.TrackingHistory{
		{TrackingID: "trk_1", Status: domain.StatusPlaced, Datetime: at.Add(-time.Hour)},
		{TrackingID: "trk_1", Status: domain.StatusShipped, Datetime: at},
	}
	tracking.History = history
	return domain.TrackingWithHistory{Tracking: tracking, History: history}
}

func TestStatusEventPublisher(t *testing.T) {
	t.Run("every subject field comes off the PERSISTED row", func(t *testing.T) {
		// The carrier request carries no caller identity at all, so the row is
		// the only possible source for any of these.
		pub := &recordingSQS{}
		notify.NewStatusEventPublisher(pub).PublishTrackingStatusChanged(
			t.Context(), sample(t), "PLACED", audit.CarrierStatusUpdate)

		if len(pub.calls) != 1 {
			t.Fatalf("published %d events, want 1", len(pub.calls))
		}
		got := pub.calls[0]
		if got.UserID != "usr_internal" {
			t.Errorf("user_id = %q, want the row's internal usr_ id", got.UserID)
		}
		if got.CognitoSub != "sub-uuid" {
			t.Errorf("cognito_sub = %q — it becomes author.cognito_sub, the key the "+
				"pipeline routes the WebSocket push by; a usr_ id there reaches nobody",
				got.CognitoSub)
		}
		if got.TrackingNumber != "3MRAI-1111-2222-3333" {
			t.Errorf("tracking_number = %q", got.TrackingNumber)
		}
		if got.PreviousStatus != "PLACED" {
			t.Errorf("previous_status = %q, want PLACED — the one field that cannot "+
				"come off the entity, whose status is already the NEW one", got.PreviousStatus)
		}
		if got.Status != "SHIPPED" {
			t.Errorf("status = %q, want SHIPPED", got.Status)
		}
	})

	t.Run("changed_at is the TRANSITION's time, not updated_at", func(t *testing.T) {
		pub := &recordingSQS{}
		in := sample(t)
		notify.NewStatusEventPublisher(pub).PublishTrackingStatusChanged(
			t.Context(), in, "PLACED", audit.CarrierStatusUpdate)

		if !pub.calls[0].ChangedAt.Equal(in.Tracking.Datetime) {
			t.Errorf("changed_at = %v, want the tracking's datetime %v — updated_at "+
				"moves on ANY write, datetime only on a transition",
				pub.calls[0].ChangedAt, in.Tracking.Datetime)
		}
	})

	t.Run("the actor travels; it is never fixed in the publisher", func(t *testing.T) {
		for _, actor := range []audit.Actor{audit.CarrierStatusUpdate, audit.TestModeProgression} {
			pub := &recordingSQS{}
			notify.NewStatusEventPublisher(pub).PublishTrackingStatusChanged(
				t.Context(), sample(t), "PLACED", actor)
			if pub.calls[0].Actor != actor {
				t.Errorf("actor = %q, want %q — a constant here would relabel every "+
					"automatic progression as a real carrier update",
					pub.calls[0].Actor, actor)
			}
		}
	})

	t.Run("the history carried is the one it was given, in order", func(t *testing.T) {
		pub := &recordingSQS{}
		notify.NewStatusEventPublisher(pub).PublishTrackingStatusChanged(
			t.Context(), sample(t), "PLACED", audit.CarrierStatusUpdate)

		got := pub.calls[0].History
		if len(got) != 2 || got[0].Status != "PLACED" || got[1].Status != "SHIPPED" {
			t.Fatalf("history = %+v, want PLACED then SHIPPED", got)
		}
	})

	t.Run("a NULL shipping address is OMITTED, never null and never empty", func(t *testing.T) {
		// The pipeline validates the envelope with Zod, which REJECTS nulls. A
		// violation is a PermanentError: the record is consumed rather than
		// retried, and the email AND the WebSocket push are lost silently.
		pub := &recordingSQS{}
		in := sample(t)
		in.Tracking.ShippingAddress = nil
		notify.NewStatusEventPublisher(pub).PublishTrackingStatusChanged(
			t.Context(), in, "PLACED", audit.CarrierStatusUpdate)

		if pub.calls[0].ShippingAddress != nil {
			t.Fatalf("shipping_address = %q, want nil so the key is omitted",
				*pub.calls[0].ShippingAddress)
		}
	})

	t.Run("a PRESENT address travels verbatim, including an empty string", func(t *testing.T) {
		// The check is an EXPLICIT nil check, never truthiness: an empty string
		// is a value the row actually holds.
		for name, raw := range map[string][]byte{
			"object": []byte(`{"street":"1 Main St"}`),
			"empty":  []byte(``),
		} {
			t.Run(name, func(t *testing.T) {
				pub := &recordingSQS{}
				in := sample(t)
				in.Tracking.ShippingAddress = raw
				notify.NewStatusEventPublisher(pub).PublishTrackingStatusChanged(
					t.Context(), in, "PLACED", audit.CarrierStatusUpdate)

				got := pub.calls[0].ShippingAddress
				if got == nil {
					t.Fatal("a present address was dropped; only a NULL column is omitted")
				}
				if *got != string(raw) {
					t.Errorf("shipping_address = %q, want the bytes verbatim %q", *got, raw)
				}
			})
		}
	})

	t.Run("the address is forwarded as raw JSON, never re-encoded", func(t *testing.T) {
		// The shape is owned by Orders/Users; this service stores and forwards it
		// and never inspects it. Round-tripping through a Go map would reorder
		// keys and re-encode numbers for no reason.
		raw := []byte(`{"zip":"01234","nested":{"b":1,"a":2},"n":1.10}`)
		pub := &recordingSQS{}
		in := sample(t)
		in.Tracking.ShippingAddress = raw
		notify.NewStatusEventPublisher(pub).PublishTrackingStatusChanged(
			t.Context(), in, "PLACED", audit.CarrierStatusUpdate)

		if *pub.calls[0].ShippingAddress != string(raw) {
			t.Errorf("shipping_address = %q, want %q byte-for-byte",
				*pub.calls[0].ShippingAddress, raw)
		}
		// And it is still valid JSON, so the envelope stays well-formed.
		if !json.Valid([]byte(*pub.calls[0].ShippingAddress)) {
			t.Error("the forwarded address is not valid JSON")
		}
	})

	t.Run("a nil publisher is a no-op, never a panic", func(t *testing.T) {
		// A runtime built without a queue must not crash the write path that
		// already committed.
		notify.NewStatusEventPublisher(nil).PublishTrackingStatusChanged(
			t.Context(), sample(t), "PLACED", audit.CarrierStatusUpdate)
	})
}

func TestTrackingCacheInvalidator(t *testing.T) {
	t.Run("a null gateway never fails the caller", func(t *testing.T) {
		// The transition has already committed; a Redis outage must not turn a
		// successful write into a 500 the carrier would then retry into a 400.
		notify.NewTrackingCacheInvalidator(nil, nil).
			InvalidateTracking(t.Context(), "ord_1", "sub-1", "usr_1")
	})

	t.Run("a nil logger is tolerated", func(t *testing.T) {
		notify.NewTrackingCacheInvalidator(cache.NewNullGateway(), nil).
			InvalidateTracking(t.Context(), "ord_1", "sub-1", "usr_1")
	})
}
