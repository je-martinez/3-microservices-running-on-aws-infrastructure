package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"strings"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// CONTRACT: These run against installLogHandler — the exact function run()
// calls — and assert on its OUTPUT, not its collaborators. A test that builds
// its own subject proves the subject works and never that anyone uses it.
// See [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]]

var (
	wiringTraceIDHex = regexp.MustCompile(`^[0-9a-f]{32}$`)
	wiringSpanIDHex  = regexp.MustCompile(`^[0-9a-f]{16}$`)
)

func decodeWiringLine(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	line := strings.TrimSpace(buf.String())
	if line == "" {
		t.Fatal("nothing was logged")
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(line), &got); err != nil {
		t.Fatalf("log line is not valid JSON (%v): %s", err, line)
	}
	return got
}

// TestInstalledLoggerCarriesTraceIDs is the regression test for the missing
// TraceHandler in the composition root.
func TestInstalledLoggerCarriesTraceIDs(t *testing.T) {
	tp := sdktrace.NewTracerProvider()
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	var buf bytes.Buffer
	log := newProcessLogger(&buf, "local")

	ctx, span := tp.Tracer("test").Start(context.Background(), "s")
	defer span.End()

	log.InfoContext(ctx, "tracking status updated")

	got := decodeWiringLine(t, &buf)
	traceID, _ := got["trace_id"].(string)
	spanID, _ := got["span_id"].(string)
	if !wiringTraceIDHex.MatchString(traceID) {
		t.Errorf("trace_id = %q, want 32 lowercase hex chars — without it a trace "+
			"that crosses into Tracking loses every log line at the boundary", traceID)
	}
	if !wiringSpanIDHex.MatchString(spanID) {
		t.Errorf("span_id = %q, want 16 lowercase hex chars", spanID)
	}
}

// TestInstalledLoggerOmitsTraceIDsWithoutASpan is the other half, and the one
// that would catch a "fix" that stamped the ids unconditionally.
//
// Startup lines, the metrics ticker and every background run have no span.
// Writing trace_id "000…0" is WORSE than writing nothing: it reads as a real id,
// and every unrelated line in the process would appear to share one trace.
func TestInstalledLoggerOmitsTraceIDsWithoutASpan(t *testing.T) {
	var buf bytes.Buffer
	log := newProcessLogger(&buf, "local")

	log.InfoContext(context.Background(), "http server starting")

	got := decodeWiringLine(t, &buf)
	if raw, present := got["trace_id"]; present {
		t.Errorf("trace_id is present as %v with no active span; it must be OMITTED, never zeroed", raw)
	}
	if raw, present := got["span_id"]; present {
		t.Errorf("span_id is present as %v with no active span; it must be OMITTED, never zeroed", raw)
	}
}

// TestInstalledLoggerCarriesBothLayers is the assertion the two separate
// wrappers exist FOR: one line carrying the request's correlation ids AND the
// trace it belongs to. That join is the entire point — logs and traces travel
// different transports and nothing else connects them.
func TestInstalledLoggerCarriesBothLayers(t *testing.T) {
	tp := sdktrace.NewTracerProvider()
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	var buf bytes.Buffer
	log := newProcessLogger(&buf, "local")

	ctx, span := tp.Tracer("test").Start(context.Background(), "s")
	defer span.End()
	// Two DIFFERENT values: cognito_sub is a JWT sub, user_id is the internal
	// usr_ id, and a test reusing one string cannot fail when they are confused.
	ctx = logging.WithLogFields(ctx,
		slog.String(logging.KeyRequestID, "req_7gK3mP1vXz9wLq2bN8rRt4Yc"),
		slog.String(logging.KeyCognitoSub, "sub-abc-123"),
		slog.String(logging.KeyUserID, "usr_9f2c"),
	)

	log.InfoContext(ctx, "request completed")

	got := decodeWiringLine(t, &buf)
	for key, want := range map[string]string{
		logging.KeyRequestID:  "req_7gK3mP1vXz9wLq2bN8rRt4Yc",
		logging.KeyCognitoSub: "sub-abc-123",
		logging.KeyUserID:     "usr_9f2c",
	} {
		if got[key] != want {
			t.Errorf("%s = %v, want %q", key, got[key], want)
		}
	}
	if traceID, _ := got["trace_id"].(string); !wiringTraceIDHex.MatchString(traceID) {
		t.Errorf("trace_id = %q, want it alongside the correlation ids on the SAME line", traceID)
	}
}

