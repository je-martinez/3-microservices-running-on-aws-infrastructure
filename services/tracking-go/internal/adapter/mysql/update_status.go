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

// StatusRepository is the write side of a status transition: the unscoped lookup
// the carrier webhook needs, and the transactional advance it shares with the
// TestMode progression. It holds a *sql.DB, not a *Queries, because
// ApplyTransition spans three statements that are one unit of work.
type StatusRepository struct {
	db *sql.DB
}

// NewStatusRepository wires the repository over an open pool.
func NewStatusRepository(db *sql.DB) *StatusRepository {
	return &StatusRepository{db: db}
}

// GetByOrderID finds a LIVE tracking by order_id ALONE.
//
// CONTRACT: Keep this UNSCOPED and a separate method from the scoped read. The
// carrier webhook's gateway route declares no authorizer, so no x-user-id ever
// arrives; applying the cognito_sub filter 404s every carrier call while looking
// implemented. A separate method, not an optional argument: Go's zero string is
// "", which silently means "scoped to the empty string".
// See [[user-id-vs-cognito-sub-ownership-key]]
//
// CONTRACT: Scan shipping_address into a plain []byte, not json.RawMessage —
// RawMessage is no sql.Scanner, so a NULL address fails at RUNTIME. Backtick
// `datetime`: it is a MySQL type keyword.
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
// history in ONE transaction, all stamped from the use case's single `now`.
//
// CONTRACT: The parent UPDATE and history INSERT share a transaction.
// tracking_history's (tracking_id, status) primary key rejects a duplicate
// transition, and outside a transaction that leaves the parent already advanced.
//
// CONTRACT: The re-read stays inside this method and the transaction — a caller
// reusing history loaded before the append announces a transition its own
// history omits. user_id and cognito_sub come off the parent row, never a
// request. See [[user-id-vs-cognito-sub-ownership-key]]
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

	// CONTRACT: Keep the FIELD() tiebreaker on this query's ORDER BY. DATETIME
	// here has fsp 0 and one unit of work stamps every row from one `now`, so
	// ties are normal; on a tie MySQL may return primary-key order, which is
	// alphabetical — DELIVERED before PLACED.
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
