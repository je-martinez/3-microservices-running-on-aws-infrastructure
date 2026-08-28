package main

import (
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/cloudwatch"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
)

// selectCacheMetrics binds the cache gateway's metrics port to a real publisher
// or to the discarding one, and it is the ONLY place that decision is made.
//
// # Why this is a function rather than three lines inside run()
//
// So it can be TESTED. main() cannot be imported, so every decision taken inline
// there is observable only by starting a process — which is precisely how this
// seam came to be wrong in the first place: the composition root passed
// cache.NewNoopMetrics() unconditionally, the cache computed
// cache_requests_total and cache_operation_duration_ms on every operation and
// threw them away, and no test in either package could see it. The gateway's
// suite proves the gateway CAN publish (through a spy it injects); the
// publisher's suite proves the publisher CAN emit (through a double it injects);
// neither can observe that the two are not connected.
//
// # The FLAG is honoured here, not inside the gateway
//
// Same rule the rest of this composition root follows: METRICS_ENABLED decides
// WHICH DEPENDENCY EXISTS, never a branch in the request path. The gateway calls
// straight through its Metrics port with no flag check of its own, so "metrics
// are off" is expressed by binding the null object rather than by a condition
// repeated at four call sites.
//
// # A nil publisher yields the NOOP, never a nil interface
//
// cloudwatch.Publisher is an INTERFACE. Handing a nil one to the gateway would
// not fail at startup — it would panic on the first cache operation, in the
// request path, well away from the wiring that caused it. The noop is returned
// instead so an absent publisher degrades to "no metrics" rather than to an
// outage.
func selectCacheMetrics(metricsEnabled bool, publisher cloudwatch.Publisher) cache.Metrics {
	if !metricsEnabled || publisher == nil {
		return cache.NewNoopMetrics()
	}
	// cloudwatch.Publisher and cache.Metrics declare the SAME method set, each
	// from its own side of the boundary: the cache declares the narrow port it
	// consumes, and the CloudWatch adapter satisfies it structurally without
	// either package importing the other. This assignment is the whole adapter.
	return publisher
}
