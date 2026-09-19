// Package outbox drains Tracking's transactional outbox: it claims pending
// messages, publishes each through the existing SNS publisher, and deletes the
// rows it delivered.
//
// CONTRACT: The claim is OURS, not `oagudo/outbox`'s Reader. That Reader holds no
// row lock at all, so every instance publishes every row — a second "your parcel
// shipped" email per task. Only the library's WRITE side is used here.
// See [[cqrs]]
package outbox

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

// Defaults for anything Options leaves at zero.
const (
	// DefaultInterval is how often a poller wakes. Chosen against what the message
	// DOES: it becomes a status email and a toast, so this interval IS the delay a
	// customer perceives. See [[cqrs]]
	DefaultInterval = 5 * time.Second

	// DefaultBatchSize bounds one cycle's work so a backlog cannot hold a claim
	// transaction open across hundreds of SNS round trips — the rows in a claim
	// stay locked for its whole duration.
	DefaultBatchSize = 20

	// DefaultMaxAttempts is where a message is discarded.
	//
	// With the default backoff this is roughly 35 minutes of retrying. Beyond it
	// the failure is not transient, and an unbounded retry is worse than a
	// discard: the claim is ordered by created_at, so the poison row is re-read
	// FIRST every cycle and consumes the batch budget that healthy messages need.
	DefaultMaxAttempts = 12

	// defaultInitialBackoff and defaultMaxBackoff bound the exponential retry.
	defaultInitialBackoff = 500 * time.Millisecond
	defaultMaxBackoff     = 5 * time.Minute

	// claimTimeout bounds one cycle. A claim that hangs holds row locks, and
	// every other instance's poller skips those rows while it does.
	claimTimeout = 30 * time.Second

	// publishTimeout bounds one SNS call, so one slow publish cannot consume the
	// whole cycle budget.
	publishTimeout = 10 * time.Second
)

const (
	appEventPublished = "outbox_message_published"
	appEventFailed    = "outbox_message_publish_failed"
	appEventDiscarded = "outbox_message_discarded"
	appEventCycle     = "outbox_cycle_failed"
)

// Message is one pending publication, as the poller read it.
type Message struct {
	ID          uuid.UUID
	Payload     []byte
	Metadata    []byte
	CreatedAt   time.Time
	ScheduledAt time.Time
	// Attempts is how many times publishing has already failed.
	Attempts int
}

// Publisher is the poller's one collaborator, declared here by its consumer.
//
// CONTRACT: Return an error to have the message RETAINED and retried. Returning
// nil deletes the row, so a publisher that swallows its own failures turns a
// durable outbox back into at-most-once delivery — which is what the table exists
// to replace.
type Publisher interface {
	Publish(ctx context.Context, msg Message) error
}

// Options configures a poller. Every zero value takes its documented default.
type Options struct {
	Interval    time.Duration
	BatchSize   int
	MaxAttempts int

	// RetryBackoff maps a failure count to the delay before the next attempt. Nil
	// takes the exponential default. Injectable so the tests do not sleep.
	RetryBackoff func(attempts int) time.Duration

	Log *slog.Logger
}

// Poller claims, publishes and deletes.
type Poller struct {
	db        *sql.DB
	publisher Publisher
	table     string

	interval    time.Duration
	batchSize   int
	maxAttempts int
	backoff     func(int) time.Duration
	log         *slog.Logger
}

// NewPoller builds a poller over the default table.
//
// CONTRACT: db must be the WRITER pool. The claim takes row locks and the cycle
// deletes, neither of which a reader replica can serve — and against Aurora a
// reader would fail every cycle with a read-only error rather than degrade.
// See [[ADR-0006-read-write-replicas]]
func NewPoller(db *sql.DB, publisher Publisher, opts Options) *Poller {
	p := &Poller{
		db:          db,
		publisher:   publisher,
		table:       "outbox",
		interval:    opts.Interval,
		batchSize:   opts.BatchSize,
		maxAttempts: opts.MaxAttempts,
		backoff:     opts.RetryBackoff,
		log:         opts.Log,
	}
	if p.interval <= 0 {
		p.interval = DefaultInterval
	}
	if p.batchSize <= 0 {
		p.batchSize = DefaultBatchSize
	}
	if p.maxAttempts <= 0 {
		p.maxAttempts = DefaultMaxAttempts
	}
	if p.backoff == nil {
		p.backoff = exponentialBackoff
	}
	if p.log == nil {
		p.log = slog.Default()
	}
	return p
}

