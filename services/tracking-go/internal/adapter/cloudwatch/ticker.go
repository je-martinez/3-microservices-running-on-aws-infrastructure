package cloudwatch

import (
	"context"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel/attribute"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
)

// StatusCounter is the ONE query the ticker needs, declared here by its
// consumer. It runs on the READ connection and excludes soft-deleted rows — a
// deleted tracking is not an order in flight, and counting it makes the gauge
// disagree with every user-facing read. See [[soft-delete]]
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

// SplitStatusCounts splits raw per-status counts into (delivered, inProgress),
// pure so it is testable without a database. BOTH values are always returned,
// 0 included, since an unpublished series reads as "no data" rather than zero.
// Anything but the terminal status counts as in progress, so a new status lands
// in "in flight" by default.
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

// RunTicker publishes the gauge series every interval until ctx is cancelled. It
// SLEEPS FIRST: at startup the database may still be unreachable, and a tick
// before the first interval yields only an unactionable failure line.
//
// CONTRACT: ctx must be the process-lifetime context, never a request's, which
// is cancelled when its response is sent. A per-tick failure is swallowed —
// a blip costs one datapoint, not the process's metrics.
// See [[logging-context]]
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

// publishTick runs one tick's query and its publishes inside a metrics-tick span.
//
// CONTRACT: Keep the wrapping span. Without it every tick's SQL and AWS spans
// reach the backend as their OWN root traces, burying real request traces under
// unattributable fragments. The name is shared with Users and events-pipeline so
// one query means the same thing everywhere; INTERNAL, not CONSUMER, because
// this is our own timer. See [[ADR-0019-distributed-tracing-opentelemetry]]
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
