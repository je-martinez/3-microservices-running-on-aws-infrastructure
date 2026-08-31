package cloudwatch_test

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/cloudwatch"
)

// startStubPublisher counts data points without reaching CloudWatch.
type startStubPublisher struct{ points atomic.Int64 }

func (s *startStubPublisher) Publish(context.Context, string, float64, [][2]string) {
	s.points.Add(1)
}

// startStubCounter answers the ticker's one query.
type startStubCounter struct{}

func (startStubCounter) CountByStatus(context.Context) (map[string]int64, error) {
	return map[string]int64{"PLACED": 1, "DELIVERED": 2}, nil
}

func startLogger() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }

// TestStartTickerReturnsNilWhenDisabled pins the GATE.
//
// METRICS_ENABLED is decided in the composition root and nowhere else, so "off"
// must mean the goroutine NEVER STARTS — not that a running loop skips its
// publishes. A nil join channel is how the caller learns there is nothing to wait
// for at shutdown.
func TestStartTickerReturnsNilWhenDisabled(t *testing.T) {
	publisher := &startStubPublisher{}

	done := cloudwatch.StartTicker(t.Context(), false, publisher, startStubCounter{},
		time.Millisecond, startLogger())

	if done != nil {
		t.Fatal("a join channel was returned with metrics disabled; the goroutine started")
	}

	time.Sleep(50 * time.Millisecond)
	if got := publisher.points.Load(); got != 0 {
		t.Fatalf("%d data points were published with metrics disabled, want 0", got)
	}
}

// TestStartTickerRunsForTheLifetimeOfItsContext is the one that catches the
// highest-risk mis-wire in this file.
//
// A goroutine that outlives a request MUST NOT inherit that request's context —
// it is cancelled the instant the response is sent, so a ticker wired to one dies
// on the first request and the dashboards go quiet with no error anywhere. Handed
// a LIVE context, the loop must keep publishing tick after tick.
//
// Asserted across SEVERAL intervals rather than one: a loop that dies after its
// first tick still publishes once, so a single-tick assertion cannot tell a
// working ticker from a dead one.
func TestStartTickerRunsForTheLifetimeOfItsContext(t *testing.T) {
	publisher := &startStubPublisher{}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := cloudwatch.StartTicker(ctx, true, publisher, startStubCounter{},
		5*time.Millisecond, startLogger())
	if done == nil {
		t.Fatal("no join channel was returned with metrics enabled; the goroutine never started")
	}

	// Five data points per tick, so >= 15 means at least three ticks ran.
	deadline := time.Now().Add(3 * time.Second)
	for publisher.points.Load() < 15 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := publisher.points.Load(); got < 15 {
		t.Fatalf("only %d data points after 3s at a 5ms interval; the ticker stopped early — "+
			"the usual cause is a context that does not live as long as the process", got)
	}

	// Cancelling the context must end it, and the join channel must close: a
	// ticker still publishing after shutdown holds the process open.
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the ticker did not stop within 2s of cancellation")
	}
}

// TestStartTickerStopsWhenItsContextIsAlreadyDead is the mirror image, and it is
// the assertion that fails if the composition root ever hands the ticker a
// request-scoped (already-cancelled) context.
func TestStartTickerStopsWhenItsContextIsAlreadyDead(t *testing.T) {
	publisher := &startStubPublisher{}

	dead, cancel := context.WithCancel(context.Background())
	cancel()

	done := cloudwatch.StartTicker(dead, true, publisher, startStubCounter{},
		5*time.Millisecond, startLogger())

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the ticker did not exit on an already-cancelled context")
	}

	if got := publisher.points.Load(); got != 0 {
		t.Fatalf("%d data points were published on a dead context, want 0", got)
	}
}
