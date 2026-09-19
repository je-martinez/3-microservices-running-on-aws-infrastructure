package bus_test

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/bus"
)

// A flow's generic-fault token is ITS OWN. The flows in this service already spell
// it differently — read_failed, internal_error, db_error — and those tokens are on
// shipped dashboards and alert rules. One shared `unhandled_error` would change
// every one of them at once, which is the kind of silent contract change a green
// suite cannot see.

func runWithFaultReason(t *testing.T, faultReason string) recordedRun {
	t.Helper()

	spansOf := recordSpans(t)
	var captured strings.Builder
	log := slog.New(traceLogHandler(&captured))

	flow := probeFlow()
	flow.FaultReason = faultReason

	_, err := bus.Pipeline(faultHandler, flow, log)(context.Background(), probeQuery{OrderID: "ord_1"})

	return recordedRun{spans: spansOf(), lines: parseLines(t, captured.String()), err: err}
}

func TestAFlowsOwnFaultReasonIsUsedForAThrownFailure(t *testing.T) {
	run := runWithFaultReason(t, "read_failed")

	failed, ok := run.lineWith("probe_failed")
	if !ok {
		t.Fatalf("no probe_failed line: %v", run.lines)
	}
	if failed["reason"] != "read_failed" {
		t.Errorf("reason = %v, want the flow's own read_failed", failed["reason"])
	}
	if got, _ := spanAttr(run.workflowSpan(t), "reason"); got != "read_failed" {
		t.Errorf("span reason = %q, want read_failed", got)
	}
}

// A flow that declares no token falls back to the generic one rather than emitting
// an empty reason, which the log context would drop entirely.
func TestAFlowWithNoFaultReasonFallsBackToTheGenericToken(t *testing.T) {
	run := runWithFaultReason(t, "")

	failed, ok := run.lineWith("probe_failed")
	if !ok {
		t.Fatalf("no probe_failed line: %v", run.lines)
	}
	if failed["reason"] != bus.ReasonUnhandledError {
		t.Errorf("reason = %v, want %q", failed["reason"], bus.ReasonUnhandledError)
	}
}

// CONTRACT: The flow's fault token must NOT reach a routine failure. A routine
// failure already carries the specific reason a route turns into its status code,
// and overwriting it with the flow's generic token is precisely the last-write-wins
// bug that destroyed a specific reason in this refactor's Node predecessor.
func TestAFlowsFaultReasonNeverOverwritesARoutineReason(t *testing.T) {
	spansOf := recordSpans(t)
	var captured strings.Builder
	log := slog.New(traceLogHandler(&captured))

	flow := probeFlow()
	flow.FaultReason = "read_failed"

	_, err := bus.Pipeline(routineNotFoundHandler, flow, log)(
		context.Background(), probeQuery{OrderID: "ord_1"})
	if err == nil {
		t.Fatal("err = nil, want the routine failure")
	}

	run := recordedRun{spans: spansOf(), lines: parseLines(t, captured.String())}
	failed, ok := run.lineWith("probe_failed")
	if !ok {
		t.Fatalf("no probe_failed line: %v", run.lines)
	}
	if failed["reason"] != "not_found" {
		t.Errorf("reason = %v, want not_found: the flow's fault token overwrote it", failed["reason"])
	}
}
