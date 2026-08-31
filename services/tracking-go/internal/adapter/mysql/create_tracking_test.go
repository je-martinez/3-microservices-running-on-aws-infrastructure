package mysql_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"

	adaptermysql "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/config"
)

// requireMySQL opens the REAL database, or skips with a message naming what is
// missing.
//
// No mocks here, deliberately. A mocked repository test passes while the real
// schema rejects the write — a documented lesson in this repo. The unique-index
// translation below is precisely the behaviour a mock cannot exercise: only the
// server can produce error 1062.
func requireMySQL(t *testing.T) *sql.DB {
	t.Helper()
	raw := os.Getenv("TRACKING_DATABASE_URL")
	if raw == "" {
		t.Skip("TRACKING_DATABASE_URL is unset; set it to the tracking MySQL DSN " +
			"(e.g. mysql://test:test@127.0.0.1:7002/tracking) to run the repository tests")
	}
	dsn, err := config.MySQLDSN(raw)
	if err != nil {
		t.Fatalf("TRACKING_DATABASE_URL is not a usable DSN: %v", err)
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("ping mysql: %v", err)
	}
	return db
}

// deleteOrders removes the rows a test created. A hard DELETE, unlike anything
// the application does: the test owns these rows and a soft delete would leave
// the unique index occupied for the next run.
//
// It uses a FRESH context, deliberately not t.Context(): the test context is
// cancelled before t.Cleanup runs, so a cleanup using it fails with "context
// canceled" and leaves the rows behind for the next run to collide with.
func deleteOrders(t *testing.T, db *sql.DB, orderIDs ...string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, orderID := range orderIDs {
		if _, err := db.ExecContext(ctx,
			`DELETE h FROM tracking_history h JOIN tracking t ON t.id = h.tracking_id
			 WHERE t.order_id = ?`, orderID); err != nil {
			t.Fatalf("cleanup history for %s: %v", orderID, err)
		}
		// Any orphan history rows the tests deliberately created (see the
		// orphan-history case) have no tracking row to join through.
		if _, err := db.ExecContext(ctx,
			`DELETE FROM tracking_history WHERE order_id = ?`, orderID); err != nil {
			t.Fatalf("cleanup orphan history for %s: %v", orderID, err)
		}
		if _, err := db.ExecContext(ctx,
			`DELETE FROM tracking WHERE order_id = ?`, orderID); err != nil {
			t.Fatalf("cleanup tracking for %s: %v", orderID, err)
		}
	}
}

