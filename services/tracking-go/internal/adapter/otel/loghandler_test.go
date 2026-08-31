package otel_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"strings"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

var (
	traceIDHex = regexp.MustCompile(`^[0-9a-f]{32}$`)
	spanIDHex  = regexp.MustCompile(`^[0-9a-f]{16}$`)
)

func traceLogger(buf *bytes.Buffer) *slog.Logger {
	return slog.New(tracing.NewTraceHandler(
		logging.NewHandler(buf, "tracking", "local", slog.LevelDebug)))
}

func TestTraceIDsAreLowercaseHexOfTheRightWidth(t *testing.T) {
	tp := sdktrace.NewTracerProvider()
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	ctx, span := tp.Tracer("test").Start(context.Background(), "s")
	defer span.End()

	var buf bytes.Buffer
	traceLogger(&buf).InfoContext(ctx, "m")

	var got map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &got); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	traceID, _ := got["trace_id"].(string)
	spanID, _ := got["span_id"].(string)
	if !traceIDHex.MatchString(traceID) {
		t.Errorf("trace_id = %q, want 32 lowercase hex chars", traceID)
	}
	if !spanIDHex.MatchString(spanID) {
		t.Errorf("span_id = %q, want 16 lowercase hex chars", spanID)
	}
}

// OMITTED, never zeroed, when there is no valid span. A "000...0" trace_id
// reads as a real id and makes 30 unrelated lines appear to share a trace.
func TestTraceIDsOmittedWithoutASpan(t *testing.T) {
	var buf bytes.Buffer
	traceLogger(&buf).InfoContext(context.Background(), "startup")

	var got map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &got); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if v, present := got["trace_id"]; present {
		t.Errorf("trace_id = %v on a line with no span; it must be omitted, never zeroed", v)
	}
	if v, present := got["span_id"]; present {
		t.Errorf("span_id = %v on a line with no span; it must be omitted", v)
	}
}

// An explicit trace_id at the call site is left alone, matching the precedence
// rule the log context follows.
func TestExplicitTraceIDWins(t *testing.T) {
	tp := sdktrace.NewTracerProvider()
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	ctx, span := tp.Tracer("test").Start(context.Background(), "s")
	defer span.End()

	var buf bytes.Buffer
	traceLogger(&buf).InfoContext(ctx, "m", slog.String("trace_id", "deadbeef"))

	var got map[string]any
	_ = json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &got)
	if got["trace_id"] != "deadbeef" {
		t.Errorf("trace_id = %v, want the call-site value", got["trace_id"])
	}
}
