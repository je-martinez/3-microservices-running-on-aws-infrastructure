// Package sqs publishes TRACKING_STATUS_CHANGED onto the shared events queue.
//
// CONTRACT: The consumer owns the wire shape — build the envelope against
// functions/events-pipeline/src/domain/envelope.ts. A misnamed field is a
// PermanentError: consumed, not retried, no email, nothing upstream notices.
// See [[events-pipeline-design]]
//
// CONTRACT: Do NOT propagate a publish failure. The transition is already
// committed, so raising makes the carrier webhook retry a transition the
// forward-only state machine rejects with 400, and ends a TestMode run three
// transitions early. Delivery is at-most-once; failures log ERROR with a reason.
package sqs

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"

	"github.com/aws/aws-sdk-go-v2/aws"
	awssqs "github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	oteltrace "go.opentelemetry.io/otel/trace"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers"
	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// PublishSpanName names the queue hop after what is published, not where it
// goes: all three producers share one queue, and Orders uses the same shape
// (`sqs.publish order_created`) so one query reads the hop across producers.
const PublishSpanName = "sqs.publish tracking_status_changed"

const (
	appEventPublishFailed    = "tracking_status_changed_publish_failed"
	appEventPublishSucceeded = "tracking_status_changed_published"
)

// SendMessageAPI is the one SQS call this package makes, declared here by the
// consumer so the SDK client satisfies it directly.
type SendMessageAPI interface {
	SendMessage(ctx context.Context, in *awssqs.SendMessageInput, opts ...func(*awssqs.Options)) (*awssqs.SendMessageOutput, error)
}

// UserResolver is declared here by its consumer, so the grpcusers client
// satisfies it without importing this package.
//
// WHY: The publisher resolves the user because the pipeline's handler requires
// email and full_name, which Tracking persists neither of. Resolving in the
// update command instead would put a Users outage inside a database write.
type UserResolver interface {
	Resolve(ctx context.Context, identifier string) (grpcusers.ResolvedUser, error)
}

// WARNING: email, full_name and shipping_address travel in this payload and
// NOWHERE else. Failure lines carry email_hash, user_id and order_id only.
// See [[logging-context]]

// Publisher emits one transition. PublishTrackingStatusChanged NEVER returns an
// error — that is the contract, not an implementation detail.
type Publisher interface {
	PublishTrackingStatusChanged(ctx context.Context, in StatusChanged)
}

type publisher struct {
	client   SendMessageAPI
	queueURL string
	resolve  UserResolver
	log      *slog.Logger
}

// NewPublisher builds the SQS-backed publisher.
func NewPublisher(client SendMessageAPI, queueURL string, resolve UserResolver, log *slog.Logger) Publisher {
	if log == nil {
		log = slog.Default()
	}
	return &publisher{client: client, queueURL: queueURL, resolve: resolve, log: log}
}

// PublishTrackingStatusChanged emits one transition. Never fails the caller.
//
// INVARIANT: creation NEVER emits an event. Only status updates do. A TestMode
// run therefore produces 5 history rows and 4 events.
func (p *publisher) PublishTrackingStatusChanged(ctx context.Context, in StatusChanged) {
	if p.queueURL == "" || p.client == nil || p.resolve == nil {
		// The publisher could not be obtained or was built without a queue. In
		// Python this reason is raised one layer up, by update_status's guard
		// around acquiring the publisher at all; here the same condition is
		// structural, so it is checked where it can actually be observed.
		p.fail(ctx, "publisher_unavailable", in, "")
		return
	}

	user, err := p.resolve.Resolve(ctx, in.UserID)
	if err != nil {
		p.fail(ctx, "email_resolution_failed", in, "")
		return
	}
	if user.Email == "" {
		// ABORT BEFORE BUILDING ANYTHING: the handler rejects a payload without
		// an email as a PERMANENT error, so the mail would never be sent and the
		// record would be consumed.
		p.fail(ctx, "no_email_for_user", in, "")
		return
	}

	body, err := json.Marshal(buildEnvelope(ctx, in, user))
	if err != nil {
		p.fail(ctx, "sqs_send_failed", in, HashEmail(user.Email))
		return
	}

	ctx, span := tracing.Tracer(tracing.TracerMessaging).Start(ctx, PublishSpanName,
		oteltrace.WithSpanKind(oteltrace.SpanKindProducer),
		oteltrace.WithAttributes(
			attribute.String("app_event", appEventPublishSucceeded),
			attribute.String("messaging.system", "aws_sqs"),
			attribute.String("event_type", EventType),
			attribute.String("event_id", DeriveEventID(in.OrderID, in.Status)),
			attribute.String("order_id", in.OrderID),
		),
	)
	defer span.End()

	_, err = p.client.SendMessage(ctx, &awssqs.SendMessageInput{
		QueueUrl:    aws.String(p.queueURL),
		MessageBody: aws.String(string(body)),
		// The trace context is injected INSIDE this span — see
		// buildMessageAttributes.
		MessageAttributes: buildMessageAttributes(ctx),
	})
	if err != nil {
		// The span going ERROR is the only place this failure is visible in a
		// waterfall: the caller sees nothing, by the policy above.
		span.SetStatus(codes.Error, "sqs_send_failed")
		p.fail(ctx, "sqs_send_failed", in, HashEmail(user.Email))
		return
	}
	span.SetStatus(codes.Ok, "")

	// The span's OWN line, so "View logs" on it in OpenObserve finds something.
	// It names WHICH notification was emitted and nothing it contained.
	p.log.InfoContext(ctx, appEventPublishSucceeded,
		slog.String("app_event", appEventPublishSucceeded),
		slog.String("event_type", EventType),
		slog.String("event_id", DeriveEventID(in.OrderID, in.Status)),
		slog.String("order_id", in.OrderID),
		slog.String("user_id", in.UserID),
		slog.String("status", in.Status),
	)
}

