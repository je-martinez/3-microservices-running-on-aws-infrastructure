package main

import (
	"context"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/cloudwatch"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
)

// CONTRACT: These assert the SEAM between the cache's metrics port and the
// CloudWatch publisher. Each half passes in isolation — gateway_test proves the
// gateway CAN publish through its own spy, publisher_test proves the publisher
// CAN emit through its own double — and neither can see that nothing connects
// them, leaving a dashboard permanently at "no data" with no failing test.
// selectCacheMetrics is that seam, extracted so it CAN be asserted on.
// See [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]]

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

// TestCacheMetricsToleratesAnAbsentPublisher pins the degraded wiring: with
// METRICS_ENABLED on and no publisher constructed, the cache gets the noop, not
// a nil that panics on the first cache operation. The nil is passed as a TYPED
// nil interface value, exactly how the bug would arrive.
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
