package mysql

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// StatusRepository is the write side of a status transition: the UNSCOPED lookup
// the carrier webhook needs, and the transactional advance both it and TestMode
// progression share.
//
// It holds a *sql.DB rather than a *Queries because ApplyTransition spans THREE
// statements that must be one unit of work — the parent UPDATE, the history
// INSERT, and the re-read that the caller's 200 body and published event are
// built from.
type StatusRepository struct {
	db *sql.DB
}

// NewStatusRepository wires the repository over an open pool.
func NewStatusRepository(db *sql.DB) *StatusRepository {
	return &StatusRepository{db: db}
}

// GetByOrderID finds a LIVE tracking by order_id ALONE.
//
// # UNSCOPED, and a SEPARATE METHOD from the reads' scoped lookup
//
// The carrier webhook carries no caller identity: its gateway route declares no
// Cognito authorizer, so no x-user-id ever reaches the service. There is nothing
// to scope by, and applying the reads' cognito_sub filter here would compare a
// value that was never sent against every row — 404ing EVERY carrier call while
// looking perfectly implemented.
//
// It is a different METHOD rather than the scoped one called with an empty
// argument, because Go's zero value for string is "" and not nil: an
// optional-parameter shape silently turns "unscoped" into "scoped to the empty
// string", which matches only rows whose cognito_sub is the empty string.
//
// sql.ErrNoRows is translated HERE, at the adapter boundary. Leaking it would
// force the handler to import database/sql to tell "no such order" from a real
// failure, or to answer 500 for a missing tracking.
//
// # Why this scans by hand instead of calling the generated GetTrackingByOrderID
//
// shipping_address is a NULLABLE JSON column and sqlc types it json.RawMessage.
// json.RawMessage is a []byte alias with NO sql.Scanner, and database/sql cannot
// store a NULL into a *json.RawMessage — it fails with
//
//	unsupported Scan, storing driver.Value type <nil> into type *json.RawMessage
//
// which is a RUNTIME error on every row whose address is NULL, not a build one.
// Scanning into a plain []byte accepts NULL (yielding nil) and is byte-identical
// otherwise. Verified against the live MySQL 8 on 2026-08-27; a mocked repository
// test would have passed with the generated row and shipped the failure.
//
// The column list is written out rather than SELECT *, and `datetime` is
// BACKTICKED and aliased: it is also a MySQL type keyword, so an unbackticked
// reference is a syntax error reported at an unhelpful location.
func (r *StatusRepository) GetByOrderID(ctx context.Context, orderID string) (domain.Tracking, error) {
	const query = "SELECT\n" +
		"  id, user_id, order_id, status, shipping_address,\n" +
		"  `datetime` AS occurred_at,\n" +
		"  created_by, created_at, updated_by, updated_at,\n" +
		"  deleted_by, deleted_at, cognito_sub, tags, tracking_number\n" +
		"FROM tracking\n" +
		"WHERE order_id = ?\n" +
		// Soft delete: the application never issues DELETE, and every read
		// filters the tombstones out.
		"  AND deleted_at IS NULL"

	var (
		row     Tracking
		address []byte
	)
	err := r.db.QueryRowContext(ctx, query, orderID).Scan(
		&row.ID,
		&row.UserID,
		&row.OrderID,
		&row.Status,
		&address,
		&row.Datetime,
		&row.CreatedBy,
		&row.CreatedAt,
		&row.UpdatedBy,
		&row.UpdatedAt,
		&row.DeletedBy,
		&row.DeletedAt,
		&row.CognitoSub,
		&row.Tags,
		&row.TrackingNumber,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Tracking{}, fmt.Errorf("%w for order_id %s", domain.ErrTrackingNotFound, orderID)
	}
	if err != nil {
		return domain.Tracking{}, fmt.Errorf("mysql: get tracking by order_id: %w", err)
	}

	return domain.Tracking{
		ID:             row.ID,
		UserID:         row.UserID,
		CognitoSub:     row.CognitoSub.String,
		OrderID:        row.OrderID,
		TrackingNumber: row.TrackingNumber,
		Status:         domain.Status(row.Status),
		// nil when the column is NULL, never an empty non-nil slice: the
		// publisher's omit-vs-send decision is an explicit nil check, and "no
		// address" must not travel as an empty value.
		ShippingAddress: address,
		Tags:            row.Tags,
		Datetime:        row.Datetime,
		CreatedBy:       row.CreatedBy.String,
		CreatedAt:       row.CreatedAt,
		UpdatedBy:       row.UpdatedBy.String,
		UpdatedAt:       row.UpdatedAt,
		DeletedBy:       row.DeletedBy.String,
		DeletedAt:       nullTimePtr(row.DeletedAt),
	}, nil
}

