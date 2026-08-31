package cloudwatch

import (
	"context"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel/attribute"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
)

// StatusCounter is the ONE query the ticker needs, declared HERE by the code that
// consumes it. The MySQL adapter satisfies it without importing this package and
// without a shared repository interface.
//
// It runs on the READ connection and excludes soft-deleted rows:
//
//	SELECT status, COUNT(*) FROM tracking WHERE deleted_at IS NULL GROUP BY status
//
// A deleted tracking is not an order in flight, and counting it would make the
// gauge disagree with every user-facing read, all of which filter the same way.
type StatusCounter interface {
	CountByStatus(ctx context.Context) (map[string]int64, error)
}

// TerminalStatus is the state machine's end state. Everything else is in flight.
const TerminalStatus = "DELIVERED"

// The three published status series. ALL is PRE-SUMMED and published as its own
// series, never computed by the dashboard: the collector queries these with
// Maximum, and a Sum across a window would double the count whenever two
// publishes land in one window.
const (
	StatusDelivered  = "DELIVERED"
	StatusInProgress = "IN_PROGRESS"
	StatusAll        = "ALL"
)

// DefaultInterval matches METRICS_INTERVAL_SECONDS' default of 15.0.
const DefaultInterval = 15 * time.Second

// httpErrorClasses are seeded at ZERO on every tick, so a dashboard panel renders
// "no errors" instead of "Error Loading Data".
var httpErrorClasses = []string{"4xx", "5xx"}

// SplitStatusCounts splits raw per-status counts into (delivered, inProgress).
//
// Pure, so the split is unit-testable without a database. BOTH values are always
// returned, 0 included: a series that stops being published reads as "no data"
// in a dashboard rather than as zero.
//
// Anything that is not the terminal status counts as in progress — INCLUDING a
// status this code does not know about. That direction is deliberate: a new
// status added to the progression should land in "still in flight" by default
// rather than silently disappear from both series.
func SplitStatusCounts(raw map[string]int64) (delivered, inProgress int64) {
	for status, count := range raw {
		if status == TerminalStatus {
			delivered += count
			continue
		}
		inProgress += count
	}
	return delivered, inProgress
}

// RunTicker publishes the gauge series every interval until ctx is cancelled.
//
// IT SLEEPS FIRST, THEN PUBLISHES. At startup the database may still be
// unreachable, and a tick before the first interval elapses yields only an
// unactionable failure line — noise at exactly the moment the log is being read
// for something else.
//
// A PER-TICK FAILURE IS SWALLOWED AND THE LOOP CONTINUES. This loop has no
// natural end, so a transient database blip or a CloudWatch outage must cost one
// datapoint, not the rest of the process's metrics. Only cancellation ends it.
//
// The ctx it receives must be the PROCESS LIFETIME context, never a request's:
// this goroutine outlives any request, and a request context is cancelled the
// moment its response is sent, which would end the ticker on the first request.
//
// Start it only when METRICS_ENABLED — the caller decides, so this function has
// no flag inside it.
func RunTicker(ctx context.Context, p Publisher, counts StatusCounter, interval time.Duration, log *slog.Logger) {
	if interval <= 0 {
		interval = DefaultInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			publishTick(ctx, p, counts, log)
		}
	}
}

// publishTick runs one tick's query and its five publishes inside a metrics-tick
// span.
//
// The loop runs on a timer, outside any request, so without a wrapper every
// tick's SQL and AWS spans would reach the backend as their OWN root traces — 60
// orphans named `connect` and `SELECT tracking` were measured in one hour, which
// buries the real request traces under fragments nobody can attribute.
//
// The span name is shared with Users and events-pipeline on purpose, so one query
// means the same thing in every service. INTERNAL, not CONSUMER: events-pipeline's
// is CONSUMER because EventBridge wakes it; this one is our own timer.
func publishTick(ctx context.Context, p Publisher, counts StatusCounter, log *slog.Logger) {
	ctx, end := tracing.WorkflowSpan(ctx, "metrics-tick",
		attribute.String("app_event", "metrics_tick_started"))

	raw, err := counts.CountByStatus(ctx)
	if err != nil {
		log.ErrorContext(ctx, "metrics_tick_failed",
			slog.String("app_event", "metrics_tick_failed"),
			slog.String("reason", "status_query_failed"),
			slog.String("exception", err.Error()),
		)
		end(err)
		return
	}

	delivered, inProgress := SplitStatusCounts(raw)

	// All three series are published every tick, zeros included.
	p.Publish(ctx, MetricOrdersByStatus, float64(delivered),
		[][2]string{{"Service", ServiceDimension}, {"Status", StatusDelivered}})
	p.Publish(ctx, MetricOrdersByStatus, float64(inProgress),
		[][2]string{{"Service", ServiceDimension}, {"Status", StatusInProgress}})
	p.Publish(ctx, MetricOrdersByStatus, float64(delivered+inProgress),
		[][2]string{{"Service", ServiceDimension}, {"Status", StatusAll}})

	// Seeded at zero so a panel renders "no errors" rather than an error.
	for _, class := range httpErrorClasses {
		p.Publish(ctx, MetricHTTPErrors, 0,
			[][2]string{{"Service", ServiceDimension}, {"StatusClass", class}})
	}

	end(nil)
}
