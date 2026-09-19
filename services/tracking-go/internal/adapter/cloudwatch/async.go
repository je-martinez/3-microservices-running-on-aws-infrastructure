package cloudwatch

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// Async buffer defaults. The buffer is sized for a burst, not for a backlog: it
// absorbs the spike a slow backend causes and then drops, because holding more
// than a few seconds of data only postpones the drop while spending memory.
const (
	DefaultAsyncBufferSize     = 2048
	DefaultAsyncFlushTimeout   = 5 * time.Second
	DefaultAsyncReportInterval = 60 * time.Second
)

// AsyncOptions tunes the buffer. Every zero value falls back to its default, so
// the zero AsyncOptions is a valid production configuration.
type AsyncOptions struct {
	// BufferSize bounds how many data may await the flusher.
	BufferSize int
	// FlushTimeout bounds the drain Close performs.
	FlushTimeout time.Duration
	// ReportInterval is how often an aggregate drop count is logged.
	ReportInterval time.Duration
	Log            *slog.Logger
}

// pending is one datum captured at hand-off, with the context it will be sent on.
type pending struct {
	//nolint:containedctx // deliberate: the datum outlives its caller and must carry
	// its own send context. See the CONTRACT on NewAsyncPublisher.
	ctx        context.Context
	name       string
	value      float64
	dimensions [][2]string
}

// AsyncPublisher decorates a Publisher so Publish becomes a buffered hand-off
// and a background flusher performs the CloudWatch round-trip.
//
// CONTRACT: Publish NEVER blocks — a channel send with a default branch. Floci
// serializes PutMetricData, so publishing on the request path made a read answer
// in ~490ms with its own duration_ms at 0. See [[logging-context]]
//
// CONTRACT: A full buffer DROPS. Never unbounded (an OOM under sustained load)
// nor blocking-when-full (the ~490ms above, reinstated).
//
// CONTRACT: Drops are reported as a periodic AGGREGATE, never per drop: the
// overflow path runs at the peak rate the service sees.
type AsyncPublisher struct {
	next Publisher
	log  *slog.Logger

	queue        chan pending
	flushTimeout time.Duration

	dropped atomic.Int64

	flusherDone  chan struct{}
	reporterDone chan struct{}
	closeOnce    sync.Once
}

// Publisher is satisfied by AsyncPublisher, so the decorator is substitutable
// wherever the interface is consumed.
var _ Publisher = (*AsyncPublisher)(nil)

// NewAsyncPublisher wraps next and starts its flusher.
//
// CONTRACT: base MUST be the process-lifetime context, never a request's — it is
// the flusher's lifetime, and a request context dies when its response is sent.
//
// CONTRACT: A datum's send context is context.WithoutCancel of the CALLER's,
// which keeps the span context (so the publish span joins the trace that caused
// it) without the cancellation. Passing the caller's context through unchanged
// fails every publish on a completed request with `context canceled`; passing
// base alone orphans the span into its own root trace.
// See [[ADR-0019-distributed-tracing-opentelemetry]]
func NewAsyncPublisher(base context.Context, next Publisher, opts AsyncOptions) *AsyncPublisher {
	if next == nil {
		next = NewNoopPublisher()
	}
	if opts.BufferSize <= 0 {
		opts.BufferSize = DefaultAsyncBufferSize
	}
	if opts.FlushTimeout <= 0 {
		opts.FlushTimeout = DefaultAsyncFlushTimeout
	}
	if opts.ReportInterval <= 0 {
		opts.ReportInterval = DefaultAsyncReportInterval
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}

	p := &AsyncPublisher{
		next:         next,
		log:          opts.Log,
		queue:        make(chan pending, opts.BufferSize),
		flushTimeout: opts.FlushTimeout,
		flusherDone:  make(chan struct{}),
		reporterDone: make(chan struct{}),
	}

	// ONE flusher, so the data a dashboard reads keep the order they were
	// produced in and the backend sees the same serialized call pattern it saw
	// before — off the request path.
	go p.flush(context.WithoutCancel(base))
	go p.report(base, opts.ReportInterval)

	return p
}

// Publish hands the datum to the flusher and returns. Never blocks, never fails,
// and drops rather than waiting when the buffer is full.
func (p *AsyncPublisher) Publish(ctx context.Context, name string, value float64, dimensions [][2]string) {
	// The caller may reuse its slice after this returns, and the flusher reads it
	// later.
	dims := make([][2]string, len(dimensions))
	copy(dims, dimensions)

	item := pending{
		ctx:        context.WithoutCancel(ctx),
		name:       name,
		value:      value,
		dimensions: dims,
	}

	select {
	case p.queue <- item:
	default:
		p.dropped.Add(1)
	}
}

// Dropped reports the running drop count without resetting it.
func (p *AsyncPublisher) Dropped() int64 { return p.dropped.Load() }

// TakeDropped returns the drops since the last call and resets the counter, so a
// periodic report describes one window instead of re-reporting the same drops
// forever.
func (p *AsyncPublisher) TakeDropped() int64 { return p.dropped.Swap(0) }

// Buffered reports how many data are awaiting the flusher — the bound the
// overflow test asserts against.
func (p *AsyncPublisher) Buffered() int { return len(p.queue) }

// Close drains what is buffered within FlushTimeout and joins the flusher.
// Idempotent: the composition root joins it from several shutdown branches.
//
// CONTRACT: The drain is BOUNDED — an unreachable backend must not hold the
// process open past its orchestrator's kill timeout.
func (p *AsyncPublisher) Close() {
	p.closeOnce.Do(func() {
		close(p.queue)

		select {
		case <-p.flusherDone:
		case <-time.After(p.flushTimeout):
			p.log.Warn("metrics_flush_shutdown_timeout",
				slog.String("app_event", "metrics_flush_shutdown_timeout"),
				slog.String("reason", "flush_budget_exhausted"),
				slog.Int("buffered", len(p.queue)),
			)
		}

		if dropped := p.TakeDropped(); dropped > 0 {
			p.logDropped(dropped)
		}
	})
}

// flush is the ONE goroutine performing the CloudWatch round-trip. It runs until
// the queue is closed AND emptied, which is what makes Close's drain complete
// rather than merely prompt.
func (p *AsyncPublisher) flush(base context.Context) {
	defer close(p.flusherDone)

	for item := range p.queue {
		ctx := item.ctx
		if ctx == nil {
			ctx = base
		}
		p.next.Publish(ctx, item.name, item.value, item.dimensions)
	}
}

// report logs the aggregate drop count once per window, and only when there is
// something to report — a periodic "0 dropped" line is pure volume.
func (p *AsyncPublisher) report(ctx context.Context, interval time.Duration) {
	defer close(p.reporterDone)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-p.flusherDone:
			return
		case <-ticker.C:
			if dropped := p.TakeDropped(); dropped > 0 {
				p.logDropped(dropped)
			}
		}
	}
}

func (p *AsyncPublisher) logDropped(count int64) {
	p.log.Warn("metrics_dropped",
		slog.String("app_event", "metrics_dropped"),
		slog.String("reason", "metric_buffer_full"),
		slog.Int64("dropped_count", count),
	)
}