// ApplyTransition advances the parent, appends the history row, and RE-READS the
// history — all in ONE transaction, all stamped from the single `now` the use
// case minted.
//
// # Why the re-read is inside this method
//
// A caller holding the history it loaded before the append has no way to know
// that slice is now stale, and publishing it produces an event that announces a
// transition its own history does not contain. The Python service expires that
// collection explicitly for this reason. Making the re-read part of THIS
// method's contract removes the opportunity to get it wrong.
//
// The re-read runs INSIDE the transaction, before the commit: it sees this
// transaction's own uncommitted INSERT (which a post-commit SELECT would also
// see, but only after a second round trip and a window in which a concurrent
// transition could add a row this call never wrote).
//
// # Why the parent UPDATE and the history INSERT must share a transaction
//
// tracking_history's composite primary key (tracking_id, status) rejects a
// duplicate transition at INSERT — a second enforcement of the forward-only
// machine, independent of the application guard. Outside a transaction, a
// rejected INSERT would leave the parent already advanced: a tracking reporting
// a status with no transition recorded behind it.
//
// # The identities are copied from the PARENT ROW
//
// user_id and cognito_sub on the history row come off `t`, never off a request.
// The carrier sends neither, and the TestMode progression runs on a timer with
// no request behind it at all.
func (r *StatusRepository) ApplyTransition(
	ctx context.Context,
	t domain.Tracking,
	to domain.Status,
	actor audit.Actor,
	now time.Time,
) (result domain.TrackingWithHistory, err error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.TrackingWithHistory{}, fmt.Errorf("mysql: begin: %w", err)
	}
	// Rollback on EVERY path that is not an explicit Commit, panics included.
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	queries := New(tx)
	stamp := sql.NullString{String: string(actor), Valid: actor != ""}
	// "" means absent, and absent must be NULL rather than the empty string: a
	// row carrying cognito_sub = '' would be matched by any read scoped to the
	// empty string, whereas NULL matches no caller's sub.
	cognitoSub := sql.NullString{String: t.CognitoSub, Valid: t.CognitoSub != ""}

	// The parent first. The statement is guarded on deleted_at IS NULL, so a
	// soft-deleted tracking reached with a stale entity matches nothing and is
	// reported as missing rather than silently resurrected.
	affected, err := queries.UpdateTrackingStatus(ctx, UpdateTrackingStatusParams{
		Status:   string(to),
		Datetime: now,
		// `datetime` and updated_at are BOTH set from the same minted now, and
		// they are distinct columns on purpose: `datetime` is the timestamp of
		// the CURRENT STATUS and moves only on a transition, while updated_at
		// moves on any write.
		UpdatedBy: stamp,
		UpdatedAt: now,
		OrderID:   t.OrderID,
	})
	if err != nil {
		err = fmt.Errorf("mysql: update tracking status: %w", err)
		return domain.TrackingWithHistory{}, err
	}
	if affected == 0 {
		err = fmt.Errorf("%w for order_id %s", domain.ErrTrackingNotFound, t.OrderID)
		return domain.TrackingWithHistory{}, err
	}

	if err = queries.CreateTrackingHistory(ctx, CreateTrackingHistoryParams{
		TrackingID: t.ID,
		Status:     string(to),
		UserID:     t.UserID,
		OrderID:    t.OrderID,
		Datetime:   now,
		CreatedBy:  stamp,
		CreatedAt:  now,
		UpdatedBy:  stamp,
		UpdatedAt:  now,
		CognitoSub: cognitoSub,
	}); err != nil {
		err = fmt.Errorf("mysql: insert tracking history: %w", err)
		return domain.TrackingWithHistory{}, err
	}

	// THE RE-READ. It happens after the append and before the commit, so the
	// slice returned contains the transition being announced.
	//
	// The query's ORDER BY carries the FIELD() tiebreaker: DATETIME here has
	// fsp 0, and every row a single unit of work writes is stamped from one
	// `now`, so ties are the normal case. On a tie MySQL is free to return
	// primary-key order, which for (tracking_id, status) is ALPHABETICAL —
	// DELIVERED before PLACED, a shipment delivered before it was placed.
	rows, err := queries.ListTrackingHistory(ctx, t.ID)
	if err != nil {
		err = fmt.Errorf("mysql: re-read tracking history: %w", err)
		return domain.TrackingWithHistory{}, err
	}

	if err = tx.Commit(); err != nil {
		err = fmt.Errorf("mysql: commit: %w", err)
		return domain.TrackingWithHistory{}, err
	}

	history := make([]domain.TrackingHistory, 0, len(rows))
	for _, row := range rows {
		history = append(history, domain.TrackingHistory{
			TrackingID: row.TrackingID,
			Status:     domain.Status(row.Status),
			UserID:     row.UserID,
			OrderID:    row.OrderID,
			CognitoSub: row.CognitoSub.String,
			Datetime:   row.OccurredAt,
			CreatedBy:  row.CreatedBy.String,
			CreatedAt:  row.CreatedAt,
			UpdatedBy:  row.UpdatedBy.String,
			UpdatedAt:  row.UpdatedAt,
			DeletedBy:  row.DeletedBy.String,
			DeletedAt:  nullTimePtr(row.DeletedAt),
		})
	}
	// The SQL already orders correctly; applying the domain rule as well keeps
	// this value ordered by ONE definition of "in order" whatever produced it.
	domain.SortHistory(history)

	// The parent is built from what was just written rather than re-selected: a
	// second SELECT would cost a round trip to learn what this function already
	// knows, and could race a concurrent transition into returning a status this
	// call never wrote.
	updated := t
	updated.Status = to
	updated.Datetime = now
	updated.UpdatedBy = string(actor)
	updated.UpdatedAt = now
	updated.History = history

	return domain.TrackingWithHistory{Tracking: updated, History: history}, nil
}

// nullTimePtr converts a nullable DATETIME into the domain's pointer form. nil
// means the row is LIVE; the domain never carries a zero time meaning "not
// deleted", because a zero time is a real instant and would compare equal to
// itself.
func nullTimePtr(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	at := value.Time
	return &at
}
