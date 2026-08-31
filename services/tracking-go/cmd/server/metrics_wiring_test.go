package main

import (
	"context"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/cloudwatch"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
)

// The CACHE's metrics port and the CLOUDWATCH publisher are two components that
// were each correct, each tested, and NOT CONNECTED TO EACH OTHER.
//
// internal/adapter/redis computes cache_requests_total and
// cache_operation_duration_ms on every single cache operation — hit, miss,
// bypass, set, invalidate — and hands them to the narrow `cache.Metrics` port it
// declares itself. The composition root passed `cache.NewNoopMetrics()` there
// unconditionally, so every one of those datapoints was computed and then
// discarded, even with METRICS_ENABLED=true.
//
// # WHY NO EXISTING TEST CAUGHT IT
//
// Because both halves pass in isolation, which is the whole shape of this class
// of bug:
//
//   - gateway_test.go asserts the gateway publishes both metrics — through a spy
//     it injects itself. It proves the gateway CAN publish, never that anything
//     in the running process RECEIVES.
//   - publisher_test.go asserts the CloudWatch publisher emits a correct datum —
//     through a recording double it injects itself. It proves the publisher CAN
//     emit, never that anything CALLS it with a cache metric.
//
// The seam between them lived in main(), which cannot be imported, so nothing
// asserted on it at all. Two green suites, a dashboard permanently at "no data",
// and no failing test anywhere.
//
// selectCacheMetrics is that seam, extracted so it CAN be asserted on.

// TestCacheMetricsReachCloudWatchWhenMetricsAreEnabled is the production-path
// assertion: with METRICS_ENABLED on, the object handed to the cache gateway must
// be the REAL publisher, not the discarding one.
//
// It asserts on the concrete behaviour rather than the type name: a Metrics that
// forwards is one whose Publish reaches the CloudWatch client underneath.
func TestCacheMetricsReachCloudWatchWhenMetricsAreEnabled(t *testing.T) {
	recorder := &recordingPublisher{}

	metrics := selectCacheMetrics(true, recorder)
	metrics.Publish(context.Background(), cache.MetricCacheRequests, 1, [][2]string{
		{"Service", "tracking"},
		{"KeyPrefix", "tracking:order:v1"},
		{"Result", "hit"},
	})

	if len(recorder.names) != 1 {
		t.Fatalf("the cache published %d metrics through to CloudWatch, want 1. "+
			"Zero means the gateway's metrics port is bound to the noop and every "+
			"cache datapoint is computed and discarded", len(recorder.names))
	}
	if recorder.names[0] != cache.MetricCacheRequests {
		t.Errorf("metric name = %q, want %q", recorder.names[0], cache.MetricCacheRequests)
	}
}

// TestCacheMetricsAreDiscardedWhenMetricsAreDisabled is the other half of the
// flag, and it is a real assertion rather than symmetry for its own sake:
// METRICS_ENABLED=false must mean NOTHING reaches CloudWatch, so a runtime with
// the flag off makes no AWS calls from the request path.
func TestCacheMetricsAreDiscardedWhenMetricsAreDisabled(t *testing.T) {
	recorder := &recordingPublisher{}

	metrics := selectCacheMetrics(false, recorder)
	metrics.Publish(context.Background(), cache.MetricCacheRequests, 1, nil)
	metrics.Publish(context.Background(), cache.MetricCacheOperationDuration, 3.5, nil)

	if len(recorder.names) != 0 {
		t.Errorf("METRICS_ENABLED=false still published %v to CloudWatch; want nothing", recorder.names)
	}
}

// TestCacheMetricsToleratesAnAbsentPublisher pins the degraded wiring: when
// METRICS_ENABLED is true but no publisher was constructed, the cache must get
// the noop rather than a nil that panics on the first cache operation.
//
// The nil is passed as a TYPED nil interface value, which is exactly how the bug
// would arrive: cloudwatch.Publisher is an interface, and a nil one reaching the
// gateway would panic on the first request rather than at startup.
func TestCacheMetricsToleratesAnAbsentPublisher(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("selectCacheMetrics(true, nil) panicked: %v", r)
		}
	}()

	metrics := selectCacheMetrics(true, nil)
	if metrics == nil {
		t.Fatal("selectCacheMetrics returned a nil Metrics; the gateway would panic on the first cache operation")
	}
	metrics.Publish(context.Background(), cache.MetricCacheRequests, 1, nil)
}

// recordingPublisher is a cloudwatch.Publisher that remembers what it was asked
// to emit. A local double rather than a shared one: the point of this file is to
// observe the SEAM, and a double declared here cannot drift with another
// package's needs.
type recordingPublisher struct {
	names []string
}

func (r *recordingPublisher) Publish(_ context.Context, name string, _ float64, _ [][2]string) {
	r.names = append(r.names, name)
}

// Compile-time proof the double really satisfies the port it stands in for.
var _ cloudwatch.Publisher = (*recordingPublisher)(nil)
