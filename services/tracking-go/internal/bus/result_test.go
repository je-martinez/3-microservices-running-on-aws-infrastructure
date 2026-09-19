package bus_test

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/bus"
)

// Most of these flows learn something only from the RESULT — the tracking_id they
// just wrote, the count they deleted, the number of rows a batch read found. Those
// values are on the span and the success line today, so the pipeline has to be
// able to attach them.

// runWithResultExtractors is runPipeline with the result-derived extractors set.
func runWithResultExtractors(
	t *testing.T,
	handler bus.Handler[probeQuery, probeResult],
) recordedRun {
	t.Helper()

	spansOf := recordSpans(t)
	var captured strings.Builder
	log := slog.New(traceLogHandler(&captured))

	flow := probeFlow()
	flow.Lines = &bus.Lines{Started: false, Succeeded: true}
	flow.ResultAttributes = func(r probeResult) []attribute.KeyValue {
		return []attribute.KeyValue{attribute.Bool("found", r.Found)}
	}
	flow.ResultFields = func(r probeResult) []slog.Attr {
		return []slog.Attr{slog.Bool("found", r.Found)}
	}

	_, err := bus.Pipeline(handler, flow, log)(context.Background(), probeQuery{OrderID: "ord_1"})

	return recordedRun{spans: spansOf(), lines: parseLines(t, captured.String()), err: err}
}

func TestResultDerivedValuesReachTheSpanAndTheSuccessLine(t *testing.T) {
	run := runWithResultExtractors(t, okHandler)

	span := run.workflowSpan(t)
	var sawSpanAttr bool
	for _, kv := range span.Attributes() {
		if string(kv.Key) == "found" && kv.Value.AsBool() {
			sawSpanAttr = true
		}
	}
	if !sawSpanAttr {
		t.Errorf("no result-derived span attribute: %v", span.Attributes())
	}

	succeeded, ok := run.lineWith("probe_succeeded")
	if !ok {
		t.Fatalf("no probe_succeeded line: %v", run.lines)
	}
	if succeeded["found"] != true {
		t.Errorf("found = %v, want true on the success line", succeeded["found"])
	}
}

// CONTRACT: The result extractors must NOT run on a failure. The zero result is
// meaningless there, and a `tracking_id: ""` or a `deleted_count: 0` on a failed
// flow reads as a real value that somebody will act on.
func TestResultDerivedValuesAreNotAttachedOnAFailure(t *testing.T) {
	run := runWithResultExtractors(t, routineNotFoundHandler)

	failed, ok := run.lineWith("probe_failed")
	if !ok {
		t.Fatalf("no probe_failed line: %v", run.lines)
	}
	if _, present := failed["found"]; present {
		t.Errorf("a zero result value was attached to a failed flow: %v", failed)
	}

	for _, kv := range run.workflowSpan(t).Attributes() {
		if string(kv.Key) == "found" {
			t.Errorf("a zero result attribute reached the span of a failed flow: %v", kv)
		}
	}
}

// A flow declaring no result extractors must not break: nil is the common case.
func TestAFlowWithNoResultExtractorsStillSucceeds(t *testing.T) {
	run := runPipeline(t, okHandler, probeQuery{OrderID: "ord_1"}, nil)

	if run.err != nil {
		t.Fatalf("err = %v, want nil", run.err)
	}
	if _, ok := run.lineWith("probe_succeeded"); !ok {
		t.Errorf("no probe_succeeded line: %v", run.lines)
	}
}
