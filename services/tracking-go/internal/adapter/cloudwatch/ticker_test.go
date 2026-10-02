package cloudwatch_test

import (
	"context"
	"errors"
	"fmt"
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

// waitForName blocks until a datum named name has been published. A count is not
// enough where failed ticks also publish: their seeds would satisfy it.
func (r *recordingPublisher) waitForName(t *testing.T, name string) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		for _, d := range r.snapshot() {
			if d.name == name {
				return
			}
		}
		select {
		case <-r.notify:
		case <-deadline:
			t.Fatalf("timed out waiting for a %s datum; got %d data points", name, len(r.snapshot()))
		}
	}
}

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// Each tick publishes FIVE data points: 3 status series + 2 http_errors_total
// seeds at zero, so a panel renders "no errors" rather than "Error Loading Data".
func TestOneTickPublishesFiveDataPoints(t *testing.T) {
	pub := newRecordingPublisher()
	counts := &stubCounter{counts: map[string]int64{"DELIVERED": 2, "PLACED": 3}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go cloudwatch.RunTicker(ctx, pub, counts, nil, 10*time.Millisecond, quietLogger())

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

// Every seed is published at ZERO each tick, under exactly its own dimension set.
func TestEveryTickPublishesEachSeedAtZero(t *testing.T) {
	pub := newRecordingPublisher()
	counts := &stubCounter{counts: map[string]int64{"DELIVERED": 1}}
	seeds := []cloudwatch.Series{
		{Name: "cache_requests_total", Dimensions: [][2]string{{"Service", "tracking"}, {"KeyPrefix", "a:b:v1"}, {"Result", "hit"}}},
		{Name: "cache_requests_total", Dimensions: [][2]string{{"Service", "tracking"}, {"KeyPrefix", "a:b:v1"}, {"Result", "bypass"}}},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go cloudwatch.RunTicker(ctx, pub, counts, seeds, 10*time.Millisecond, quietLogger())

	// Two full ticks: a seed published once and then dropped still goes flat.
	pub.waitFor(t, 2*(5+len(seeds)))
	cancel()

	perSeed := map[string]int{}
	for _, d := range pub.snapshot() {
		if d.name != "cache_requests_total" {
			continue
		}
		if d.value != 0 {
			t.Errorf("seed %v published %v, want 0", d.dimensions, d.value)
		}
		perSeed[fmt.Sprint(d.dimensions)]++
	}
	for _, s := range seeds {
		if perSeed[fmt.Sprint(s.Dimensions)] < 2 {
			t.Errorf("seed %v published %d times over two ticks, want every tick",
				s.Dimensions, perSeed[fmt.Sprint(s.Dimensions)])
		}
	}
}

// Both status series are published even at zero.
func TestZeroCountsAreStillPublished(t *testing.T) {
	pub := newRecordingPublisher()
	counts := &stubCounter{counts: map[string]int64{}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go cloudwatch.RunTicker(ctx, pub, counts, nil, 10*time.Millisecond, quietLogger())

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
	go cloudwatch.RunTicker(ctx, pub, counts, nil, 300*time.Millisecond, quietLogger())

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
	go cloudwatch.RunTicker(ctx, pub, counts, nil, 10*time.Millisecond, quietLogger())

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

	pub.waitForName(t, "orders_by_tracking_status_total")
	cancel()
}

// A failed status query still publishes every zero seed. A database outage is
// exactly when an http_errors_total or cache_requests_total panel must keep
// reading 0 rather than "Error Loading Data"; the status series are the only
// casualty.
func TestFailedStatusQueryStillPublishesEverySeed(t *testing.T) {
	pub := newRecordingPublisher()
	counts := &stubCounter{err: errors.New("database is unreachable")}
	seeds := []cloudwatch.Series{
		{Name: "cache_requests_total", Dimensions: [][2]string{{"Service", "tracking"}, {"KeyPrefix", "a:b:v1"}, {"Result", "hit"}}},
		{Name: "cache_requests_total", Dimensions: [][2]string{{"Service", "tracking"}, {"KeyPrefix", "a:b:v1"}, {"Result", "miss"}}},
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go cloudwatch.RunTicker(ctx, pub, counts, seeds, 10*time.Millisecond, quietLogger())

	pub.waitFor(t, 2+len(seeds))
	cancel()

	seen := map[string]float64{}
	for _, d := range pub.snapshot() {
		if d.name == "orders_by_tracking_status_total" {
			t.Fatalf("published %s|%s although the status query failed", d.name, d.dimensions[len(d.dimensions)-1][1])
		}
		seen[d.name+"|"+fmt.Sprint(d.dimensions)] = d.value
	}
	want := []string{
		"http_errors_total|" + fmt.Sprint([][2]string{{"Service", "tracking"}, {"StatusClass", "4xx"}}),
		"http_errors_total|" + fmt.Sprint([][2]string{{"Service", "tracking"}, {"StatusClass", "5xx"}}),
	}
	for _, s := range seeds {
		want = append(want, s.Name+"|"+fmt.Sprint(s.Dimensions))
	}
	for _, key := range want {
		value, present := seen[key]
		if !present {
			t.Errorf("seed %s was not published on a failed tick", key)
			continue
		}
		if value != 0 {
			t.Errorf("seed %s = %v, want 0", key, value)
		}
	}
}

// Only context cancellation ends it.
func TestTickerStopsOnContextCancellation(t *testing.T) {
	pub := newRecordingPublisher()
	counts := &stubCounter{counts: map[string]int64{"DELIVERED": 1}}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		cloudwatch.RunTicker(ctx, pub, counts, nil, 10*time.Millisecond, quietLogger())
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