// TestInstalledLoggerKeepsCallSiteAttributesWinning pins the WRAPPER ORDER. Both
// wrappers append after the record's own fields and the JSON handler keeps the
// FIRST occurrence, so a call site naming its own order_id wins; inverted, the
// ambient value takes over and the line lies.
func TestInstalledLoggerKeepsCallSiteAttributesWinning(t *testing.T) {
	tp := sdktrace.NewTracerProvider()
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	var buf bytes.Buffer
	log := newProcessLogger(&buf, "local")

	ctx, span := tp.Tracer("test").Start(context.Background(), "s")
	defer span.End()
	ctx = logging.WithLogFields(ctx, slog.String(logging.KeyOrderID, "ord_ambient"))

	log.InfoContext(ctx, "m",
		slog.String(logging.KeyOrderID, "ord_explicit"),
		slog.String("trace_id", "explicit-trace"))

	got := decodeWiringLine(t, &buf)
	if got[logging.KeyOrderID] != "ord_explicit" {
		t.Errorf("order_id = %v, want ord_explicit", got[logging.KeyOrderID])
	}
	if got["trace_id"] != "explicit-trace" {
		t.Errorf("trace_id = %v, want explicit-trace", got["trace_id"])
	}
}

// TestTheTwoEnrichersWriteDisjointKeys pins the premise that makes the wrapper
// order safe: the log context's keys and the trace layer's do not overlap, so
// "first occurrence wins" never has to choose between them. That is a property
// of today's allow-list, not a law — adding trace_id to it makes the two layers
// compete and this test fails at that commit, which is when the decision needs
// re-making rather than an ambient trace_id silently shadowing the real span's.
func TestTheTwoEnrichersWriteDisjointKeys(t *testing.T) {
	traceLayerKeys := []string{"trace_id", "span_id"}

	for _, key := range traceLayerKeys {
		ctx := logging.WithLogFields(context.Background(), slog.String(key, "smuggled"))
		for _, got := range logging.LogFields(ctx) {
			if got.Key == key {
				t.Errorf("logging.WithLogFields now accepts %q — the log context and the "+
					"trace layer write the same key, so the WRAPPER ORDER in "+
					"newProcessLogger is suddenly load-bearing. Re-read the order "+
					"rationale there before changing the allow-list.", key)
			}
		}
	}
}

// TestInstallProcessLoggerSetsTheDefaultLogger covers the other half of what
// run() calls: the enriched logger must also become slog.Default, so the
// enrichment catches records from code that never asked for it.
func TestInstallProcessLoggerSetsTheDefaultLogger(t *testing.T) {
	tp := sdktrace.NewTracerProvider()
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	restore := slog.Default()
	t.Cleanup(func() { slog.SetDefault(restore) })

	var buf bytes.Buffer
	installProcessLogger(&buf, "local")

	ctx, span := tp.Tracer("test").Start(context.Background(), "s")
	defer span.End()
	ctx = logging.WithLogFields(ctx, slog.String(logging.KeyRequestID, "req_7gK3mP1vXz9wLq2bN8rRt4Yc"))

	// No logger threaded through — the ambient default.
	slog.InfoContext(ctx, "from the default logger")

	got := decodeWiringLine(t, &buf)
	if got[logging.KeyRequestID] != "req_7gK3mP1vXz9wLq2bN8rRt4Yc" {
		t.Errorf("request_id = %v, want it on a line from the DEFAULT logger", got[logging.KeyRequestID])
	}
	if traceID, _ := got["trace_id"].(string); !wiringTraceIDHex.MatchString(traceID) {
		t.Errorf("trace_id = %q, want it on a line from the DEFAULT logger", traceID)
	}
}
