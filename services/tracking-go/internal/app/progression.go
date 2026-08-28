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

// DefaultProgressionInterval is the design's cadence: t=10s PROCESSING, t=20s
// SHIPPED, t=30s OUT_FOR_DELIVERY, t=40s DELIVERED.
//
// Tests inject ~0 rather than patching this, so the suite runs in milliseconds
// while production keeps the real cadence — a test that actually waited 40
// seconds would be skipped or deleted, and either way the feature would stop
// being covered.
const DefaultProgressionInterval = 10 * time.Second

// UnscopedTrackingReader is the progression's read port, and it is EXPLICITLY
// unscoped: there is no caller to scope by, and the order id came from a
// tracking this process just created rather than from a request.
//
// A SEPARATE METHOD from the reads' GetByOrderIDScoped — never the same method
// with an empty argument. Go's zero value for string is "", not nil, so an
// optional-scope parameter left unset would silently mean "scoped to the empty
// string" rather than "unscoped", and the progression would read nothing, every
// time, while looking correctly implemented. The method below takes no identity
// parameter at all, so that mistake has nowhere to happen.
type UnscopedTrackingReader interface {
	GetByOrderID(ctx context.Context, orderID string) (domain.Tracking, error)
}

// Transitioner is UpdateStatus, consumed as an interface so the progression
// physically cannot grow a second transition path.
//
// The state machine's guards, the history row, the datetime bump, the history
// re-read, the event and the invalidation all live in UpdateStatus. A second
// copy is how the carrier webhook and the automatic progression would start
// disagreeing about what a transition means — and the disagreement would only
// ever be visible in production data.
type Transitioner interface {
	Execute(ctx context.Context, orderID string, requested domain.Status, actor audit.Actor) (domain.TrackingWithHistory, error)
}

// Progression drives TestMode runs: one status every interval, from PLACED to
// DELIVERED.
//
// !! KNOWN LIMITATION, EXPLICITLY ACCEPTED — DO NOT "FIX" !!
//
// These are in-process goroutines, chosen deliberately over a durable scheduler.
// If the process restarts mid-run — a rebuild, a redeploy, a crash, a container
// reschedule — the goroutine is LOST and the tracking stays frozen at whatever
// status it reached, forever. Nothing retries it, nothing resumes it, and no
// error is reported anywhere. A tracking stuck at PROCESSING after a rebuild is
// EXPECTED, not a bug to investigate; recover by creating a new TestMode
// tracking or by driving the remaining transitions through
// PUT /v1/trackings/{orderId}/status.
//
// This is acceptable because TestMode is a 40-second E2E fixture: nothing
// downstream depends on it completing, and real carrier updates arrive through
// the PUT endpoint, which is persistent. Paying for a durable scheduler — a new
// dependency, a new table, a poller, its own failure modes — to make a
// 40-second test fixture restart-proof is not a trade this service wants.
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

// Start launches a run for orderID and returns immediately.
//
// # THE CONTEXT IS THE WHOLE POINT OF THIS METHOD, AND OF ITS SIGNATURE
//
// Start takes NO context. The goroutine derives its context from p.base — the
// PROCESS lifetime context — and there is deliberately no parameter through
// which a handler could hand over the request's.
//
// net/http cancels a request's context the instant the response is written, so
// a goroutine that inherited it would die at its first tick. And the symptom
// would be indistinguishable from the accepted restart limitation documented on
// the type: "the tracking froze partway through". The bug would disguise itself
// as a known limitation, and nobody would investigate it.
//
// The caller invokes this only AFTER the creating transaction has committed and
// the response has been written. Starting it any earlier races the commit and
// the progression always loses: its first read opens a fresh session, sees no
// tracking, and the run ends immediately at PLACED. (Verified in the Python
// service, not theoretical.)
func (p *Progression) Start(orderID string) {
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		p.Run(p.base, orderID)
	}()
}

// Wait blocks until every in-flight run has ended, or until ctx is done.
//
// Called from graceful shutdown so the process does not exit leaving goroutines
// mid-flight WITHOUT AT LEAST LOGGING IT. It does not cancel anything itself:
// cancelling the base context is the composition root's job, and Wait only
// joins. A drain that runs out of budget is reported with a machine-readable
// reason rather than passing silently.
// The DEADLINE IS THE CALLER'S. Wait adds none of its own: the composition root
// already bounds the whole drain, and a second timer here would either duplicate
// that budget or silently shorten it.
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

// Run executes the whole progression. Exported so tests drive it synchronously,
// without a goroutine and without sleeping.
//
// NOTHING ESCAPES. Every ending is explicit and logged, panics included: a
// background goroutine that returned an error nobody reads would surface as
// nothing at all, detached from the request that caused it — and a panic would
// take the whole process down over a 40-second test fixture.
func (p *Progression) Run(ctx context.Context, orderID string) {
	// ONE span for the whole run, not one per tick, and opened INSIDE the
	// goroutine. A span opened around the spawn would end the moment Start
	// returned — long before the first tick — recording a 40-second workflow as
	// a microsecond of scheduling.
	//
	// WithNewRoot, because the creating request's span is already closed by the
	// time a background run starts. That is correct: the progression is a
	// fixture with its own lifetime, not a part of the POST that scheduled it.
	// Parenting it to a finished span would nest a 40-second child under a
	// millisecond parent.
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

		status, done, reason := p.advanceOnce(ctx, orderID)
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
	ctx context.Context, orderID string,
) (status domain.Status, done bool, reason string) {
	// Each step reads through the adapter, which opens its OWN session: the
	// creating request's was committed and closed long before the first tick,
	// and holding one open across 40 seconds of ticking would pin a pooled
	// connection for the whole run.
	//
	// UNSCOPED. See UnscopedTrackingReader.
	tracking, err := p.reader.GetByOrderID(ctx, orderID)
	switch {
	case errors.Is(err, domain.ErrTrackingNotFound):
		// Soft-deleted (or never there) between two ticks. Not an error: the
		// progression is a fixture and the row it animated is gone.
		return "", true, "tracking_not_found"
	case err != nil:
		return "", true, "unexpected_error"
	}

	next, ok := domain.NextStatus(tracking.Status)
	if !ok {
		// Already terminal — this run finished, or a carrier PUT delivered it
		// first. Either way there is nothing left to do: the CLEAN ending.
		return "", true, ""
	}

	// The SAME function the carrier PUT calls. Only the actor differs, which is
	// what keeps an automatic run identifiable from tracking_history.created_by
	// after the fact.
	if _, err := p.transitioner.Execute(ctx, orderID, next, audit.TestModeProgression); err != nil {
		var invalid *domain.InvalidTransitionError
		switch {
		case errors.As(err, &invalid):
			// Something else moved it while this run was sleeping. The state
			// machine is the authority; the progression yields and STOPS. It
			// does NOT retry: retrying a rejected forward-only transition can
			// only be rejected again, forever. The guard's own reason is what
			// gets logged.
			return "", true, string(invalid.Reason)
		case errors.Is(err, domain.ErrTrackingNotFound):
			return "", true, "tracking_not_found"
		default:
			return "", true, "unexpected_error"
		}
	}
	return next, false, ""
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
