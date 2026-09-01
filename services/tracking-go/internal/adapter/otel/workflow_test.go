package otel_test

import (
	"context"
	"errors"
	nethttp "net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	oteltrace "go.opentelemetry.io/otel/trace"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
)

// recorder installs an in-memory exporter, points the package helpers at it, and
// returns the exporter the assertions read the collected spans from.
func recorder(t *testing.T) *tracetest.InMemoryExporter {
	t.Helper()
	exporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	tracing.SetTracerProvider(tp)
	return exporter
}

func TestWorkflowSpanSuccess(t *testing.T) {
	exporter := recorder(t)

	ctx, end := tracing.WorkflowSpan(context.Background(), "init_tracking",
		attribute.String("app_event", "init_tracking_started"),
		attribute.String("order_id", "ord_1"),
	)
	_ = ctx
	end(nil)

	spans := exporter.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	s := spans[0]
	if s.Name != "init_tracking" {
		t.Errorf("Name = %q, want init_tracking", s.Name)
	}
	if s.SpanKind != oteltrace.SpanKindInternal {
		t.Errorf("SpanKind = %v, want Internal", s.SpanKind)
	}
	if s.Status.Code != codes.Ok {
		t.Errorf("Status = %v, want Ok on success", s.Status.Code)
	}
	if len(s.Events) != 0 {
		t.Errorf("a successful span must record no exception event, got %v", s.Events)
	}
}

// The error is recorded EXACTLY ONCE. The Python helper disables the SDK's own
// recorder for this reason; the Go equivalent is not deferring a second one.
func TestWorkflowSpanRecordsTheErrorExactlyOnce(t *testing.T) {
	exporter := recorder(t)

	_, end := tracing.WorkflowSpan(context.Background(), "carrier_status_update")
	end(errors.New("not_strictly_forward"))

	spans := exporter.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	s := spans[0]
	if s.Status.Code != codes.Error {
		t.Errorf("Status = %v, want Error", s.Status.Code)
	}
	if s.Status.Description != "not_strictly_forward" {
		t.Errorf("Status.Description = %q, want the error's own text", s.Status.Description)
	}

	exceptions := 0
	for _, e := range s.Events {
		if e.Name == "exception" {
			exceptions++
		}
	}
	if exceptions != 1 {
		t.Errorf("got %d exception events, want exactly 1 (a double record overwrites the status description)", exceptions)
	}
}

// MarkPhase adds an EVENT, not a span: a milestone is an instant.
func TestMarkPhaseAddsAnEvent(t *testing.T) {
	exporter := recorder(t)

	ctx, end := tracing.WorkflowSpan(context.Background(), "init_tracking")
	tracing.MarkPhase(ctx, "user_resolved", "")
	tracing.MarkPhase(ctx, "creation_failed", "duplicate_order")
	end(nil)

	spans := exporter.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1 — MarkPhase must not open a span", len(spans))
	}
	names := map[string]bool{}
	var reason string
	for _, e := range spans[0].Events {
		names[e.Name] = true
		for _, a := range e.Attributes {
			if string(a.Key) == "reason" {
				reason = a.Value.AsString()
			}
		}
	}
	if !names["user_resolved"] || !names["creation_failed"] {
		t.Errorf("events = %v, want both phases", names)
	}
	if reason != "duplicate_order" {
		t.Errorf("reason = %q, want duplicate_order", reason)
	}
}

// Outside any recording span MarkPhase is a no-op, never a panic: the metrics
// ticker and startup code call into shared helpers with no span active.
func TestMarkPhaseOutsideASpanIsANoop(t *testing.T) {
	tracing.MarkPhase(context.Background(), "user_resolved", "")
}

// The health probe is excluded from tracing: Python does it with
// OTEL_PYTHON_FASTAPI_EXCLUDED_URLS, Go needs a filter.
func TestGinFilterExcludesHealth(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{"/v1/health", false},
		{"/v1/trackings/ord_1", true},
		{"/v1/trackings", true},
		// Only the exact route, not anything merely containing it.
		{"/v1/healthcheck", true},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, tt.path, nil)
			if got := tracing.GinFilter(req); got != tt.want {
				t.Errorf("GinFilter(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}
