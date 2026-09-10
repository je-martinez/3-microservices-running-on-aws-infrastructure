package app

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// DefaultProgressionInterval is the design's cadence: PROCESSING at 10s through
// DELIVERED at 40s. Tests inject ~0 rather than patching it, so the suite runs
// in milliseconds while production keeps the real cadence.
const DefaultProgressionInterval = 10 * time.Second

// UnscopedTrackingReader is the progression's EXPLICITLY unscoped read port —
// there is no caller to scope by, and the order id came from a tracking this
// process just created.
//
// CONTRACT: A SEPARATE method from GetByOrderIDScoped, never the same one with
// an empty argument. Go's zero string is "", so an unset optional scope means
// "scoped to the empty string" and the progression reads nothing, every time,
// while looking implemented. See [[user-id-vs-cognito-sub-ownership-key]]
type UnscopedTrackingReader interface {
	GetByOrderID(ctx context.Context, orderID string) (domain.Tracking, error)
}

// Transitioner is UpdateStatus as an interface, so every live-row transition
// uses the carrier's one persistence path — guards, history row, datetime bump,
// re-read, event and invalidation all live there. The second method is narrower
// on purpose: after cleanup tombstones the fixture only its notifications
// continue, and it can neither write history nor resurrect the row.
type Transitioner interface {
	Execute(ctx context.Context, orderID string, requested domain.Status, actor audit.Actor) (domain.TrackingWithHistory, error)

	// ContinueDeletedTestMode publishes the next TestMode status from the last
	// committed snapshot after E2E cleanup has soft-deleted the row. It must not
	// persist or resurrect the tombstone.
	ContinueDeletedTestMode(
		ctx context.Context,
		current domain.TrackingWithHistory,
		requested domain.Status,
	) (domain.TrackingWithHistory, error)
}

// Progression drives TestMode runs: one status every interval, PLACED to
// DELIVERED.
//
// CONTRACT: Do NOT add a durable scheduler. These are in-process goroutines, and
// a restart mid-run LOSES the goroutine: the tracking stays frozen forever with
// nothing retrying, resuming or reporting it. A tracking stuck at PROCESSING
// after a rebuild is EXPECTED — recover by creating a new TestMode tracking or
// driving the rest through PUT /v1/trackings/{orderId}/status.
// See [[testmode-in-process-no-durable-scheduler]]
type Progression struct {
	// base is the PROCESS LIFETIME context, never a request's. See Start.
	base         context.Context //nolint:containedctx // deliberate: see Start.
	reader       UnscopedTrackingReader
	transitioner Transitioner
	interval     time.Duration
	log          *slog.Logger
	tracer       trace.Tracer
	wg           sync.WaitGroup
}

// NewProgression wires the progression.
//
// base MUST be the process lifetime context — the one derived from
// signal.NotifyContext in the composition root. A non-positive interval falls
// back to the design's cadence rather than spinning.
func NewProgression(
	base context.Context,
	reader UnscopedTrackingReader,
	transitioner Transitioner,
	interval time.Duration,
	log *slog.Logger,
	tracer trace.Tracer,
) *Progression {
	if base == nil {
		base = context.Background()
	}
	if interval <= 0 {
		interval = DefaultProgressionInterval
	}
	if log == nil {
		log = slog.Default()
	}
	return &Progression{
		base:         base,
		reader:       reader,
		transitioner: transitioner,
		interval:     interval,
		log:          log,
		tracer:       tracer,
	}
}

// Start launches a run for tracking and returns immediately.
//
// CONTRACT: Start takes NO context — the goroutine derives from p.base, the
// process-lifetime context, and no parameter lets a handler hand over the
// request's. net/http cancels a request context when the response is written, so
// an inherited one dies at the first tick and looks exactly like the accepted
// restart limitation. See [[testmode-in-process-no-durable-scheduler]]
//
// Call this only after the creating transaction has committed and the response
// is written. The committed snapshot is the fallback when a concurrent cleanup
// hides the row before the first tick.
func (p *Progression) Start(tracking domain.TrackingWithHistory) {
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		p.run(p.base, tracking)
	}()
}

// Wait blocks until every in-flight run has ended, or until ctx is done. It
// cancels nothing — cancelling the base context is the composition root's job —
// and a drain out of budget is reported with a machine-readable reason.
//
// CONTRACT: The DEADLINE IS THE CALLER'S. A second timer here would duplicate
// the composition root's budget or silently shorten it.
func (p *Progression) Wait(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}
	done := make(chan struct{})
	go func() {
		p.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-ctx.Done():
		// The drain ran out of budget. The runs are abandoned exactly as a
		// restart would abandon them — see the KNOWN LIMITATION — but this line
		// is the difference between "abandoned and said so" and "abandoned
		// silently", which is the whole of what graceful shutdown owes here.
		p.log.Warn("test_mode_progression_shutdown_incomplete",
			slog.String("app_event", "test_mode_progression_shutdown_incomplete"),
			slog.String("reason", "shutdown_deadline"))
	}
}

