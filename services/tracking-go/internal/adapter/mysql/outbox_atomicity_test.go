package mysql_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"

	repomysql "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// REAL MySQL, never a mock. The property under test is that TWO writes share ONE
// transaction, and a mock has no transaction to share. See [[testing]]
//
// Its OWN throwaway schema: it applies every migration, and creating the outbox
// table in the shared `tracking` database would leave it behind for the service.
const outboxSchema = "tracking_go_test_outbox"

// requireOutboxMySQL builds a throwaway schema with the FULL migration chain
// applied, and returns a pool over it.
func requireOutboxMySQL(t *testing.T) *sql.DB {
	t.Helper()

	serverDSN := countDSN()
	probe, err := sql.Open("mysql", serverDSN+"?parseTime=true")
	if err != nil {
		t.Skipf("cannot open MySQL (%s): %v", countDSNEnv, err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := probe.PingContext(ctx); err != nil {
		_ = probe.Close()
		t.Skipf("MySQL is unreachable; set %s to run the repository tests: %v", countDSNEnv, err)
	}
	_ = probe.Close()

	db := requireThrowawaySchema(t, serverDSN, outboxSchema)
	applyMigrations(t, db)
	return db
}

// applyMigrations runs every `*.up.sql` in order, so this suite tests the schema
// the migration chain actually produces rather than a hand-copied CREATE TABLE.
func applyMigrations(t *testing.T, db *sql.DB) {
	t.Helper()

	paths, err := filepath.Glob(filepath.Join("..", "..", "..", "migrations", "*.up.sql"))
	if err != nil {
		t.Fatalf("globbing migrations: %v", err)
	}
	if len(paths) == 0 {
		t.Fatal("no migrations found — the glob is wrong, and an empty schema would make every assertion below vacuous")
	}
	// Glob returns sorted names, and the golang-migrate prefix is zero-padded, so
	// lexical order IS migration order.
	for _, path := range paths {
		source, err := os.ReadFile(path) //nolint:gosec // a fixed path inside the repo
		if err != nil {
			t.Fatalf("reading %s: %v", path, err)
		}
		if _, err := db.ExecContext(t.Context(), string(source)); err != nil {
			t.Fatalf("applying %s: %v", filepath.Base(path), err)
		}
	}
}

// countOutboxRows returns how many messages are waiting to be published.
func countOutboxRows(t *testing.T, db *sql.DB) int {
	t.Helper()
	var n int
	if err := db.QueryRowContext(t.Context(), "SELECT COUNT(*) FROM outbox").Scan(&n); err != nil {
		t.Fatalf("counting outbox rows: %v", err)
	}
	return n
}

// countHistoryRows returns how many transitions a tracking has recorded.
func countHistoryRows(t *testing.T, db *sql.DB, trackingID string) int {
	t.Helper()
	var n int
	if err := db.QueryRowContext(t.Context(),
		"SELECT COUNT(*) FROM tracking_history WHERE tracking_id = ?", trackingID).Scan(&n); err != nil {
		t.Fatalf("counting history rows: %v", err)
	}
	return n
}

// statusOf reads a tracking's persisted status.
func statusOf(t *testing.T, db *sql.DB, orderID string) string {
	t.Helper()
	var status string
	if err := db.QueryRowContext(t.Context(),
		"SELECT status FROM tracking WHERE order_id = ?", orderID).Scan(&status); err != nil {
		t.Fatalf("reading status: %v", err)
	}
	return status
}

// TestTheOutboxRowSharesTheTransitionsTRANSACTION is the decisive test, and it is
// decisive only because it asserts BOTH directions.
//
// CONTRACT: Keep both halves. A commit-only assertion cannot distinguish one
// shared transaction from two separate ones that both happened to succeed — which
// is precisely the arrangement the outbox exists to eliminate. The rollback half
// is what proves the outbox write is INSIDE the business transaction.
// See [[cqrs]]
func TestTheOutboxRowSharesTheTransitionsTRANSACTION(t *testing.T) {
	db := requireOutboxMySQL(t)

	// TWO DIFFERENT VALUES for user_id and cognito_sub. Every fixture in this
	// package does, because a row using one value for both cannot fail on the
	// ownership bug. See [[user-id-vs-cognito-sub-ownership-key]]
	const (
		userID     = "usr_outboxatomicity01"
		cognitoSub = "sub-outbox-atomicity-0001"
	)
	now := time.Now().UTC().Truncate(time.Second)

	t.Run("a COMMITTED transition leaves the business rows AND exactly one outbox row", func(t *testing.T) {
		const (
			orderID    = "ord_outboxcommit000001"
			trackingID = "trk_outboxcommit000001"
		)
		transitionSeed(t, db, orderID, trackingID, userID, cognitoSub, domain.StatusPlaced, now)
		t.Cleanup(func() { transitionCleanup(t, db, orderID) })

		repo := repomysql.NewStatusRepository(db,
			repomysql.WithOutbox(repomysql.NewOutboxWriter(db)))

		current, err := repo.GetByOrderID(t.Context(), orderID)
		if err != nil {
			t.Fatalf("GetByOrderID: %v", err)
		}

		before := countOutboxRows(t, db)
		if _, err := repo.ApplyTransition(
			t.Context(), current, domain.StatusShipped, audit.CarrierStatusUpdate, now); err != nil {
			t.Fatalf("ApplyTransition: %v", err)
		}

		if got := statusOf(t, db, orderID); got != string(domain.StatusShipped) {
			t.Errorf("persisted status = %q, want SHIPPED", got)
		}
		if got := countHistoryRows(t, db, trackingID); got != 2 {
			t.Errorf("history rows = %d, want 2 (PLACED + SHIPPED)", got)
		}
		if got := countOutboxRows(t, db) - before; got != 1 {
			t.Errorf("outbox rows written = %d, want EXACTLY 1 — a committed transition "+
				"must leave one message for the poller, and duplicates would send the "+
				"customer two emails for one transition", got)
		}
	})

	t.Run("a ROLLED-BACK transition leaves NEITHER the history row NOR an outbox row", func(t *testing.T) {
		const (
			orderID    = "ord_outboxrollbk000001"
			trackingID = "trk_outboxrollbk000001"
		)
		transitionSeed(t, db, orderID, trackingID, userID, cognitoSub, domain.StatusPlaced, now)
		t.Cleanup(func() { transitionCleanup(t, db, orderID) })

		repo := repomysql.NewStatusRepository(db,
			repomysql.WithOutbox(repomysql.NewOutboxWriter(db)))

		current, err := repo.GetByOrderID(t.Context(), orderID)
		if err != nil {
			t.Fatalf("GetByOrderID: %v", err)
		}

		// Forced the way production reaches it: the composite primary key
		// (tracking_id, status) rejects PLACED -> PLACED after the parent UPDATE.
		//
		// CONTRACT: This proves the BUSINESS rows roll back and nothing more — the
		// INSERT fails BEFORE the outbox write, so the count below is zero either
		// way. TestARollbackAFTERTheOutboxWriteLeavesNoOutboxRow is the one that
		// can show the shared transaction. See [[cqrs]]
		before := countOutboxRows(t, db)
		_, err = repo.ApplyTransition(
			t.Context(), current, domain.StatusPlaced, audit.CarrierStatusUpdate, now)
		if err == nil {
			t.Fatal("ApplyTransition to an already-recorded status must fail on the " +
				"composite primary key; with no error there is no rollback to observe")
		}

		if got := statusOf(t, db, orderID); got != string(domain.StatusPlaced) {
			t.Errorf("persisted status = %q, want PLACED — the parent UPDATE must have rolled back", got)
		}
		if got := countHistoryRows(t, db, trackingID); got != 1 {
			t.Errorf("history rows = %d, want 1 — the failed INSERT must leave nothing behind", got)
		}
		if got := countOutboxRows(t, db) - before; got != 0 {
			t.Errorf("outbox rows written = %d, want 0 — the outbox row MUST roll back with "+
				"the business write. A surviving row announces a transition that never "+
				"happened: the customer is emailed that their parcel shipped when the "+
				"database still says PLACED", got)
		}
	})
}

// TestTheTransitionStillWorksWithNoOutboxConfigured pins the degraded wiring.
//
// A repository built without an outbox writer keeps transitioning. The outbox is
// an added durability guarantee, not a new required dependency: an environment
// whose migration has not run yet must still serve the carrier webhook.
func TestTheTransitionStillWorksWithNoOutboxConfigured(t *testing.T) {
	db := requireOutboxMySQL(t)

	const (
		orderID    = "ord_outboxabsent000001"
		trackingID = "trk_outboxabsent000001"
		userID     = "usr_outboxabsent00001"
		cognitoSub = "sub-outbox-absent-0001"
	)
	now := time.Now().UTC().Truncate(time.Second)
	transitionSeed(t, db, orderID, trackingID, userID, cognitoSub, domain.StatusPlaced, now)
	t.Cleanup(func() { transitionCleanup(t, db, orderID) })

	repo := repomysql.NewStatusRepository(db)

	current, err := repo.GetByOrderID(t.Context(), orderID)
	if err != nil {
		t.Fatalf("GetByOrderID: %v", err)
	}

	before := countOutboxRows(t, db)
	if _, err := repo.ApplyTransition(
		t.Context(), current, domain.StatusShipped, audit.CarrierStatusUpdate, now); err != nil {
		t.Fatalf("ApplyTransition without an outbox writer: %v", err)
	}

	if got := statusOf(t, db, orderID); got != string(domain.StatusShipped) {
		t.Errorf("persisted status = %q, want SHIPPED", got)
	}
	if got := countOutboxRows(t, db) - before; got != 0 {
		t.Errorf("outbox rows = %d, want 0 — no writer means no message", got)
	}
}

// TestTheOutboxPayloadIsTheSNSEnvelope pins what the poller will later publish.
//
// CONTRACT: The payload is the FULLY BUILT envelope, assembled at write time from
// the persisted row. Storing an identifier for the poller to re-read instead would
// reintroduce the failure the outbox closes: by the time the poller looked, the
// row may have advanced again, and the "shipped" notification would describe the
// DELIVERED state. See [[events-pipeline-design]]
func TestTheOutboxPayloadIsTheSNSEnvelope(t *testing.T) {
	db := requireOutboxMySQL(t)

	const (
		orderID    = "ord_outboxpayload00001"
		trackingID = "trk_outboxpayload00001"
		userID     = "usr_outboxpayload0001"
		cognitoSub = "sub-outbox-payload-001"
	)
	now := time.Now().UTC().Truncate(time.Second)
	transitionSeed(t, db, orderID, trackingID, userID, cognitoSub, domain.StatusPlaced, now)
	t.Cleanup(func() { transitionCleanup(t, db, orderID) })

	repo := repomysql.NewStatusRepository(db,
		repomysql.WithOutbox(repomysql.NewOutboxWriter(db)))

	current, err := repo.GetByOrderID(t.Context(), orderID)
	if err != nil {
		t.Fatalf("GetByOrderID: %v", err)
	}
	if _, err := repo.ApplyTransition(
		t.Context(), current, domain.StatusShipped, audit.CarrierStatusUpdate, now); err != nil {
		t.Fatalf("ApplyTransition: %v", err)
	}

	var payload, metadata []byte
	var attempted int
	if err := db.QueryRowContext(t.Context(),
		"SELECT payload, metadata, times_attempted FROM outbox ORDER BY created_at DESC LIMIT 1",
	).Scan(&payload, &metadata, &attempted); err != nil {
		t.Fatalf("reading the outbox row: %v", err)
	}

	if attempted != 0 {
		t.Errorf("times_attempted = %d on a fresh row, want 0", attempted)
	}

	stored, err := repomysql.DecodeOutboxPayload(payload)
	if err != nil {
		t.Fatalf("the payload is not a decodable status-change message: %v\n%s", err, payload)
	}
	if stored.OrderID != orderID {
		t.Errorf("payload.OrderID = %q, want %q", stored.OrderID, orderID)
	}
	if stored.Status != string(domain.StatusShipped) {
		t.Errorf("payload.Status = %q, want SHIPPED", stored.Status)
	}
	// PreviousStatus is the one field that cannot be recovered later: the row's
	// status is already the new one. If the outbox did not capture it at write
	// time, nothing downstream can reconstruct it.
	if stored.PreviousStatus != string(domain.StatusPlaced) {
		t.Errorf("payload.PreviousStatus = %q, want PLACED", stored.PreviousStatus)
	}
	if stored.UserID != userID {
		t.Errorf("payload.UserID = %q, want %q", stored.UserID, userID)
	}
	// Off the PERSISTED ROW, and the key the events pipeline routes the WebSocket
	// push by. A usr_ id there reaches nobody, with no error.
	if stored.CognitoSub != cognitoSub {
		t.Errorf("payload.CognitoSub = %q, want %q", stored.CognitoSub, cognitoSub)
	}
	if stored.Actor != audit.CarrierStatusUpdate {
		t.Errorf("payload.Actor = %q, want %q", stored.Actor, audit.CarrierStatusUpdate)
	}
	if len(stored.History) != 2 {
		t.Errorf("payload.History has %d entries, want 2 — the RE-READ inside the "+
			"transaction is what makes the announced history contain the transition "+
			"being announced", len(stored.History))
	}

	// The trace context travels in metadata, so the poller's publish span joins
	// the trace of the request that wrote the row rather than starting its own.
	if len(metadata) == 0 {
		t.Error("metadata is empty: without the trace context the publish span is an " +
			"orphan and the waterfall stops at the outbox write")
	}
}

// TestTheOutboxWriteFailureFailsTheTransition pins the direction of the guarantee.
//
// CONTRACT: A failed outbox write must FAIL the transition. Swallowing it restores
// the pre-outbox failure — a committed status change nobody is told about — while
// every happy-path test stays green. The publish is best-effort; the RECORD of it
// is not. See [[cqrs]]
func TestTheOutboxWriteFailureFailsTheTransition(t *testing.T) {
	db := requireOutboxMySQL(t)

	const (
		orderID    = "ord_outboxbroken00001"
		trackingID = "trk_outboxbroken00001"
		userID     = "usr_outboxbroken00001"
		cognitoSub = "sub-outbox-broken-0001"
	)
	now := time.Now().UTC().Truncate(time.Second)
	transitionSeed(t, db, orderID, trackingID, userID, cognitoSub, domain.StatusPlaced, now)
	t.Cleanup(func() { transitionCleanup(t, db, orderID) })

	// A writer pointed at a table that does not exist is the cheapest real
	// failure: the INSERT reaches the server and comes back 1146.
	repo := repomysql.NewStatusRepository(db,
		repomysql.WithOutbox(repomysql.NewOutboxWriterWithTable(db, "outbox_does_not_exist")))

	current, err := repo.GetByOrderID(t.Context(), orderID)
	if err != nil {
		t.Fatalf("GetByOrderID: %v", err)
	}

	_, err = repo.ApplyTransition(
		t.Context(), current, domain.StatusShipped, audit.CarrierStatusUpdate, now)
	if err == nil {
		t.Fatal("a failed outbox write must fail the transition, not be swallowed")
	}
	if errors.Is(err, domain.ErrTrackingNotFound) {
		t.Errorf("the failure must not masquerade as a missing tracking: %v", err)
	}

	if got := statusOf(t, db, orderID); got != string(domain.StatusPlaced) {
		t.Errorf("persisted status = %q, want PLACED — the transition must have rolled back", got)
	}
	if got := countHistoryRows(t, db, trackingID); got != 1 {
		t.Errorf("history rows = %d, want 1", got)
	}
}

// TestARollbackAFTERTheOutboxWriteLeavesNoOutboxRow is the test that actually
// proves the shared transaction, and the one the other rollback case cannot be.
//
// CONTRACT: The abort must happen AFTER the outbox row is written. Every natural
// failure in ApplyTransition occurs BEFORE it, so a rollback test built on one
// passes whether that write shares this transaction or opens its own. Measured:
// the own-transaction mutation is invisible there and caught here. See [[cqrs]]
func TestARollbackAFTERTheOutboxWriteLeavesNoOutboxRow(t *testing.T) {
	db := requireOutboxMySQL(t)

	const (
		orderID    = "ord_outboxlaterb00001"
		trackingID = "trk_outboxlaterb00001"
		userID     = "usr_outboxlaterb0001"
		cognitoSub = "sub-outbox-laterb-001"
	)
	now := time.Now().UTC().Truncate(time.Second)
	transitionSeed(t, db, orderID, trackingID, userID, cognitoSub, domain.StatusPlaced, now)
	t.Cleanup(func() { transitionCleanup(t, db, orderID) })

	aborted := errors.New("aborted after every write, before the commit")
	repo := repomysql.NewStatusRepository(db,
		repomysql.WithOutbox(repomysql.NewOutboxWriter(db)),
		repomysql.WithFailureBeforeCommit(func() error { return aborted }))

	current, err := repo.GetByOrderID(t.Context(), orderID)
	if err != nil {
		t.Fatalf("GetByOrderID: %v", err)
	}

	before := countOutboxRows(t, db)
	_, err = repo.ApplyTransition(
		t.Context(), current, domain.StatusShipped, audit.CarrierStatusUpdate, now)
	if !errors.Is(err, aborted) {
		t.Fatalf("ApplyTransition err = %v, want the injected abort — with no abort there is "+
			"no rollback to observe and this test proves nothing", err)
	}

	if got := statusOf(t, db, orderID); got != string(domain.StatusPlaced) {
		t.Errorf("persisted status = %q, want PLACED", got)
	}
	if got := countHistoryRows(t, db, trackingID); got != 1 {
		t.Errorf("history rows = %d, want 1", got)
	}
	if got := countOutboxRows(t, db) - before; got != 0 {
		t.Errorf("outbox rows = %d, want 0. The outbox row did NOT roll back with the "+
			"business write, so it is in a SEPARATE transaction: a committed message "+
			"announcing a transition the database never recorded, and the customer is "+
			"emailed that a parcel shipped when its status is still PLACED", got)
	}
}