func TestCreateWritesBothRowsFromOneNow(t *testing.T) {
	db := requireMySQL(t)
	repo := adaptermysql.NewTrackingRepository(db)
	ctx := t.Context()

	const orderID = "ord_go_create_1"
	deleteOrders(t, db, orderID)
	t.Cleanup(func() { deleteOrders(t, db, orderID) })

	now := time.Now().UTC().Truncate(time.Second)
	got, err := repo.Create(ctx, domain.NewTracking{
		OrderID: orderID,
		// Two DIFFERENT values, so a swap of the two columns is detectable.
		UserID:          "usr_internal_create",
		CognitoSub:      "sub-create-abc-123",
		ShippingAddress: []byte(`{"street":"a","future_field":{"deep":1}}`),
		Tags:            []string{domain.E2ESourceTag},
	}, now)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if len(got.History) != 1 {
		t.Fatalf("history rows = %d, want exactly 1", len(got.History))
	}
	if !got.Tracking.Datetime.Equal(now) || !got.History[0].Datetime.Equal(now) {
		t.Errorf("tracking=%v history=%v — both rows must carry the SAME minted now %v",
			got.Tracking.Datetime, got.History[0].Datetime, now)
	}
	if got.Tracking.CreatedBy != string(audit.CreateTracking) {
		t.Errorf("created_by = %q, want %q", got.Tracking.CreatedBy, audit.CreateTracking)
	}
	if got.Tracking.Status != domain.StatusPlaced || got.History[0].Status != domain.StatusPlaced {
		t.Errorf("status = %q/%q, want PLACED on both rows",
			got.Tracking.Status, got.History[0].Status)
	}
	if len(got.Tracking.ID) != domain.IDLength ||
		got.Tracking.ID[:len(domain.TrackingPrefix)] != domain.TrackingPrefix {
		t.Errorf("id = %q, want a %d-char trk_ id", got.Tracking.ID, domain.IDLength)
	}
	if len(got.Tracking.TrackingNumber) != domain.TrackingNumberLength {
		t.Errorf("tracking_number = %q, want %d characters",
			got.Tracking.TrackingNumber, domain.TrackingNumberLength)
	}
	if got.History[0].TrackingID != got.Tracking.ID {
		t.Errorf("history tracking_id = %q, want %q",
			got.History[0].TrackingID, got.Tracking.ID)
	}

	// Read the row back through the driver: what the repository returned in
	// memory is not evidence of what MySQL stored.
	var (
		userID     string
		cognitoSub sql.NullString
		occurredAt time.Time
		createdAt  time.Time
		updatedAt  time.Time
		address    []byte
		tags       string
	)
	if err := db.QueryRowContext(ctx,
		"SELECT user_id, cognito_sub, `datetime`, created_at, updated_at, shipping_address, tags "+
			"FROM tracking WHERE order_id = ?", orderID,
	).Scan(&userID, &cognitoSub, &occurredAt, &createdAt, &updatedAt, &address, &tags); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !createdAt.Equal(now) || !updatedAt.Equal(now) {
		t.Errorf("stored created_at=%v updated_at=%v, want the single minted now %v",
			createdAt, updatedAt, now)
	}
	if userID != "usr_internal_create" {
		t.Errorf("stored user_id = %q, want the internal usr_ id", userID)
	}
	if cognitoSub.String != "sub-create-abc-123" {
		t.Errorf("stored cognito_sub = %q, want the header sub verbatim", cognitoSub.String)
	}
	if !occurredAt.Equal(now) {
		// MySQL DATETIME here has fsp 0 and ROUNDS rather than truncates, so an
		// untruncated `now` lands on the NEXT second.
		t.Errorf("stored datetime = %v, want %v", occurredAt, now)
	}
	if string(address) == "" || string(address) == "null" {
		t.Errorf("shipping_address stored as %q, want the JSON object", address)
	}
	if tags != `["E2E Source"]` {
		t.Errorf("tags = %s, want [\"E2E Source\"]", tags)
	}

	// The HISTORY row's stamps, read back from the SERVER. Asserting only on the
	// value the repository returned proves nothing: that struct is built from
	// `now` in Go, so it agrees with itself even when the INSERT stamped something
	// else entirely.
	var (
		historyOccurredAt time.Time
		historyCreatedAt  time.Time
		historyCreatedBy  sql.NullString
		historyStatus     string
		historyCognitoSub sql.NullString
		historyUserID     string
		historyRows       int
	)
	if err := db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM tracking_history WHERE order_id = ?", orderID,
	).Scan(&historyRows); err != nil {
		t.Fatal(err)
	}
	if historyRows != 1 {
		t.Fatalf("%d history rows persisted, want exactly 1", historyRows)
	}
	if err := db.QueryRowContext(ctx,
		"SELECT `datetime`, created_at, created_by, status, cognito_sub, user_id "+
			"FROM tracking_history WHERE order_id = ?", orderID,
	).Scan(&historyOccurredAt, &historyCreatedAt, &historyCreatedBy, &historyStatus,
		&historyCognitoSub, &historyUserID); err != nil {
		t.Fatalf("read back history: %v", err)
	}
	if !historyOccurredAt.Equal(now) || !historyCreatedAt.Equal(now) {
		t.Errorf("stored history datetime=%v created_at=%v, want the SAME minted now %v "+
			"as the tracking row — two time.Now() calls can straddle a second boundary",
			historyOccurredAt, historyCreatedAt, now)
	}
	if !historyOccurredAt.Equal(occurredAt) {
		t.Errorf("the tracking (%v) and its opening history row (%v) were stamped "+
			"differently; both must come from ONE now", occurredAt, historyOccurredAt)
	}
	if historyCreatedBy.String != string(audit.CreateTracking) {
		t.Errorf("history created_by = %q, want %q", historyCreatedBy.String, audit.CreateTracking)
	}
	if historyStatus != string(domain.StatusPlaced) {
		t.Errorf("history status = %q, want PLACED", historyStatus)
	}
	if historyCognitoSub.String != "sub-create-abc-123" {
		t.Errorf("history cognito_sub = %q, want the header sub verbatim",
			historyCognitoSub.String)
	}
	if historyUserID != "usr_internal_create" {
		t.Errorf("history user_id = %q, want the internal usr_ id", historyUserID)
	}

	// The unique index adjudicates a duplicate; the repository must translate it.
	if _, err := repo.Create(ctx, domain.NewTracking{
		OrderID: orderID, UserID: "usr_internal_create",
	}, now); !errors.Is(err, domain.ErrTrackingAlreadyExists) {
		t.Fatalf("duplicate insert err = %v, want ErrTrackingAlreadyExists", err)
	}
}

