package otel

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	oteltrace "go.opentelemetry.io/otel/trace"
)

// EndFunc closes a workflow span. Pass the flow's error, or nil on success.
type EndFunc func(err error)

// WorkflowSpan opens one INTERNAL span named after a business flow.
//
// Auto-instrumentation can only see what a library does: an HTTP request, a SQL
// statement, an outbound gRPC call. It cannot see that four of those together
// are "a tracking was created", which is the unit a person actually asks about.
//
// The returned EndFunc MUST be called on every path, success and failure alike —
// `defer`red where the error is available, or called explicitly. An unclosed
// span is not an error anywhere: it silently never reaches the backend, and the
// flow disappears from the cascade while the code still looks instrumented.
//
// THE ERROR IS RECORDED EXACTLY ONCE. Python passes record_exception=False and
// set_status_on_exception=False because the SDK's own __exit__ runs AFTER the
// except arm and would record the exception a SECOND time and overwrite the
// chosen status description. The Go equivalent of that discipline is here:
// RecordError once, SetStatus explicitly, and no second deferred recorder
// anywhere. Verified, not theoretical.
func WorkflowSpan(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, EndFunc) {
	ctx, span := provider.Tracer(TracerWorkflow).Start(ctx, name,
		oteltrace.WithSpanKind(oteltrace.SpanKindInternal),
		oteltrace.WithAttributes(attrs...),
	)

	return ctx, func(err error) {
		if err != nil {
			span.RecordError(err)
			// The description is the error's own text; the machine-readable
			// `reason` is a separate attribute the caller sets, matching its log
			// line's `reason` so trace and logs tell one story.
			span.SetStatus(codes.Error, err.Error())
		} else {
			span.SetStatus(codes.Ok, "")
		}
		span.End()
	}
}

// SetSpanAttributes attaches what a flow only learns part-way through — the
// tracking_id it just wrote, the reason a failure branch logged.
func SetSpanAttributes(ctx context.Context, attrs ...attribute.KeyValue) {
	span := oteltrace.SpanFromContext(ctx)
	if span.IsRecording() {
		span.SetAttributes(attrs...)
	}
}

// MarkPhase records a lifecycle milestone as an EVENT on the active span.
//
// An event, not a span, because a milestone is an INSTANT — it has no duration
// to draw. What it buys is the answer to "how far did this request get?" on a
// flow that failed: the span alone shows a workflow that ended, while the events
// show it resolved the user and then died creating the tracking.
//
// No-ops when nothing is recording, so it is safe on paths that also run outside
// a request. No PII, by the same rule the log lines follow: lifecycle vocabulary
// only, never the payload, never an address, never an email. `reason` carries
// the same already-sanitized token the matching *_failed line does, and is
// omitted when empty.
func MarkPhase(ctx context.Context, name, reason string) {
	span := oteltrace.SpanFromContext(ctx)
	if !span.IsRecording() {
		return
	}
	if reason == "" {
		span.AddEvent(name)
		return
	}
	span.AddEvent(name, oteltrace.WithAttributes(attribute.String("reason", reason)))
}
