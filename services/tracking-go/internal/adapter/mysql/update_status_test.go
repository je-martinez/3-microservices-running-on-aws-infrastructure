package mysql_test

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	repomysql "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// REAL MySQL, never a mock. A mocked repository test passes against a schema
// that does not exist: it cannot catch a column narrower than the value written,
// a DATETIME that rounds a fractional second forward, or a composite primary key
// rejecting a duplicate transition. All three are behaviours this file asserts.
//
// requireMySQL and deleteOrders are shared with the creation suite in this same
// test package; the seeding helper below is named transitionSeed so the suites
// can coexist without colliding.

// transitionCleanup removes this suite's rows from a t.Cleanup.
//
// It uses a FRESH context rather than t.Context(): Go cancels a test's context
// BEFORE its registered cleanups run, so a cleanup issuing queries on it fails
// with "context canceled" and leaves the rows behind for the next run to collide
// with on uq_tracking_order_id.
func transitionCleanup(t *testing.T, db *sql.DB, orderIDs ...string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(t.Context()), 10*time.Second)
	defer cancel()
	for _, orderID := range orderIDs {
		if _, err := db.ExecContext(ctx,
			`DELETE h FROM tracking_history h JOIN tracking t ON t.id = h.tracking_id
			 WHERE t.order_id = ?`, orderID); err != nil {
			t.Errorf("cleanup history for %s: %v", orderID, err)
		}
		if _, err := db.ExecContext(ctx,
			`DELETE FROM tracking WHERE order_id = ?`, orderID); err != nil {
			t.Errorf("cleanup tracking for %s: %v", orderID, err)
		}
	}
}

