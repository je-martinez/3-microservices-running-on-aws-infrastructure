package cloudwatch

import (
	"context"
	"log/slog"
	"time"
)

// StartTicker turns METRICS_ENABLED into a RUNNING GOROUTINE, or into nothing.
// "Off" means the loop NEVER STARTS, so a runtime with metrics off opens no
// database session on a timer and reaches no CloudWatch endpoint.
//
// CONTRACT: ctx MUST be the process-lifetime context, never a request's. A
// request context is cancelled when its response is sent, and the ticker then
// dies SILENTLY — cancellation is the loop's normal exit, so nothing logs and
// the dashboards just go flat.
//
// The returned channel closes when the loop finishes, and is NIL when the ticker
// never started: a caller forgetting the check hangs at shutdown rather than
// racing. See [[logging-context]]
func StartTicker(
	ctx context.Context,
	enabled bool,
	publisher Publisher,
	counts StatusCounter,
	interval time.Duration,
	log *slog.Logger,
) <-chan struct{} {
	if !enabled {
		return nil
	}
	if log == nil {
		log = slog.Default()
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		RunTicker(ctx, publisher, counts, interval, log)
	}()
	return done
}
