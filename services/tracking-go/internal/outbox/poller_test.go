package outbox_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	oteltrace "go.opentelemetry.io/otel/trace"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/outbox"
)

// REAL MySQL, never a mock. The property under test is InnoDB's own row-locking
// behaviour under FOR UPDATE SKIP LOCKED — a mocked database has no locks, so a
// mock would report exactly-once delivery for an implementation that has none.
// See [[testing]]

const (
	pollerSchema  = "tracking_go_test_poller"
	pollerDSNEnv  = "TRACKING_TEST_MYSQL_DSN"
	pollerFallDSN = "test:test@tcp(127.0.0.1:7002)/"
)

func pollerServerDSN() string {
	if v := strings.TrimSpace(os.Getenv(pollerDSNEnv)); v != "" {
		return v
	}
	return pollerFallDSN
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// requirePollerMySQL builds a throwaway schema holding ONLY the outbox table.
//
// The poller reads nothing else, so the business tables are deliberately absent:
// a suite that needed them would be asserting on something other than the claim.
func requirePollerMySQL(t *testing.T) *sql.DB {
	t.Helper()

	serverDSN := pollerServerDSN()
	probe, err := sql.Open("mysql", serverDSN+"?parseTime=true")
	if err != nil {
		t.Skipf("cannot open MySQL (%s): %v", pollerDSNEnv, err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := probe.PingContext(ctx); err != nil {
		_ = probe.Close()
		t.Skipf("MySQL is unreachable; set %s to run the poller tests: %v", pollerDSNEnv, err)
	}
	_ = probe.Close()

	db := newThrowawaySchema(t, serverDSN, pollerSchema)

	// The outbox DDL comes from the MIGRATION, not a copy: a hand-written CREATE
	// TABLE here would let the column types drift from what production runs, and
	// the BINARY(16) id is exactly the kind of detail that drifts silently.
	path := filepath.Join("..", "..", "migrations", "000003_add_outbox.up.sql")
	source, err := os.ReadFile(path) //nolint:gosec // a fixed path inside the repo
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	if _, err := db.ExecContext(t.Context(), string(source)); err != nil {
		t.Fatalf("applying the outbox migration: %v", err)
	}
	return db
}

// newThrowawaySchema creates an isolated database. DDL runs as root, because the
// local `test` user holds only database-scoped grants.
func newThrowawaySchema(t *testing.T, appServerDSN, schema string) *sql.DB {
	t.Helper()

	adminDSN := strings.TrimSpace(os.Getenv("TRACKING_TEST_MYSQL_ADMIN_DSN"))
	if adminDSN == "" {
		at := strings.Index(appServerDSN, "@")
		if at < 0 {
			t.Fatalf("cannot derive an admin DSN from %q", appServerDSN)
		}
		adminDSN = "root:test" + appServerDSN[at:]
	}

	admin, err := sql.Open("mysql", adminDSN+"?parseTime=true&multiStatements=true")
	if err != nil {
		t.Fatalf("open mysql admin: %v", err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := admin.PingContext(ctx); err != nil {
		_ = admin.Close()
		t.Skipf("MySQL admin is unreachable: %v", err)
	}

	appUser := "test"
	if at := strings.Index(appServerDSN, "@"); at > 0 {
		if user, _, found := strings.Cut(appServerDSN[:at], ":"); found && user != "" {
			appUser = user
		}
	}

	if _, err := admin.ExecContext(t.Context(), "DROP DATABASE IF EXISTS "+schema); err != nil {
		_ = admin.Close()
		t.Fatalf("dropping a stale test schema: %v", err)
	}
	if _, err := admin.ExecContext(t.Context(),
		"CREATE DATABASE "+schema+" DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"); err != nil {
		_ = admin.Close()
		t.Fatalf("creating the test schema: %v", err)
	}
	if _, err := admin.ExecContext(t.Context(), fmt.Sprintf(
		"GRANT ALL PRIVILEGES ON `%s`.* TO '%s'@'%%'; FLUSH PRIVILEGES;", schema, appUser)); err != nil {
		_ = admin.Close()
		t.Fatalf("granting the test schema to %q: %v", appUser, err)
	}

	t.Cleanup(func() {
		// A FRESH context: Go cancels t.Context() before cleanups run, so the DROP
		// would fail with "context canceled" and leave the schema behind.
		dropCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = admin.ExecContext(dropCtx, "DROP DATABASE IF EXISTS "+schema)
		_ = admin.Close()
	})

	db, err := sql.Open("mysql", appServerDSN+schema+"?parseTime=true&multiStatements=true")
	if err != nil {
		t.Fatalf("opening the test schema: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// seedMessage inserts one pending message due immediately, and returns its id.
func seedMessage(t *testing.T, db *sql.DB, payload string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	binary, err := id.MarshalBinary()
	if err != nil {
		t.Fatalf("marshalling a message id: %v", err)
	}
	// scheduled_at in the PAST, so the claim's `scheduled_at <= UTC_TIMESTAMP()`
	// matches regardless of clock skew between this process and the server.
	now := time.Now().UTC().Add(-time.Minute)
	if _, err := db.ExecContext(t.Context(),
		`INSERT INTO outbox (id, created_at, scheduled_at, metadata, payload, times_attempted)
		 VALUES (?, ?, ?, ?, ?, 0)`,
		binary, now, now, []byte(`{}`), []byte(payload)); err != nil {
		t.Fatalf("seeding an outbox message: %v", err)
	}
	return id
}

func countRows(t *testing.T, db *sql.DB) int {
	t.Helper()
	var n int
	if err := db.QueryRowContext(t.Context(), "SELECT COUNT(*) FROM outbox").Scan(&n); err != nil {
		t.Fatalf("counting outbox rows: %v", err)
	}
	return n
}

func attemptsOf(t *testing.T, db *sql.DB, id uuid.UUID) int {
	t.Helper()
	binary, err := id.MarshalBinary()
	if err != nil {
		t.Fatalf("marshalling a message id: %v", err)
	}
	var n int
	if err := db.QueryRowContext(t.Context(),
		"SELECT times_attempted FROM outbox WHERE id = ?", binary).Scan(&n); err != nil {
		t.Fatalf("reading times_attempted: %v", err)
	}
	return n
}

// recordingPublisher counts deliveries per payload and can be made slow, so two
// pollers genuinely overlap inside their claim transactions.
type recordingPublisher struct {
	mu       sync.Mutex
	payloads []string

	delay time.Duration
	err   error
}

func (p *recordingPublisher) Publish(_ context.Context, msg outbox.Message) error {
	if p.delay > 0 {
		time.Sleep(p.delay)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.err != nil {
		return p.err
	}
	p.payloads = append(p.payloads, string(msg.Payload))
	return nil
}

func (p *recordingPublisher) delivered() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.payloads...)
}

func (p *recordingPublisher) count(payload string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, got := range p.payloads {
		if got == payload {
			n++
		}
	}
	return n
}

// TestTwoPollersDeliverEachMessageExactlyOnce is the highest-risk property in this
// package, and the reason the claim uses FOR UPDATE SKIP LOCKED.
//
// CONTRACT: Keep this test CONCURRENT. One poller cannot tell a correct claim from
// no locking at all — both deliver each message once — so it passes against an
// implementation that double-publishes as soon as a second task exists. Every
// instance runs a poller, and a duplicate is a second email. See [[cqrs]]
func TestTwoPollersDeliverEachMessageExactlyOnce(t *testing.T) {
	db := requirePollerMySQL(t)

	const messages = 12
	payloads := make([]string, 0, messages)
	for i := range messages {
		payload := fmt.Sprintf(`{"order_id":"ord_concurrent%02d"}`, i)
		seedMessage(t, db, payload)
		payloads = append(payloads, payload)
	}

	// The delay is what makes the overlap real: without it each claim commits
	// before the other poller's SELECT runs, and the two never contend — the test
	// would then pass with no locking whatever.
	publisher := &recordingPublisher{delay: 25 * time.Millisecond}

	// Batch size 4 with 12 rows, so neither poller can take the whole table in one
	// pass and both must keep coming back for more.
	first := outbox.NewPoller(db, publisher, outbox.Options{BatchSize: 4, Log: quietLog()})
	second := outbox.NewPoller(db, publisher, outbox.Options{BatchSize: 4, Log: quietLog()})

	var wg sync.WaitGroup
	for _, poller := range []*outbox.Poller{first, second} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Drain in a loop rather than one pass: with two pollers racing, either
			// may find an empty batch while the other still holds rows.
			deadline := time.Now().Add(20 * time.Second)
			for time.Now().Before(deadline) {
				published, err := poller.RunOnce(t.Context())
				if err != nil {
					t.Errorf("RunOnce: %v", err)
					return
				}
				if published == 0 && countRows(t, db) == 0 {
					return
				}
			}
			t.Error("the pollers did not drain the outbox within the deadline")
		}()
	}
	wg.Wait()

	if remaining := countRows(t, db); remaining != 0 {
		t.Errorf("%d rows left in the outbox, want 0 — a published message must be deleted "+
			"or the next tick republishes it", remaining)
	}

	delivered := publisher.delivered()
	if len(delivered) != messages {
		t.Errorf("total deliveries = %d, want exactly %d.\nDelivered: %v",
			len(delivered), messages, delivered)
	}
	for _, payload := range payloads {
		switch got := publisher.count(payload); got {
		case 1:
			// exactly once
		case 0:
			t.Errorf("%s was never delivered — a claimed row must not be lost", payload)
		default:
			t.Errorf("%s was delivered %d times. Two pollers claimed the same row: "+
				"the customer gets %d emails for one status change", payload, got, got)
		}
	}
}

// TestASecondPollerSkipsALockedRowRatherThanBlocking pins the SKIP LOCKED half
// specifically, separately from the end-to-end count above.
//
// CONTRACT: SKIP LOCKED, never a bare FOR UPDATE. A bare one is also correct about
// exactly-once, so the test above passes either way — but it makes the second
// poller WAIT, serialising every instance behind one. See [[cqrs]]
func TestASecondPollerSkipsALockedRowRatherThanBlocking(t *testing.T) {
	db := requirePollerMySQL(t)

	seedMessage(t, db, `{"order_id":"ord_locked0000001"}`)

	// Hold the only row under an explicit FOR UPDATE, simulating a poller mid-claim.
	holder, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatalf("begin the holding transaction: %v", err)
	}
	defer func() { _ = holder.Rollback() }()
	var heldID []byte
	if err := holder.QueryRowContext(t.Context(),
		"SELECT id FROM outbox FOR UPDATE").Scan(&heldID); err != nil {
		t.Fatalf("locking the row: %v", err)
	}

	publisher := &recordingPublisher{}
	poller := outbox.NewPoller(db, publisher, outbox.Options{BatchSize: 10, Log: quietLog()})

	// A budget far under InnoDB's 50s default lock-wait timeout: a bare FOR UPDATE
	// blocks here, and the deadline is what makes that visible as a failure rather
	// than a slow pass.
	done := make(chan int, 1)
	errs := make(chan error, 1)
	go func() {
		published, err := poller.RunOnce(t.Context())
		if err != nil {
			errs <- err
			return
		}
		done <- published
	}()

	select {
	case published := <-done:
		if published != 0 {
			t.Errorf("published %d messages, want 0 — the only row is locked by another "+
				"claim and must be left alone", published)
		}
		if got := len(publisher.delivered()); got != 0 {
			t.Errorf("delivered %d messages, want 0", got)
		}
	case err := <-errs:
		t.Fatalf("RunOnce: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("RunOnce BLOCKED on a row another transaction holds. The claim is missing " +
			"SKIP LOCKED: every instance's poller then serialises behind whichever one " +
			"claimed first, and a slow publish stalls all of them")
	}

	if got := countRows(t, db); got != 1 {
		t.Errorf("outbox rows = %d, want 1 — the skipped row must stay for its own claimant", got)
	}
}

// TestAFailedPublishIsRetriedAndNotLost pins the durability promise.
//
// A publish that fails leaves the row in place with times_attempted advanced and
// scheduled_at pushed out, so the next cycle tries again. Deleting on failure, or
// leaving times_attempted at zero, both look like success here and lose the
// notification.
func TestAFailedPublishIsRetriedAndNotLost(t *testing.T) {
	db := requirePollerMySQL(t)

	const payload = `{"order_id":"ord_retry00000001"}`
	id := seedMessage(t, db, payload)

	publisher := &recordingPublisher{err: errors.New("sns is unreachable")}
	poller := outbox.NewPoller(db, publisher, outbox.Options{
		BatchSize: 10,
		Log:       quietLog(),
		// A zero-length backoff, so the retry is due immediately and the test does
		// not sleep. Production backs off exponentially.
		RetryBackoff: func(int) time.Duration { return 0 },
	})

	published, err := poller.RunOnce(t.Context())
	if err != nil {
		t.Fatalf("RunOnce must not fail on a publish error, that is the retry path: %v", err)
	}
	if published != 0 {
		t.Errorf("published = %d, want 0 — the publisher failed", published)
	}
	if got := countRows(t, db); got != 1 {
		t.Fatalf("outbox rows = %d, want 1 — a failed publish MUST NOT delete the row, "+
			"or the notification is lost with nothing recording that it was owed", got)
	}
	if got := attemptsOf(t, db, id); got != 1 {
		t.Errorf("times_attempted = %d, want 1 — without the counter a poison row is "+
			"retried forever and can never be discarded", got)
	}

	// Now the broker recovers and the same row goes out.
	publisher.mu.Lock()
	publisher.err = nil
	publisher.mu.Unlock()

	published, err = poller.RunOnce(t.Context())
	if err != nil {
		t.Fatalf("RunOnce after recovery: %v", err)
	}
	if published != 1 {
		t.Errorf("published = %d, want 1 — the retained row must go out on the next cycle", published)
	}
	if got := publisher.count(payload); got != 1 {
		t.Errorf("delivered %d times, want 1", got)
	}
	if got := countRows(t, db); got != 0 {
		t.Errorf("outbox rows = %d, want 0 after a successful publish", got)
	}
}

// TestARowThatKeepsFailingIsDiscardedRatherThanBlockingTheQueue pins the poison
// row's fate.
//
// CONTRACT: Discard at MaxAttempts, logged at ERROR with the order id. An unbounded
// retry is a silent stall: the claim is ordered by created_at, so the poison row is
// re-read FIRST every cycle and takes the batch budget. See [[cqrs]]
func TestARowThatKeepsFailingIsDiscardedRatherThanBlockingTheQueue(t *testing.T) {
	db := requirePollerMySQL(t)

	seedMessage(t, db, `{"order_id":"ord_poison000001"}`)
	// A second, healthy row proves the poison one does not take the queue with it.
	const healthy = `{"order_id":"ord_healthy00001"}`
	seedMessage(t, db, healthy)

	failing := &failOnePublisher{failFor: "ord_poison000001"}

	var logged strings.Builder
	logger := slog.New(slog.NewJSONHandler(&logged, &slog.HandlerOptions{Level: slog.LevelDebug}))

	poller := outbox.NewPoller(db, failing, outbox.Options{
		BatchSize:    10,
		MaxAttempts:  3,
		Log:          logger,
		RetryBackoff: func(int) time.Duration { return 0 },
	})

	// Cycle past MaxAttempts. The healthy row goes out on the first pass.
	for range 5 {
		if _, err := poller.RunOnce(t.Context()); err != nil {
			t.Fatalf("RunOnce: %v", err)
		}
	}

	if got := failing.count(healthy); got != 1 {
		t.Errorf("the healthy message was delivered %d times, want exactly 1 — a poison "+
			"row must neither block it nor cause a duplicate", got)
	}
	if got := countRows(t, db); got != 0 {
		t.Errorf("outbox rows = %d, want 0 — the poison row must be discarded at "+
			"MaxAttempts, not retried forever", got)
	}

	lines := logged.String()
	if !strings.Contains(lines, "outbox_message_discarded") {
		t.Errorf("a discarded message must be logged at ERROR with app_event="+
			"outbox_message_discarded — a row dropped silently is a notification nobody "+
			"knows was lost.\nLogged:\n%s", lines)
	}
	if !strings.Contains(lines, "ord_poison000001") {
		t.Errorf("the discard line must name the order_id, or it is not actionable.\nLogged:\n%s", lines)
	}
}

// failOnePublisher fails every message whose payload names one order.
type failOnePublisher struct {
	mu       sync.Mutex
	failFor  string
	payloads []string
}

func (p *failOnePublisher) Publish(_ context.Context, msg outbox.Message) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if strings.Contains(string(msg.Payload), p.failFor) {
		return errors.New("permanent failure for this message")
	}
	p.payloads = append(p.payloads, string(msg.Payload))
	return nil
}

func (p *failOnePublisher) count(payload string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, got := range p.payloads {
		if got == payload {
			n++
		}
	}
	return n
}

// TestAMessageScheduledForTheFutureIsNotClaimedYet pins the backoff's mechanism.
//
// Without the scheduled_at predicate, a failed row is re-read on the very next
// cycle and the exponential backoff exists only in a comment.
func TestAMessageScheduledForTheFutureIsNotClaimedYet(t *testing.T) {
	db := requirePollerMySQL(t)

	id := uuid.New()
	binary, err := id.MarshalBinary()
	if err != nil {
		t.Fatalf("marshalling a message id: %v", err)
	}
	now := time.Now().UTC()
	if _, err := db.ExecContext(t.Context(),
		`INSERT INTO outbox (id, created_at, scheduled_at, metadata, payload, times_attempted)
		 VALUES (?, ?, ?, ?, ?, 1)`,
		binary, now, now.Add(time.Hour), []byte(`{}`),
		[]byte(`{"order_id":"ord_future000001"}`)); err != nil {
		t.Fatalf("seeding a scheduled message: %v", err)
	}

	publisher := &recordingPublisher{}
	poller := outbox.NewPoller(db, publisher, outbox.Options{BatchSize: 10, Log: quietLog()})

	published, err := poller.RunOnce(t.Context())
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if published != 0 {
		t.Errorf("published = %d, want 0 — a message scheduled an hour out is not due", published)
	}
	if got := countRows(t, db); got != 1 {
		t.Errorf("outbox rows = %d, want 1 — the row must wait for its schedule", got)
	}
}

// TestTheStoredTraceContextReachesThePublisher is the trace-continuity proof.
//
// CONTRACT: The publish span must be a CHILD of the span that wrote the row. The
// two run on different contexts, so the traceparent in metadata is the only thing
// connecting them — without it the waterfall shows two unrelated traces, each
// complete on its own. See [[ADR-0019-distributed-tracing-opentelemetry]]
func TestTheStoredTraceContextReachesThePublisher(t *testing.T) {
	db := requirePollerMySQL(t)

	const (
		traceID = "4bf92f3577b34da6a3ce929d0e0e4736"
		spanID  = "00f067aa0ba902b7"
	)
	traceparent := "00-" + traceID + "-" + spanID + "-01"

	id := uuid.New()
	binary, err := id.MarshalBinary()
	if err != nil {
		t.Fatalf("marshalling a message id: %v", err)
	}
	metadata, err := json.Marshal(map[string]string{"traceparent": traceparent})
	if err != nil {
		t.Fatalf("encoding metadata: %v", err)
	}
	now := time.Now().UTC().Add(-time.Minute)
	if _, err := db.ExecContext(t.Context(),
		`INSERT INTO outbox (id, created_at, scheduled_at, metadata, payload, times_attempted)
		 VALUES (?, ?, ?, ?, ?, 0)`,
		binary, now, now, metadata, []byte(`{"order_id":"ord_traced000001"}`)); err != nil {
		t.Fatalf("seeding a traced message: %v", err)
	}

	observed := &contextObservingPublisher{}
	poller := outbox.NewPoller(db, observed, outbox.Options{BatchSize: 10, Log: quietLog()})

	if _, err := poller.RunOnce(t.Context()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	if observed.traceID != traceID {
		t.Errorf("the publisher saw trace_id %q, want %q — the stored traceparent must be "+
			"restored onto the publish context, or the publish span starts a NEW trace and "+
			"the waterfall stops at the outbox write", observed.traceID, traceID)
	}
	if observed.parentSpanID != spanID {
		t.Errorf("the publisher saw parent span_id %q, want %q", observed.parentSpanID, spanID)
	}
}

// TestAMessageWithNoStoredTraceContextStillPublishes pins the degraded path.
//
// A row written before the metadata column carried anything, or by a request with
// no active span, must still be delivered. Losing the notification over a missing
// trace id would trade a real failure for an observability nicety.
func TestAMessageWithNoStoredTraceContextStillPublishes(t *testing.T) {
	db := requirePollerMySQL(t)

	id := uuid.New()
	binary, err := id.MarshalBinary()
	if err != nil {
		t.Fatalf("marshalling a message id: %v", err)
	}
	now := time.Now().UTC().Add(-time.Minute)
	if _, err := db.ExecContext(t.Context(),
		`INSERT INTO outbox (id, created_at, scheduled_at, metadata, payload, times_attempted)
		 VALUES (?, ?, ?, NULL, ?, 0)`,
		binary, now, now, []byte(`{"order_id":"ord_notrace000001"}`)); err != nil {
		t.Fatalf("seeding an untraced message: %v", err)
	}

	publisher := &recordingPublisher{}
	poller := outbox.NewPoller(db, publisher, outbox.Options{BatchSize: 10, Log: quietLog()})

	published, err := poller.RunOnce(t.Context())
	if err != nil {
		t.Fatalf("RunOnce with NULL metadata: %v", err)
	}
	if published != 1 {
		t.Errorf("published = %d, want 1 — a missing trace context must not stop delivery", published)
	}
	if got := countRows(t, db); got != 0 {
		t.Errorf("outbox rows = %d, want 0", got)
	}
}

// contextObservingPublisher records the trace it was called under.
type contextObservingPublisher struct {
	traceID      string
	parentSpanID string
}

func (p *contextObservingPublisher) Publish(ctx context.Context, _ outbox.Message) error {
	// The SpanContext on the ctx the poller hands over IS the restored remote
	// parent: the poller does not open a span of its own here, so what a real
	// publisher would parent its span to is exactly what this reads.
	sc := oteltrace.SpanContextFromContext(ctx)
	p.traceID = sc.TraceID().String()
	p.parentSpanID = sc.SpanID().String()
	return nil
}

// TestMain installs the W3C propagator this package's trace-continuity test
// depends on.
//
// CONTRACT: Install it HERE, not inside a test. otel's global propagator is
// process-wide and defaults to a NO-OP, so without this both Inject and Extract do
// nothing and the trace assertions decide on something else entirely. Mirrors what
// SetupTracing installs. See [[ADR-0019-distributed-tracing-opentelemetry]]
func TestMain(m *testing.M) {
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{}))
	os.Exit(m.Run())
}
