package logging

import (
	"context"
	"log/slog"
)

// The seven keys the shared cross-service log context may carry. A FIXED set
// rather than a free map: the field names are a convention shared by all four
// services, so one dashboard query spans them. A typo'd key would otherwise
// silently become a new indexed field nobody ever queries.
const (
	KeyCognitoSub  = "cognito_sub"
	KeyUserID      = "user_id"
	KeyOrderID     = "order_id"
	KeyTrackingID  = "tracking_id"
	KeyEmailHash   = "email_hash"
	KeyRequestID   = "request_id"
	KeyCacheResult = "cache_result"
)

var allowedKeys = map[string]bool{
	KeyCognitoSub: true, KeyUserID: true, KeyOrderID: true, KeyTrackingID: true,
	KeyEmailHash: true, KeyRequestID: true, KeyCacheResult: true,
}

type logFieldsKey struct{}

// WithLogFields merges fields into ctx's log context and returns a NEW context.
//
// CONTRACT: Never mutate in place — a mutated slice leaks into every context
// holding the same reference, so a goroutine started earlier observes a merge it
// was never meant to see. Unknown keys, nil values and empty strings are
// dropped: an empty user_id reads as a resolved blank identity.
// See [[logging-context]]
func WithLogFields(ctx context.Context, fields ...slog.Attr) context.Context {
	existing := LogFields(ctx)

	overridden := make(map[string]bool, len(fields))
	for _, f := range fields {
		if keep(f) {
			overridden[f.Key] = true
		}
	}

	merged := make([]slog.Attr, 0, len(existing)+len(fields))
	// A later merge overrides an earlier one for the same key — that is how the
	// late-resolved usr_ id reaches every line after the gRPC call.
	for _, e := range existing {
		if !overridden[e.Key] {
			merged = append(merged, e)
		}
	}
	for _, f := range fields {
		if keep(f) {
			merged = append(merged, f)
		}
	}
	if len(merged) == 0 {
		return ctx
	}
	return context.WithValue(ctx, logFieldsKey{}, merged)
}

// LogFields returns the active context's fields, or nil outside a request.
func LogFields(ctx context.Context) []slog.Attr {
	if ctx == nil {
		return nil
	}
	fields, _ := ctx.Value(logFieldsKey{}).([]slog.Attr)
	return fields
}

// keep applies the allow-list and the omitted-never-null rule at MERGE time, so
// a caller merging an unresolved identity costs nothing and adds no field.
func keep(a slog.Attr) bool {
	if !allowedKeys[a.Key] {
		return false
	}
	v := a.Value.Resolve()
	if v.Any() == nil {
		return false
	}
	if v.Kind() == slog.KindString && v.String() == "" {
		return false
	}
	return true
}

// ContextHandler merges the ambient log context into every record before the
// inner handler renders it. Wrapping the HANDLER rather than the logger makes
// the enrichment unconditional, with no logger threaded through constructors.
type ContextHandler struct{ inner slog.Handler }

// NewContextHandler wraps inner so records carry the context's log fields.
func NewContextHandler(inner slog.Handler) slog.Handler { return &ContextHandler{inner: inner} }

func (h *ContextHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h *ContextHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &ContextHandler{inner: h.inner.WithAttrs(attrs)}
}

func (h *ContextHandler) WithGroup(name string) slog.Handler {
	return &ContextHandler{inner: h.inner.WithGroup(name)}
}

// Handle appends the ambient fields AFTER the record's own, so a call-site
// attribute of the same name is written first and wins.
//
// CONTRACT: Keep that order. The JSON handler keeps the FIRST occurrence of a
// key, and overwriting a call site's deliberate order_id with the request's
// makes the log lie. See [[logging-context]]
func (h *ContextHandler) Handle(ctx context.Context, r slog.Record) error {
	fields := LogFields(ctx)
	if len(fields) == 0 {
		return h.inner.Handle(ctx, r)
	}

	enriched := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	// Call-site attributes FIRST: the JSON handler keeps the first occurrence
	// of a key, so an explicit field beats the ambient one.
	r.Attrs(func(a slog.Attr) bool {
		enriched.AddAttrs(a)
		return true
	})
	enriched.AddAttrs(fields...)
	return h.inner.Handle(ctx, enriched)
}
