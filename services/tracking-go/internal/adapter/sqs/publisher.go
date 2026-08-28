// Package sqs publishes TRACKING_STATUS_CHANGED onto the shared events queue.
//
// # The wire contract, and where it comes from
//
// THE AUTHORITY IS THE CONSUMER, not this file:
// functions/events-pipeline/src/domain/envelope.ts and
// .../handlers/tracking-status-changed.ts. A missing or misnamed field is NOT a
// loud failure — the handler rejects it as a PermanentError, the record is
// consumed rather than retried, and the user never gets an email. Nothing
// upstream notices. That is why the envelope is built literally against those two
// schemas.
//
// # FAILURE POLICY: LOG AND SWALLOW
//
// Neither a failed email resolution nor a failed send propagates. The transition
// is already persisted and COMMITTED by the time this runs, and this endpoint's
// two callers make raising the worse option:
//
//   - The CARRIER WEBHOOK is an external third party. A 500 makes it retry the
//     PUT — and the retry hits the SAME transition it already applied, which the
//     forward-only state machine rejects with a 400. So the carrier would see a
//     permanent-looking failure for a status change we actually recorded, and
//     would keep redelivering until it gave up.
//   - TESTMODE PROGRESSION already swallows everything by design; an error here
//     would silently end the run three transitions early.
//
// The trade accepted is AT-MOST-ONCE delivery of the notification, which is the
// correct direction for this event: a missed "out for delivery" email is a
// degraded experience, while a duplicate one is a bug report.
//
// This is NOT silent: every failure is an ERROR line with a machine-readable
// reason, which is what makes it alertable.
//
// # PII
//
// email, full_name and shipping_address travel in the payload because the
// pipeline needs somewhere to send the mail and something to render in it, and
// NOWHERE else. None is ever logged: failure lines carry email_hash plus user_id
// and order_id, never the address, the name, or the delivery address.
package sqs

import (
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

// PublishSpanName is the queue hop's span name, NAMED AFTER WHAT IS PUBLISHED,
// not after where it goes.
//
// All three producers publish every event type onto the SAME shared queue, so a
// name identifying the transport reads as a distinction and is not one: a reader
// looking at a cascade could not tell a tracking transition from an order
// confirmation. This is the same shape Orders uses (`sqs.publish order_created`),
// so one query reads the queue hop across all producers.
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

// UserResolver is declared HERE, by the publisher that consumes it — narrow, one
// method, never a central interface file. The grpcusers client satisfies it
// without importing this package.
//
// The publisher resolves the user itself because the pipeline's handler REQUIRES
// email (and now full_name), and Tracking persists neither. Doing it here rather
// than in the update command keeps the command's job the state transition: it
// would otherwise have to handle a Users outage in the middle of a database
// write.
type UserResolver interface {
	Resolve(ctx context.Context, identifier string) (grpcusers.ResolvedUser, error)
}

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
			// An EXPLICIT nil check (the pointer's own nil-ness, which omitempty
			// reads), never truthiness: an empty string is a value the row
			// actually holds, and only NULL means "no address".
			ShippingAddress: in.ShippingAddress,
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

// buildMessageAttributes returns type, source, and the W3C trace context.
//
// # type and source
//
// Duplicated out of the envelope so the queue can be inspected and filtered
// without deserializing the body — the same two keys Users and Orders set.
//
// # traceparent, and why it rides HERE and not in the envelope
//
// SQS is where the trace would otherwise end: the pipeline's Lambda is a separate
// process reached through a queue, so nothing links its spans to the PUT that
// produced the message unless the context travels with it. MessageAttributes is
// the transport SQS gives us for exactly that.
//
// It is deliberately NOT a field of the envelope. The envelope is the DOMAIN
// contract with events-pipeline and a transport concern has no business in it;
// the consumer reads record.messageAttributes.traceparent.stringValue, which needs
// no schema change at all.
//
// # It MUST be called INSIDE the publish span
//
// The propagator reads whatever span is ACTIVE at the moment it runs, so WHERE
// this is called decides which span the consumer parents itself to. Evaluated one
// line earlier it would write the enclosing WORKFLOW span's id, and the pipeline's
// spans would hang BESIDE the publish rather than under it — a trace that still
// looks complete. Orders hit exactly this and fixed it the same way.
//
// # Omitted, never empty
//
// The propagator writes NOTHING into the carrier when there is no valid active
// span, so this loop adds zero keys rather than a blank traceparent. That matters:
// the consumer would treat "" as a malformed-but-present context, which is
// strictly worse than an absent one it can link nothing to.
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
// NOT dead code, and kept for the same reason Users and Orders keep theirs: a
// test (or an environment) that must not emit binds this instead, rather than the
// command growing an `if publishEnabled` branch that production would then carry
// forever.
//
// Deliberately records nothing. A test that needs to ASSERT on what was published
// uses its own recording fake — a Noop that silently swallowed the call cannot
// fail when the call stops happening.
type noopPublisher struct{}

// NewNoopPublisher returns the discarding publisher.
func NewNoopPublisher() Publisher { return noopPublisher{} }

func (noopPublisher) PublishTrackingStatusChanged(context.Context, StatusChanged) {}
