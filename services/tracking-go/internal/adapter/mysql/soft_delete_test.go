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
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// REAL MySQL, never a mock. The whole point of these tests is the behaviour of
// the SERVER — collation, JSON_CONTAINS, the derived-table wrapper MySQL demands
// when an UPDATE's subquery reads the table it targets. A mock would agree with
// whatever the Go code believed and prove none of it.
//
// Its own schema, dropped at the end of the run. Pointing these tests at the
// shared `tracking` database would silently destroy the running Python service's
// data — a mistake this repo has already paid for once.
const softDeleteSchema = "tracking_go_test_softdelete"

// softDeleteDSNEnv is the connection string. It falls back to the local compose
// default so `go test ./...` works with no setup on a machine with the stack up.
const softDeleteDSNEnv = "TRACKING_TEST_MYSQL_DSN"

const softDeleteDefaultDSN = "test:test@tcp(127.0.0.1:7002)/"

func softDeleteDSN() string {
	if value := strings.TrimSpace(os.Getenv(softDeleteDSNEnv)); value != "" {
		return value
	}
	return softDeleteDefaultDSN
}

// softDeleteApplyBaseline runs the SAME migration the service ships, so the test
// schema cannot drift from production DDL. That matters more here than in most
// repository tests: the whole case-sensitivity suite below is meaningful only
// because the baseline declares cognito_sub and user_id utf8mb4_unicode_ci.
func softDeleteApplyBaseline(t *testing.T, db *sql.DB) {
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

// requireSoftDeleteMySQL opens a connection to a FRESH schema and returns it.
//
// Named apart from its siblings in this package on purpose: several test files
// here each need their own isolated schema, and one shared helper would make them
// fight over a single database.
func requireSoftDeleteMySQL(t *testing.T) *sql.DB {
	t.Helper()

	admin, err := sql.Open("mysql", softDeleteDSN()+"?parseTime=true&multiStatements=true")
	if err != nil {
		t.Skipf("cannot open MySQL (%s): %v", softDeleteDSNEnv, err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := admin.PingContext(ctx); err != nil {
		_ = admin.Close()
		t.Skipf("MySQL is unreachable; set %s to run the repository tests: %v", softDeleteDSNEnv, err)
	}

	if _, err := admin.ExecContext(t.Context(), "DROP DATABASE IF EXISTS "+softDeleteSchema); err != nil {
		t.Fatalf("dropping a stale test schema: %v", err)
	}
	if _, err := admin.ExecContext(t.Context(),
		"CREATE DATABASE "+softDeleteSchema+" DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"); err != nil {
		t.Fatalf("creating the test schema: %v", err)
	}
	t.Cleanup(func() {
		// A FRESH context, never t.Context(): that one is already cancelled by the
		// time cleanups run, so the drop would be abandoned and leak the schema.
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer dropCancel()
		// Best-effort teardown; a leaked schema is dropped by the next run.
		_, _ = admin.ExecContext(dropCtx, "DROP DATABASE IF EXISTS "+softDeleteSchema)
		_ = admin.Close()
	})

	db, err := sql.Open("mysql", softDeleteDSN()+softDeleteSchema+"?parseTime=true&multiStatements=true")
	if err != nil {
		t.Fatalf("opening the test schema: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// The SAME baseline migration the service ships, so the collations these
	// tests depend on cannot drift from production DDL. utf8mb4_unicode_ci on
	// cognito_sub and user_id is precisely what makes the utf8mb4_bin pin in the
	// predicate a safety control rather than decoration.
	softDeleteApplyBaseline(t, db)
	return db
}

func truncateSoftDelete(t *testing.T, db *sql.DB) {
	t.Helper()
	// Children first — the FK is RESTRICT (deliberately: no ON DELETE CASCADE).
	//
	// Full statements rather than "DELETE FROM "+table: the table names are
	// constants here, but spelling them out keeps any SQL string in this file
	// free of concatenation, so a later edit cannot turn a fixture helper into an
	// injection point without it being obvious.
	for _, statement := range []string{
		"DELETE FROM tracking_history",
		"DELETE FROM tracking",
	} {
		if _, err := db.ExecContext(t.Context(), statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
}

type softDeleteSeedRow struct {
	orderID string
	userID  string
	// cognitoSub is stored as NULL when nullSub is true, mirroring rows that
	// predate the cognito_sub migration.
	cognitoSub string
	nullSub    bool
	tags       []string
	// historyStatuses seeds one tracking_history row per entry.
	historyStatuses []domain.Status
	deleted         bool
}

// seed inserts one tracking (and its history) with direct SQL rather than through
// another task's repository, so these tests exercise the statements under test
// and nothing else.
func seedSoftDelete(t *testing.T, db *sql.DB, row softDeleteSeedRow, now time.Time) string {
	t.Helper()

	id := "trk_" + softDeletePad(row.orderID)
	sub := sql.NullString{String: row.cognitoSub, Valid: !row.nullSub}
	tags := softDeleteTagsJSON(t, row.tags)

	deletedAt := sql.NullTime{}
	deletedBy := sql.NullString{}
	if row.deleted {
		deletedAt = sql.NullTime{Time: now, Valid: true}
		deletedBy = sql.NullString{String: "seed", Valid: true}
	}

	const insertTracking = `
INSERT INTO tracking (id, user_id, order_id, status, shipping_address, ` + "`datetime`" + `,
                      created_by, created_at, updated_by, updated_at,
                      deleted_by, deleted_at, cognito_sub, tags, tracking_number)
VALUES (?, ?, ?, ?, NULL, ?, 'seed', ?, 'seed', ?, ?, ?, ?, ?, ?)`

	if _, err := db.ExecContext(t.Context(), insertTracking,
		id, row.userID, row.orderID, string(domain.StatusPlaced), now, now, now,
		deletedBy, deletedAt, sub, tags, "3MRAI-"+softDeletePad(row.orderID)[:14],
	); err != nil {
		t.Fatalf("seed tracking %s: %v", row.orderID, err)
	}

	const insertHistory = `
INSERT INTO tracking_history (tracking_id, status, user_id, order_id, ` + "`datetime`" + `,
                              created_by, created_at, updated_by, updated_at,
                              deleted_by, deleted_at, cognito_sub)
VALUES (?, ?, ?, ?, ?, 'seed', ?, 'seed', ?, NULL, NULL, ?)`

	for _, status := range row.historyStatuses {
		if _, err := db.ExecContext(t.Context(), insertHistory,
			id, string(status), row.userID, row.orderID, now, now, now, sub,
		); err != nil {
			t.Fatalf("seed history %s/%s: %v", row.orderID, status, err)
		}
	}
	return id
}

func softDeleteTagsJSON(t *testing.T, tags []string) string {
	t.Helper()
	if tags == nil {
		return "[]"
	}
	out := "["
	for i, tag := range tags {
		if i > 0 {
			out += ","
		}
		out += softDeleteQuoteJSON(tag)
	}
	return out + "]"
}

func softDeleteQuoteJSON(s string) string {
	out := `"`
	for _, r := range s {
		switch r {
		case '"':
			out += `\"`
		case '\\':
			out += `\\`
		default:
			out += string(r)
		}
	}
	return out + `"`
}

// pad builds a deterministic 24-char suffix so ids fit VARCHAR(28) exactly.
func softDeletePad(seedText string) string {
	const filler = "000000000000000000000000"
	out := seedText + filler
	return out[:24]
}

func softDeleteLiveHistoryCount(t *testing.T, db *sql.DB, orderID string) int {
	t.Helper()
	var n int
	err := db.QueryRowContext(t.Context(),
		"SELECT COUNT(*) FROM tracking_history WHERE order_id = ? AND deleted_at IS NULL",
		orderID).Scan(&n)
	if err != nil {
		t.Fatalf("liveHistoryCount(%s): %v", orderID, err)
	}
	return n
}

func softDeleteIsLive(t *testing.T, db *sql.DB, orderID string) bool {
	t.Helper()
	var n int
	err := db.QueryRowContext(t.Context(),
		"SELECT COUNT(*) FROM tracking WHERE order_id = ? AND deleted_at IS NULL",
		orderID).Scan(&n)
	if err != nil {
		t.Fatalf("isLive(%s): %v", orderID, err)
	}
	return n == 1
}

func softDeleteStamp(t *testing.T, db *sql.DB, orderID string) (sql.NullTime, sql.NullString) {
	t.Helper()
	var at sql.NullTime
	var by sql.NullString
	err := db.QueryRowContext(t.Context(),
		"SELECT deleted_at, deleted_by FROM tracking WHERE order_id = ?",
		orderID).Scan(&at, &by)
	if err != nil {
		t.Fatalf("deletedStamp(%s): %v", orderID, err)
	}
	return at, by
}

func TestSoftDeleteByUser(t *testing.T) {
	db := requireSoftDeleteMySQL(t)
	repo := mysql.NewSoftDeleteRepository(db)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	t.Run("matches EITHER identity", func(t *testing.T) {
		truncateSoftDelete(t, db)
		// One row reachable only by cognito_sub (its user_id belongs to someone
		// else), one only by user_id (its cognito_sub is NULL, like rows
		// predating the migration), and one belonging to nobody involved.
		//
		// The two identities are DIFFERENT VALUES on purpose: a test using the
		// same string for both cannot fail when the predicate matches the wrong
		// column.
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_a", userID: "usr_other", cognitoSub: "sub-1",
			historyStatuses: []domain.Status{domain.StatusPlaced}}, now)
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_b", userID: "usr_1", nullSub: true,
			historyStatuses: []domain.Status{domain.StatusPlaced}}, now)
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_c", userID: "usr_nope", cognitoSub: "sub-nope"}, now)

		got, err := repo.SoftDeleteByUser(ctx, "sub-1", "usr_1", audit.DeleteByUser, now)
		if err != nil {
			t.Fatal(err)
		}
		if got != 2 {
			t.Fatalf("deleted = %d, want 2 (the OR must reach both rows)", got)
		}
		if softDeleteLiveHistoryCount(t, db, "ord_a") != 0 {
			t.Error("history was left live under a deleted tracking")
		}
		if softDeleteLiveHistoryCount(t, db, "ord_b") != 0 {
			t.Error("history under the user_id-only row was left live")
		}
		if !softDeleteIsLive(t, db, "ord_c") {
			t.Error("an unrelated user's tracking was swept")
		}
	})

	// A row whose cognito_sub is NULL is reachable ONLY through user_id. Matching
	// on cognito_sub alone would silently leave a returning user's oldest
	// trackings live and unreachable.
	t.Run("a NULL-cognito_sub row is reached through user_id alone", func(t *testing.T) {
		truncateSoftDelete(t, db)
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_legacy", userID: "usr_1", nullSub: true}, now)

		got, err := repo.SoftDeleteByUser(ctx, "sub-1", "usr_1", audit.DeleteByUser, now)
		if err != nil {
			t.Fatal(err)
		}
		if got != 1 {
			t.Fatalf("deleted = %d, want 1 — a NULL cognito_sub must not make the "+
				"row unreachable, it predates the migration", got)
		}
	})

	t.Run("comparison is CASE-SENSITIVE under utf8mb4_bin", func(t *testing.T) {
		truncateSoftDelete(t, db)
		// The columns are utf8mb4_unicode_ci — case-insensitive — while the ids
		// come from a mixed-case alphabet minted by Postgres, which compares
		// case-sensitively. Without the explicit COLLATE these are one person.
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_upper", userID: "usr_AbC", cognitoSub: "sub-AbC"}, now)

		got, err := repo.SoftDeleteByUser(ctx, "sub-abc", "usr_abc", audit.DeleteByUser, now)
		if err != nil {
			t.Fatal(err)
		}
		if got != 0 {
			t.Fatalf("deleted = %d, want 0 — a lower-case id must NOT sweep the "+
				"mixed-case row; that is a different person", got)
		}
		if !softDeleteIsLive(t, db, "ord_upper") {
			t.Error("a different person's tracking was swept by a case-folded id")
		}
	})

	// The children are selected through the same predicate, so the collation pin
	// has to be on the subquery too. Without it the parent survives while its
	// history is swept — a half-erased stranger.
	t.Run("the case-sensitivity pin covers the history subquery too", func(t *testing.T) {
		truncateSoftDelete(t, db)
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_hist_case", userID: "usr_AbC", cognitoSub: "sub-AbC",
			historyStatuses: []domain.Status{domain.StatusPlaced, domain.StatusProcessing}}, now)

		if _, err := repo.SoftDeleteByUser(ctx, "sub-abc", "usr_abc", audit.DeleteByUser, now); err != nil {
			t.Fatal(err)
		}
		if n := softDeleteLiveHistoryCount(t, db, "ord_hist_case"); n != 2 {
			t.Fatalf("live history = %d, want 2 — a case-folded id must not sweep "+
				"another person's history either", n)
		}
	})

	t.Run("children are stamped before the parent and the count is the parent's", func(t *testing.T) {
		truncateSoftDelete(t, db)
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_h", userID: "usr_1", cognitoSub: "sub-1",
			historyStatuses: []domain.Status{
				domain.StatusPlaced, domain.StatusProcessing, domain.StatusShipped,
				domain.StatusOutForDelivery, domain.StatusDelivered,
			}}, now)

		got, err := repo.SoftDeleteByUser(ctx, "sub-1", "usr_1", audit.DeleteByUser, now)
		if err != nil {
			t.Fatal(err)
		}
		if got != 1 {
			t.Fatalf("deleted = %d, want 1 — the count is the PARENT rowcount, not "+
				"the 5 history rows", got)
		}
		if n := softDeleteLiveHistoryCount(t, db, "ord_h"); n != 0 {
			t.Errorf("%d history rows left live", n)
		}
	})

	t.Run("live history under an ALREADY-deleted tracking is still swept", func(t *testing.T) {
		truncateSoftDelete(t, db)
		// A partial previous run: the parent is stamped, the children are not.
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_partial", userID: "usr_1", cognitoSub: "sub-1",
			deleted:         true,
			historyStatuses: []domain.Status{domain.StatusPlaced, domain.StatusProcessing, domain.StatusShipped},
		}, now)

		if _, err := repo.SoftDeleteByUser(ctx, "sub-1", "usr_1", audit.DeleteByUser, now); err != nil {
			t.Fatal(err)
		}
		if n := softDeleteLiveHistoryCount(t, db, "ord_partial"); n != 0 {
			t.Fatalf("%d history rows left live — the parent-id subquery must NOT be "+
				"filtered on deleted_at IS NULL", n)
		}
	})

	t.Run("idempotent: a second call stamps nothing", func(t *testing.T) {
		truncateSoftDelete(t, db)
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_i", userID: "usr_1", cognitoSub: "sub-1",
			historyStatuses: []domain.Status{domain.StatusPlaced, domain.StatusProcessing}}, now)

		if _, err := repo.SoftDeleteByUser(ctx, "sub-1", "usr_1", audit.DeleteByUser, now); err != nil {
			t.Fatal(err)
		}
		second, err := repo.SoftDeleteByUser(ctx, "sub-1", "usr_1", audit.DeleteByUser, now)
		if err != nil {
			t.Fatal(err)
		}
		if second != 0 {
			t.Errorf("second call deleted = %d, want 0", second)
		}
	})

	// deleted_by records WHAT PRODUCED the change. A row erased by the cascade
	// must stay distinguishable from one the harness swept.
	t.Run("stamps the actor and the passed-in now", func(t *testing.T) {
		truncateSoftDelete(t, db)
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_stamp", userID: "usr_1", cognitoSub: "sub-1"}, now)

		if _, err := repo.SoftDeleteByUser(ctx, "sub-1", "usr_1", audit.DeleteByUser, now); err != nil {
			t.Fatal(err)
		}
		at, by := softDeleteStamp(t, db, "ord_stamp")
		if !by.Valid || by.String != string(audit.DeleteByUser) {
			t.Errorf("deleted_by = %v, want %q", by, audit.DeleteByUser)
		}
		if !at.Valid || !at.Time.Equal(now) {
			t.Errorf("deleted_at = %v, want the passed-in %s — never a second "+
				"time.Now(), which MySQL would ROUND to a different second", at, now)
		}
	})

	// The repository guards the row-selection point itself. The use case already
	// refuses empties, but this method is exported and the predicate is an OR:
	// an empty value would match every row carrying an empty string.
	t.Run("an empty identity never reaches the statement", func(t *testing.T) {
		truncateSoftDelete(t, db)
		// A row with an EMPTY user_id — exactly what an unguarded empty
		// identity would sweep.
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_empty", userID: "", cognitoSub: "sub-victim"}, now)

		for _, tc := range []struct{ sub, user string }{
			{"", "usr_1"}, {"sub-1", ""}, {"", ""},
		} {
			got, err := repo.SoftDeleteByUser(ctx, tc.sub, tc.user, audit.DeleteByUser, now)
			if err == nil {
				t.Errorf("SoftDeleteByUser(%q,%q) err = nil, want a refusal", tc.sub, tc.user)
			}
			if got != 0 {
				t.Errorf("SoftDeleteByUser(%q,%q) deleted = %d, want 0", tc.sub, tc.user, got)
			}
		}
		if !softDeleteIsLive(t, db, "ord_empty") {
			t.Fatal("an empty identity swept a row carrying an empty string — " +
				"someone else's data")
		}
	})
}

