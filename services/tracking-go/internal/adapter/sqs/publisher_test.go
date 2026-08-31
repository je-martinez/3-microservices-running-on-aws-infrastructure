package sqs_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	awssqs "github.com/aws/aws-sdk-go-v2/service/sqs"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/sqs"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

type fakeSQS struct {
	mu   sync.Mutex
	sent []*awssqs.SendMessageInput
	err  error
}

func (f *fakeSQS) SendMessage(_ context.Context, in *awssqs.SendMessageInput, _ ...func(*awssqs.Options)) (*awssqs.SendMessageOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, in)
	if f.err != nil {
		return nil, f.err
	}
	return &awssqs.SendMessageOutput{}, nil
}

func (f *fakeSQS) last() *awssqs.SendMessageInput {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.sent) == 0 {
		return nil
	}
	return f.sent[len(f.sent)-1]
}

func (f *fakeSQS) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

type stubResolver struct {
	user grpcusers.ResolvedUser
	err  error
}

func (s stubResolver) Resolve(context.Context, string) (grpcusers.ResolvedUser, error) {
	return s.user, s.err
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// realisticAddressJSON is the shape the shipping_address COLUMN actually holds:
// a JSON OBJECT snapshot owned by Orders, stored in a MySQL JSON column and read
// back as raw bytes. Not a one-line street string — the Python producer maps the
// column through SQLAlchemy's `Mapped[dict | None]` and serialises a dict, so the
// pipeline has only ever received an object here.
const realisticAddressJSON = `{"city": "Austin", "line1": "1 Test St", "state": "TX", "country": "US", "postal_code": "78701"}`

func fullInput() sqs.StatusChanged {
	return sqs.StatusChanged{
		OrderID:         "ord_abc",
		UserID:          "usr_abc",
		Status:          "IN_TRANSIT",
		PreviousStatus:  "PLACED",
		TrackingNumber:  "TRK123456789",
		ChangedAt:       time.Date(2026, 8, 27, 12, 34, 56, 0, time.UTC),
		ShippingAddress: json.RawMessage(realisticAddressJSON),
		History: []sqs.HistoryEntry{
			{Status: "PLACED", Datetime: time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)},
			{Status: "IN_TRANSIT", Datetime: time.Date(2026, 8, 27, 12, 34, 56, 0, time.UTC)},
		},
		Actor:      audit.CarrierStatusUpdate,
		CognitoSub: "sub-uuid",
	}
}

func decodeEnvelope(t *testing.T, in *awssqs.SendMessageInput) map[string]any {
	t.Helper()
	if in == nil {
		t.Fatal("nothing was sent")
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(*in.MessageBody), &envelope); err != nil {
		t.Fatalf("body is not JSON: %v\n%s", err, *in.MessageBody)
	}
	return envelope
}

