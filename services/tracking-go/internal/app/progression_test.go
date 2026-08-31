package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	oteltrace "go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// progFakeTransitioner advances an in-memory status the way UpdateStatus would,
// and records the actor it was called with.
//
// It is mutex-guarded because the central test drives it from a REAL goroutine
// while the assertions read it from the test's: without the lock `-race` would
// fail on the very test that exists to prove the goroutine keeps running.
type progFakeTransitioner struct {
	mu       sync.Mutex
	status   domain.Status
	actors   []audit.Actor
	calls    int
	deleted  int
	failWith error
}

func (f *progFakeTransitioner) Execute(
	_ context.Context, orderID string, requested domain.Status, actor audit.Actor,
) (domain.TrackingWithHistory, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.actors = append(f.actors, actor)
	if f.failWith != nil {
		return domain.TrackingWithHistory{}, f.failWith
	}
	f.status = requested
	return domain.TrackingWithHistory{Tracking: domain.Tracking{
		OrderID: orderID,
		Status:  requested,
	}}, nil
}

func (f *progFakeTransitioner) ContinueDeletedTestMode(
	_ context.Context,
	current domain.TrackingWithHistory,
	requested domain.Status,
) (domain.TrackingWithHistory, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.deleted++
	f.actors = append(f.actors, audit.TestModeProgression)
	if f.failWith != nil {
		return domain.TrackingWithHistory{}, f.failWith
	}
	f.status = requested
	current.Tracking.Status = requested
	return current, nil
}

func (f *progFakeTransitioner) Status() domain.Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.status
}

func (f *progFakeTransitioner) Calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func (f *progFakeTransitioner) DeletedCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.deleted
}

func (f *progFakeTransitioner) Actors() []audit.Actor {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]audit.Actor(nil), f.actors...)
}

// progFakeReader is the UNSCOPED read port. Its method takes NO identity
// argument at all, which is the structural half of the rule: there is no
// parameter a caller could accidentally pass "" into and turn an unscoped read
// into one scoped to the empty string.
type progFakeReader struct {
	t         *progFakeTransitioner
	err       error
	gone      bool
	goneAfter int
}

func (r *progFakeReader) GetByOrderID(_ context.Context, orderID string) (domain.Tracking, error) {
	if r.gone || (r.goneAfter > 0 && r.t.Calls() >= r.goneAfter) {
		return domain.Tracking{}, domain.ErrTrackingNotFound
	}
	if r.err != nil {
		return domain.Tracking{}, r.err
	}
	return domain.Tracking{OrderID: orderID, Status: r.t.Status()}, nil
}

// progLogs captures the JSON log lines so a test can assert on the machine
// readable `reason` the convention requires on every *_failed event.
type progLogs struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *progLogs) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

// Has reports whether any captured line carries key=value.
func (l *progLogs) Has(key, value string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, line := range strings.Split(l.buf.String(), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var fields map[string]any
		if err := json.Unmarshal([]byte(line), &fields); err != nil {
			continue
		}
		if got, ok := fields[key].(string); ok && got == value {
			return true
		}
	}
	return false
}

// progLogger returns a real service logger writing into the capture buffer, so
// the assertions read the SAME JSON shape production emits.
func progLogger(t *testing.T) (*progLogs, *slog.Logger) {
	t.Helper()
	logs := &progLogs{}
	return logs, logging.New(logs, logging.ServiceName, "test")
}

// progRecorder installs an in-memory exporter and returns the tracer to inject
// plus the exporter the span assertions read from.
func progRecorder(t *testing.T) (oteltrace.Tracer, *tracetest.InMemoryExporter) {
	t.Helper()
	exporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	return tp.Tracer("progression_test"), exporter
}

func progNoopTracer() oteltrace.Tracer { return noop.NewTracerProvider().Tracer("noop") }

func progSnapshot(orderID string, status domain.Status) domain.TrackingWithHistory {
	tracking := domain.Tracking{OrderID: orderID, Status: status}
	return domain.TrackingWithHistory{Tracking: tracking}
}

// progPanickingTransitioner is the layer beneath a returned error: the call
// itself blowing up.
type progPanickingTransitioner struct{}

