package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/go-sql-driver/mysql"
)

// CONTRACT: These assert on what the driver's logger WRITES, never that a setter
// was called. "SetLogger received something non-nil" passes against an adapter
// that drops the message, writes plain text, or emits a second severity
// vocabulary — the actual regressions. Each test drives installDriverLogging and
// parses the bytes, as the collector would. See [[logging-context]]

// decodeDriverLine parses the single line the adapter is expected to write.
func decodeDriverLine(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	raw := strings.TrimSpace(buf.String())
	if raw == "" {
		t.Fatal("the driver logged nothing at all — its output was swallowed")
	}
	if strings.Count(raw, "\n") != 0 {
		t.Fatalf("expected exactly ONE line, got %d:\n%s", strings.Count(raw, "\n")+1, raw)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatalf("the driver's output is NOT JSON (%v). The collector cannot classify it, "+
			"so it lands in the `unclassified` stream with no service_name and severity 0:\n%s",
			err, raw)
	}
	return got
}

// TestDriverLogGoesThroughSlogAsOneJSONLine is the regression test.
// go-sql-driver/mysql carries its OWN package-level logger writing plain text to
// stderr, which nothing in slog's world reaches — those lines escape as
// unclassified in the collector.
func TestDriverLogGoesThroughSlogAsOneJSONLine(t *testing.T) {
	var buf bytes.Buffer
	restoreDriverLogger(t)
	installDriverLogging(newProcessLogger(&buf, "local"))

	// The driver calls Print with the message split across arguments, exactly as
	// connection.go:801 does: a "file:line " prefix, a literal, then the error.
	mysqlDriverLogger(t).Print("connection.go:801 ", "closing bad idle connection: ",
		errors.New("unexpected read from socket"))

	got := decodeDriverLine(t, &buf)

	if got["service_name"] != "tracking" {
		t.Errorf("service_name = %v, want %q — without it the record is unattributable "+
			"and no service_name query finds it", got["service_name"], "tracking")
	}
	if got["severity_text"] != "WARN" {
		t.Errorf("severity_text = %v, want WARN. These are real events worth seeing "+
			"(a bad idle connection was closed), not INFO chatter — and a record with no "+
			"severity ingests as OTel UNSPECIFIED (0), invisible to every severity filter",
			got["severity_text"])
	}
	if got["severity_number"] != float64(13) {
		t.Errorf("severity_number = %v, want 13 (OTel WARN)", got["severity_number"])
	}
	if _, ok := got["timestamp"].(string); !ok {
		t.Errorf("timestamp is missing or not a string: %v", got["timestamp"])
	}
}

// TestDriverLogKeepsTheWholeMessage covers what a "was the setter called" test
// cannot. mysql.Logger is Print(v ...any), a variadic the driver splits its
// message across, so an adapter forwarding only v[0] is still "wired" and still
// emits valid JSON while the sentence saying WHAT WENT WRONG is gone.
func TestDriverLogKeepsTheWholeMessage(t *testing.T) {
	var buf bytes.Buffer
	restoreDriverLogger(t)
	installDriverLogging(newProcessLogger(&buf, "local"))

	mysqlDriverLogger(t).Print("connection.go:801 ", "closing bad idle connection: ",
		errors.New("unexpected read from socket"))

	got := decodeDriverLine(t, &buf)
	message, _ := got["message"].(string)

	for _, fragment := range []string{
		"connection.go:801",
		"closing bad idle connection",
		"unexpected read from socket",
	} {
		if !strings.Contains(message, fragment) {
			t.Errorf("message = %q, missing %q — the adapter dropped part of what the "+
				"driver said, which is the one thing it must not do", message, fragment)
		}
	}
}

// TestDriverLogCarriesNoPercentFormatting pins the trap in the Print signature.
//
// slog takes a MESSAGE, not a format string, so the adapter must join with
// fmt.Sprint and never Sprintf. A DSN or an error carrying a literal % would
// otherwise render as %!d(MISSING) — corrupting the diagnostic exactly when the
// connection string is what you need to read.
func TestDriverLogCarriesNoPercentFormatting(t *testing.T) {
	var buf bytes.Buffer
	restoreDriverLogger(t)
	installDriverLogging(newProcessLogger(&buf, "local"))

	mysqlDriverLogger(t).Print("packet with a literal %s and %d in it")

	got := decodeDriverLine(t, &buf)
	message, _ := got["message"].(string)
	if !strings.Contains(message, "%s") || !strings.Contains(message, "%d") {
		t.Errorf("message = %q, want the verbs preserved literally — the adapter treated "+
			"the driver's message as a format string", message)
	}
	if strings.Contains(message, "MISSING") || strings.Contains(message, "EXTRA") {
		t.Errorf("message = %q contains fmt's error markers: it went through Sprintf, "+
			"not Sprint", message)
	}
}

// TestDriverLogIsTaggedAsTheDriver keeps the line diagnosable.
//
// Once the message is JSON it stops carrying the "[mysql] " prefix the standard
// logger prepended, so without an explicit field a reader cannot tell a driver
// line from one this service wrote itself.
func TestDriverLogIsTaggedAsTheDriver(t *testing.T) {
	var buf bytes.Buffer
	restoreDriverLogger(t)
	installDriverLogging(newProcessLogger(&buf, "local"))

	mysqlDriverLogger(t).Print("closing bad idle connection: ", errors.New("boom"))

	got := decodeDriverLine(t, &buf)
	if got["app_event"] != "mysql_driver_log" {
		t.Errorf("app_event = %v, want mysql_driver_log so a driver line is "+
			"distinguishable from one this service emitted", got["app_event"])
	}
}

// TestInstallDriverLoggingRejectsNothing covers the degenerate call.
//
// SetLogger returns an error on a nil logger and installDriverLogging must not
// hand it one: a driver left on its stderr default is the regression itself, and
// a panic here would take the process down over a log line.
func TestInstallDriverLoggingDoesNotPanicOnANilLogger(t *testing.T) {
	restoreDriverLogger(t)
	installDriverLogging(nil)

	// The driver must still have a usable logger afterwards.
	mysqlDriverLogger(t).Print("still usable")
}

// CONTRACT: Read the logger back through the driver's OWN public surface, never
// a reference this test kept. mysql.NewConfig() copies the package-level logger
// into the config it returns, so this is what a connection opened now would log
// through; a held reference passes even if SetLogger was never called.
func mysqlDriverLogger(t *testing.T) mysql.Logger {
	t.Helper()
	logger := mysql.NewConfig().Logger
	if logger == nil {
		t.Fatal("the driver has no logger at all")
	}
	return logger
}

// restoreDriverLogger puts the package-level logger back after the test.
//
// mysql.SetLogger is PROCESS-GLOBAL state, so a test that installs one leaks it
// into every later test in this package.
func restoreDriverLogger(t *testing.T) {
	t.Helper()
	previous := mysql.NewConfig().Logger
	t.Cleanup(func() { _ = mysql.SetLogger(previous) })
}
