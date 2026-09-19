package notify_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/notify"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/sqs"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/outbox"
)

// storedMessage renders a payload the way the transition's outbox write does, so
// this suite tests against the real encoding rather than a hand-built JSON string
// that could drift from it.
func storedMessage(t *testing.T, payload mysql.OutboxPayload) outbox.Message {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encoding the stored payload: %v", err)
	}
	return outbox.Message{ID: uuid.New(), Payload: raw}
}

// recordingOutboxSQS records what the bridge handed the SNS publisher.
type recordingOutboxSQS struct {
	calls []sqs.StatusChanged
	err   error
}

func (r *recordingOutboxSQS) TryPublishTrackingStatusChanged(_ context.Context, in sqs.StatusChanged) error {
	r.calls = append(r.calls, in)
	return r.err
}

func samplePayload() mysql.OutboxPayload {
	at := time.Date(2026, 9, 19, 15, 4, 5, 0, time.UTC)
	return mysql.OutboxPayload{
		OrderID:     "ord_1",
		OrderNumber: "2609078KJ4M2",
		// TWO DIFFERENT identity values, so a swap between them fails.
		UserID:         "usr_internal",
		Status:         "SHIPPED",
		PreviousStatus: "PLACED",
		TrackingNumber: "3MRAI-1111-2222-3333",
		ChangedAt:      at,
		History: []mysql.OutboxHistory{
			{Status: "PLACED", Datetime: at.Add(-time.Hour)},
			{Status: "SHIPPED", Datetime: at},
		},
		Actor:      audit.CarrierStatusUpdate,
		CognitoSub: "sub-uuid",
	}
}

// TestTheOutboxPublisherRebuildsTheEnvelopeFromTheStoredPayload pins that nothing
// is re-read from the database at publish time.
//
// CONTRACT: Every field comes off the STORED payload. Re-reading the row here
// publishes the CURRENT status under an older transition's event id, and
// previous_status is not recoverable at all. See [[events-pipeline-design]]
func TestTheOutboxPublisherRebuildsTheEnvelopeFromTheStoredPayload(t *testing.T) {
	recorded := &recordingOutboxSQS{}
	publisher := notify.NewOutboxSNSPublisher(recorded)

	if err := publisher.Publish(t.Context(), storedMessage(t, samplePayload())); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	if len(recorded.calls) != 1 {
		t.Fatalf("published %d events, want 1", len(recorded.calls))
	}
	got := recorded.calls[0]

	if got.OrderID != "ord_1" {
		t.Errorf("order_id = %q", got.OrderID)
	}
	if got.OrderNumber != "2609078KJ4M2" {
		t.Errorf("order_number = %q", got.OrderNumber)
	}
	if got.UserID != "usr_internal" {
		t.Errorf("user_id = %q, want the row's internal usr_ id", got.UserID)
	}
	if got.CognitoSub != "sub-uuid" {
		t.Errorf("cognito_sub = %q — it becomes author.cognito_sub, the key the pipeline "+
			"routes the WebSocket push by; a usr_ id there reaches nobody", got.CognitoSub)
	}
	if got.Status != "SHIPPED" {
		t.Errorf("status = %q", got.Status)
	}
	if got.PreviousStatus != "PLACED" {
		t.Errorf("previous_status = %q — the one field no later read can reconstruct",
			got.PreviousStatus)
	}
	if got.TrackingNumber != "3MRAI-1111-2222-3333" {
		t.Errorf("tracking_number = %q", got.TrackingNumber)
	}
	if !got.ChangedAt.Equal(samplePayload().ChangedAt) {
		t.Errorf("changed_at = %v, want the TRANSITION's own timestamp", got.ChangedAt)
	}
	// The actor threads through rather than being chosen here: this path serves
	// both the carrier webhook and TestMode, and a constant would relabel every
	// automatic progression as a real carrier update.
	if got.Actor != audit.CarrierStatusUpdate {
		t.Errorf("actor = %q", got.Actor)
	}
	if len(got.History) != 2 {
		t.Fatalf("history has %d entries, want 2", len(got.History))
	}
	if got.History[1].Status != "SHIPPED" {
		t.Errorf("history[1].status = %q — the announced timeline must contain the "+
			"transition being announced", got.History[1].Status)
	}
}

