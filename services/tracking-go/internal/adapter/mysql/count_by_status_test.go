package mysql_test

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql"
)

// REAL MySQL, never a mock — the same rule the other repository tests here
// follow. A mocked GROUP BY would agree with whatever this file believed about
// the soft-delete filter and prove none of it.
//
// Its own schema, like every other repository test in this package: one shared
// database would make the files fight over the same rows.
const countSchema = "tracking_go_test_count"

const countDSNEnv = "TRACKING_TEST_MYSQL_DSN"

const countDefaultDSN = "test:test@tcp(127.0.0.1:7002)/"

func countDSN() string {
	if value := strings.TrimSpace(os.Getenv(countDSNEnv)); value != "" {
		return value
	}
	return countDefaultDSN
}

func requireCountMySQL(t *testing.T) *sql.DB {
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

	db := requireThrowawaySchema(t, serverDSN, countSchema)

	path := filepath.Join("..", "..", "..", "migrations", "000001_baseline.up.sql")
	source, err := os.ReadFile(path) //nolint:gosec // a fixed path inside the repo
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	if _, err := db.ExecContext(t.Context(), string(source)); err != nil {
		t.Fatalf("applying the baseline migration: %v", err)
	}
	return db
}

// countSeed inserts one tracking row at the given status, optionally
// soft-deleted.
func countSeed(t *testing.T, db *sql.DB, id, orderID, status string, deleted bool) {
	t.Helper()

	const insert = "INSERT INTO tracking " +
		"(id, user_id, order_id, tracking_number, status, cognito_sub, `datetime`, " +
		" created_by, created_at, updated_by, updated_at, deleted_at, deleted_by) " +
		"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"

	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)

	var deletedAt any
	var deletedBy any
	if deleted {
		deletedAt = now
		deletedBy = "TEST"
	}

	if _, err := db.ExecContext(t.Context(), insert,
		id, "usr_"+id, orderID, "TRK"+id, status, "sub-"+id, now,
		"TEST", now, "TEST", now, deletedAt, deletedBy,
	); err != nil {
		t.Fatalf("seeding %s: %v", id, err)
	}
}

// TestCountByStatus covers the ticker's one query.
//
// The two facts worth a real server: the GROUP BY shape maps into the Go map the
// ticker expects, and SOFT-DELETED ROWS ARE EXCLUDED. The second is the one that
// matters — a deleted tracking is not an order in flight, and counting it would
// make the gauge disagree with every user-facing read, all of which filter the
// same way.
func TestCountByStatus(t *testing.T) {
	db := requireCountMySQL(t)
	repo := mysql.NewMetricsRepository(db)

	t.Run("groups live rows by status", func(t *testing.T) {
		t.Cleanup(func() { countTruncate(t, db) })

		countSeed(t, db, "c1", "ord_c1", "PLACED", false)
		countSeed(t, db, "c2", "ord_c2", "PLACED", false)
		countSeed(t, db, "c3", "ord_c3", "DELIVERED", false)

		got, err := repo.CountByStatus(t.Context())
		if err != nil {
			t.Fatalf("CountByStatus: %v", err)
		}

		want := map[string]int64{"PLACED": 2, "DELIVERED": 1}
		if len(got) != len(want) {
			t.Fatalf("got %v, want %v", got, want)
		}
		for status, count := range want {
			if got[status] != count {
				t.Fatalf("status %s = %d, want %d (full result %v)", status, got[status], count, got)
			}
		}
	})

	t.Run("excludes soft-deleted rows", func(t *testing.T) {
		t.Cleanup(func() { countTruncate(t, db) })

		countSeed(t, db, "d1", "ord_d1", "PLACED", false)
		countSeed(t, db, "d2", "ord_d2", "PLACED", true)
		// A status that exists ONLY on a deleted row must not appear at all —
		// not as a zero, which would still be a series the dashboard renders.
		countSeed(t, db, "d3", "ord_d3", "SHIPPED", true)

		got, err := repo.CountByStatus(t.Context())
		if err != nil {
			t.Fatalf("CountByStatus: %v", err)
		}

		if got["PLACED"] != 1 {
			t.Fatalf("PLACED = %d, want 1 — a soft-deleted row was counted (%v)", got["PLACED"], got)
		}
		if _, present := got["SHIPPED"]; present {
			t.Fatalf("SHIPPED is present (%v); every row at that status is soft-deleted", got)
		}
	})

	t.Run("an empty table is an empty map, not an error", func(t *testing.T) {
		t.Cleanup(func() { countTruncate(t, db) })

		got, err := repo.CountByStatus(t.Context())
		if err != nil {
			t.Fatalf("CountByStatus on an empty table: %v", err)
		}
		if len(got) != 0 {
			t.Fatalf("got %v, want an empty map", got)
		}
	})
}

// countTruncate clears the tables between subtests.
//
// context.Background(), NEVER t.Context(): t.Context() is cancelled the instant
// the test function returns, BEFORE t.Cleanup callbacks run, so a truncate using
// it fails with `context canceled` and the next subtest inherits dirty rows.
func countTruncate(t *testing.T, db *sql.DB) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Children first — the FK is RESTRICT (no ON DELETE CASCADE, deliberately).
	for _, statement := range []string{
		"DELETE FROM tracking_history",
		"DELETE FROM tracking",
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
}
