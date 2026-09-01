package cloudwatch

import (
	"context"
	"log/slog"
	"time"
)

// StartTicker turns METRICS_ENABLED into a RUNNING GOROUTINE, or into nothing.
//
// # The flag is the caller's, and this is the only place it becomes a goroutine
//
// "Off" means the loop NEVER STARTS — not that a started loop skips its
// publishes. That distinction is the whole point of gating in the composition
// root: a suite or a runtime with metrics off then opens no database session on a
// timer and reaches for no CloudWatch endpoint at all.
//
// # ctx MUST be the PROCESS LIFETIME context
//
// This goroutine outlives every request. A request's context is cancelled the
// instant its response is sent, so a ticker wired to one dies on the first
// request that happened to start it — and it dies SILENTLY: the loop's exit on
// cancellation is its normal shutdown path, so nothing is logged, nothing errors,
// and the dashboards simply go flat. Derive from the signal context in main,
// never from a *gin.Context's request.
//
// # The returned channel is the JOIN handle
//
// It closes when the loop has actually finished, so shutdown can wait for a
// publish in flight rather than exiting underneath it. It is NIL when the ticker
// was not started, which is how a caller knows there is nothing to wait for —
// receiving from a nil channel blocks forever, so a caller that forgets the check
// hangs at shutdown rather than racing.
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
