// Package sqs publishes TRACKING_STATUS_CHANGED onto the shared SNS events
// topic, which fans it out to the pipeline's queue and the notifications queue.
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
	"errors"
	"fmt"
	"log/slog"

	"github.com/aws/aws-sdk-go-v2/aws"
	awssns "github.com/aws/aws-sdk-go-v2/service/sns"
	snstypes "github.com/aws/aws-sdk-go-v2/service/sns/types"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	oteltrace "go.opentelemetry.io/otel/trace"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers"
	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// PublishSpanName names the topic hop after what is published, not where it
// goes: all three producers share one topic, and Orders uses the same shape
// (`sns.publish order_created`) so one query reads the hop across producers.
const PublishSpanName = "sns.publish tracking_status_changed"

const (
	appEventPublishFailed    = "tracking_status_changed_publish_failed"
	appEventPublishSucceeded = "tracking_status_changed_published"
)

// The two structural failures that carry no wrapped cause.
var (
	// ErrPublisherUnavailable means this process has no usable topic or client.
	ErrPublisherUnavailable = errors.New("sqs: publisher unavailable")
	// ErrNoEmailForUser means the pipeline's handler would reject the payload as a
	// PERMANENT error, so sending it would consume the record and deliver nothing.
	ErrNoEmailForUser = errors.New("sqs: no email for user")
)

