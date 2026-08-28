package mysql_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"

	repo "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/config"
)

// ─── the real database ──────────────────────────────────────────────────────
//
// REAL MySQL, never a mock. A mocked repository test passes against a schema
// that does not exist and a driver that never runs: it cannot catch a column
// name that drifted, a DATETIME rounding a timestamp up a second, or an
// `IN ()` that MySQL rejects outright. Those are exactly the defects this file
// exists to catch.
//
// # It runs against its OWN schema, never the shared local `tracking` database
//
// The local `tracking` database is the one docker compose serves and the one the
// E2E suite reads. A test that TRUNCATEs it destroys a running environment, and
// this repo has already paid for that once (tables gone, the migration tool's
// version row intact, so re-migrating was a silent no-op). Every test here
// creates a throwaway schema, applies the baseline DDL to it, and drops it at
// the end.

const readsTestSchema = "tracking_go_test_reads"

// readsServerDSN strips the database name off TRACKING_DATABASE_URL, leaving the
// server address these tests attach their own schema to.
//
// Same environment variable the sibling repository tests use, so the suite has
// ONE switch rather than one per file — but the database segment is discarded
// deliberately: pointing these tests at the shared `tracking` database is what
// this file exists not to do.
func readsServerDSN(t *testing.T) (string, bool) {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv("TRACKING_DATABASE_URL"))
	if raw == "" {
		return "", false
	}
	dsn, err := config.MySQLDSN(raw)
	if err != nil {
		t.Fatalf("TRACKING_DATABASE_URL is not a usable DSN: %v", err)
	}
	// "user:pass@tcp(host:port)/db?params" -> "user:pass@tcp(host:port)/".
	slash := strings.LastIndex(dsn, ")/")
	if slash < 0 {
		t.Fatalf("cannot locate the database segment in the generated DSN")
	}
	return dsn[:slash+2], true
}

