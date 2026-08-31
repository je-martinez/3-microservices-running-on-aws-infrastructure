package logging_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// decode returns the single JSON object written to buf.
func decode(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	line := strings.TrimSpace(buf.String())
	if line == "" {
		t.Fatal("nothing was logged")
	}
	if strings.Count(line, "\n") != 0 {
		t.Fatalf("expected exactly one line, got:\n%s", line)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(line), &got); err != nil {
		t.Fatalf("log line is not valid JSON (%v): %s", err, line)
	}
	return got
}

func TestBaseFieldShape(t *testing.T) {
	var buf bytes.Buffer
	log := logging.New(&buf, "tracking", "local")

	log.Info("tracking created", slog.String("order_id", "ord_123"))

	got := decode(t, &buf)
	if got["severity_text"] != "INFO" {
		t.Errorf("severity_text = %v, want INFO", got["severity_text"])
	}
	if got["severity_number"] != float64(9) {
		t.Errorf("severity_number = %v, want 9", got["severity_number"])
	}
	if got["service_name"] != "tracking" {
		t.Errorf("service_name = %v, want tracking", got["service_name"])
	}
	if got["deployment_environment"] != "local" {
		t.Errorf("deployment_environment = %v, want local", got["deployment_environment"])
	}
	if got["message"] != "tracking created" {
		t.Errorf("message = %v, want 'tracking created'", got["message"])
	}
	if got["order_id"] != "ord_123" {
		t.Errorf("order_id = %v, want ord_123", got["order_id"])
	}
}

// The base fields appear in a fixed order, ahead of the context fields. The
// order is part of the shape the other three services emit.
func TestBaseFieldOrder(t *testing.T) {
	var buf bytes.Buffer
	log := logging.New(&buf, "tracking", "local")

	log.Info("hello", slog.String("order_id", "ord_1"))

	line := strings.TrimSpace(buf.String())
	want := []string{
		`"severity_text"`,
		`"severity_number"`,
		`"timestamp"`,
		`"service_name"`,
		`"deployment_environment"`,
		`"message"`,
		`"order_id"`,
	}
	previous := -1
	for _, key := range want {
		at := strings.Index(line, key)
		if at < 0 {
			t.Fatalf("key %s missing from: %s", key, line)
		}
		if at < previous {
			t.Errorf("key %s appears out of order in: %s", key, line)
		}
		previous = at
	}
}

// WARN not WARNING, FATAL not CRITICAL. Both spellings in one backend made
// dashboard filters return half the matches.
func TestSeverityNames(t *testing.T) {
	tests := []struct {
		level      slog.Level
		wantText   string
		wantNumber float64
	}{
		{slog.LevelDebug, "DEBUG", 5},
		{slog.LevelInfo, "INFO", 9},
		{slog.LevelWarn, "WARN", 13},
		{slog.LevelError, "ERROR", 17},
		{logging.LevelFatal, "FATAL", 21},
	}
	for _, tt := range tests {
		t.Run(tt.wantText, func(t *testing.T) {
			var buf bytes.Buffer
			h := logging.NewHandler(&buf, "tracking", "local", slog.LevelDebug)
			slog.New(h).Log(context.Background(), tt.level, "m")

			got := decode(t, &buf)
			if got["severity_text"] != tt.wantText {
				t.Errorf("severity_text = %v, want %v", got["severity_text"], tt.wantText)
			}
			if got["severity_number"] != tt.wantNumber {
				t.Errorf("severity_number = %v, want %v", got["severity_number"], tt.wantNumber)
			}
		})
	}
}

func TestUnknownLevelFallsBackToZero(t *testing.T) {
	var buf bytes.Buffer
	h := logging.NewHandler(&buf, "tracking", "local", slog.Level(-100))
	slog.New(h).Log(context.Background(), slog.Level(-99), "custom")

	got := decode(t, &buf)
	if got["severity_number"] != float64(0) {
		t.Errorf("severity_number = %v, want 0 for an unmapped level", got["severity_number"])
	}
}