func (progPanickingTransitioner) Execute(
	context.Context, string, domain.Status, audit.Actor,
) (domain.TrackingWithHistory, error) {
	panic("transition exploded")
}

func (progPanickingTransitioner) ContinueDeletedTestMode(
	context.Context,
	domain.TrackingWithHistory,
	domain.Status,
) (domain.TrackingWithHistory, error) {
	panic("transition exploded")
}

func TestProgression(t *testing.T) {
	// ~0 interval so the suite never sleeps 40 seconds.
	const fast = time.Millisecond

	t.Run("PLACED to DELIVERED is FOUR transitions, not five", func(t *testing.T) {
		tr := &progFakeTransitioner{status: domain.StatusPlaced}
		logs, log := progLogger(t)
		p := app.NewProgression(context.Background(), &progFakeReader{t: tr}, tr,
			fast, log, progNoopTracer())

		p.Run(context.Background(), "ord_1")

		if got := tr.Status(); got != domain.StatusDelivered {
			t.Fatalf("final status = %q, want DELIVERED", got)
		}
		if tr.Calls() != 4 {
			t.Fatalf("transitions = %d, want 4 — creation writes PLACED itself, so "+
				"the run leaves 5 history rows and sends 4 events", tr.Calls())
		}
		// Reaching DELIVERED is the CLEAN ending, and the convention has no
		// SUCCESS severity: success is INFO plus app_event=*_succeeded. Reporting
		// it as *_failed with a reason would make every healthy TestMode run show
		// up in the failure dashboards.
		if !logs.Has("app_event", "test_mode_progression_succeeded") {
			t.Error("reaching DELIVERED must log app_event=test_mode_progression_succeeded")
		}
		if logs.Has("app_event", "test_mode_progression_failed") {
			t.Error("a run that reached DELIVERED must not log a *_failed event")
		}
		if !logs.Has("app_event", "test_mode_progression_started") {
			t.Error("the run must open with app_event=test_mode_progression_started")
		}
	})

	t.Run("every transition carries the test-mode actor", func(t *testing.T) {
		tr := &progFakeTransitioner{status: domain.StatusPlaced}
		_, log := progLogger(t)
		p := app.NewProgression(context.Background(), &progFakeReader{t: tr}, tr,
			fast, log, progNoopTracer())

		p.Run(context.Background(), "ord_1")

		actors := tr.Actors()
		if len(actors) != 4 {
			t.Fatalf("actors recorded = %d, want 4", len(actors))
		}
		for i, a := range actors {
			if a != audit.TestModeProgression {
				t.Errorf("transition %d actor = %q, want tracking_api:test_mode_progression "+
					"(the ONLY difference from the carrier path)", i, a)
			}
		}
	})

	// THE CENTRAL TEST. A faithful line-by-line port of the Python would give the
	// goroutine the request's context, which Go cancels the moment the response is
	// sent — and the run would die at the first transition. The symptom is
	// identical to the accepted restart limitation ("frozen after a restart"), so
	// the bug would disguise itself as a known limitation and nobody would look.
	t.Run("the run SURVIVES the request context being cancelled", func(t *testing.T) {
		tr := &progFakeTransitioner{status: domain.StatusPlaced}
		_, log := progLogger(t)
		p := app.NewProgression(context.Background(), &progFakeReader{t: tr}, tr,
			fast, log, progNoopTracer())

		// The request's context, cancelled exactly as net/http cancels it when
		// the handler returns.
		//
		// Start takes NO context: the signature itself is the fix. There is no
		// parameter through which a handler could hand its dying context to a
		// goroutine that has to outlive it. This test cancels the request context
		// anyway, from the caller's side, to prove that nothing the progression
		// reached for is tied to it.
		requestCtx, cancelRequest := context.WithCancel(context.Background())
		p.Start(progSnapshot("ord_1", domain.StatusPlaced))
		cancelRequest()
		<-requestCtx.Done()

		done := make(chan struct{})
		go func() { p.Wait(context.Background()); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("the run never finished")
		}

		if got := tr.Status(); got != domain.StatusDelivered {
			t.Fatalf("final status = %q, want DELIVERED — the goroutine inherited the "+
				"request's context and died when the response was sent", got)
		}
		if tr.Calls() != 4 {
			t.Fatalf("transitions = %d, want 4 — the run was cut short by the "+
				"request context", tr.Calls())
		}
	})

	t.Run("a missing initial row is reported explicitly", func(t *testing.T) {
		tr := &progFakeTransitioner{status: domain.StatusPlaced}
		logs, log := progLogger(t)
		p := app.NewProgression(context.Background(), &progFakeReader{t: tr, gone: true}, tr,
			fast, log, progNoopTracer())

		p.Run(context.Background(), "ord_gone") // must return, not panic, not hang

		if tr.Calls() != 0 {
			t.Errorf("transitions = %d, want 0", tr.Calls())
		}
		if !logs.Has("reason", "tracking_not_found") {
			t.Error("a run with no committed snapshot must report reason=tracking_not_found")
		}
	})

	t.Run("a delete mid-run does not truncate the published status chain", func(t *testing.T) {
		tr := &progFakeTransitioner{status: domain.StatusPlaced}
		logs, log := progLogger(t)
		p := app.NewProgression(context.Background(),
			&progFakeReader{t: tr, goneAfter: 2}, tr,
			fast, log, progNoopTracer())

		p.Run(context.Background(), "ord_deleted_mid_run")

		if got := tr.Status(); got != domain.StatusDelivered {
			t.Errorf("final status = %q, want DELIVERED", got)
		}
		if tr.Calls() != 4 {
			t.Errorf("published transitions = %d, want 4 — deleting the row after two "+
				"ticks must not strand SHIPPED as the last published status", tr.Calls())
		}
		if tr.DeletedCalls() != 2 {
			t.Errorf("post-delete transitions = %d, want 2", tr.DeletedCalls())
		}
		if logs.Has("reason", "tracking_not_found") {
			t.Error("a teardown delete is an expected race, not a failed progression")
		}
		if !logs.Has("app_event", "test_mode_progression_succeeded") {
			t.Error("a progression that publishes the full chain must end with *_succeeded")
		}
	})

	t.Run("the creation snapshot survives deletion before the first tick", func(t *testing.T) {
		tr := &progFakeTransitioner{status: domain.StatusPlaced}
		logs, log := progLogger(t)
		p := app.NewProgression(context.Background(), &progFakeReader{t: tr, gone: true}, tr,
			fast, log, progNoopTracer())

		p.Start(progSnapshot("ord_deleted_before_tick", domain.StatusPlaced))
		p.Wait(context.Background())

		if got := tr.Status(); got != domain.StatusDelivered {
			t.Errorf("final status = %q, want DELIVERED", got)
		}
		if tr.Calls() != 4 || tr.DeletedCalls() != 4 {
			t.Errorf("transitions = %d (%d post-delete), want 4 (4 post-delete)",
				tr.Calls(), tr.DeletedCalls())
		}
		if logs.Has("reason", "tracking_not_found") {
			t.Error("the committed creation snapshot must close the read-before-cleanup race")
		}
		if !logs.Has("app_event", "test_mode_progression_succeeded") {
			t.Error("the snapshot-backed chain must end with *_succeeded")
		}
	})

	t.Run("a carrier PUT moving it first ends the run, logging the guard's reason", func(t *testing.T) {
		tr := &progFakeTransitioner{
			status: domain.StatusPlaced,
			failWith: &domain.InvalidTransitionError{
				Current:   domain.StatusDelivered,
				Requested: domain.StatusProcessing,
				Reason:    domain.ReasonNotStrictlyForward,
			},
		}
		logs, log := progLogger(t)
		p := app.NewProgression(context.Background(), &progFakeReader{t: tr}, tr,
			fast, log, progNoopTracer())

		p.Run(context.Background(), "ord_1")

		if tr.Calls() != 1 {
			t.Fatalf("transitions = %d, want 1 — a rejected forward-only transition "+
				"must NEVER be retried; retrying can only be rejected again, forever", tr.Calls())
		}
		if !logs.Has("reason", string(domain.ReasonNotStrictlyForward)) {
			t.Error("the guard's own reason must be logged")
		}
	})

	t.Run("an unexpected error ends the run with reason=unexpected_error", func(t *testing.T) {
		tr := &progFakeTransitioner{status: domain.StatusPlaced, failWith: errors.New("boom")}
		logs, log := progLogger(t)
		p := app.NewProgression(context.Background(), &progFakeReader{t: tr}, tr,
			fast, log, progNoopTracer())

		p.Run(context.Background(), "ord_1")

		if tr.Calls() != 1 {
			t.Errorf("transitions = %d, want 1 — an unexpected error ends the run", tr.Calls())
		}
		if !logs.Has("reason", "unexpected_error") {
			t.Error("an unexpected error must be logged with reason=unexpected_error")
		}
	})

	t.Run("a failing read ends the run with reason=unexpected_error", func(t *testing.T) {
		tr := &progFakeTransitioner{status: domain.StatusPlaced}
		logs, log := progLogger(t)
		p := app.NewProgression(context.Background(),
			&progFakeReader{t: tr, err: errors.New("connection refused")}, tr,
			fast, log, progNoopTracer())

		p.Run(context.Background(), "ord_1")

		if tr.Calls() != 0 {
			t.Errorf("transitions = %d, want 0 — the read failed", tr.Calls())
		}
		if !logs.Has("reason", "unexpected_error") {
			t.Error("a failing read must be logged with reason=unexpected_error")
		}
	})

	t.Run("shutdown cancels the run and logs it", func(t *testing.T) {
		tr := &progFakeTransitioner{status: domain.StatusPlaced}
		logs, log := progLogger(t)
		// A process context, and an interval long enough that the run is
		// certainly still sleeping when shutdown arrives.
		base, shutdown := context.WithCancel(context.Background())
		p := app.NewProgression(base, &progFakeReader{t: tr}, tr,
			500*time.Millisecond, log, progNoopTracer())

		p.Start(progSnapshot("ord_1", domain.StatusPlaced))
		shutdown()

		done := make(chan struct{})
		go func() { p.Wait(context.Background()); close(done) }()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("Wait did not return after shutdown — the process would exit " +
				"leaving goroutines mid-flight")
		}

		if !logs.Has("reason", "cancelled") {
			t.Error("shutdown must be logged: the process must not exit leaving " +
				"goroutines mid-flight without at least saying so")
		}
	})

	t.Run("Wait returns when its own context expires, logging the incomplete drain", func(t *testing.T) {
		tr := &progFakeTransitioner{status: domain.StatusPlaced}
		logs, log := progLogger(t)
		// A run that will not finish within the drain budget, on a base context
		// that is NEVER cancelled.
		p := app.NewProgression(context.Background(), &progFakeReader{t: tr}, tr,
			10*time.Second, log, progNoopTracer())
		p.Start(progSnapshot("ord_1", domain.StatusPlaced))

		waitCtx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()

		done := make(chan struct{})
		go func() { p.Wait(waitCtx); close(done) }()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("Wait ignored its own deadline and would hold the process open")
		}

		if !logs.Has("reason", "shutdown_deadline") {
			t.Error("an incomplete drain must be logged with reason=shutdown_deadline")
		}
	})

	t.Run("ONE root span for the run, one EVENT per tick", func(t *testing.T) {
		tr := &progFakeTransitioner{status: domain.StatusPlaced}
		tracer, exporter := progRecorder(t)
		_, log := progLogger(t)
		p := app.NewProgression(context.Background(), &progFakeReader{t: tr}, tr,
			fast, log, tracer)

		// A context carrying a LIVE parent span, as the creating request's would
		// if it were (wrongly) propagated. The run's span must still be a root.
		parentCtx, parentSpan := tracer.Start(context.Background(), "init_tracking")
		p.Run(parentCtx, "ord_1")
		parentSpan.End()

		var run tracetest.SpanStub
		var found int
		for _, s := range exporter.GetSpans() {
			if s.Name == "test_mode_progression" {
				run = s
				found++
			}
		}
		if found != 1 {
			t.Fatalf("test_mode_progression spans = %d, want exactly 1 for the whole run", found)
		}
		if run.Parent.IsValid() {
			t.Error("the run's span must be a ROOT — the creating request's span is " +
				"already closed by the time a background run starts")
		}
		if n := len(run.Events); n != 4 {
			t.Errorf("span events = %d, want 4 — each tick adds an EVENT, not a child span", n)
		}
	})

	// The span must cover the WORK, and the only way to prove that is to go
	// through Start — the spawning path production uses. A span opened around the
	// spawn instead of inside the goroutine ends the moment Start returns, so it
	// records a 40-second workflow as a microsecond of scheduling and carries
	// NONE of the per-tick events. Driving Run directly cannot catch that: Run is
	// where the span belongs either way.
	t.Run("the span opened by Start covers the whole run, not the spawn", func(t *testing.T) {
		tr := &progFakeTransitioner{status: domain.StatusPlaced}
		tracer, exporter := progRecorder(t)
		_, log := progLogger(t)
		p := app.NewProgression(context.Background(), &progFakeReader{t: tr}, tr,
			fast, log, tracer)

		p.Start(progSnapshot("ord_1", domain.StatusPlaced))

		done := make(chan struct{})
		go func() { p.Wait(context.Background()); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("the run never finished")
		}

		spans := exporter.GetSpans()
		if len(spans) != 1 {
			t.Fatalf("spans = %d, want exactly 1 for the whole run", len(spans))
		}
		run := spans[0]
		if run.Name != "test_mode_progression" {
			t.Errorf("span name = %q, want test_mode_progression", run.Name)
		}
		// The load-bearing assertion: the events are INSIDE the span. A span
		// closed around the spawn is already ended when the ticks happen, and an
		// ended span drops every AddEvent silently.
		if n := len(run.Events); n != 4 {
			t.Fatalf("span events = %d, want 4 — the span ended before the work "+
				"started, so every per-tick event was dropped on an ended span", n)
		}
		// And the span must still be OPEN when the last transition lands: its end
		// time cannot precede the event it claims to contain.
		last := run.Events[len(run.Events)-1].Time
		if run.EndTime.Before(last) {
			t.Errorf("span ended at %v, before its own last event at %v — the span "+
				"was opened around the spawn rather than inside the goroutine",
				run.EndTime, last)
		}
	})

	// A panic inside a background goroutine takes the WHOLE PROCESS down: there
	// is no handler frame above it and no gin.Recovery. A 40-second test fixture
	// must not be able to kill the service.
	t.Run("a panicking transition cannot take the process down", func(t *testing.T) {
		tr := &progPanickingTransitioner{}
		logs, log := progLogger(t)
		p := app.NewProgression(context.Background(),
			&progFakeReader{t: &progFakeTransitioner{status: domain.StatusPlaced}}, tr,
			fast, log, progNoopTracer())

		p.Run(context.Background(), "ord_1") // must return, not crash the test binary

		if !logs.Has("reason", "unexpected_error") {
			t.Error("a recovered panic must still end the run with reason=unexpected_error")
		}
	})

	// time.NewTicker PANICS on a non-positive duration, and this ticker is
	// created inside a goroutine where the panic would take the process down over
	// a misconfigured test fixture. A zero interval falls back to the design's
	// cadence instead.
	t.Run("a non-positive interval falls back to the default rather than panicking", func(t *testing.T) {
		for _, interval := range []time.Duration{0, -time.Second} {
			tr := &progFakeTransitioner{status: domain.StatusPlaced}
			logs, log := progLogger(t)
			p := app.NewProgression(context.Background(), &progFakeReader{t: tr}, tr,
				interval, log, progNoopTracer())

			// Cancel immediately: the point is that constructing the ticker does
			// not panic, not that a 10s run completes.
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			p.Run(ctx, "ord_1") // must return, not panic

			// It must END CLEANLY on the cancellation, not be rescued by Run's
			// recover(). The recover is the last line of defence against a panic
			// taking the process down; relying on it here would turn a
			// misconfigured interval into an unexplained unexpected_error on
			// every single TestMode request.
			if !logs.Has("reason", "cancelled") {
				t.Errorf("interval %v: the run did not end on the cancellation", interval)
			}
			if logs.Has("reason", "unexpected_error") {
				t.Errorf("interval %v: time.NewTicker panicked and was only rescued by "+
					"recover() — a non-positive interval must fall back to the default",
					interval)
			}
		}
	})

	t.Run("the default interval is the design's 10s cadence", func(t *testing.T) {
		if app.DefaultProgressionInterval != 10*time.Second {
			t.Errorf("DefaultProgressionInterval = %v, want 10s", app.DefaultProgressionInterval)
		}
	})
}