func TestEnvelopeShape(t *testing.T) {
	client := &fakeSQS{}
	resolver := stubResolver{user: grpcusers.ResolvedUser{
		InternalID: "usr_abc", Email: "person@example.com", FullName: "Ada Lovelace"}}
	p := sqs.NewPublisher(client, "https://sqs/queue", resolver, quietLog())

	ctx := logging.WithLogFields(t.Context(),
		slog.String(logging.KeyRequestID, "req_7gK3mP1vXz9wLq2bN8rRt4Yc"))
	p.PublishTrackingStatusChanged(ctx, fullInput())

	envelope := decodeEnvelope(t, client.last())

	if envelope["type"] != "TRACKING_STATUS_CHANGED" {
		t.Errorf("type = %v", envelope["type"])
	}
	if envelope["source"] != "tracking" {
		t.Errorf("source = %v", envelope["source"])
	}
	if envelope["user_id"] != "usr_abc" {
		t.Errorf("user_id = %v", envelope["user_id"])
	}
	if envelope["order_id"] != "ord_abc" {
		t.Errorf("order_id = %v", envelope["order_id"])
	}
	if envelope["request_id"] != "req_7gK3mP1vXz9wLq2bN8rRt4Yc" {
		t.Errorf("request_id = %v", envelope["request_id"])
	}

	author, _ := envelope["author"].(map[string]any)
	if author["actor"] != "tracking_api:carrier_status_update" {
		t.Errorf("author.actor = %v", author["actor"])
	}
	if author["cognito_sub"] != "sub-uuid" {
		t.Errorf("author.cognito_sub = %v", author["cognito_sub"])
	}
	// NEVER present: there is no human author, and no producer field inside author.
	if _, present := author["user_id"]; present {
		t.Error("author.user_id must NEVER be present; the tracking's user_id is the SUBJECT and lives at the root")
	}
	if _, present := author["source"]; present {
		t.Error("author.source must NEVER be present; the root source already names the producer")
	}

	payload, _ := envelope["payload"].(map[string]any)
	if payload["status"] != "IN_TRANSIT" || payload["previous_status"] != "PLACED" {
		t.Errorf("transition = %v -> %v", payload["previous_status"], payload["status"])
	}
	if payload["email"] != "person@example.com" {
		t.Errorf("payload.email = %v", payload["email"])
	}
	if payload["full_name"] != "Ada Lovelace" {
		t.Errorf("payload.full_name = %v", payload["full_name"])
	}
	if payload["order_id"] != "ord_abc" {
		t.Errorf("payload.order_id = %v", payload["order_id"])
	}
	if payload["tracking_number"] != "TRK123456789" {
		t.Errorf("payload.tracking_number = %v", payload["tracking_number"])
	}
	// A JSON OBJECT, and the assertion is written against the CONSUMER's schema
	// rather than against whatever this producer happens to emit:
	// functions/events-pipeline/src/handlers/tracking-status-changed.ts declares
	// `shipping_address: z.record(z.string(), z.unknown()).optional()`. A Go
	// *string here serialises as a JSON STRING CONTAINING JSON
	// ("{\"city\": \"Austin\"}"), which fails that record() and is a
	// PermanentError: the record is CONSUMED, not retried, and the email and the
	// WebSocket push are lost with the producer logging success.
	address, isObject := payload["shipping_address"].(map[string]any)
	if !isObject {
		t.Fatalf("payload.shipping_address decoded as %T (%v), want a JSON object (map[string]any); "+
			"the pipeline's Zod schema is z.record(z.string(), z.unknown()) and rejects a string",
			payload["shipping_address"], payload["shipping_address"])
	}
	if address["city"] != "Austin" {
		t.Errorf("payload.shipping_address.city = %v, want Austin", address["city"])
	}
	if address["line1"] != "1 Test St" {
		t.Errorf("payload.shipping_address.line1 = %v, want 1 Test St", address["line1"])
	}
	if address["postal_code"] != "78701" {
		t.Errorf("payload.shipping_address.postal_code = %v, want 78701", address["postal_code"])
	}
	if payload["changed_at"] != "2026-08-27T12:34:56" {
		t.Errorf("payload.changed_at = %v, want the naive ISO-8601 Python's isoformat() emits", payload["changed_at"])
	}
	history, _ := payload["history"].([]any)
	if len(history) != 2 {
		t.Fatalf("history has %d entries, want 2", len(history))
	}
	first, _ := history[0].(map[string]any)
	if first["status"] != "PLACED" {
		t.Errorf("history[0].status = %v", first["status"])
	}
	if _, present := first["datetime"]; !present {
		t.Error("history entries carry status and datetime")
	}
	// Only those two keys per entry — the rest are identical across all of them
	// and already at the envelope root.
	if len(first) != 2 {
		t.Errorf("history entry has %d keys, want exactly status and datetime: %v", len(first), first)
	}
}

// event_id is DETERMINISTIC. The pipeline dedupes on a unique index over it, so
// a random id per attempt would send a SECOND notification email.
func TestEventIDIsDeterministic(t *testing.T) {
	a := sqs.DeriveEventID("ord_abc", "IN_TRANSIT")
	b := sqs.DeriveEventID("ord_abc", "IN_TRANSIT")
	if a != b {
		t.Fatalf("DeriveEventID is not deterministic: %q then %q", a, b)
	}
	if !strings.HasPrefix(a, "evt_") {
		t.Errorf("event id %q has no evt_ prefix", a)
	}
	if len(a) != len("evt_")+16 {
		t.Errorf("event id %q is %d chars, want evt_ + 16", a, len(a))
	}
	if c := sqs.DeriveEventID("ord_abc", "DELIVERED"); c == a {
		t.Error("a different status must produce a different event id")
	}
	if d := sqs.DeriveEventID("ord_xyz", "IN_TRANSIT"); d == a {
		t.Error("a different order must produce a different event id")
	}
}

