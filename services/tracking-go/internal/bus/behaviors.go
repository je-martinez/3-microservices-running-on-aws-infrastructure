package bus

import (
	"context"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	oteltrace "go.opentelemetry.io/otel/trace"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
)

// Validator rejects a message before the handler sees it. Return a Routine error
// so the rejection is a 4xx in the logs and not a fault on the span.
type Validator[Q any] func(q Q) error

// Flow describes one use case to the pipeline: what to call it, and what to
// attach to its lines and its span.
//
// CONTRACT: Fields and Attributes read the MESSAGE, never a request or a header.
// A behavior that reached for a gin.Context would drag the transport into the
// pipeline, and the pipeline is what the TestMode progression shares with the
// carrier webhook — one of those two callers has no request at all.
//
// WARNING: No PII in either. Never shipping_address, never a plaintext email,
// never an api key. See [[logging-context]]
type Flow[Q any, R any] struct {
	// Name is the flow, and `<Name>_started|_succeeded|_failed` is its app_event.
	Name string

	// Fields are the shared-context values every line of this flow carries. Nil
	// is legal: a flow with no message-derived context adds none.
	Fields func(q Q) []slog.Attr

	// Attributes are the span's. Kept separate from Fields because a span carries
	// what a log line must not — a count, a boolean flag — and the allow-list the
	// log context applies has no equivalent here.
	Attributes func(q Q) []attribute.KeyValue

	// ResultFields and ResultAttributes are what the flow learns only from its
	// RESULT — the tracking_id it just wrote, the count it deleted.
	//
	// CONTRACT: Neither runs on a failure. The zero result is meaningless there,
	// and a `tracking_id: ""` or a `deleted_count: 0` on a failed flow reads as a
	// real value somebody will act on.
	ResultFields     func(r R) []slog.Attr
	ResultAttributes func(r R) []attribute.KeyValue

	// Validate is optional. Nil installs no validation layer at all rather than a
	// pass-through, so a flow with nothing to check pays nothing.
	Validate Validator[Q]

	// FaultReason is the `reason` this flow reports for a THROWN failure — a fault
	// nothing classified as routine. Empty falls back to ReasonUnhandledError.
	//
	// CONTRACT: Per-flow, not shared. The flows here already spell it differently
	// (read_failed, internal_error, db_error) and those tokens are on shipped
	// dashboards and alert rules, so one shared token would change every one of
	// them at once. It NEVER reaches a routine failure, which carries its own.
	// See [[logging-context]]
	FaultReason string

	// Lines selects which SUCCESS-path log lines this flow emits. Nil is
	// DefaultLines.
	//
	// CONTRACT: A POINTER. Go's zero Lines is {false, false}, indistinguishable
	// from asking for silence, so a flow whose author forgot to choose would be
	// invisible. Silence takes an explicit &Lines{}. See [[logging-context]]
	Lines *Lines
}

// Lines selects a flow's success-path log lines. Per-flow, because the differences
// here are deliberate: the two reads suppress both (the `request completed` line
// already carries route, status and duration_ms for the service's most frequent
// calls), while the cascade leg logs both.
//
// CONTRACT: The `*_failed` line is NOT here and is never suppressible — it is the
// only record of WHY a request failed. See [[logging-context]]
type Lines struct {
	Started   bool
	Succeeded bool
}

// DefaultLines is what a flow declaring no selection gets: `_succeeded`, no
// `_started`.
var DefaultLines = Lines{Started: false, Succeeded: true}

// classifyFor is Classify with the flow's own fault token substituted in.
//
// CONTRACT: Substitute ONLY on a THROWN failure. A routine failure carries the
// specific reason its route reads, and a flow-wide token overwriting it is the
// last-write-wins bug that destroys it. See [[logging-context]]
func classifyFor[Q any, R any](flow Flow[Q, R], err error) Outcome {
	outcome := Classify(err)
	if outcome.Thrown && flow.FaultReason != "" {
		outcome.Reason = flow.FaultReason
	}
	return outcome
}

