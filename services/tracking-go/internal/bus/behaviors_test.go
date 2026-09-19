package bus_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/bus"
)

// CONTRACT: Every assertion here goes THROUGH bus.Pipeline, never by calling a
// behavior or the handler underneath it. A suite that exercises handlers directly
// cannot see a pipeline layer overwriting what a handler set — the exact bug that
// stayed green across 709 tests in this refactor's Node predecessor.
// See [[cqrs]]

// ─── the subject ────────────────────────────────────────────────────────────

// probeQuery is a stand-in message. Its fields are the two shared-context values
// the real flows carry, so the extractor path is exercised rather than stubbed.
type probeQuery struct {
	OrderID    string
	CognitoSub string
}

type probeResult struct{ Found bool }

// probeFlow describes the stand-in flow exactly as a real one is described.
func probeFlow() bus.Flow[probeQuery, probeResult] {
	return bus.Flow[probeQuery, probeResult]{
		Name: "probe",
		Fields: func(q probeQuery) []slog.Attr {
			return []slog.Attr{
				slog.String("order_id", q.OrderID),
				slog.String("cognito_sub", q.CognitoSub),
			}
		},
		Attributes: func(q probeQuery) []attribute.KeyValue {
			return []attribute.KeyValue{attribute.String("order_id", q.OrderID)}
		},
	}
}

// ─── harness ────────────────────────────────────────────────────────────────

// recordedRun is everything one pipeline invocation emitted.
type recordedRun struct {
	spans []sdktrace.ReadOnlySpan
	lines []map[string]any
	err   error
}

// runPipeline builds the REAL pipeline over handler and invokes it once.
func runPipeline(
	t *testing.T,
	handler bus.Handler[probeQuery, probeResult],
	q probeQuery,
	validate bus.Validator[probeQuery],
) recordedRun {
	t.Helper()

	spansOf := recordSpans(t)
	var captured strings.Builder
	log := slog.New(traceLogHandler(&captured))

	flow := probeFlow()
	flow.Validate = validate
	// BOTH lines, so the assertions below can read a *_started line. The DEFAULT
	// selection omits it — see TestAFlowThatDeclaresNoSelectionLogsSucceededButNotStarted.
	flow.Lines = &bus.Lines{Started: true, Succeeded: true}

	wrapped := bus.Pipeline(handler, flow, log)
	_, err := wrapped(context.Background(), q)

	return recordedRun{spans: spansOf(), lines: parseLines(t, captured.String()), err: err}
}

// recordSpans installs an in-memory exporter as BOTH the global provider and the
// tracing package's own, and restores them afterwards.
//
// CONTRACT: Return a CLOSURE over the exporter, never exporter.GetSpans().
// Snapshots — that expression snapshots before any span exists, so every later
// read returns the empty slice it captured and the test passes on no evidence.
func recordSpans(t *testing.T) func() []sdktrace.ReadOnlySpan {
	t.Helper()

	exporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	tracing.SetTracerProvider(tp)
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		tracing.SetTracerProvider(previous)
	})

	return func() []sdktrace.ReadOnlySpan { return exporter.GetSpans().Snapshots() }
}

