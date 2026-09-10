package otel

import (
	"context"
	"log/slog"

	oteltrace "go.opentelemetry.io/otel/trace"
)

// TraceHandler stamps the active span's ids onto every log record. Logs and
// traces reach OpenObserve by different transports and nothing joins them
// automatically, so trace_id on the line is the only join key.
//
// CONTRACT: LOWERCASE HEX, zero-padded to 32 and 16 characters — the join is
// string equality, and any other rendering silently matches nothing.
//
// CONTRACT: OMITTED, never zeroed, with no valid span. Startup lines, the ticker
// and background work have none, and trace_id "000…0" reads as a real id that
// unrelated lines appear to share. See [[logging-context]]
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