// Run executes the whole progression, exported so tests drive it synchronously.
//
// CONTRACT: NOTHING escapes — every ending is explicit and logged, panics
// included. A background goroutine's returned error surfaces as nothing at all,
// and a panic takes the process down over a 40-second test fixture.
func (p *Progression) Run(ctx context.Context, orderID string) {
	tracking, err := p.reader.GetByOrderID(ctx, orderID)
	if err != nil {
		p.runWithoutSnapshot(ctx, orderID, err)
		return
	}
	p.run(ctx, domain.TrackingWithHistory{
		Tracking: tracking,
		History:  tracking.History,
	})
}

// runWithoutSnapshot records the rare case where the row vanished before a
// synchronous test could take its initial snapshot. Production Start receives
// the committed creation result directly, so a concurrent cleanup cannot open
// this gap there.
func (p *Progression) runWithoutSnapshot(ctx context.Context, orderID string, err error) {
	ctx, span := p.startSpan(ctx)
	defer span.End()
	span.SetAttributes(
		attribute.String("app_event", "test_mode_progression_started"),
		attribute.String("order_id", orderID),
		attribute.Float64("interval_seconds", p.interval.Seconds()))

	p.log.InfoContext(ctx, "test_mode_progression_started",
		slog.String("app_event", "test_mode_progression_started"),
		slog.String("order_id", orderID),
		slog.Float64("interval_seconds", p.interval.Seconds()))

	reason := "unexpected_error"
	if errors.Is(err, domain.ErrTrackingNotFound) {
		reason = "tracking_not_found"
	}
	p.finish(ctx, span, orderID, reason)
}

func (p *Progression) run(ctx context.Context, current domain.TrackingWithHistory) {
	orderID := current.Tracking.OrderID
	// CONTRACT: ONE span for the whole run, opened INSIDE the goroutine. Around
	// the spawn it ends when Start returns, recording a 40-second workflow as a
	// microsecond of scheduling. WithNewRoot because the creating request's span
	// is already closed, and parenting to it nests a 40-second child under a
	// millisecond parent. See [[ADR-0019-distributed-tracing-opentelemetry]]
	ctx, span := p.startSpan(ctx)
	defer span.End()
	span.SetAttributes(
		attribute.String("app_event", "test_mode_progression_started"),
		attribute.String("order_id", orderID),
		attribute.Float64("interval_seconds", p.interval.Seconds()))

	p.log.InfoContext(ctx, "test_mode_progression_started",
		slog.String("app_event", "test_mode_progression_started"),
		slog.String("order_id", orderID),
		slog.Float64("interval_seconds", p.interval.Seconds()))

	defer func() {
		if r := recover(); r != nil {
			// A TestMode fixture must not be able to take the process down.
			p.finish(ctx, span, orderID, "unexpected_error")
		}
	}()

	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()

	for {
		// Sleep FIRST, then advance: creation already wrote PLACED, so the very
		// first tick produces PROCESSING at t=interval. Advancing before the
		// first sleep would collapse t=0 and t=10s into one instant.
		select {
		case <-ctx.Done():
			// Shutdown. The tracking simply stays where it is — see the KNOWN
			// LIMITATION on the type.
			p.finish(ctx, span, orderID, "cancelled")
			return
		case <-ticker.C:
		}

		updated, done, reason := p.advanceOnce(ctx, current)
		if done {
			if reason != "" {
				p.finish(ctx, span, orderID, reason)
				return
			}
			span.SetAttributes(attribute.String("app_event", "test_mode_progression_succeeded"))
			p.log.InfoContext(ctx, "test_mode_progression_succeeded",
				slog.String("app_event", "test_mode_progression_succeeded"),
				slog.String("order_id", orderID))
			return
		}
		current = updated
		status := current.Tracking.Status

		// A span EVENT per tick, not a child span: it marks when each transition
		// landed inside the one workflow span, which is exactly what the
		// *_advanced log line already says.
		span.AddEvent("test_mode_progression_advanced",
			trace.WithAttributes(attribute.String("status", string(status))))
		p.log.InfoContext(ctx, "test_mode_progression_advanced",
			slog.String("app_event", "test_mode_progression_advanced"),
			slog.String("order_id", orderID),
			slog.String("status", string(status)))
	}
}