// linesOf resolves the selection, so every read of it goes through one place.
func linesOf[Q any, R any](flow Flow[Q, R]) Lines {
	if flow.Lines == nil {
		return DefaultLines
	}
	return *flow.Lines
}

// pipelineOrder is D4, named once so the test asserting it and the function
// building it cannot disagree.
var pipelineOrder = []string{"tracing", "app_event", "logging", "validation"}

// PipelineOrder returns D4's behavior order, outermost first.
func PipelineOrder() []string { return append([]string(nil), pipelineOrder...) }

// Pipeline wraps h in the four behaviors in D4's order: tracing -> app_event ->
// logging -> validation -> handler.
//
// CONTRACT: Do NOT reorder these. Tracing must be outermost or the app_event
// layer's SetSpanAttributes finds no recording span and drops every attribute
// silently; logging must be inside tracing or its closing line is written after
// the span is restored and carries no trace_id — valid JSON, correct fields,
// unjoinable to its trace. Validation is innermost so a rejected message is
// still traced and still logs its `*_failed`. See [[cqrs]]
func Pipeline[Q any, R any](h Handler[Q, R], flow Flow[Q, R], log *slog.Logger) Handler[Q, R] {
	if log == nil {
		log = slog.Default()
	}

	mws := []Middleware[Q, R]{
		tracingBehavior[Q, R](flow),
		appEventBehavior[Q, R](flow),
		loggingBehavior[Q, R](flow, log),
	}
	if flow.Validate != nil {
		mws = append(mws, validationBehavior[Q, R](flow.Validate))
	}

	return Wrap(h, mws...)
}

// tracingBehavior opens the flow's workflow span.
//
// This is the layer that MOVED here out of the HTTP handlers, and the move is the
// point: the span names a business operation, which is a property of the use case
// and not of the transport in front of it.
//
// CONTRACT: Mark the span ERROR only for a THROWN failure. A routine 404 or a
// rejected transition leaves the status unset — a false error on every
// not-found trains whoever reads the waterfall to ignore errors here, which is
// the habit that lets a real fault pass unnoticed.
// See [[ADR-0019-distributed-tracing-opentelemetry]]
func tracingBehavior[Q any, R any](flow Flow[Q, R]) Middleware[Q, R] {
	return func(next Handler[Q, R]) Handler[Q, R] {
		return func(ctx context.Context, q Q) (R, error) {
			ctx, span := tracing.Tracer(tracing.TracerWorkflow).Start(ctx, flow.Name,
				oteltrace.WithSpanKind(oteltrace.SpanKindInternal),
				oteltrace.WithAttributes(spanAttributes(flow, q)...),
			)
			defer span.End()

			result, err := next(ctx, q)

			outcome := Classify(err)
			if !outcome.Failed && flow.ResultAttributes != nil {
				span.SetAttributes(flow.ResultAttributes(result)...)
			}

			switch {
			case outcome.Thrown:
				// RecordError exactly once, and SetStatus explicitly — a second
				// deferred recorder would overwrite the chosen description.
				span.RecordError(err)
				span.SetStatus(codes.Error, err.Error())
			case outcome.Failed:
				// Deliberately neither Ok nor Error. Ok would claim the flow
				// succeeded; Error would claim a fault. UNSET is the honest
				// answer for "handled, and not the happy path".
			default:
				span.SetStatus(codes.Ok, "")
			}

			return result, err
		}
	}
}