// UTC, millisecond precision, Z suffix. Not RFC3339Nano (variable precision,
// +00:00 offset).
func TestTimestampFormat(t *testing.T) {
	var buf bytes.Buffer
	logging.New(&buf, "tracking", "local").Info("m")

	got := decode(t, &buf)
	ts, ok := got["timestamp"].(string)
	if !ok {
		t.Fatalf("timestamp is not a string: %v", got["timestamp"])
	}
	if !strings.HasSuffix(ts, "Z") {
		t.Errorf("timestamp %q does not end in Z", ts)
	}
	// 2026-08-27T12:34:56.789Z is exactly 24 characters.
	if len(ts) != 24 {
		t.Errorf("timestamp %q has length %d, want 24 (millisecond precision)", ts, len(ts))
	}
	if ts[19] != '.' {
		t.Errorf("timestamp %q has no millisecond separator at index 19", ts)
	}
}

// Nil and empty values are DROPPED. Never null, never "".
func TestEmptyAndNilValuesAreDropped(t *testing.T) {
	var buf bytes.Buffer
	log := logging.New(&buf, "tracking", "local")

	log.Info("m",
		slog.String("user_id", ""),
		slog.Any("order_id", nil),
		slog.String("tracking_id", "trk_kept"),
	)

	got := decode(t, &buf)
	if _, present := got["user_id"]; present {
		t.Errorf(`empty user_id was emitted as %v; it must be omitted entirely`, got["user_id"])
	}
	if _, present := got["order_id"]; present {
		t.Errorf(`nil order_id was emitted as %v; it must be omitted entirely`, got["order_id"])
	}
	if got["tracking_id"] != "trk_kept" {
		t.Errorf("tracking_id = %v, want trk_kept", got["tracking_id"])
	}
}

// A zero NUMBER is not an empty value: 0 is a real count and must survive.
func TestZeroNumbersSurvive(t *testing.T) {
	var buf bytes.Buffer
	logging.New(&buf, "tracking", "local").Info("m",
		slog.Int("http_response_status_code", 0),
		slog.Float64("duration_ms", 0),
		slog.Bool("cache_enabled", false),
	)

	got := decode(t, &buf)
	for _, key := range []string{"http_response_status_code", "duration_ms", "cache_enabled"} {
		if _, present := got[key]; !present {
			t.Errorf("%s was dropped; only nil and empty STRINGS are dropped", key)
		}
	}
}

// A value JSON cannot encode is stringified, never dropped: losing a field
// silently is how a diagnostic disappears exactly when it is needed.
func TestNonSerializableValuesAreStringified(t *testing.T) {
	var buf bytes.Buffer
	logging.New(&buf, "tracking", "local").Info("m",
		slog.Any("weird", make(chan int)),
	)

	got := decode(t, &buf)
	value, present := got["weird"]
	if !present {
		t.Fatal("a non-serializable value was dropped; it must be stringified")
	}
	if _, isString := value.(string); !isString {
		t.Errorf("weird = %#v, want a string rendering", value)
	}
}

// exception and stack appear only when present.
func TestExceptionAndStackOnlyWhenPresent(t *testing.T) {
	var buf bytes.Buffer
	logging.New(&buf, "tracking", "local").Info("clean")
	got := decode(t, &buf)
	if _, present := got["exception"]; present {
		t.Error("exception present on a line with no error")
	}
	if _, present := got["stack"]; present {
		t.Error("stack present on a line with no error")
	}

	buf.Reset()
	logging.New(&buf, "tracking", "local").Error("failed",
		slog.String("exception", "boom: connection refused"))
	got = decode(t, &buf)
	if got["exception"] != "boom: connection refused" {
		t.Errorf("exception = %v, want the message", got["exception"])
	}
}

// WithAttrs and WithGroup must not lose the base fields — slog calls them for
// every logger built with log.With(...).
func TestWithAttrsCarriesFields(t *testing.T) {
	var buf bytes.Buffer
	log := logging.New(&buf, "tracking", "local").With(slog.String("order_id", "ord_9"))

	log.Info("m", slog.String("tracking_id", "trk_1"))

	got := decode(t, &buf)
	if got["order_id"] != "ord_9" {
		t.Errorf("order_id from With() = %v, want ord_9", got["order_id"])
	}
	if got["tracking_id"] != "trk_1" {
		t.Errorf("tracking_id = %v, want trk_1", got["tracking_id"])
	}
	if got["service_name"] != "tracking" {
		t.Error("With() lost the base fields")
	}
}
