package otel

import (
	"context"
	"log/slog"

	oteltrace "go.opentelemetry.io/otel/trace"
)

// TraceHandler stamps the active span's ids onto every log record.
//
// Logs and traces travel two different paths: stdout -> Docker's fluentd driver
// -> OpenObserve for logs, OTLP -> the collector -> OpenObserve for traces.
// Nothing joins them automatically. trace_id on the log line is the ONLY thing
// that lets a dashboard answer "show me every line, in every service, for the
// request that produced this slow span".
//
// Measured before the Python equivalent existed: Tracking emitted 0 of 348 log
// lines with a trace_id, while Users emitted 32/42 and Orders 53/64 — so a trace
// that crossed into Tracking simply lost its logs at the boundary.
//
// THE TWO RULES THAT MATTER:
//
//  1. LOWERCASE HEX, zero-padded to 32 and 16 characters. Users and Orders emit
//     that form, and a join is string equality — any other rendering silently
//     matches nothing.
//  2. OMITTED, NEVER ZEROED, when there is no valid span. Startup lines, the
//     metrics ticker and background work have no span; writing
//     trace_id: "000...0" would be worse than writing nothing, because it reads
//     as a real id and 30 unrelated lines would appear to share a trace.
type TraceHandler struct{ inner slog.Handler }

// NewTraceHandler wraps inner so records carry trace_id/span_id when a span is
// active.
func NewTraceHandler(inner slog.Handler) slog.Handler { return &TraceHandler{inner: inner} }

func (h *TraceHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h *TraceHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &TraceHandler{inner: h.inner.WithAttrs(attrs)}
}

func (h *TraceHandler) WithGroup(name string) slog.Handler {
	return &TraceHandler{inner: h.inner.WithGroup(name)}
}

func (h *TraceHandler) Handle(ctx context.Context, r slog.Record) error {
	sc := oteltrace.SpanContextFromContext(ctx)
	// IsValid is false both when there is no span at all and when the context is
	// the all-zero invalid one — exactly the cases where the fields must be
	// absent rather than zeroed.
	if !sc.IsValid() {
		return h.inner.Handle(ctx, r)
	}

	enriched := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	// Call-site attributes first, so an explicit trace_id wins — the same
	// precedence rule the log context follows.
	r.Attrs(func(a slog.Attr) bool {
		enriched.AddAttrs(a)
		return true
	})
	// TraceID.String() and SpanID.String() are already lowercase hex, padded to
	// 32 and 16 characters.
	enriched.AddAttrs(
		slog.String("trace_id", sc.TraceID().String()),
		slog.String("span_id", sc.SpanID().String()),
	)
	return h.inner.Handle(ctx, enriched)
}