// traceLogHandler builds the process logger's handler chain as
// installProcessLogger does. NewTraceHandler is what stamps trace_id, and the
// order assertions read that field as their evidence that the logging layer runs
// INSIDE the span — a bare JSONHandler would emit none and they would pass on no
// evidence.
func traceLogHandler(w io.Writer) slog.Handler {
	return tracing.NewTraceHandler(
		slog.NewJSONHandler(w, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

func parseLines(t *testing.T, raw string) []map[string]any {
	t.Helper()

	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		if line == "" {
			continue
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			t.Fatalf("log line is not JSON: %q (%v)", line, err)
		}
		out = append(out, parsed)
	}
	return out
}

// lineWith returns the line whose app_event matches, and whether one exists.
func (r recordedRun) lineWith(appEvent string) (map[string]any, bool) {
	for _, line := range r.lines {
		if line["app_event"] == appEvent {
			return line, true
		}
	}
	return nil, false
}

// workflowSpan returns the single span the pipeline opened.
func (r recordedRun) workflowSpan(t *testing.T) sdktrace.ReadOnlySpan {
	t.Helper()
	if len(r.spans) != 1 {
		t.Fatalf("span count = %d, want exactly 1 (the workflow span)", len(r.spans))
	}
	return r.spans[0]
}

func spanAttr(span sdktrace.ReadOnlySpan, key string) (string, bool) {
	for _, kv := range span.Attributes() {
		if string(kv.Key) == key {
			return kv.Value.AsString(), true
		}
	}
	return "", false
}

// ─── handlers ───────────────────────────────────────────────────────────────

func okHandler(_ context.Context, _ probeQuery) (probeResult, error) {
	return probeResult{Found: true}, nil
}

var errProbeNotFound = errors.New("tracking not found")

func routineNotFoundHandler(_ context.Context, _ probeQuery) (probeResult, error) {
	return probeResult{}, bus.Routine(errProbeNotFound, "not_found")
}

func faultHandler(_ context.Context, _ probeQuery) (probeResult, error) {
	return probeResult{}, errors.New("connection refused")
}

// ─── the success path ───────────────────────────────────────────────────────

func TestTheSuccessPathLogsStartedThenSucceededWithNoReason(t *testing.T) {
	run := runPipeline(t, okHandler, probeQuery{OrderID: "ord_1", CognitoSub: "sub-owner"}, nil)

	if run.err != nil {
		t.Fatalf("err = %v, want nil", run.err)
	}

	started, ok := run.lineWith("probe_started")
	if !ok {
		t.Fatalf("no probe_started line: %v", run.lines)
	}
	succeeded, ok := run.lineWith("probe_succeeded")
	if !ok {
		t.Fatalf("no probe_succeeded line: %v", run.lines)
	}

	// There is NO SUCCESS severity — success is INFO plus app_event=*_succeeded.
	for _, line := range []map[string]any{started, succeeded} {
		if line["level"] != "INFO" {
			t.Errorf("level = %v, want INFO for %v", line["level"], line["app_event"])
		}
		// OMITTED, never null: a `reason` key present at all on a success line is
		// the failure, whatever its value.
		if _, present := line["reason"]; present {
			t.Errorf("%v carries a reason: %v", line["app_event"], line)
		}
	}

	if succeeded["order_id"] != "ord_1" {
		t.Errorf("order_id = %v, want ord_1: the flow's shared-context fields must attach", succeeded["order_id"])
	}
	if succeeded["cognito_sub"] != "sub-owner" {
		t.Errorf("cognito_sub = %v, want sub-owner", succeeded["cognito_sub"])
	}
	if _, present := succeeded["duration_ms"]; !present {
		t.Errorf("no duration_ms on the closing line: %v", succeeded)
	}
}

func TestTheSuccessPathMarksTheSpanOk(t *testing.T) {
	run := runPipeline(t, okHandler, probeQuery{OrderID: "ord_1"}, nil)
	span := run.workflowSpan(t)

	if span.Name() != "probe" {
		t.Errorf("span name = %q, want %q", span.Name(), "probe")
	}
	if span.Status().Code != codes.Ok {
		t.Errorf("span status = %v, want Ok", span.Status().Code)
	}
	if got, _ := spanAttr(span, "app_event"); got != "probe_succeeded" {
		t.Errorf("span app_event = %q, want probe_succeeded", got)
	}
	if got, _ := spanAttr(span, "order_id"); got != "ord_1" {
		t.Errorf("span order_id = %q, want ord_1", got)
	}
	if _, present := spanAttr(span, "reason"); present {
		t.Error("the succeeded span carries a reason attribute")
	}
}

// ─── the routine-not-found path — the load-bearing case ─────────────────────

// A domain "not found" a route turns into a 404 logs *_failed WITH its reason and
// leaves the span status alone. A behavior that only inspects `err != nil`
// flattens this, and nothing a caller can observe reveals it.
func TestARoutineNotFoundLogsFailedWithItsReasonAndDoesNotMarkTheSpanError(t *testing.T) {
	run := runPipeline(t, routineNotFoundHandler, probeQuery{OrderID: "ord_missing"}, nil)

	if !errors.Is(run.err, errProbeNotFound) {
		t.Fatalf("err = %v, want the handler's own sentinel to travel to the caller", run.err)
	}

	failed, ok := run.lineWith("probe_failed")
	if !ok {
		t.Fatalf("no probe_failed line for a routine failure: %v", run.lines)
	}
	if failed["reason"] != "not_found" {
		t.Errorf("reason = %v, want not_found", failed["reason"])
	}
	// WARN, not ERROR: a 404 is not an operator's problem.
	if failed["level"] != "WARN" {
		t.Errorf("level = %v, want WARN for a routine failure", failed["level"])
	}
	if _, present := run.lineWith("probe_succeeded"); present {
		t.Error("a failed flow also logged *_succeeded")
	}

	span := run.workflowSpan(t)
	if span.Status().Code == codes.Error {
		t.Error("the span is marked ERROR for a routine 404: the distinction is flattened")
	}
	if got, _ := spanAttr(span, "app_event"); got != "probe_failed" {
		t.Errorf("span app_event = %q, want probe_failed", got)
	}
	if got, _ := spanAttr(span, "reason"); got != "not_found" {
		t.Errorf("span reason = %q, want not_found", got)
	}
	if len(span.Events()) != 0 {
		t.Errorf("the span records an exception event for a routine failure: %v", span.Events())
	}
}

// ─── the genuine-fault path ─────────────────────────────────────────────────

func TestAGenuineFaultMarksTheSpanErrorAndLogsAtError(t *testing.T) {
	run := runPipeline(t, faultHandler, probeQuery{OrderID: "ord_1"}, nil)

	if run.err == nil {
		t.Fatal("err = nil, want the handler's error")
	}

	failed, ok := run.lineWith("probe_failed")
	if !ok {
		t.Fatalf("no probe_failed line: %v", run.lines)
	}
	if failed["reason"] != bus.ReasonUnhandledError {
		t.Errorf("reason = %v, want %q", failed["reason"], bus.ReasonUnhandledError)
	}
	if failed["level"] != "ERROR" {
		t.Errorf("level = %v, want ERROR for a genuine fault", failed["level"])
	}

	span := run.workflowSpan(t)
	if span.Status().Code != codes.Error {
		t.Errorf("span status = %v, want Error for a genuine fault", span.Status().Code)
	}
	if len(span.Events()) == 0 {
		t.Error("a genuine fault recorded no exception event on the span")
	}
}

// A handler's own specific reason must survive the generic layer. The Node
// predecessor stamped `unhandled_error` over it, and last-write-wins on the span
// destroyed the specific token.
func TestASpecificRoutineReasonIsNotOverwrittenByTheGenericToken(t *testing.T) {
	handler := func(_ context.Context, _ probeQuery) (probeResult, error) {
		return probeResult{}, bus.Routine(errors.New("already delivered"), "already_delivered")
	}

	run := runPipeline(t, handler, probeQuery{OrderID: "ord_1"}, nil)

	failed, ok := run.lineWith("probe_failed")
	if !ok {
		t.Fatalf("no probe_failed line: %v", run.lines)
	}
	if failed["reason"] != "already_delivered" {
		t.Errorf("reason = %v, want already_delivered (not the generic token)", failed["reason"])
	}
	if got, _ := spanAttr(run.workflowSpan(t), "reason"); got != "already_delivered" {
		t.Errorf("span reason = %q, want already_delivered", got)
	}
}

// ─── validation ─────────────────────────────────────────────────────────────

var errProbeInvalid = errors.New("order_id is required")

// Validation is INNERMOST, so a rejection still produces the full started/failed
// pair and a span — the observability of a rejected request is the point.
func TestValidationRejectsBeforeTheHandlerAndStillEmitsTheFailedEvent(t *testing.T) {
	reached := false
	handler := func(_ context.Context, _ probeQuery) (probeResult, error) {
		reached = true
		return probeResult{Found: true}, nil
	}
	validate := func(q probeQuery) error {
		if q.OrderID == "" {
			return bus.Routine(errProbeInvalid, "missing_order_id")
		}
		return nil
	}

	run := runPipeline(t, handler, probeQuery{}, validate)

	if reached {
		t.Error("the handler ran on an invalid message")
	}
	if !errors.Is(run.err, errProbeInvalid) {
		t.Fatalf("err = %v, want the validator's error", run.err)
	}

	failed, ok := run.lineWith("probe_failed")
	if !ok {
		t.Fatalf("no probe_failed line for a rejected message: %v", run.lines)
	}
	if failed["reason"] != "missing_order_id" {
		t.Errorf("reason = %v, want missing_order_id", failed["reason"])
	}
	if run.workflowSpan(t).Status().Code == codes.Error {
		t.Error("a validation rejection is marked ERROR on the span: it is a routine 4xx")
	}
}

func TestValidationLetsAValidMessageThrough(t *testing.T) {
	validate := func(probeQuery) error { return nil }

	run := runPipeline(t, okHandler, probeQuery{OrderID: "ord_1"}, validate)

	if run.err != nil {
		t.Fatalf("err = %v, want nil", run.err)
	}
	if _, ok := run.lineWith("probe_succeeded"); !ok {
		t.Errorf("no probe_succeeded line: %v", run.lines)
	}
}

// ─── the pipeline ORDER (D4) ────────────────────────────────────────────────

// CONTRACT: D4's order is tracing -> app_event -> logging -> validation, and each
// step is load-bearing — tracing outside app_event (or its attributes are dropped),
// app_event outside logging, validation innermost (or a rejection is untraced).
// See [[cqrs]]
func TestThePipelineOrderIsTracingThenAppEventThenLoggingThenValidation(t *testing.T) {
	want := []string{"tracing", "app_event", "logging", "validation"}
	got := bus.PipelineOrder()

	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("pipeline order:\n got %v\nwant %v", got, want)
	}
}

// The order as BEHAVIOUR rather than as a list: the span attributes the app_event
// layer sets arrive only if tracing opened the span first, and the log lines the
// logging layer writes carry the app_event only if that layer ran outside it.
func TestTheDeclaredOrderIsTheOrderTheBehavioursActuallyRunIn(t *testing.T) {
	run := runPipeline(t, okHandler, probeQuery{OrderID: "ord_1"}, func(probeQuery) error { return nil })

	// tracing outermost: the app_event layer's attribute landed on a live span.
	if got, _ := spanAttr(run.workflowSpan(t), "app_event"); got != "probe_succeeded" {
		t.Errorf("span app_event = %q: the app_event layer ran outside the span, so its attributes were dropped", got)
	}
	// app_event outside logging: the logged line carries the decided event.
	if _, ok := run.lineWith("probe_succeeded"); !ok {
		t.Errorf("no probe_succeeded log line: the logging layer did not see the app_event layer's decision: %v", run.lines)
	}
	// The log line carries trace_id, which only holds while the span is live —
	// i.e. the logging layer runs INSIDE tracing.
	succeeded, _ := run.lineWith("probe_succeeded")
	if succeeded["trace_id"] == nil || succeeded["trace_id"] == "" {
		t.Errorf("the closing line carries no trace_id: it was written after the span was restored: %v", succeeded)
	}
}
