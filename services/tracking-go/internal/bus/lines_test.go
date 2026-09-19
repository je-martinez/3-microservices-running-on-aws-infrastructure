package bus_test

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/codes"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/bus"
)

// CONTRACT: Which log lines a flow emits is per-flow and deliberate — the reads
// emit none on success, the cascade leg emits both. The SPAN is unaffected: a flow
// always gets its span, app_event and status. See [[logging-context]]

// runWithLines is runPipeline with explicit line selection.
func runWithLines(t *testing.T, handler bus.Handler[probeQuery, probeResult], lines bus.Lines) recordedRun {
	t.Helper()

	spansOf := recordSpans(t)
	var captured strings.Builder
	log := slog.New(traceLogHandler(&captured))

	flow := probeFlow()
	flow.Lines = &lines

	_, err := bus.Pipeline(handler, flow, log)(context.Background(), probeQuery{OrderID: "ord_1"})

	return recordedRun{spans: spansOf(), lines: parseLines(t, captured.String()), err: err}
}

func TestAFlowCanSuppressItsStartedAndSucceededLines(t *testing.T) {
	// The reads' selection: failures only.
	run := runWithLines(t, okHandler, bus.Lines{Started: false, Succeeded: false})

	if _, present := run.lineWith("probe_started"); present {
		t.Errorf("a suppressed *_started line was emitted: %v", run.lines)
	}
	if _, present := run.lineWith("probe_succeeded"); present {
		t.Errorf("a suppressed *_succeeded line was emitted: %v", run.lines)
	}
	if len(run.lines) != 0 {
		t.Errorf("the pipeline logged %d line(s) for a flow that asked for none: %v", len(run.lines), run.lines)
	}
}

// Suppressing the success lines must not suppress the span: the flow still needs
// to appear in the waterfall, with its status and its app_event.
func TestSuppressingLinesLeavesTheSpanIntact(t *testing.T) {
	run := runWithLines(t, okHandler, bus.Lines{Started: false, Succeeded: false})

	span := run.workflowSpan(t)
	if span.Status().Code != codes.Ok {
		t.Errorf("span status = %v, want Ok", span.Status().Code)
	}
	if got, _ := spanAttr(span, "app_event"); got != "probe_succeeded" {
		t.Errorf("span app_event = %q, want probe_succeeded", got)
	}
}

// CONTRACT: A *_failed line is NOT suppressible. It is the only record of why a
// request did not do what it was asked, and the `request completed` line the
// middleware writes carries a status code and no reason.
func TestTheFailedLineIsAlwaysEmittedEvenForAFlowThatSuppressesTheRest(t *testing.T) {
	run := runWithLines(t, routineNotFoundHandler, bus.Lines{Started: false, Succeeded: false})

	failed, ok := run.lineWith("probe_failed")
	if !ok {
		t.Fatalf("no probe_failed line: a failure is never suppressible: %v", run.lines)
	}
	if failed["reason"] != "not_found" {
		t.Errorf("reason = %v, want not_found", failed["reason"])
	}
}

func TestAFlowCanRequestBothStartedAndSucceeded(t *testing.T) {
	// The cascade leg's selection.
	run := runWithLines(t, okHandler, bus.Lines{Started: true, Succeeded: true})

	if _, ok := run.lineWith("probe_started"); !ok {
		t.Errorf("no probe_started line: %v", run.lines)
	}
	if _, ok := run.lineWith("probe_succeeded"); !ok {
		t.Errorf("no probe_succeeded line: %v", run.lines)
	}
}

// The zero Lines value would silently mean "log nothing", which is the wrong
// default for a new flow: a flow whose author forgot to choose must be VISIBLE,
// not silent. DefaultLines is what a flow gets when it declares no selection.
func TestAFlowThatDeclaresNoSelectionLogsSucceededButNotStarted(t *testing.T) {
	spansOf := recordSpans(t)
	var captured strings.Builder
	log := slog.New(traceLogHandler(&captured))

	// probeFlow() declares no Lines at all, which is the case this test is about.
	_, err := bus.Pipeline(okHandler, probeFlow(), log)(context.Background(), probeQuery{OrderID: "ord_1"})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	run := recordedRun{spans: spansOf(), lines: parseLines(t, captured.String())}

	if _, present := run.lineWith("probe_started"); present {
		t.Errorf("the default selection emits a *_started line: %v", run.lines)
	}
	if _, ok := run.lineWith("probe_succeeded"); !ok {
		t.Errorf("the default selection emits no *_succeeded line: %v", run.lines)
	}
}
