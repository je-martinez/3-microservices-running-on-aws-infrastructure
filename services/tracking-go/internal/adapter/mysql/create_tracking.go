package mysql

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/go-sql-driver/mysql"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql/tagtype"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// duplicateEntryErrno is MySQL's ER_DUP_ENTRY. A unique-index rejection reaches
// the driver as a *mysql.MySQLError carrying this number; matching on the number
// rather than on the message keeps the translation working across server
// versions and locales, which a substring match on "Duplicate entry" would not.
const duplicateEntryErrno = 1062

// TrackingRepository is the write side of tracking creation.
//
// It holds a *sql.DB rather than a *Queries because Create spans TWO statements
// that must be one unit of work: a tracking without its opening history row is a
// shipment with no recorded beginning, and only a transaction can guarantee both
// or neither.
type TrackingRepository struct {
	db *sql.DB
}

// NewTrackingRepository wires the repository over an open pool.
func NewTrackingRepository(db *sql.DB) *TrackingRepository {
	return &TrackingRepository{db: db}
}

// ExistsByOrderID reports whether the order already has a LIVE tracking or ANY
// live history row.
//
// History is checked too, and that is not belt-and-braces. A soft-deleted
// tracking leaves its history rows behind; re-creating over them would either
// collide on tracking_history's composite primary key or attach a brand-new
// tracking to somebody else's status trail. Checking both is what makes a retry
// unable to duplicate a shipment.
func (r *TrackingRepository) ExistsByOrderID(ctx context.Context, orderID string) (bool, error) {
	var exists bool
	err := r.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM tracking         WHERE order_id = ? AND deleted_at IS NULL
			UNION ALL
			SELECT 1 FROM tracking_history WHERE order_id = ? AND deleted_at IS NULL
		)`, orderID, orderID).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("mysql: check tracking existence: %w", err)
	}
	return exists, nil
}

// Create writes the tracking and its opening history row in ONE transaction,
// both stamped from the passed `now`.
//
// The id and the tracking number are MINTED HERE, not taken as inputs: they are
// the row's identity, and a caller supplying either could collide two shipments
// on purpose.
//
// A unique-index rejection becomes domain.ErrTrackingAlreadyExists — the SAME
// error the use case's pre-check produces — so a lost race answers 409 and never
// 500.
func (r *TrackingRepository) Create(
	ctx context.Context, in domain.NewTracking, now time.Time,
) (result domain.TrackingWithHistory, err error) {
	trackingID, err := domain.NewTrackingID()
	if err != nil {
		return domain.TrackingWithHistory{}, fmt.Errorf("mysql: mint tracking id: %w", err)
	}
	trackingNumber, err := domain.NewTrackingNumber()
	if err != nil {
		return domain.TrackingWithHistory{}, fmt.Errorf("mysql: mint tracking number: %w", err)
	}

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.TrackingWithHistory{}, fmt.Errorf("mysql: begin: %w", err)
	}
	// Rollback on EVERY path that is not an explicit Commit, including a panic.
	// Without it, a failed second INSERT would leave the first one holding an
	// open transaction until the connection is recycled — and the order id
	// unavailable to the retry that would have succeeded.
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	queries := New(tx)
	actor := string(audit.CreateTracking)
	// The audit actor is a CONSTANT of this write path, not the caller's identity:
	// it records WHAT produced the row. Two of this service's three write paths
	// have no user identity at all to stamp.
	stamp := sql.NullString{String: actor, Valid: true}

	// "" means absent, and absent must be NULL — not the empty string. A row with
	// cognito_sub = '' would be matched by any read scoped to the empty string;
	// NULL matches no caller's sub, so such a row is unreachable rather than
	// mis-attributed.
	cognitoSub := sql.NullString{String: in.CognitoSub, Valid: in.CognitoSub != ""}

	var address json.RawMessage
	if len(in.ShippingAddress) > 0 {
		address = json.RawMessage(in.ShippingAddress)
	}

	if err = queries.CreateTracking(ctx, CreateTrackingParams{
		ID:              trackingID,
		UserID:          in.UserID,
		OrderID:         in.OrderID,
		Status:          string(domain.InitialStatus),
		ShippingAddress: address,
		Datetime:        now,
		CreatedBy:       stamp,
		CreatedAt:       now,
		UpdatedBy:       stamp,
		UpdatedAt:       now,
		CognitoSub:      cognitoSub,
		Tags:            tagtype.Tags(in.Tags),
		TrackingNumber:  trackingNumber,
	}); err != nil {
		if isDuplicateEntry(err) {
			// A racing INSERT lost the unique index. The SAME error the pre-check
			// produces, so the handler answers 409 either way.
			err = fmt.Errorf("%w for order_id %s", domain.ErrTrackingAlreadyExists, in.OrderID)
			return domain.TrackingWithHistory{}, err
		}
		err = fmt.Errorf("mysql: insert tracking: %w", err)
		return domain.TrackingWithHistory{}, err
	}

	if err = queries.CreateTrackingHistory(ctx, CreateTrackingHistoryParams{
		TrackingID: trackingID,
		Status:     string(domain.InitialStatus),
		UserID:     in.UserID,
		OrderID:    in.OrderID,
		// The SAME `now` as the tracking row above. Two time.Now() calls could
		// straddle a second boundary and leave a tracking whose current status is
		// stamped a second apart from the history row announcing it.
		Datetime:   now,
		CreatedBy:  stamp,
		CreatedAt:  now,
		UpdatedBy:  stamp,
		UpdatedAt:  now,
		CognitoSub: cognitoSub,
	}); err != nil {
		if isDuplicateEntry(err) {
			err = fmt.Errorf("%w for order_id %s", domain.ErrTrackingAlreadyExists, in.OrderID)
			return domain.TrackingWithHistory{}, err
		}
		err = fmt.Errorf("mysql: insert tracking history: %w", err)
		return domain.TrackingWithHistory{}, err
	}

	if err = tx.Commit(); err != nil {
		err = fmt.Errorf("mysql: commit: %w", err)
		return domain.TrackingWithHistory{}, err
	}

	// Built from the values just written rather than re-read: a SELECT after the
	// commit would cost a round trip to learn what this function already knows,
	// and could race a concurrent transition into returning a status this call
	// never wrote.
	tracking := domain.Tracking{
		ID:              trackingID,
		UserID:          in.UserID,
		CognitoSub:      in.CognitoSub,
		OrderID:         in.OrderID,
		TrackingNumber:  trackingNumber,
		Status:          domain.InitialStatus,
		ShippingAddress: in.ShippingAddress,
		Tags:            in.Tags,
		Datetime:        now,
		CreatedBy:       actor,
		CreatedAt:       now,
		UpdatedBy:       actor,
		UpdatedAt:       now,
	}
	history := []domain.TrackingHistory{{
		TrackingID: trackingID,
		Status:     domain.InitialStatus,
		UserID:     in.UserID,
		OrderID:    in.OrderID,
		CognitoSub: in.CognitoSub,
		Datetime:   now,
		CreatedBy:  actor,
		CreatedAt:  now,
		UpdatedBy:  actor,
		UpdatedAt:  now,
	}}
	tracking.History = history

	return domain.TrackingWithHistory{Tracking: tracking, History: history}, nil
}

// isDuplicateEntry reports whether err is a unique-index rejection.
func isDuplicateEntry(err error) bool {
	var mysqlErr *mysql.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == duplicateEntryErrno
}