func TestEnvelopeEventIDMatchesDerive(t *testing.T) {
	client := &fakeSQS{}
	p := sqs.NewPublisher(client, "q",
		stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())
	p.PublishTrackingStatusChanged(t.Context(), fullInput())

	envelope := decodeEnvelope(t, client.last())
	if envelope["event_id"] != sqs.DeriveEventID("ord_abc", "IN_TRANSIT") {
		t.Errorf("event_id = %v", envelope["event_id"])
	}
}

// OMITTED, never null: a Zod schema downstream rejects nulls, and a violation
// consumes the record and LOSES the email and the push.
func TestOmissionRules(t *testing.T) {
	t.Run("request_id omitted when the context has none", func(t *testing.T) {
		client := &fakeSQS{}
		p := sqs.NewPublisher(client, "q",
			stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())
		p.PublishTrackingStatusChanged(t.Context(), fullInput())

		envelope := decodeEnvelope(t, client.last())
		if _, present := envelope["request_id"]; present {
			t.Errorf("request_id = %v, want the key absent", envelope["request_id"])
		}
		if strings.Contains(*client.last().MessageBody, `"request_id":null`) {
			t.Error("request_id was emitted as null")
		}
	})

	t.Run("author.cognito_sub omitted when the row has none", func(t *testing.T) {
		client := &fakeSQS{}
		p := sqs.NewPublisher(client, "q",
			stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())
		in := fullInput()
		in.CognitoSub = ""
		p.PublishTrackingStatusChanged(t.Context(), in)

		envelope := decodeEnvelope(t, client.last())
		author, _ := envelope["author"].(map[string]any)
		if _, present := author["cognito_sub"]; present {
			t.Errorf("author.cognito_sub = %v, want the key absent", author["cognito_sub"])
		}
	})

	// The column is NULLABLE and most rows hold no address, so this is the COMMON
	// path, not an edge case. The pipeline's schema is `.optional()` and NOT
	// `.nullable()`: an emitted null fails Zod exactly as a wrong type does.
	t.Run("shipping_address omitted when the column is NULL", func(t *testing.T) {
		client := &fakeSQS{}
		p := sqs.NewPublisher(client, "q",
			stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())

		in := fullInput()
		in.ShippingAddress = nil
		p.PublishTrackingStatusChanged(t.Context(), in)

		body := *client.last().MessageBody
		payload, _ := decodeEnvelope(t, client.last())["payload"].(map[string]any)
		if _, present := payload["shipping_address"]; present {
			t.Errorf("shipping_address = %v on a NULL column, want the key absent", payload["shipping_address"])
		}
		// Asserted on the RAW BODY too: a decoded map cannot tell an omitted key
		// from one explicitly set to null, so the map check alone would pass on
		// the very shape Zod rejects.
		if strings.Contains(body, `"shipping_address"`) {
			t.Errorf("shipping_address appears on the wire for a NULL column: %s", body)
		}
	})

	// Empty bytes are NOT a value. A *string field made "" a legal address to
	// forward; raw JSON has no such spelling — "" is not a JSON document, and
	// emitting it would be a syntax error in the consumer, not an empty address.
	t.Run("shipping_address omitted on empty bytes, never emitted as invalid JSON", func(t *testing.T) {
		for name, empty := range map[string]json.RawMessage{
			"nil":         nil,
			"zero-length": {},
		} {
			t.Run(name, func(t *testing.T) {
				client := &fakeSQS{}
				p := sqs.NewPublisher(client, "q",
					stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())

				in := fullInput()
				in.ShippingAddress = empty
				p.PublishTrackingStatusChanged(t.Context(), in)

				if client.count() == 0 {
					t.Fatal("nothing was published; an absent address must not abort the event")
				}
				payload, _ := decodeEnvelope(t, client.last())["payload"].(map[string]any)
				if _, present := payload["shipping_address"]; present {
					t.Errorf("shipping_address = %v, want the key absent", payload["shipping_address"])
				}
			})
		}
	})

	// A JSON column can legally hold the literal document `null`. omitempty does
	// NOT save us there — the bytes are non-empty, so they marshal straight
	// through as `"shipping_address": null`, the exact shape Zod rejects.
	t.Run("shipping_address omitted when the column holds the JSON literal null", func(t *testing.T) {
		client := &fakeSQS{}
		p := sqs.NewPublisher(client, "q",
			stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())

		in := fullInput()
		in.ShippingAddress = json.RawMessage(`null`)
		p.PublishTrackingStatusChanged(t.Context(), in)

		body := *client.last().MessageBody
		if strings.Contains(body, `"shipping_address":null`) {
			t.Errorf("shipping_address was emitted as null; the schema is .optional(), NOT .nullable(): %s", body)
		}
		payload, _ := decodeEnvelope(t, client.last())["payload"].(map[string]any)
		if _, present := payload["shipping_address"]; present {
			t.Errorf("shipping_address = %v, want the key absent", payload["shipping_address"])
		}
	})

	t.Run("full_name ALWAYS present, empty when unknown", func(t *testing.T) {
		client := &fakeSQS{}
		p := sqs.NewPublisher(client, "q",
			stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com", FullName: ""}}, quietLog())
		p.PublishTrackingStatusChanged(t.Context(), fullInput())

		payload, _ := decodeEnvelope(t, client.last())["payload"].(map[string]any)
		got, present := payload["full_name"]
		if !present {
			t.Fatal("full_name is ALWAYS present, deliberately unlike shipping_address")
		}
		if got != "" {
			t.Errorf("full_name = %v, want \"\"", got)
		}
	})
}

// The actor is threaded through from the command, never chosen here. Hardcoding
// one would relabel every automatic progression as a carrier update.
func TestActorIsThreadedThroughNotConstant(t *testing.T) {
	for _, actor := range []audit.Actor{audit.CarrierStatusUpdate, audit.TestModeProgression} {
		t.Run(string(actor), func(t *testing.T) {
			client := &fakeSQS{}
			p := sqs.NewPublisher(client, "q",
				stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())
			in := fullInput()
			in.Actor = actor
			p.PublishTrackingStatusChanged(t.Context(), in)

			author, _ := decodeEnvelope(t, client.last())["author"].(map[string]any)
			if author["actor"] != string(actor) {
				t.Errorf("author.actor = %v, want %s", author["actor"], actor)
			}
		})
	}
}

// type and source travel as message attributes so the queue can be inspected
// without deserializing the body, and the W3C context rides beside them — NOT
// inside the envelope.
func TestMessageAttributes(t *testing.T) {
	client := &fakeSQS{}
	p := sqs.NewPublisher(client, "q",
		stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())
	p.PublishTrackingStatusChanged(t.Context(), fullInput())

	in := client.last()
	attrs := in.MessageAttributes
	if attrs["type"].StringValue == nil || *attrs["type"].StringValue != "TRACKING_STATUS_CHANGED" {
		t.Errorf("type attribute = %v", attrs["type"])
	}
	if attrs["source"].StringValue == nil || *attrs["source"].StringValue != "tracking" {
		t.Errorf("source attribute = %v", attrs["source"])
	}
	if attrs["type"].DataType == nil || *attrs["type"].DataType != "String" {
		t.Errorf("type DataType = %v", attrs["type"].DataType)
	}

	// The envelope must NOT carry transport concerns.
	envelope := decodeEnvelope(t, in)
	for _, key := range []string{"traceparent", "tracestate"} {
		if _, present := envelope[key]; present {
			t.Errorf("%s is inside the envelope; it belongs in MessageAttributes", key)
		}
	}
}

// With no valid active span the propagator writes nothing: omitted, never blank.
func TestTraceparentOmittedWithoutASpan(t *testing.T) {
	client := &fakeSQS{}
	p := sqs.NewPublisher(client, "q",
		stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())
	p.PublishTrackingStatusChanged(t.Context(), fullInput())

	if attr, present := client.last().MessageAttributes["traceparent"]; present {
		if attr.StringValue != nil && *attr.StringValue == "" {
			t.Error("a blank traceparent was sent; it must be omitted entirely")
		}
	}
}

// Four failure reasons, ALL logged and SWALLOWED. The transition is already
// committed; a raise would make the carrier retry into a 400.
func TestFailuresAreLoggedAndSwallowed(t *testing.T) {
	t.Run("email_resolution_failed", func(t *testing.T) {
		var buf strings.Builder
		client := &fakeSQS{}
		p := sqs.NewPublisher(client, "q",
			stubResolver{err: errors.New("users is unreachable")},
			slog.New(slog.NewJSONHandler(&buf, nil)))

		p.PublishTrackingStatusChanged(t.Context(), fullInput())

		if client.count() != 0 {
			t.Error("a message was sent despite a failed resolution")
		}
		if !strings.Contains(buf.String(), "email_resolution_failed") {
			t.Errorf("no reason=email_resolution_failed: %s", buf.String())
		}
	})

	t.Run("no_email_for_user aborts before building anything", func(t *testing.T) {
		var buf strings.Builder
		client := &fakeSQS{}
		p := sqs.NewPublisher(client, "q",
			stubResolver{user: grpcusers.ResolvedUser{InternalID: "usr_abc", Email: ""}},
			slog.New(slog.NewJSONHandler(&buf, nil)))

		p.PublishTrackingStatusChanged(t.Context(), fullInput())

		if client.count() != 0 {
			t.Error("a message was sent with no email")
		}
		if !strings.Contains(buf.String(), "no_email_for_user") {
			t.Errorf("no reason=no_email_for_user: %s", buf.String())
		}
	})

	t.Run("sqs_send_failed carries email_hash", func(t *testing.T) {
		var buf strings.Builder
		client := &fakeSQS{err: errors.New("queue unreachable")}
		p := sqs.NewPublisher(client, "q",
			stubResolver{user: grpcusers.ResolvedUser{Email: "person@example.com"}},
			slog.New(slog.NewJSONHandler(&buf, nil)))

		p.PublishTrackingStatusChanged(t.Context(), fullInput())

		out := buf.String()
		if !strings.Contains(out, "sqs_send_failed") {
			t.Errorf("no reason=sqs_send_failed: %s", out)
		}
		if !strings.Contains(out, sqs.HashEmail("person@example.com")) {
			t.Errorf("sqs_send_failed must carry email_hash: %s", out)
		}
		// NEVER the plaintext address.
		if strings.Contains(out, "person@example.com") {
			t.Errorf("the log line leaked a plaintext email: %s", out)
		}
	})

	t.Run("publisher_unavailable when the queue url is empty", func(t *testing.T) {
		var buf strings.Builder
		client := &fakeSQS{}
		p := sqs.NewPublisher(client, "",
			stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}},
			slog.New(slog.NewJSONHandler(&buf, nil)))

		p.PublishTrackingStatusChanged(t.Context(), fullInput())

		if client.count() != 0 {
			t.Error("a message was sent with no queue url")
		}
		if !strings.Contains(buf.String(), "publisher_unavailable") {
			t.Errorf("no reason=publisher_unavailable: %s", buf.String())
		}
	})
}

// The address, the name and the email never appear in any log line.
func TestNoPIIIsLogged(t *testing.T) {
	var buf strings.Builder
	client := &fakeSQS{err: errors.New("boom")}
	p := sqs.NewPublisher(client, "q",
		stubResolver{user: grpcusers.ResolvedUser{
			Email: "person@example.com", FullName: "Ada Lovelace"}},
		slog.New(slog.NewJSONHandler(&buf, nil)))

	p.PublishTrackingStatusChanged(t.Context(), fullInput())

	for _, forbidden := range []string{"person@example.com", "Ada Lovelace", "1 Test St", "Austin", "78701"} {
		if strings.Contains(buf.String(), forbidden) {
			t.Errorf("the log leaked PII %q: %s", forbidden, buf.String())
		}
	}
}

func TestNoopPublisherSendsNothing(t *testing.T) {
	sqs.NewNoopPublisher().PublishTrackingStatusChanged(t.Context(), fullInput())
}