// appEventBehavior stamps `app_event` and `reason` on the span.
//
// CONTRACT: `reason` is set ONLY on a failure. Span attributes are
// last-write-wins per key, so a generic layer writing a reason unconditionally
// destroys a specific one — and it destroys it AFTER the handler has already
// returned the specific error, so the response still looks right.
// See [[logging-context]]
func appEventBehavior[Q any, R any](flow Flow[Q, R]) Middleware[Q, R] {
	return func(next Handler[Q, R]) Handler[Q, R] {
		return func(ctx context.Context, q Q) (R, error) {
			tracing.SetSpanAttributes(ctx,
				attribute.String("app_event", flow.Name+"_started"))

			result, err := next(ctx, q)

			outcome := classifyFor(flow, err)
			attrs := []attribute.KeyValue{
				attribute.String("app_event", flow.Name+eventSuffix(outcome)),
			}
			if outcome.Failed {
				attrs = append(attrs, attribute.String("reason", outcome.Reason))
			}
			tracing.SetSpanAttributes(ctx, attrs...)

			return result, err
		}
	}
}

// loggingBehavior emits the flow's `*_started` line and its closing line.
//
// CONTRACT: There is no SUCCESS severity — success is INFO plus
// `app_event=*_succeeded`. A routine failure logs WARN and a thrown one ERROR, so
// an alert rule on ERROR does not fire on every 404. `reason` is OMITTED on
// success, never null. See [[logging-context]]
func loggingBehavior[Q any, R any](flow Flow[Q, R], log *slog.Logger) Middleware[Q, R] {
	lines := linesOf(flow)

	return func(next Handler[Q, R]) Handler[Q, R] {
		return func(ctx context.Context, q Q) (R, error) {
			fields := logFields(flow, q)

			if lines.Started {
				started := append([]slog.Attr{
					slog.String("app_event", flow.Name+"_started"),
				}, fields...)
				log.LogAttrs(ctx, slog.LevelInfo, flow.Name+"_started", started...)
			}

			begun := time.Now()
			result, err := next(ctx, q)
			outcome := classifyFor(flow, err)

			if !outcome.Failed && !lines.Succeeded {
				return result, err
			}

			event := flow.Name + eventSuffix(outcome)
			closing := []slog.Attr{slog.String("app_event", event)}
			if outcome.Failed {
				closing = append(closing, slog.String("reason", outcome.Reason))
			}
			if !outcome.Failed && flow.ResultFields != nil {
				closing = append(closing, flow.ResultFields(result)...)
			}
			closing = append(closing, fields...)
			closing = append(closing,
				slog.Int64("duration_ms", time.Since(begun).Milliseconds()))
			if outcome.Thrown {
				// The error text is for OPERATORS and reaches no response body.
				closing = append(closing, slog.String("error", err.Error()))
			}

			log.LogAttrs(ctx, severityOf(outcome), event, closing...)

			return result, err
		}
	}
}

// validationBehavior rejects a message before the handler runs.
//
// It is the INNERMOST layer, so a rejection is still inside the span and still
// produces the `*_started`/`*_failed` pair — the observability of a rejected
// request is exactly what a request log line cannot explain.
func validationBehavior[Q any, R any](validate Validator[Q]) Middleware[Q, R] {
	return func(next Handler[Q, R]) Handler[Q, R] {
		return func(ctx context.Context, q Q) (R, error) {
			if err := validate(q); err != nil {
				var zero R
				return zero, err
			}
			return next(ctx, q)
		}
	}
}

// eventSuffix maps an outcome to the app_event suffix. Both failure kinds share
// `_failed`: the severity and the span status carry the difference, and a third
// suffix would be a new token every dashboard query would have to learn.
func eventSuffix(outcome Outcome) string {
	if outcome.Failed {
		return "_failed"
	}
	return "_succeeded"
}

// severityOf keeps a routine 4xx out of the ERROR stream.
func severityOf(outcome Outcome) slog.Level {
	switch {
	case outcome.Thrown:
		return slog.LevelError
	case outcome.Failed:
		return slog.LevelWarn
	default:
		return slog.LevelInfo
	}
}

func logFields[Q any, R any](flow Flow[Q, R], q Q) []slog.Attr {
	if flow.Fields == nil {
		return nil
	}
	return flow.Fields(q)
}

func spanAttributes[Q any, R any](flow Flow[Q, R], q Q) []attribute.KeyValue {
	if flow.Attributes == nil {
		return nil
	}
	return flow.Attributes(q)
}