// fail logs one of the four reasons and returns. Never raises.
//
// emailHash is carried ONLY on sqs_send_failed, where an address was resolved and
// the send is what broke — the other three have no resolved address to identify.
// The plaintext email never appears.
func (p *publisher) fail(ctx context.Context, reason string, in StatusChanged, emailHash string) {
	attrs := []any{
		slog.String("app_event", appEventPublishFailed),
		slog.String("reason", reason),
		// These fields and no more: the line names WHICH notification was lost,
		// never what it would have contained — no address, no name, no history.
		slog.String("order_id", in.OrderID),
		slog.String("user_id", in.UserID),
		slog.String("status", in.Status),
	}
	if emailHash != "" {
		attrs = append(attrs, slog.String("email_hash", emailHash))
	}
	p.log.ErrorContext(ctx, appEventPublishFailed, attrs...)
}

// buildEnvelope assembles the wire shape field by field. Every omission below is
// a rule, not a style choice — see envelope.go.
func buildEnvelope(ctx context.Context, in StatusChanged, user grpcusers.ResolvedUser) envelope {
	history := make([]historyEntry, 0, len(in.History))
	for _, entry := range in.History {
		history = append(history, historyEntry{
			Status:   entry.Status,
			Datetime: entry.Datetime.UTC().Format(timestampLayout),
		})
	}

	env := envelope{
		EventID: DeriveEventID(in.OrderID, in.Status),
		Type:    EventType,
		Source:  EventSource,
		UserID:  in.UserID,
		OrderID: in.OrderID,
		Author: author{
			Actor: string(in.Actor),
			// Omitted when empty; comes off the persisted row, never the request.
			CognitoSub: in.CognitoSub,
		},
		Payload: payload{
			Status:         in.Status,
			PreviousStatus: in.PreviousStatus,
			ChangedAt:      in.ChangedAt.UTC().Format(timestampLayout),
			Email:          user.Email,
			// ALWAYS present, "" when unknown.
			FullName:       user.FullName,
			OrderID:        in.OrderID,
			TrackingNumber: in.TrackingNumber,
			// Raw JSON forwarded byte-for-byte as an OBJECT, or omitted. Never a
			// string, and never null — see omittableAddress.
			ShippingAddress: omittableAddress(in.ShippingAddress),
			History:         history,
		},
	}

	// Omitted when empty, never null, never "".
	for _, field := range logging.LogFields(ctx) {
		if field.Key == logging.KeyRequestID {
			env.RequestID = field.Value.String()
			break
		}
	}
	return env
}

// omittableAddress returns the address bytes to place on the wire, or nil to have
// omitempty drop the key entirely.
//
// CONTRACT: shipping_address is a JSON OBJECT or NO KEY AT ALL — the pipeline's
// Zod schema is .optional() and not .nullable(), so anything else is a
// PermanentError that consumes the record and loses the email and the WebSocket
// push. Nil bytes, zero-length bytes and the literal document `null` (which
// omitempty does not catch) all become nil here. Everything else forwards
// UNPARSED, because Orders owns the shape. See [[events-pipeline-design]]
func omittableAddress(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	if string(bytes.TrimSpace(raw)) == "null" {
		return nil
	}
	return raw
}

// buildMessageAttributes returns type, source, and the W3C trace context.
//
// CONTRACT: Call this INSIDE the publish span. The propagator reads whichever
// span is active, so one line earlier it writes the enclosing workflow span's id
// and the pipeline's spans hang BESIDE the publish instead of under it — a trace
// that still looks complete. traceparent rides in MessageAttributes, not in the
// envelope, which stays the domain contract; blank values are skipped so the
// consumer never sees a malformed-but-present context.
// See [[ADR-0019-distributed-tracing-opentelemetry]]
func buildMessageAttributes(ctx context.Context) map[string]sqstypes.MessageAttributeValue {
	attributes := map[string]sqstypes.MessageAttributeValue{
		"type":   {DataType: aws.String("String"), StringValue: aws.String(EventType)},
		"source": {DataType: aws.String("String"), StringValue: aws.String(EventSource)},
	}

	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	for key, value := range carrier {
		if value == "" {
			continue
		}
		attributes[key] = sqstypes.MessageAttributeValue{
			DataType:    aws.String("String"),
			StringValue: aws.String(value),
		}
	}
	return attributes
}

// noopPublisher discards every call.
//
// WHY: A test or environment that must not emit binds this, so the command never
// grows an `if publishEnabled` branch. It records nothing on purpose — a test
// asserting on what was published uses its own recording fake.
type noopPublisher struct{}

// NewNoopPublisher returns the discarding publisher.
func NewNoopPublisher() Publisher { return noopPublisher{} }

func (noopPublisher) PublishTrackingStatusChanged(context.Context, StatusChanged) {}