// PublishAPI is the one SNS call this package makes, declared here by the
// consumer so the SDK client satisfies it directly.
type PublishAPI interface {
	Publish(ctx context.Context, in *awssns.PublishInput, opts ...func(*awssns.Options)) (*awssns.PublishOutput, error)
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
//
// CONTRACT: ONE void method. The poller's returned error comes from the separate
// FailablePublisher; folding both in here makes every inline-path stub grow a
// method it never calls. See [[cqrs]]
type Publisher interface {
	PublishTrackingStatusChanged(ctx context.Context, in StatusChanged)
}

// FailablePublisher reports whether a publish went out.
//
// CONTRACT: For the OUTBOX POLLER alone. Its error is what retains the row for a
// retry, so the void form there deletes undelivered messages. Both forms log every
// failure identically; only the return differs. See [[cqrs]]
type FailablePublisher interface {
	Publisher
	TryPublishTrackingStatusChanged(ctx context.Context, in StatusChanged) error
}

type publisher struct {
	client   PublishAPI
	topicARN string
	resolve  UserResolver
	log      *slog.Logger
}

// NewPublisher builds the SNS-backed publisher.
//
// CONTRACT: Do NOT rename this package to `sns`.
// cmd/server/wiring_reachability_test.go pins the import path and asserts the
// composition root reaches this constructor; a rename silences that guard
// unless its inventory moves in the same change.
func NewPublisher(client PublishAPI, topicARN string, resolve UserResolver, log *slog.Logger) FailablePublisher {
	if log == nil {
		log = slog.Default()
	}
	return &publisher{client: client, topicARN: topicARN, resolve: resolve, log: log}
}

// PublishTrackingStatusChanged emits one transition. Never fails the caller.
//
// CONTRACT: Stays void. It runs AFTER a committed write, and a raised failure makes
// the carrier retry a transition the forward-only guard rejects as 400. The poller
// calls TryPublishTrackingStatusChanged instead. See [[cqrs]]
//
// INVARIANT: creation NEVER emits an event. Only status updates do. A TestMode
// run therefore produces 5 history rows and 4 events.
func (p *publisher) PublishTrackingStatusChanged(ctx context.Context, in StatusChanged) {
	_ = p.TryPublishTrackingStatusChanged(ctx, in)
}

// TryPublishTrackingStatusChanged emits one transition and REPORTS whether it
// went out.
//
// CONTRACT: For the OUTBOX POLLER only. Its caller retains the row and retries on
// an error, so swallowing here deletes an undelivered message. Every failure is
// still logged as the void path logs it; the error is additional. See [[cqrs]]
func (p *publisher) TryPublishTrackingStatusChanged(ctx context.Context, in StatusChanged) error {
	if p.topicARN == "" || p.client == nil || p.resolve == nil {
		// The publisher could not be obtained or was built without a topic. In
		// Python this reason is raised one layer up, by update_status's guard
		// around acquiring the publisher at all; here the same condition is
		// structural, so it is checked where it can actually be observed.
		p.fail(ctx, "publisher_unavailable", in, "")
		return ErrPublisherUnavailable
	}

	user, err := p.resolve.Resolve(ctx, in.UserID)
	if err != nil {
		p.fail(ctx, "email_resolution_failed", in, "")
		return fmt.Errorf("sqs: resolve user for the notification: %w", err)
	}
	if user.Email == "" {
		// ABORT BEFORE BUILDING ANYTHING: the handler rejects a payload without
		// an email as a PERMANENT error, so the mail would never be sent and the
		// record would be consumed.
		p.fail(ctx, "no_email_for_user", in, "")
		return ErrNoEmailForUser
	}

	body, err := json.Marshal(buildEnvelope(ctx, in, user))
	if err != nil {
		p.fail(ctx, "sns_publish_failed", in, HashEmail(user.Email))
		return fmt.Errorf("sqs: encode the envelope: %w", err)
	}

	ctx, span := tracing.Tracer(tracing.TracerMessaging).Start(ctx, PublishSpanName,
		oteltrace.WithSpanKind(oteltrace.SpanKindProducer),
		oteltrace.WithAttributes(
			attribute.String("app_event", appEventPublishSucceeded),
			attribute.String("messaging.system", "aws_sns"),
			attribute.String("event_type", EventType),
			attribute.String("event_id", DeriveEventID(in.OrderID, in.Status)),
			attribute.String("order_id", in.OrderID),
		),
	)
	defer span.End()

	_, err = p.client.Publish(ctx, &awssns.PublishInput{
		TopicArn: aws.String(p.topicARN),
		Message:  aws.String(string(body)),
		// The trace context is injected INSIDE this span — see
		// buildMessageAttributes.
		MessageAttributes: buildMessageAttributes(ctx),
	})
	if err != nil {
		// The span going ERROR is the only place this failure is visible in a
		// waterfall: the caller sees nothing, by the policy above.
		span.SetStatus(codes.Error, "sns_publish_failed")
		p.fail(ctx, "sns_publish_failed", in, HashEmail(user.Email))
		return fmt.Errorf("sqs: publish to sns: %w", err)
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
	return nil
}

// fail logs one of the four reasons and returns. Never raises.
//
// emailHash is carried ONLY on sns_publish_failed, where an address was resolved and
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
			OrderNumber:    omittableOrderNumber(in.OrderNumber),
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

// omittableOrderNumber returns both wire forms of the order number, or nil to
// have omitempty drop the key entirely.
//
// CONTRACT: nil for "", never an object of empty strings. A present-but-blank
// order number renders as an empty gap on a receipt, where an absent one makes
// the template fall back to the order id — which is the intended degradation for
// an order predating the backfill. See [[friendly-order-number]]
func omittableOrderNumber(canonical string) *orderNumber {
	if canonical == "" {
		return nil
	}
	return &orderNumber{
		Raw:       canonical,
		Formatted: domain.FormatOrderNumber(canonical),
	}
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
// consumer never sees a malformed-but-present context. Raw message delivery
// forwards these to the queue unchanged, so the shape is the same one SQS saw.
// See [[ADR-0019-distributed-tracing-opentelemetry]]
func buildMessageAttributes(ctx context.Context) map[string]snstypes.MessageAttributeValue {
	attributes := map[string]snstypes.MessageAttributeValue{
		"type":   {DataType: aws.String("String"), StringValue: aws.String(EventType)},
		"source": {DataType: aws.String("String"), StringValue: aws.String(EventSource)},
	}

	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	for key, value := range carrier {
		if value == "" {
			continue
		}
		attributes[key] = snstypes.MessageAttributeValue{
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
func NewNoopPublisher() FailablePublisher { return noopPublisher{} }

func (noopPublisher) PublishTrackingStatusChanged(context.Context, StatusChanged) {}

// TryPublishTrackingStatusChanged reports success, because discarding IS this
// publisher's whole job. Reporting a failure would make the poller retain and
// retry every message forever against a publisher that will never send one.
func (noopPublisher) TryPublishTrackingStatusChanged(context.Context, StatusChanged) error {
	return nil
}