// TestTheAddressIsForwardedByteForByte pins the shape the pipeline's Zod schema
// requires.
//
// CONTRACT: The address is a JSON OBJECT forwarded unparsed. Narrowing it to a
// string re-encodes the object as a JSON string, which the consumer's z.record
// rejects as a PermanentError — the record is consumed and both the email and the
// WebSocket push are lost while this service logs success.
// See [[events-pipeline-design]]
func TestTheAddressIsForwardedByteForByte(t *testing.T) {
	const address = `{"city":"Austin","line1":"1 Test St","postal_code":"78701"}`

	payload := samplePayload()
	payload.ShippingAddress = json.RawMessage(address)

	recorded := &recordingOutboxSQS{}
	if err := notify.NewOutboxSNSPublisher(recorded).
		Publish(t.Context(), storedMessage(t, payload)); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	var forwarded, original map[string]any
	if err := json.Unmarshal(recorded.calls[0].ShippingAddress, &forwarded); err != nil {
		t.Fatalf("the forwarded address is not a JSON object: %v\n%s",
			err, recorded.calls[0].ShippingAddress)
	}
	if err := json.Unmarshal([]byte(address), &original); err != nil {
		t.Fatalf("the fixture is not valid JSON: %v", err)
	}
	if len(forwarded) != len(original) {
		t.Errorf("the address gained or lost fields in transit: %v vs %v", forwarded, original)
	}
	for key, want := range original {
		if forwarded[key] != want {
			t.Errorf("address[%q] = %v, want %v", key, forwarded[key], want)
		}
	}
}

// TestAnUndecodablePayloadIsAPermanentFailure pins what happens to a row nothing
// can parse.
//
// CONTRACT: Return an error. Returning nil DELETES the row — a message thrown away
// in silence. An error retains it, so it ends at the attempt limit with a discard
// line naming it, which is the only trace anybody gets. See [[cqrs]]
func TestAnUndecodablePayloadIsAPermanentFailure(t *testing.T) {
	recorded := &recordingOutboxSQS{}
	publisher := notify.NewOutboxSNSPublisher(recorded)

	err := publisher.Publish(t.Context(), outbox.Message{
		ID:      uuid.New(),
		Payload: []byte(`{"order_id": this is not json`),
	})
	if err == nil {
		t.Fatal("an undecodable payload must fail, or the poller deletes the row and the " +
			"notification is lost with nothing recording it")
	}
	if len(recorded.calls) != 0 {
		t.Errorf("published %d events from an undecodable payload, want 0", len(recorded.calls))
	}
}

// TestAPublishFailureIsReportedToThePoller is the load-bearing inversion of the
// SNS publisher's own contract.
//
// CONTRACT: sqs.Publisher NEVER returns an error, because inline it runs after a
// committed write and must not fail it. The poller NEEDS the failure: it is what
// retains the row. A bridge swallowing it deletes every message on the first SNS
// outage. See [[cqrs]]
func TestAPublishFailureIsReportedToThePoller(t *testing.T) {
	failing := &failingSQS{err: errors.New("sns is unreachable")}
	publisher := notify.NewOutboxSNSPublisher(failing)

	err := publisher.Publish(t.Context(), storedMessage(t, samplePayload()))
	if err == nil {
		t.Fatal("a failed SNS publish must be reported, or the poller deletes the row " +
			"and the customer's notification is lost")
	}
}

// TestASuccessfulPublishReportsNoError closes the pair above: the bridge must not
// report failure for a delivery that worked, or every message is republished
// forever.
func TestASuccessfulPublishReportsNoError(t *testing.T) {
	recorded := &recordingOutboxSQS{}
	if err := notify.NewOutboxSNSPublisher(recorded).
		Publish(t.Context(), storedMessage(t, samplePayload())); err != nil {
		t.Fatalf("a successful publish must report no error: %v", err)
	}
}

// failingSQS reports every publish as failed.
type failingSQS struct {
	err error
}

func (f *failingSQS) TryPublishTrackingStatusChanged(context.Context, sqs.StatusChanged) error {
	return f.err
}
