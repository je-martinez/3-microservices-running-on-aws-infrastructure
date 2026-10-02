package main

import (
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/cloudwatch"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
)

// selectCacheMetrics binds the cache gateway's metrics port to a real publisher
// or the discarding one — the ONLY place that decision is made.
//
// CONTRACT: Keep it a function, not three lines in run(). main() cannot be
// imported, so an inline decision is observable only by starting a process: the
// gateway's suite proves it CAN publish and the publisher's proves it CAN emit,
// and neither can see that the two are not connected.
// See [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]]
//
// CONTRACT: The flag is honoured here, never inside the gateway, and a nil
// publisher yields the NOOP rather than a nil interface — a nil one panics on
// the first cache operation, in the request path, far from the wiring.
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

// cacheRequestSeeds is what the metrics ticker publishes at zero every tick: one
// cache_requests_total series per dimension set the cache gateway publishes.
//
// CONTRACT: Pass this to StartTicker, never nil. Unit tests on either side stay
// green while the cache cards throw in every quiet window.
// See [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]]
func cacheRequestSeeds() []cloudwatch.Series {
	dimensions := cache.CacheRequestDimensions()
	seeds := make([]cloudwatch.Series, 0, len(dimensions))
	for _, dims := range dimensions {
		seeds = append(seeds, cloudwatch.Series{Name: cache.MetricCacheRequests, Dimensions: dims})
	}
	return seeds
}