// Start runs the poller until ctx is cancelled, and returns a channel that closes
// when the loop has finished.
//
// CONTRACT: ctx MUST be the process-lifetime context, never a request's.
// net/http cancels a request context the instant its response is written, so an
// inherited one kills the loop at the first cycle — and cancellation is the loop's
// NORMAL exit, so nothing logs and the outbox just silently stops draining while
// every transition still records its message. The same trap the metrics ticker and
// the TestMode progression each document.
// See [[testmode-in-process-no-durable-scheduler]]
func (p *Poller) Start(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)

		ticker := time.NewTicker(p.interval)
		defer ticker.Stop()

		// A cycle immediately, before the first tick: a task that restarted with a
		// backlog must not wait out an interval before touching it.
		p.cycle(ctx)

		for {
			select {
			case <-ticker.C:
				p.cycle(ctx)
			case <-ctx.Done():
				return
			}
		}
	}()
	return done
}

// cycle runs one pass and logs a failure of the pass itself.
func (p *Poller) cycle(ctx context.Context) {
	if _, err := p.RunOnce(ctx); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			// Shutdown, or a cycle that ran out of budget. Neither is an
			// application fault, and the next cycle re-reads whatever was left.
			return
		}
		p.log.ErrorContext(ctx, appEventCycle,
			slog.String("app_event", appEventCycle),
			slog.String("reason", "claim_failed"),
			slog.String("error", err.Error()))
	}
}

// RunOnce claims one batch, publishes it, and reports how many were delivered.
//
// CONTRACT: A publish failure is NOT returned as an error. The row is retained for
// its retry and the cycle continues with the rest of the batch; returning would
// abandon messages that would have gone out. Only a failure of the CLAIM ITSELF —
// a database the poller cannot reach — is an error here.
func (p *Poller) RunOnce(ctx context.Context) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, claimTimeout)
	defer cancel()

	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("outbox: begin claim: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	messages, err := p.claim(ctx, tx)
	if err != nil {
		return 0, err
	}
	if len(messages) == 0 {
		// Nothing claimed: commit to release the snapshot rather than leaving an
		// idle transaction open until the next cycle.
		committed = true
		if err := tx.Commit(); err != nil {
			return 0, fmt.Errorf("outbox: commit an empty claim: %w", err)
		}
		return 0, nil
	}

	published := 0
	for _, msg := range messages {
		if p.handle(ctx, tx, msg) {
			published++
		}
	}

	// CONTRACT: Commit AFTER publishing. The commit is what releases the row locks,
	// so committing earlier would let another poller claim and publish the same
	// rows while this one is still calling SNS — which is exactly the duplicate
	// SKIP LOCKED is here to prevent, and it reproduces reliably with two pollers
	// and a publish slower than a claim.
	if err := tx.Commit(); err != nil {
		// Every delete and every reschedule in this batch rolls back with it, so
		// the messages stay pending and the next cycle re-reads them. Those that
		// were already published go out a second time; the pipeline dedupes on its
		// event_id unique index, which is why at-least-once is the safe direction
		// to fail in.
		return 0, fmt.Errorf("outbox: commit claim: %w", err)
	}
	committed = true

	return published, nil
}

