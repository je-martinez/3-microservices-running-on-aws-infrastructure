package otel

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	oteltrace "go.opentelemetry.io/otel/trace"
)

// EndFunc closes a workflow span. Pass the flow's error, or nil on success.
type EndFunc func(err error)

// WorkflowSpan opens one INTERNAL span named after a business flow — the unit a
// person asks about, which auto-instrumentation cannot see.
//
// CONTRACT: Call the returned EndFunc on EVERY path. An unclosed span is an
// error nowhere: it silently never reaches the backend and the flow vanishes
// from the cascade while the code still looks instrumented.
//
// CONTRACT: Record the error EXACTLY ONCE — RecordError once, SetStatus
// explicitly, and no second deferred recorder, which would overwrite the chosen
// status description. See [[ADR-0019-distributed-tracing-opentelemetry]]
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

// MarkPhase records a lifecycle milestone as an EVENT on the active span, so a
// failed flow shows how far it got. No-ops when nothing is recording.
//
// WARNING: No PII. Lifecycle vocabulary only — never the payload, an address or
// an email. `reason` carries the same sanitized token the *_failed line does.
// See [[logging-context]]
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