func TestCreateRollsBackWhenTheHistoryRowFails(t *testing.T) {
	// A tracking without its opening history row is a shipment with no recorded
	// beginning: the reads would answer with an empty history, and the next
	// transition would compare against a status trail that does not exist. Only a
	// shared transaction can guarantee both rows or neither.
	//
	// The failure is injected by RENAMING tracking_history for the duration of the
	// call, so the FIRST insert succeeds and the SECOND cannot. That is the only
	// window a missing rollback leaves a parentless tracking in, and no
	// value-level trick reaches it: the two tables declare identical column
	// widths, so anything the history INSERT rejects the tracking INSERT rejects
	// first.
	db := requireMySQL(t)
	repo := adaptermysql.NewTrackingRepository(db)

	const orderID = "ord_go_create_atomic"
	deleteOrders(t, db, orderID)
	t.Cleanup(func() { deleteOrders(t, db, orderID) })

	rename := func(from, to string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := db.ExecContext(ctx,
			"RENAME TABLE "+from+" TO "+to); err != nil {
			t.Fatalf("rename %s to %s: %v", from, to, err)
		}
	}
	rename("tracking_history", "tracking_history_atomic_probe")
	t.Cleanup(func() { rename("tracking_history_atomic_probe", "tracking_history") })

	_, err := repo.Create(t.Context(), domain.NewTracking{
		OrderID: orderID, UserID: "usr_atomic", CognitoSub: "sub-atomic",
	}, time.Now().UTC().Truncate(time.Second))
	if err == nil {
		t.Fatal("the history INSERT could not fail; the probe did not take effect")
	}

	var count int
	if err := db.QueryRowContext(t.Context(),
		"SELECT COUNT(*) FROM tracking WHERE order_id = ?", orderID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("%d tracking rows survived a failed unit of work, want 0 — "+
			"both INSERTs must share ONE transaction", count)
	}
}

func TestExistsByOrderID(t *testing.T) {
	db := requireMySQL(t)
	repo := adaptermysql.NewTrackingRepository(db)
	ctx := t.Context()

	const orderID = "ord_go_exists_1"
	deleteOrders(t, db, orderID)
	t.Cleanup(func() { deleteOrders(t, db, orderID) })

	exists, err := repo.ExistsByOrderID(ctx, orderID)
	if err != nil {
		t.Fatalf("ExistsByOrderID: %v", err)
	}
	if exists {
		t.Fatal("reported an existing tracking for an order that has none")
	}

	if _, err := repo.Create(ctx, domain.NewTracking{
		OrderID: orderID, UserID: "usr_exists", CognitoSub: "sub-exists",
	}, time.Now().UTC().Truncate(time.Second)); err != nil {
		t.Fatalf("Create: %v", err)
	}

	exists, err = repo.ExistsByOrderID(ctx, orderID)
	if err != nil {
		t.Fatalf("ExistsByOrderID: %v", err)
	}
	if !exists {
		t.Fatal("the pre-check missed a tracking that exists; a retry would duplicate a shipment")
	}
}

func TestExistsByOrderIDSeesOrphanHistory(t *testing.T) {
	// The guard rejects an order that already has a tracking OR any history. A
	// soft-deleted tracking leaves live history behind, and re-creating over it
	// would collide on tracking_history's composite PK — or worse, attach a fresh
	// tracking to a status trail that is not its own.
	db := requireMySQL(t)
	repo := adaptermysql.NewTrackingRepository(db)
	ctx := t.Context()

	const orderID = "ord_go_exists_history"
	deleteOrders(t, db, orderID)
	t.Cleanup(func() { deleteOrders(t, db, orderID) })

	if _, err := repo.Create(ctx, domain.NewTracking{
		OrderID: orderID, UserID: "usr_hist", CognitoSub: "sub-hist",
	}, time.Now().UTC().Truncate(time.Second)); err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Soft-delete the tracking ONLY, leaving its history live.
	if _, err := db.ExecContext(ctx,
		"UPDATE tracking SET deleted_at = NOW(), deleted_by = 'test' WHERE order_id = ?",
		orderID); err != nil {
		t.Fatal(err)
	}

	exists, err := repo.ExistsByOrderID(ctx, orderID)
	if err != nil {
		t.Fatalf("ExistsByOrderID: %v", err)
	}
	if !exists {
		t.Fatal("live history for the order was not treated as an existing tracking")
	}
}
