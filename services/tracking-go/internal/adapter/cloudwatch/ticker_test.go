package cloudwatch_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/cloudwatch"
)

type recordedDatum struct {
	name       string
	value      float64
	dimensions [][2]string
}

type recordingPublisher struct {
	mu   sync.Mutex
	data []recordedDatum
	// notify fires after each Publish so a test can wait deterministically.
	notify chan struct{}
}

func newRecordingPublisher() *recordingPublisher {
	return &recordingPublisher{notify: make(chan struct{}, 128)}
}

func (r *recordingPublisher) Publish(_ context.Context, name string, value float64, dimensions [][2]string) {
	r.mu.Lock()
	r.data = append(r.data, recordedDatum{name, value, dimensions})
	r.mu.Unlock()
	select {
	case r.notify <- struct{}{}:
	default:
	}
}

func (r *recordingPublisher) snapshot() []recordedDatum {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]recordedDatum(nil), r.data...)
}

// waitFor blocks until n data points have been published or the deadline passes.
func (r *recordingPublisher) waitFor(t *testing.T, n int) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		if len(r.snapshot()) >= n {
			return
		}
		select {
		case <-r.notify:
		case <-deadline:
			t.Fatalf("timed out waiting for %d data points; got %d", n, len(r.snapshot()))
		}
	}
}

type stubCounter struct {
	mu     sync.Mutex
	counts map[string]int64
	err    error
	calls  int
}

func (s *stubCounter) CountByStatus(context.Context) (map[string]int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	return s.counts, s.err
}

func (s *stubCounter) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// Each tick publishes FIVE data points: 3 status series + 2 http_errors_total
// seeds at zero, so a panel renders "no errors" rather than "Error Loading Data".
func TestOneTickPublishesFiveDataPoints(t *testing.T) {
	pub := newRecordingPublisher()
	counts := &stubCounter{counts: map[string]int64{"DELIVERED": 2, "PLACED": 3}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go cloudwatch.RunTicker(ctx, pub, counts, 10*time.Millisecond, quietLogger())

	pub.waitFor(t, 5)
	cancel()

	got := pub.snapshot()[:5]
	want := map[string]float64{
		"orders_by_tracking_status_total|DELIVERED":   2,
		"orders_by_tracking_status_total|IN_PROGRESS": 3,
		// ALL is a PRE-SUMMED published series, not a dashboard sum.
		"orders_by_tracking_status_total|ALL": 5,
		"http_errors_total|4xx":               0,
		"http_errors_total|5xx":               0,
	}
	seen := map[string]float64{}
	for _, d := range got {
		label := d.dimensions[len(d.dimensions)-1][1]
		seen[d.name+"|"+label] = d.value
	}
	for key, wantValue := range want {
		gotValue, present := seen[key]
		if !present {
			t.Errorf("datum %s was not published", key)
			continue
		}
		if gotValue != wantValue {
			t.Errorf("%s = %v, want %v", key, gotValue, wantValue)
		}
	}
}

// Both status series are published even at zero.
func TestZeroCountsAreStillPublished(t *testing.T) {
	pub := newRecordingPublisher()
	counts := &stubCounter{counts: map[string]int64{}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go cloudwatch.RunTicker(ctx, pub, counts, 10*time.Millisecond, quietLogger())

	pub.waitFor(t, 5)
	cancel()

	labels := map[string]bool{}
	for _, d := range pub.snapshot() {
		if d.name == "orders_by_tracking_status_total" {
			labels[d.dimensions[len(d.dimensions)-1][1]] = true
		}
	}
	for _, label := range []string{"DELIVERED", "IN_PROGRESS", "ALL"} {
		if !labels[label] {
			t.Errorf("%s was skipped at zero; a series that stops being published reads as 'no data', not zero", label)
		}
	}
}

// It SLEEPS FIRST. At startup the DB may be unreachable, and a tick before the
// first interval yields only an unactionable failure line.
func TestTickerSleepsBeforeItsFirstPublish(t *testing.T) {
	pub := newRecordingPublisher()
	counts := &stubCounter{counts: map[string]int64{"DELIVERED": 1}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go cloudwatch.RunTicker(ctx, pub, counts, 300*time.Millisecond, quietLogger())

	time.Sleep(80 * time.Millisecond)
	if n := len(pub.snapshot()); n != 0 {
		t.Fatalf("published %d data points before the first interval elapsed; the ticker must sleep first", n)
	}
	if c := counts.callCount(); c != 0 {
		t.Fatalf("queried the database %d times before the first interval; the ticker must sleep first", c)
	}
}

// A per-tick failure is swallowed and THE LOOP CONTINUES. Unlike a TestMode run,
// this loop has no natural end: a blip must cost one datapoint, not the rest of
// the process's metrics.
func TestTickerContinuesAfterAFailedTick(t *testing.T) {
	pub := newRecordingPublisher()
	counts := &stubCounter{err: errors.New("database is unreachable")}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go cloudwatch.RunTicker(ctx, pub, counts, 10*time.Millisecond, quietLogger())

	// Let several ticks fail.
	time.Sleep(120 * time.Millisecond)
	if counts.callCount() < 2 {
		t.Fatalf("the loop stopped after a failed tick; got %d queries", counts.callCount())
	}

	// Once the database recovers, publishing resumes.
	counts.mu.Lock()
	counts.err = nil
	counts.counts = map[string]int64{"DELIVERED": 1}
	counts.mu.Unlock()

	pub.waitFor(t, 5)
	cancel()
}

// Only context cancellation ends it.
func TestTickerStopsOnContextCancellation(t *testing.T) {
	pub := newRecordingPublisher()
	counts := &stubCounter{counts: map[string]int64{"DELIVERED": 1}}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		cloudwatch.RunTicker(ctx, pub, counts, 10*time.Millisecond, quietLogger())
		close(done)
	}()

	pub.waitFor(t, 5)
	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("RunTicker did not return after its context was cancelled")
	}
}