func TestSoftDeleteByTag(t *testing.T) {
	db := requireSoftDeleteMySQL(t)
	repo := mysql.NewSoftDeleteRepository(db)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	t.Run("JSON_CONTAINS matching, verified against the real server", func(t *testing.T) {
		cases := []struct {
			name  string
			tags  []string
			match bool
		}{
			{"exact single tag", []string{"E2E Source"}, true},
			{"among others", []string{"x", "E2E Source"}, true},
			{"empty array", []string{}, false},
			{"other tag only", []string{"other"}, false},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				truncateSoftDelete(t, db)
				seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_tag", userID: "usr_1", cognitoSub: "sub-1",
					tags: tc.tags}, now)

				got, err := repo.SoftDeleteByTag(ctx, domain.E2ESourceTag, audit.E2ECleanup, now)
				if err != nil {
					t.Fatal(err)
				}
				want := int64(0)
				if tc.match {
					want = 1
				}
				if got != want {
					t.Errorf("deleted = %d, want %d for tags %v", got, want, tc.tags)
				}
			})
		}
	})

	t.Run("an untagged row created by a real user is untouchable", func(t *testing.T) {
		truncateSoftDelete(t, db)
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_real", userID: "usr_1", cognitoSub: "sub-1",
			historyStatuses: []domain.Status{domain.StatusPlaced}}, now)

		if _, err := repo.SoftDeleteByTag(ctx, domain.E2ESourceTag, audit.E2ECleanup, now); err != nil {
			t.Fatal(err)
		}
		if !softDeleteIsLive(t, db, "ord_real") {
			t.Fatal("an untagged row was deleted by the e2e cleanup")
		}
		if n := softDeleteLiveHistoryCount(t, db, "ord_real"); n != 1 {
			t.Fatalf("live history = %d, want 1 — an untagged row's history is "+
				"untouchable too", n)
		}
	})

	t.Run("the tagged row's history is swept through the FK", func(t *testing.T) {
		truncateSoftDelete(t, db)
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_tagged", userID: "usr_1", cognitoSub: "sub-1",
			tags:            []string{domain.E2ESourceTag},
			historyStatuses: []domain.Status{domain.StatusPlaced, domain.StatusProcessing}}, now)

		got, err := repo.SoftDeleteByTag(ctx, domain.E2ESourceTag, audit.E2ECleanup, now)
		if err != nil {
			t.Fatal(err)
		}
		if got != 1 {
			t.Fatalf("deleted = %d, want 1 — the count is the PARENT rowcount", got)
		}
		if n := softDeleteLiveHistoryCount(t, db, "ord_tagged"); n != 0 {
			t.Errorf("%d history rows left live under a deleted tracking", n)
		}
	})

	// tracking_history carries no tags column, deliberately, so the children are
	// selected THROUGH the FK. A partial previous run leaves live history under
	// an already-stamped parent, and it must still be swept.
	t.Run("live history under an ALREADY-deleted tagged tracking is still swept", func(t *testing.T) {
		truncateSoftDelete(t, db)
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_tag_partial", userID: "usr_1", cognitoSub: "sub-1",
			tags: []string{domain.E2ESourceTag}, deleted: true,
			historyStatuses: []domain.Status{domain.StatusPlaced, domain.StatusProcessing}}, now)

		if _, err := repo.SoftDeleteByTag(ctx, domain.E2ESourceTag, audit.E2ECleanup, now); err != nil {
			t.Fatal(err)
		}
		if n := softDeleteLiveHistoryCount(t, db, "ord_tag_partial"); n != 0 {
			t.Fatalf("%d history rows left live — the parent-id subquery must NOT "+
				"be filtered on deleted_at IS NULL", n)
		}
	})

	t.Run("idempotent: a second call stamps nothing", func(t *testing.T) {
		truncateSoftDelete(t, db)
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_tag_i", userID: "usr_1", cognitoSub: "sub-1",
			tags: []string{domain.E2ESourceTag}}, now)

		if _, err := repo.SoftDeleteByTag(ctx, domain.E2ESourceTag, audit.E2ECleanup, now); err != nil {
			t.Fatal(err)
		}
		second, err := repo.SoftDeleteByTag(ctx, domain.E2ESourceTag, audit.E2ECleanup, now)
		if err != nil {
			t.Fatal(err)
		}
		if second != 0 {
			t.Errorf("second call deleted = %d, want 0", second)
		}
	})

	t.Run("stamps the harness's own actor", func(t *testing.T) {
		truncateSoftDelete(t, db)
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_tag_actor", userID: "usr_1", cognitoSub: "sub-1",
			tags: []string{domain.E2ESourceTag}}, now)

		if _, err := repo.SoftDeleteByTag(ctx, domain.E2ESourceTag, audit.E2ECleanup, now); err != nil {
			t.Fatal(err)
		}
		_, by := softDeleteStamp(t, db, "ord_tag_actor")
		if !by.Valid || by.String != string(audit.E2ECleanup) {
			t.Errorf("deleted_by = %v, want %q — a row the harness swept must stay "+
				"distinguishable from one a real flow removed", by, audit.E2ECleanup)
		}
	})

	// The tag is a case-sensitive literal shared verbatim with Users. A near-miss
	// must clean up nothing rather than quietly matching.
	t.Run("the tag literal is matched exactly", func(t *testing.T) {
		truncateSoftDelete(t, db)
		seedSoftDelete(t, db, softDeleteSeedRow{orderID: "ord_case_tag", userID: "usr_1", cognitoSub: "sub-1",
			tags: []string{domain.E2ESourceTag}}, now)

		got, err := repo.SoftDeleteByTag(ctx, "e2e-source", audit.E2ECleanup, now)
		if err != nil {
			t.Fatal(err)
		}
		if got != 0 {
			t.Errorf("deleted = %d, want 0 — %q is not the tag", got, "e2e-source")
		}
	})

	t.Run("a tag containing a quote character stays a bound parameter", func(t *testing.T) {
		truncateSoftDelete(t, db)
		// Not an injection test so much as a proof the JSON is built in SQL:
		// string-building it in Go would put this straight into the statement.
		if _, err := repo.SoftDeleteByTag(ctx, `E2E" or "1`, audit.E2ECleanup, now); err != nil {
			t.Fatalf("a quoted tag broke the statement: %v", err)
		}
	})
}