// requireReadsSchema opens a connection to a FRESH schema and returns it. The
// schema is dropped when the test ends, whether it passed or not.
func requireReadsSchema(t *testing.T) *sql.DB {
	t.Helper()

	server, configured := readsServerDSN(t)
	if !configured {
		t.Skip("TRACKING_DATABASE_URL is unset; set it to the tracking MySQL DSN " +
			"(e.g. mysql://test:test@127.0.0.1:7002/tracking) to run the repository tests")
	}

	admin, err := sql.Open("mysql", server+"?parseTime=true&multiStatements=true")
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := admin.PingContext(ctx); err != nil {
		_ = admin.Close()
		t.Fatalf("ping mysql: %v", err)
	}

	schema := readsTestSchema
	if _, err := admin.ExecContext(t.Context(), "DROP DATABASE IF EXISTS "+schema); err != nil {
		t.Fatalf("dropping a stale test schema: %v", err)
	}
	if _, err := admin.ExecContext(t.Context(),
		"CREATE DATABASE "+schema+" DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"); err != nil {
		t.Fatalf("creating the test schema: %v", err)
	}
	t.Cleanup(func() {
		// A FRESH context, never t.Context(): that one is already cancelled by
		// the time a Cleanup runs, so the DROP would fail with "context
		// canceled" and leave the schema behind for the next run to trip over.
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer dropCancel()
		// Best-effort teardown; a leaked schema is dropped by the next run.
		_, _ = admin.ExecContext(dropCtx, "DROP DATABASE IF EXISTS "+schema)
		_ = admin.Close()
	})

	db, err := sql.Open("mysql", server+schema+"?parseTime=true&multiStatements=true")
	if err != nil {
		t.Fatalf("opening the test schema: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	applyReadsBaseline(t, db)
	return db
}

// applyReadsBaseline runs the same migration the service ships, so the test schema
// cannot drift from production DDL.
func applyReadsBaseline(t *testing.T, db *sql.DB) {
	t.Helper()
	path := filepath.Join("..", "..", "..", "migrations", "000001_baseline.up.sql")
	source, err := os.ReadFile(path) //nolint:gosec // a fixed path inside the repo
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	if _, err := db.ExecContext(t.Context(), string(source)); err != nil {
		t.Fatalf("applying the baseline migration: %v", err)
	}
}

// ─── fixtures ───────────────────────────────────────────────────────────────

// seedReadsTracking inserts one tracking plus one history row per status.
//
// user_id and cognitoSub are SEPARATE parameters and every caller passes
// DIFFERENT values. A fixture reusing one value for both could not fail on the
// ownership bug — the read would match under either filter.
func seedReadsTracking(
	t *testing.T, db *sql.DB, orderID, userID, cognitoSub string,
	statuses []domain.Status, moment time.Time,
) string {
	t.Helper()

	trackingID := "trk_" + orderID
	current := statuses[len(statuses)-1]

	if _, err := db.ExecContext(t.Context(), `
		INSERT INTO tracking (
			id, user_id, order_id, status, shipping_address, `+"`datetime`"+`,
			created_by, created_at, updated_by, updated_at, cognito_sub, tags, tracking_number
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, JSON_ARRAY(), ?)`,
		trackingID, userID, orderID, string(current), []byte(`{"line1":"1 Main St"}`), moment,
		"test", moment, "test", moment, readsNullable(cognitoSub), "3MRAI-"+orderID,
	); err != nil {
		t.Fatalf("seeding tracking %s: %v", orderID, err)
	}

	for _, status := range statuses {
		if _, err := db.ExecContext(t.Context(), `
			INSERT INTO tracking_history (
				tracking_id, status, user_id, order_id, `+"`datetime`"+`,
				created_by, created_at, updated_by, updated_at, cognito_sub
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			trackingID, string(status), userID, orderID, moment,
			"test", moment, "test", moment, readsNullable(cognitoSub),
		); err != nil {
			t.Fatalf("seeding history %s/%s: %v", orderID, status, err)
		}
	}
	return trackingID
}

func readsNullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func softDeleteReadsOrder(t *testing.T, db *sql.DB, orderID string) {
	t.Helper()
	if _, err := db.ExecContext(t.Context(),
		"UPDATE tracking SET deleted_at = ?, deleted_by = ? WHERE order_id = ?",
		time.Now().UTC().Truncate(time.Second), "test", orderID); err != nil {
		t.Fatalf("soft-deleting %s: %v", orderID, err)
	}
}

// ─── the scoped single read ─────────────────────────────────────────────────

func TestScopedReadsFilterByCognitoSub(t *testing.T) {
	db := requireReadsSchema(t)
	reader := repo.NewTrackingReader(db)
	ctx := t.Context()

	// Truncate to the second: MySQL DATETIME here has fsp 0 and ROUNDS the
	// fractional part rather than truncating it, so an untruncated `now` can
	// come back a second later than it went in.
	now := time.Now().UTC().Truncate(time.Second)

	// user_id and cognito_sub are DIFFERENT values, deliberately.
	seedReadsTracking(t, db, "ord_1", "usr_internal", "sub-owner",
		[]domain.Status{domain.StatusPlaced, domain.StatusProcessing}, now)

	t.Run("the owner's sub resolves it", func(t *testing.T) {
		got, err := reader.GetByOrderIDScoped(ctx, "ord_1", "sub-owner")
		if err != nil {
			t.Fatalf("GetByOrderIDScoped: %v", err)
		}
		if got.Tracking.OrderID != "ord_1" {
			t.Errorf("order_id = %q", got.Tracking.OrderID)
		}
		if got.Tracking.UserID != "usr_internal" {
			t.Errorf("user_id = %q, want the internal usr_ id", got.Tracking.UserID)
		}
		if got.Tracking.CognitoSub != "sub-owner" {
			t.Errorf("cognito_sub = %q", got.Tracking.CognitoSub)
		}
		if len(got.History) == 0 {
			t.Error("the read must return the tracking together with its history")
		}
		if !got.Tracking.Datetime.Equal(now) {
			t.Errorf("datetime = %v, want %v — DATETIME fsp 0 ROUNDS, so timestamps "+
				"must be truncated to the second before they are stored",
				got.Tracking.Datetime, now)
		}
	})

	t.Run("the internal usr_ id resolves NOTHING", func(t *testing.T) {
		_, err := reader.GetByOrderIDScoped(ctx, "ord_1", "usr_internal")
		if !errors.Is(err, domain.ErrTrackingNotFound) {
			t.Fatalf("err = %v, want ErrTrackingNotFound — scoping by user_id would "+
				"404 every read including the owner's", err)
		}
	})

	t.Run("another user's sub resolves NOTHING", func(t *testing.T) {
		_, err := reader.GetByOrderIDScoped(ctx, "ord_1", "sub-intruder")
		if !errors.Is(err, domain.ErrTrackingNotFound) {
			t.Fatalf("err = %v, want ErrTrackingNotFound", err)
		}
	})

	// The empty string is what an optional-parameter port would silently pass.
	t.Run("an empty sub resolves NOTHING", func(t *testing.T) {
		_, err := reader.GetByOrderIDScoped(ctx, "ord_1", "")
		if !errors.Is(err, domain.ErrTrackingNotFound) {
			t.Fatalf("err = %v, want ErrTrackingNotFound — an empty sub must never "+
				"behave like an unscoped read", err)
		}
	})

	t.Run("an unknown order id is ErrTrackingNotFound, not a driver error", func(t *testing.T) {
		_, err := reader.GetByOrderIDScoped(ctx, "ord_nope", "sub-owner")
		if !errors.Is(err, domain.ErrTrackingNotFound) {
			t.Fatalf("err = %v, want ErrTrackingNotFound", err)
		}
	})

	t.Run("history is ordered by timestamp then progression position", func(t *testing.T) {
		// Both transitions share ONE second: a bare datetime sort ties, and MySQL
		// then falls back to PK order — alphabetical — which puts DELIVERED first.
		got, err := reader.GetByOrderIDScoped(ctx, "ord_1", "sub-owner")
		if err != nil {
			t.Fatal(err)
		}
		if len(got.History) != 2 {
			t.Fatalf("history has %d entries, want 2", len(got.History))
		}
		if got.History[0].Status != domain.StatusPlaced {
			t.Errorf("history[0] = %q, want PLACED", got.History[0].Status)
		}
		if got.History[1].Status != domain.StatusProcessing {
			t.Errorf("history[1] = %q, want PROCESSING", got.History[1].Status)
		}
	})

	t.Run("a soft-deleted tracking is invisible", func(t *testing.T) {
		softDeleteReadsOrder(t, db, "ord_1")
		if _, err := reader.GetByOrderIDScoped(ctx, "ord_1", "sub-owner"); !errors.Is(err, domain.ErrTrackingNotFound) {
			t.Fatalf("err = %v, want ErrTrackingNotFound", err)
		}
	})
}

// The composite PK makes DELIVERED sort first on a tie. This is the case the
// FIELD() tiebreaker exists for, asserted against real MySQL because no
// in-memory double reproduces the PK fallback.
func TestScopedReadOrdersDeliveredLastOnATie(t *testing.T) {
	db := requireReadsSchema(t)
	reader := repo.NewTrackingReader(db)
	now := time.Now().UTC().Truncate(time.Second)

	seedReadsTracking(t, db, "ord_tie", "usr_internal", "sub-owner", []domain.Status{
		domain.StatusPlaced, domain.StatusProcessing, domain.StatusShipped,
		domain.StatusOutForDelivery, domain.StatusDelivered,
	}, now)

	got, err := reader.GetByOrderIDScoped(t.Context(), "ord_tie", "sub-owner")
	if err != nil {
		t.Fatal(err)
	}
	want := []domain.Status{
		domain.StatusPlaced, domain.StatusProcessing, domain.StatusShipped,
		domain.StatusOutForDelivery, domain.StatusDelivered,
	}
	for i, expected := range want {
		if got.History[i].Status != expected {
			t.Fatalf("history[%d] = %q, want %q (full order: %v) — the datetime tie "+
				"fell back to alphabetical PK order", i, got.History[i].Status, expected,
				readsStatuses(got.History))
		}
	}
}

func readsStatuses(history []domain.TrackingHistory) []domain.Status {
	out := make([]domain.Status, 0, len(history))
	for _, e := range history {
		out = append(out, e.Status)
	}
	return out
}

// ─── the scoped batch read ──────────────────────────────────────────────────

func TestScopedListFiltersByCognitoSub(t *testing.T) {
	db := requireReadsSchema(t)
	reader := repo.NewTrackingReader(db)
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Second)

	seedReadsTracking(t, db, "ord_mine", "usr_internal", "sub-owner",
		[]domain.Status{domain.StatusPlaced}, now)
	seedReadsTracking(t, db, "ord_theirs", "usr_other", "sub-other",
		[]domain.Status{domain.StatusPlaced}, now)
	seedReadsTracking(t, db, "ord_gone", "usr_internal", "sub-owner",
		[]domain.Status{domain.StatusPlaced}, now)
	softDeleteReadsOrder(t, db, "ord_gone")

	t.Run("only the caller's live trackings come back", func(t *testing.T) {
		got, err := reader.ListByOrderIDsScoped(ctx,
			[]string{"ord_mine", "ord_theirs", "ord_gone", "ord_nope"}, "sub-owner")
		if err != nil {
			t.Fatalf("ListByOrderIDsScoped: %v", err)
		}
		if len(got) != 1 || got[0].Tracking.OrderID != "ord_mine" {
			t.Fatalf("got %d trackings %v, want exactly [ord_mine]", len(got), readsOrderIDs(got))
		}
		if len(got[0].History) == 0 {
			t.Error("each tracking must come back together with its history")
		}
	})

	t.Run("the internal usr_ id resolves NOTHING", func(t *testing.T) {
		got, err := reader.ListByOrderIDsScoped(ctx, []string{"ord_mine"}, "usr_internal")
		if err != nil {
			t.Fatalf("ListByOrderIDsScoped: %v", err)
		}
		if len(got) != 0 {
			t.Fatalf("the internal usr_ id resolved %d trackings — the list must scope "+
				"by cognito_sub only", len(got))
		}
	})

	t.Run("an empty sub resolves NOTHING", func(t *testing.T) {
		got, err := reader.ListByOrderIDsScoped(ctx, []string{"ord_mine"}, "")
		if err != nil {
			t.Fatalf("ListByOrderIDsScoped: %v", err)
		}
		if len(got) != 0 {
			t.Fatalf("an empty sub resolved %d trackings", len(got))
		}
	})

	// The adapter must not build `IN ()`, which MySQL rejects outright.
	t.Run("an empty id list returns empty WITHOUT a syntax error", func(t *testing.T) {
		got, err := reader.ListByOrderIDsScoped(ctx, nil, "sub-owner")
		if err != nil {
			t.Fatalf("ListByOrderIDsScoped(nil): %v — an empty slice must never reach "+
				"an IN () clause", err)
		}
		if got == nil {
			t.Error("want a non-nil empty slice")
		}
		if len(got) != 0 {
			t.Errorf("got %d trackings, want none", len(got))
		}
	})

	// The batch must load history in ONE additional query, never one per
	// tracking. Correctness first: every parent gets ITS OWN history.
	t.Run("history is attached to the right parent", func(t *testing.T) {
		seedReadsTracking(t, db, "ord_second", "usr_internal", "sub-owner",
			[]domain.Status{domain.StatusPlaced, domain.StatusProcessing}, now)

		got, err := reader.ListByOrderIDsScoped(ctx,
			[]string{"ord_mine", "ord_second"}, "sub-owner")
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 2 {
			t.Fatalf("got %d trackings, want 2", len(got))
		}
		byOrder := map[string][]domain.TrackingHistory{}
		for _, item := range got {
			byOrder[item.Tracking.OrderID] = item.History
		}
		if len(byOrder["ord_mine"]) != 1 {
			t.Errorf("ord_mine has %d history entries, want 1", len(byOrder["ord_mine"]))
		}
		if len(byOrder["ord_second"]) != 2 {
			t.Errorf("ord_second has %d history entries, want 2", len(byOrder["ord_second"]))
		}
		for _, entry := range byOrder["ord_second"] {
			if entry.OrderID != "ord_second" {
				t.Errorf("a history entry for %q was attached to ord_second", entry.OrderID)
			}
		}
	})
}

func readsOrderIDs(items []domain.TrackingWithHistory) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.Tracking.OrderID)
	}
	return out
}

// A row with a NULL cognito_sub is unreachable over both user-scoped reads: the
// filter compares against a sub, and NULL matches nobody. Never mis-attributed.
func TestScopedReadsCannotReachANullCognitoSubRow(t *testing.T) {
	db := requireReadsSchema(t)
	reader := repo.NewTrackingReader(db)
	now := time.Now().UTC().Truncate(time.Second)

	seedReadsTracking(t, db, "ord_null", "usr_internal", "",
		[]domain.Status{domain.StatusPlaced}, now)

	if _, err := reader.GetByOrderIDScoped(t.Context(), "ord_null", ""); !errors.Is(err, domain.ErrTrackingNotFound) {
		t.Fatalf("err = %v, want ErrTrackingNotFound — NULL must not match an empty sub", err)
	}
	got, err := reader.ListByOrderIDsScoped(t.Context(), []string{"ord_null"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("a NULL-cognito_sub row was returned to an empty sub")
	}
}