// claim takes a batch of due messages and locks them for this poller's tx. The
// locks live until the CALLER commits, which is after publishing — see RunOnce.
//
// CONTRACT: FOR UPDATE SKIP LOCKED. A plain SELECT takes no lock and every
// instance publishes every row; a bare FOR UPDATE makes the second instance WAIT,
// serialising every task behind the first. See [[cqrs]]
//
// CONTRACT: UTC_TIMESTAMP(3), with the precision argument, matching the column's
// fsp 3. Bare UTC_TIMESTAMP() is fsp 0, so a row scheduled at ...:59.058 — which
// every short-backoff retry is — reads as LATER than "now" for the rest of that
// second, and the retry is never claimed again. See [[cqrs]]
func (p *Poller) claim(ctx context.Context, tx *sql.Tx) ([]Message, error) {
	//nolint:gosec // p.table is a package constant, never caller input.
	query := fmt.Sprintf(`
		SELECT id, payload, metadata, created_at, scheduled_at, times_attempted
		FROM %s
		WHERE scheduled_at <= UTC_TIMESTAMP(3)
		ORDER BY created_at ASC
		LIMIT ?
		FOR UPDATE SKIP LOCKED`, p.table)

	rows, err := tx.QueryContext(ctx, query, p.batchSize)
	if err != nil {
		return nil, fmt.Errorf("outbox: claim: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var claimed []Message
	for rows.Next() {
		var (
			rawID    []byte
			metadata []byte
			msg      Message
		)
		if err := rows.Scan(&rawID, &msg.Payload, &metadata,
			&msg.CreatedAt, &msg.ScheduledAt, &msg.Attempts); err != nil {
			return nil, fmt.Errorf("outbox: scan claimed message: %w", err)
		}
		// BINARY(16), because that is how the library's writer stores a UUID for
		// MySQL. FromBytes, not Parse: the column holds raw bytes, not text.
		id, err := uuid.FromBytes(rawID)
		if err != nil {
			return nil, fmt.Errorf("outbox: message id is not a 16-byte UUID: %w", err)
		}
		msg.ID = id
		// NULL scans as nil, and a nil metadata is legal — see restoreTraceContext.
		msg.Metadata = metadata
		claimed = append(claimed, msg)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("outbox: iterate claimed messages: %w", err)
	}

	// CONTRACT: The cursor must be drained and CLOSED before the caller publishes.
	// go-sql-driver allows one active result set per connection, and the claim's
	// transaction is pinned to that connection — so a still-open cursor makes the
	// first delete or reschedule on this tx fail with "commands out of sync". The
	// deferred Close covers the error paths; this one covers the success path,
	// where the next statement runs immediately.
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("outbox: close claim rows: %w", err)
	}

	return claimed, nil
}

// handle publishes one message and reports whether it was delivered.
func (p *Poller) handle(ctx context.Context, tx *sql.Tx, msg Message) bool {
	// CONTRACT: Discard BEFORE attempting. A message already at the limit has had
	// every attempt it is owed, and publishing once more would make MaxAttempts
	// mean "attempts plus one" — off by one on the only bound that stops a poison
	// row consuming the batch budget forever.
	if msg.Attempts >= p.maxAttempts {
		p.discard(ctx, tx, msg)
		return false
	}

	// The traceparent stored at write time, restored onto the context the publisher
	// receives. This is the ONLY link between the request that recorded the message
	// and the publish: the two run in different goroutines, so nothing ambient
	// connects them.
	publishCtx := restoreTraceContext(ctx, msg.Metadata)
	publishCtx, cancel := context.WithTimeout(publishCtx, publishTimeout)
	defer cancel()

	if err := p.publisher.Publish(publishCtx, msg); err != nil {
		p.retryLater(ctx, tx, msg, err)
		return false
	}

	if err := p.delete(ctx, tx, msg); err != nil {
		// The message WAS delivered; only the bookkeeping failed. Logged, not
		// retried: the next cycle re-reads the row and publishes it a second time,
		// which the pipeline's event_id unique index dedupes. A delete that keeps
		// failing shows up as the same order_id published every cycle.
		p.log.ErrorContext(ctx, appEventFailed,
			slog.String("app_event", appEventFailed),
			slog.String("reason", "delete_after_publish_failed"),
			slog.String("message_id", msg.ID.String()),
			slog.String("error", err.Error()))
		return true
	}

	p.log.InfoContext(publishCtx, appEventPublished,
		slog.String("app_event", appEventPublished),
		slog.String("message_id", msg.ID.String()),
		// The queue wait, which is what tells a slow notification from a slow
		// poller — and the only reason created_at is read at all.
		slog.Int64("queue_wait_ms", time.Since(msg.CreatedAt).Milliseconds()))
	return true
}

// retryLater advances the attempt counter and pushes the message out.
func (p *Poller) retryLater(ctx context.Context, tx *sql.Tx, msg Message, cause error) {
	attempts := msg.Attempts + 1
	next := time.Now().UTC().Add(p.backoff(attempts))

	//nolint:gosec // p.table is a package constant, never caller input.
	query := fmt.Sprintf(
		"UPDATE %s SET times_attempted = ?, scheduled_at = ? WHERE id = ?", p.table)

	// WARNING: The cause's text goes in the log and NOWHERE near the payload. The
	// payload holds shipping_address and, once the SNS publisher builds the
	// envelope, an email address. See [[logging-context]]
	attrs := []any{
		slog.String("app_event", appEventFailed),
		slog.String("reason", "publish_failed"),
		slog.String("message_id", msg.ID.String()),
		slog.Int("attempts", attempts),
		slog.Int("max_attempts", p.maxAttempts),
		slog.String("error", cause.Error()),
	}

	if _, err := tx.ExecContext(ctx, query, attempts, next, idBytes(msg.ID)); err != nil {
		// The row keeps its old counter and stays due, so the next cycle retries
		// immediately — degraded rather than lost.
		attrs = append(attrs, slog.String("reschedule_error", err.Error()))
	}
	p.log.ErrorContext(ctx, appEventFailed, attrs...)
}

// discard removes a message that has exhausted its attempts.
//
// CONTRACT: Log at ERROR and name the order id. The row is gone after this, so
// this line is the ONLY record that a customer's notification was never sent — a
// silent discard is indistinguishable from a successful delivery.
func (p *Poller) discard(ctx context.Context, tx *sql.Tx, msg Message) {
	attrs := []any{
		slog.String("app_event", appEventDiscarded),
		slog.String("reason", "max_attempts_exhausted"),
		slog.String("message_id", msg.ID.String()),
		slog.Int("attempts", msg.Attempts),
	}
	// order_id is the only payload field lifted out, because it is what makes the
	// line actionable — and it is not PII. Nothing else from the payload is logged.
	if orderID := orderIDFromPayload(msg.Payload); orderID != "" {
		attrs = append(attrs, slog.String("order_id", orderID))
	}

	if err := p.delete(ctx, tx, msg); err != nil {
		// Left in place, so it is discarded again next cycle rather than retried.
		attrs = append(attrs, slog.String("delete_error", err.Error()))
	}
	p.log.ErrorContext(ctx, appEventDiscarded, attrs...)
}

// delete removes one published or discarded message.
func (p *Poller) delete(ctx context.Context, tx *sql.Tx, msg Message) error {
	//nolint:gosec // p.table is a package constant, never caller input.
	query := fmt.Sprintf("DELETE FROM %s WHERE id = ?", p.table)
	if _, err := tx.ExecContext(ctx, query, idBytes(msg.ID)); err != nil {
		return fmt.Errorf("outbox: delete message %s: %w", msg.ID, err)
	}
	return nil
}

// idBytes renders a message id for the BINARY(16) column.
func idBytes(id uuid.UUID) []byte {
	binary := id
	return binary[:]
}

// restoreTraceContext puts the stored traceparent back on the context.
//
// CONTRACT: A message with no usable trace context still publishes. Failing here
// would trade a lost notification for an observability nicety — and rows written
// by a request with no active span legitimately carry none.
// See [[ADR-0019-distributed-tracing-opentelemetry]]
func restoreTraceContext(ctx context.Context, metadata []byte) context.Context {
	if len(metadata) == 0 {
		return ctx
	}
	var carrier propagation.MapCarrier
	if err := json.Unmarshal(metadata, &carrier); err != nil {
		return ctx
	}
	return otel.GetTextMapPropagator().Extract(ctx, carrier)
}

// orderIDFromPayload lifts the order id out of a stored payload for a log line.
//
// It decodes ONLY that field: the payload also holds shipping_address, and a
// struct with more fields is an invitation to log one of them.
func orderIDFromPayload(payload []byte) string {
	var partial struct {
		OrderID string `json:"order_id"`
	}
	if err := json.Unmarshal(payload, &partial); err != nil {
		return ""
	}
	return partial.OrderID
}

// exponentialBackoff doubles the delay per failure, capped.
//
// CONTRACT: Keep the cap. Uncapped doubling reaches days within a few dozen
// attempts, and a message scheduled past its own discard threshold is retained
// forever without another attempt.
func exponentialBackoff(attempts int) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	// Bounded before the shift: 1<<63 overflows into a negative duration, which
	// schedules the retry in the PAST and turns the backoff into a hot loop.
	if attempts > 20 {
		return defaultMaxBackoff
	}
	delay := defaultInitialBackoff * time.Duration(math.Pow(2, float64(attempts-1)))
	if delay > defaultMaxBackoff || delay <= 0 {
		return defaultMaxBackoff
	}
	return delay
}