// transitionSeed inserts one tracking plus one history row directly, so this
// suite does not depend on the creation repository another task owns.
func transitionSeed(t *testing.T, db *sql.DB, orderID, trackingID, userID, cognitoSub string, status domain.Status, at time.Time) {
	t.Helper()
	if _, err := db.ExecContext(t.Context(), `
		INSERT INTO tracking (
		  id, user_id, order_id, status, `+"`datetime`"+`,
		  created_by, created_at, updated_by, updated_at, cognito_sub, tags, tracking_number
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, JSON_ARRAY(), ?)`,
		trackingID, userID, orderID, string(status), at,
		string(audit.CreateTracking), at, string(audit.CreateTracking), at, cognitoSub,
		// Derived from the ORDER id, not the tracking id: the tracking ids in
		// this suite share a common prefix and would collide on
		// uq_tracking_tracking_number.
		"3MRAI-"+orderID[len(orderID)-12:],
	); err != nil {
		t.Fatalf("seed tracking: %v", err)
	}
	if _, err := db.ExecContext(t.Context(), `
		INSERT INTO tracking_history (
		  tracking_id, status, user_id, order_id, `+"`datetime`"+`,
		  created_by, created_at, updated_by, updated_at, cognito_sub
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		trackingID, string(status), userID, orderID, at,
		string(audit.CreateTracking), at, string(audit.CreateTracking), at, cognitoSub,
	); err != nil {
		t.Fatalf("seed history: %v", err)
	}
}

func TestGetByOrderIDIsUnscoped(t *testing.T) {
	db := requireMySQL(t)
	repo := repomysql.NewStatusRepository(db)
	ctx := t.Context()

	const orderID = "ord_go_unscoped_1"
	deleteOrders(t, db, orderID)
	t.Cleanup(func() { transitionCleanup(t, db, orderID) })

	// TWO DIFFERENT identity values. A fixture reusing one string for both
	// cannot fail on the cognito_sub/user_id confusion.
	transitionSeed(t, db, orderID, "trk_go_unscoped_00000000001",
		"usr_owner_1", "sub-owner-1", domain.StatusPlaced, time.Now().UTC().Truncate(time.Second))

	got, err := repo.GetByOrderID(ctx, orderID)
	if err != nil {
		t.Fatalf("GetByOrderID: %v — the carrier webhook sends no caller identity, "+
			"so this read must find the row by order_id ALONE", err)
	}
	if got.OrderID != orderID {
		t.Errorf("order_id = %q, want %q", got.OrderID, orderID)
	}
	if got.CognitoSub != "sub-owner-1" || got.UserID != "usr_owner_1" {
		t.Errorf("identities = (%q, %q), want (sub-owner-1, usr_owner_1) — both must "+
			"come off the row so the post-commit invalidation has a source",
			got.CognitoSub, got.UserID)
	}
	if got.Status != domain.StatusPlaced {
		t.Errorf("status = %q, want PLACED", got.Status)
	}
}

func TestGetByOrderIDMissingIsErrTrackingNotFound(t *testing.T) {
	db := requireMySQL(t)
	repo := repomysql.NewStatusRepository(db)

	// sql.ErrNoRows must be translated at the adapter boundary. Leaking it would
	// make the handler either import database/sql or answer 500 for an order
	// that simply has no tracking.
	if _, err := repo.GetByOrderID(t.Context(), "ord_go_definitely_absent"); !errors.Is(err, domain.ErrTrackingNotFound) {
		t.Fatalf("err = %v, want domain.ErrTrackingNotFound", err)
	}
}

func TestApplyTransition(t *testing.T) {
	db := requireMySQL(t)
	repo := repomysql.NewStatusRepository(db)
	ctx := t.Context()

	t.Run("writes the parent and the history row from ONE now", func(t *testing.T) {
		const orderID = "ord_go_apply_1"
		deleteOrders(t, db, orderID)
		t.Cleanup(func() { transitionCleanup(t, db, orderID) })

		seededAt := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
		transitionSeed(t, db, orderID, "trk_go_apply_000000000001",
			"usr_apply_1", "sub-apply-1", domain.StatusPlaced, seededAt)

		current, err := repo.GetByOrderID(ctx, orderID)
		if err != nil {
			t.Fatal(err)
		}

		now := time.Now().UTC().Truncate(time.Second)
		got, err := repo.ApplyTransition(ctx, current, domain.StatusShipped, audit.CarrierStatusUpdate, now)
		if err != nil {
			t.Fatalf("ApplyTransition: %v", err)
		}

		if got.Tracking.Status != domain.StatusShipped {
			t.Errorf("status = %q, want SHIPPED", got.Tracking.Status)
		}
		// Truncated, not rounded: this column has fsp 0 and MySQL ROUNDS a
		// fractional second forward, so an untruncated now persists one second
		// ahead of the value reported on the wire.
		if !got.Tracking.Datetime.Equal(now) {
			t.Errorf("tracking.datetime = %v, want the minted now %v", got.Tracking.Datetime, now)
		}
		if got.Tracking.UpdatedBy != string(audit.CarrierStatusUpdate) {
			t.Errorf("updated_by = %q, want %q", got.Tracking.UpdatedBy, audit.CarrierStatusUpdate)
		}

		// The re-read: the returned history ENDS with the transition just made.
		if len(got.History) != 2 {
			t.Fatalf("history rows = %d, want 2 (PLACED + SHIPPED)", len(got.History))
		}
		last := got.History[len(got.History)-1]
		if last.Status != domain.StatusShipped {
			t.Fatalf("history = %v — ApplyTransition must RE-READ after the append, "+
				"or the event omits the very transition it announces", got.History)
		}
		if !last.Datetime.Equal(now) {
			t.Errorf("history.datetime = %v, want the same minted now %v", last.Datetime, now)
		}
		if last.CreatedBy != string(audit.CarrierStatusUpdate) {
			t.Errorf("history.created_by = %q, want %q", last.CreatedBy, audit.CarrierStatusUpdate)
		}
		if last.CognitoSub != "sub-apply-1" || last.UserID != "usr_apply_1" {
			t.Errorf("history identities = (%q, %q), want (sub-apply-1, usr_apply_1) — "+
				"copied from the parent row, not from a request that carries none",
				last.CognitoSub, last.UserID)
		}

		// And what is actually PERSISTED matches what was returned.
		var persisted string
		if err := db.QueryRowContext(ctx,
			"SELECT status FROM tracking WHERE order_id = ?", orderID).Scan(&persisted); err != nil {
			t.Fatal(err)
		}
		if persisted != string(domain.StatusShipped) {
			t.Errorf("persisted status = %q, want SHIPPED", persisted)
		}
	})

	t.Run("the actor travels: a test-mode row stays identifiable afterwards", func(t *testing.T) {
		const orderID = "ord_go_apply_actor"
		deleteOrders(t, db, orderID)
		t.Cleanup(func() { transitionCleanup(t, db, orderID) })

		now := time.Now().UTC().Truncate(time.Second)
		transitionSeed(t, db, orderID, "trk_go_applyactor_00000001",
			"usr_actor_1", "sub-actor-1", domain.StatusPlaced, now)

		current, err := repo.GetByOrderID(ctx, orderID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.ApplyTransition(ctx, current, domain.StatusProcessing, audit.TestModeProgression, now); err != nil {
			t.Fatal(err)
		}

		var createdBy string
		if err := db.QueryRowContext(ctx,
			"SELECT created_by FROM tracking_history WHERE tracking_id = ? AND status = ?",
			current.ID, string(domain.StatusProcessing)).Scan(&createdBy); err != nil {
			t.Fatal(err)
		}
		if createdBy != string(audit.TestModeProgression) {
			t.Errorf("created_by = %q, want %q — an automatic run must not be "+
				"indistinguishable from a real carrier update", createdBy, audit.TestModeProgression)
		}
	})

	t.Run("both writes land, or NEITHER does", func(t *testing.T) {
		// The composite PK (tracking_id, status) rejects a duplicate transition
		// at INSERT. If the parent UPDATE were not in the same transaction, the
		// status would advance while its history row was rejected — a tracking
		// reporting a status with no transition behind it.
		const orderID = "ord_go_apply_atomic"
		deleteOrders(t, db, orderID)
		t.Cleanup(func() { transitionCleanup(t, db, orderID) })

		now := time.Now().UTC().Truncate(time.Second)
		transitionSeed(t, db, orderID, "trk_go_applyatomic_0000001",
			"usr_atomic_1", "sub-atomic-1", domain.StatusPlaced, now)

		current, err := repo.GetByOrderID(ctx, orderID)
		if err != nil {
			t.Fatal(err)
		}
		// PLACED -> PLACED: the application guard would reject this, but the
		// repository is being exercised directly to prove the rollback.
		if _, err := repo.ApplyTransition(ctx, current, domain.StatusPlaced, audit.CarrierStatusUpdate, now); err == nil {
			t.Fatal("a duplicate history row was accepted; the composite PK must reject it")
		}

		var status string
		var updatedBy sql.NullString
		if err := db.QueryRowContext(ctx,
			"SELECT status, updated_by FROM tracking WHERE order_id = ?", orderID).Scan(&status, &updatedBy); err != nil {
			t.Fatal(err)
		}
		if updatedBy.String == string(audit.CarrierStatusUpdate) {
			t.Error("the parent UPDATE survived a failed history INSERT — the two " +
				"must share one transaction")
		}
		if status != string(domain.StatusPlaced) {
			t.Errorf("status = %q, want the untouched PLACED", status)
		}
	})

	t.Run("history comes back in progression order even when the timestamps TIE", func(t *testing.T) {
		// DATETIME has fsp 0, and one unit of work stamps every row it writes
		// from a single now, so ties are the normal case rather than the corner
		// one. On a tie MySQL may return primary-key order, which for
		// (tracking_id, status) is ALPHABETICAL — DELIVERED first, i.e. a
		// shipment delivered before it was placed.
		const orderID = "ord_go_apply_order"
		deleteOrders(t, db, orderID)
		t.Cleanup(func() { transitionCleanup(t, db, orderID) })

		now := time.Now().UTC().Truncate(time.Second)
		transitionSeed(t, db, orderID, "trk_go_applyorder_00000001",
			"usr_order_1", "sub-order-1", domain.StatusPlaced, now)

		current, err := repo.GetByOrderID(ctx, orderID)
		if err != nil {
			t.Fatal(err)
		}
		// Every transition stamped with the SAME now, so all five rows tie.
		var history []domain.TrackingHistory
		for _, next := range []domain.Status{
			domain.StatusProcessing, domain.StatusShipped,
			domain.StatusOutForDelivery, domain.StatusDelivered,
		} {
			got, err := repo.ApplyTransition(ctx, current, next, audit.TestModeProgression, now)
			if err != nil {
				t.Fatalf("ApplyTransition(%s): %v", next, err)
			}
			current = got.Tracking
			history = got.History
		}

		// The value asserted on is the LAST ApplyTransition's OWN re-read: that
		// is the slice the 200 body and the published event are built from.
		want := []domain.Status{
			domain.StatusPlaced, domain.StatusProcessing, domain.StatusShipped,
			domain.StatusOutForDelivery, domain.StatusDelivered,
		}
		if len(history) != len(want) {
			t.Fatalf("history rows = %d, want %d", len(history), len(want))
		}
		for i, status := range want {
			if history[i].Status != status {
				t.Fatalf("history[%d] = %q, want %q — on a datetime TIE the order "+
					"must be progression position, never the alphabetical primary-key "+
					"order MySQL is free to return (full: %v)",
					i, history[i].Status, status, history)
			}
		}
	})

	t.Run("a soft-deleted tracking cannot be advanced", func(t *testing.T) {
		const orderID = "ord_go_apply_deleted"
		deleteOrders(t, db, orderID)
		t.Cleanup(func() { transitionCleanup(t, db, orderID) })

		now := time.Now().UTC().Truncate(time.Second)
		transitionSeed(t, db, orderID, "trk_go_applydeleted_000001",
			"usr_del_1", "sub-del-1", domain.StatusPlaced, now)

		current, err := repo.GetByOrderID(ctx, orderID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx,
			"UPDATE tracking SET deleted_at = ?, deleted_by = ? WHERE order_id = ?",
			now, string(audit.DeleteByUser), orderID); err != nil {
			t.Fatal(err)
		}

		// The read no longer finds it at all.
		if _, err := repo.GetByOrderID(ctx, orderID); !errors.Is(err, domain.ErrTrackingNotFound) {
			t.Errorf("GetByOrderID on a deleted row err = %v, want ErrTrackingNotFound", err)
		}
		// And the write, reached with a stale entity, must not resurrect it.
		if _, err := repo.ApplyTransition(ctx, current, domain.StatusShipped, audit.CarrierStatusUpdate, now); !errors.Is(err, domain.ErrTrackingNotFound) {
			t.Errorf("ApplyTransition on a deleted row err = %v, want ErrTrackingNotFound — "+
				"the UPDATE is guarded on deleted_at IS NULL and matches nothing", err)
		}
	})
}

// Compile-time proof that the repository satisfies the use case's port. If the
// port and the adapter drift, this fails at build time rather than at wiring.
var _ interface {
	GetByOrderID(ctx context.Context, orderID string) (domain.Tracking, error)
	ApplyTransition(ctx context.Context, t domain.Tracking, to domain.Status, actor audit.Actor, now time.Time) (domain.TrackingWithHistory, error)
} = (*repomysql.StatusRepository)(nil)