// startSpan opens the run's root span, tolerating a nil tracer so a degraded
// wiring runs the progression rather than nil-panicking inside a goroutine
// where the panic would be reported nowhere useful.
func (p *Progression) startSpan(ctx context.Context) (context.Context, trace.Span) {
	if p.tracer == nil {
		return ctx, trace.SpanFromContext(context.Background())
	}
	return p.tracer.Start(ctx, "test_mode_progression", trace.WithNewRoot())
}

// advanceOnce moves the tracking by exactly one status.
//
// done=true means STOP, and it covers every reason a run should end. The caller
// does not need to distinguish them, which is what keeps Run simple. A non-empty
// reason means the ending is a *_failed one; an empty reason with done=true is
// the clean arrival at DELIVERED.
func (p *Progression) advanceOnce(
	ctx context.Context,
	current domain.TrackingWithHistory,
) (updated domain.TrackingWithHistory, done bool, reason string) {
	orderID := current.Tracking.OrderID
	// Each step reads through the adapter, which opens its OWN session: the
	// creating request's was committed and closed long before the first tick,
	// and holding one open across 40 seconds of ticking would pin a pooled
	// connection for the whole run.
	//
	// UNSCOPED. See UnscopedTrackingReader.
	tracking, err := p.reader.GetByOrderID(ctx, orderID)
	switch {
	case errors.Is(err, domain.ErrTrackingNotFound):
		return p.advanceDeleted(ctx, current)
	case err != nil:
		return domain.TrackingWithHistory{}, true, "unexpected_error"
	}
	current.Tracking = tracking

	next, ok := domain.NextStatus(tracking.Status)
	if !ok {
		// Already terminal — this run finished, or a carrier PUT delivered it
		// first. Either way there is nothing left to do: the CLEAN ending.
		return current, true, ""
	}

	// The SAME function the carrier PUT calls. Only the actor differs, which is
	// what keeps an automatic run identifiable from tracking_history.created_by
	// after the fact.
	updated, err = p.transitioner.Execute(ctx, orderID, next, audit.TestModeProgression)
	if err != nil {
		var invalid *domain.InvalidTransitionError
		switch {
		case errors.As(err, &invalid):
			// Something else moved it while this run was sleeping. The state
			// machine is the authority; the progression yields and STOPS. It
			// does NOT retry: retrying a rejected forward-only transition can
			// only be rejected again, forever. The guard's own reason is what
			// gets logged.
			return domain.TrackingWithHistory{}, true, string(invalid.Reason)
		case errors.Is(err, domain.ErrTrackingNotFound):
			// Cleanup can land after the read above but before UpdateStatus's own
			// lookup or guarded UPDATE. Continue from the same last committed
			// snapshot instead of letting that narrower race truncate the chain.
			return p.advanceDeleted(ctx, current)
		default:
			return domain.TrackingWithHistory{}, true, "unexpected_error"
		}
	}
	return updated, false, ""
}

// advanceDeleted keeps an already-deleted E2E fixture's notification chain
// complete without writing through the tombstone. The last committed snapshot
// came either from init-tracking or from the preceding successful transition,
// so it still carries every subject field the event publisher needs.
func (p *Progression) advanceDeleted(
	ctx context.Context,
	current domain.TrackingWithHistory,
) (updated domain.TrackingWithHistory, done bool, reason string) {
	next, ok := domain.NextStatus(current.Tracking.Status)
	if !ok {
		return current, true, ""
	}

	updated, err := p.transitioner.ContinueDeletedTestMode(ctx, current, next)
	if err == nil {
		return updated, false, ""
	}

	var invalid *domain.InvalidTransitionError
	if errors.As(err, &invalid) {
		return domain.TrackingWithHistory{}, true, string(invalid.Reason)
	}
	return domain.TrackingWithHistory{}, true, "unexpected_error"
}

// finish records a non-success ending. Swallowed rather than propagated: the run
// ENDS, it does not fail anything — there is no caller left to fail.
//
// INFO, not ERROR: every reason reaching here is an expected way for a fixture
// to stop. The convention has no SUCCESS severity and *_failed carries its own
// machine-readable reason, which is what an operator filters on.
func (p *Progression) finish(ctx context.Context, span trace.Span, orderID, reason string) {
	span.SetAttributes(
		attribute.String("app_event", "test_mode_progression_failed"),
		attribute.String("reason", reason))
	p.log.InfoContext(ctx, "test_mode_progression_failed",
		slog.String("app_event", "test_mode_progression_failed"),
		slog.String("reason", reason),
		slog.String("order_id", orderID))
}
