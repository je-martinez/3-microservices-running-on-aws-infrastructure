package mysql

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// TrackingReader is the READ side of the two user-scoped REST endpoints, kept
// separate from the write repository so the read path never receives the
// creation and soft-delete methods it must not call.
//
// CONTRACT: Every method here is ownership-scoped and there is no unscoped
// variant. `cognito_sub = ?` goes INSIDE the SQL, never as a filter over loaded
// rows, so a non-owned row never enters the process. An unscoped lookup is a
// different method on a different type — not an optional argument, since Go's
// zero string turns "unscoped" into "scoped to the empty string".
// See [[user-id-vs-cognito-sub-ownership-key]]
type TrackingReader struct {
	db *sql.DB
}

// NewTrackingReader wires the reader over an open pool.
func NewTrackingReader(db *sql.DB) *TrackingReader {
	return &TrackingReader{db: db}
}

// trackingColumns is the SELECT list for the tracking table.
//
// CONTRACT: Do NOT add shipping_address or tags — neither appears on either
// read's response, and a column never fetched cannot be leaked by a later edit
// to the mapping. Backtick `datetime`: it is a MySQL type keyword.
const trackingColumns = "id, user_id, order_id, status, cognito_sub, `datetime`"

// historyColumns mirrors trackingColumns for tracking_history.
const historyColumns = "tracking_id, status, user_id, order_id, cognito_sub, `datetime`"

// historyOrder is the deterministic history ordering, shared by both reads.
//
// CONTRACT: Keep the FIELD() tiebreaker. ORDER BY datetime alone is not
// deterministic — fsp 0 and one `now` per unit of work make ties routine, and on
// a tie MySQL may use the (tracking_id, status) key, which sorts alphabetically:
// DELIVERED before PLACED. domain.SortHistory repeats the rule in Go.
const historyOrder = "ORDER BY `datetime` ASC, " +
	"FIELD(status, 'PLACED', 'PROCESSING', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED') ASC"

// GetByOrderIDScoped returns the caller's tracking for orderID with its ordered
// history.
//
// CONTRACT: Scope by cognito_sub, NEVER by user_id. The gateway injects the JWT
// sub as x-user-id while tracking.user_id holds the internal usr_ id, so a
// user_id predicate answers "not found" for every read including the owner's,
// while looking correct. A missing row and someone else's both return
// ErrTrackingNotFound, so this is no oracle for other people's order ids.
// See [[user-id-vs-cognito-sub-ownership-key]]
func (r *TrackingReader) GetByOrderIDScoped(
	ctx context.Context, orderID, cognitoSub string,
) (domain.TrackingWithHistory, error) {
	var (
		row        trackingRow
		trackingID string
	)
	err := r.db.QueryRowContext(ctx, `
		SELECT `+trackingColumns+`
		FROM tracking
		WHERE order_id = ?
		  AND cognito_sub = ?
		  AND deleted_at IS NULL`,
		orderID, cognitoSub,
	).Scan(&row.id, &row.userID, &row.orderID, &row.status, &row.cognitoSub, &row.occurredAt)

	if errors.Is(err, sql.ErrNoRows) {
		// One answer for "no such tracking" and for "not yours".
		return domain.TrackingWithHistory{}, domain.ErrTrackingNotFound
	}
	if err != nil {
		return domain.TrackingWithHistory{}, fmt.Errorf("mysql: get tracking by order id: %w", err)
	}
	trackingID = row.id

	history, err := r.historyFor(ctx, []string{trackingID})
	if err != nil {
		return domain.TrackingWithHistory{}, err
	}

	return domain.TrackingWithHistory{
		Tracking: row.toDomain(),
		History:  history[trackingID],
	}, nil
}

// ListByOrderIDsScoped returns the caller's trackings among orderIDs with their
// ordered history. Unknown, soft-deleted and non-owned ids are simply absent.
//
// CONTRACT: Two queries total, never one per tracking — history is fetched in
// one statement keyed on the parent ids, since per-parent queries make a 100-id
// request cost 101 round trips.
func (r *TrackingReader) ListByOrderIDsScoped(
	ctx context.Context, orderIDs []string, cognitoSub string,
) ([]domain.TrackingWithHistory, error) {
	// An empty list must never reach the SQL: `IN ()` is a syntax error in
	// MySQL, and the empty result is the correct answer anyway. The use case
	// short-circuits too; this is the second guard, because the adapter is also
	// reachable from a future caller that forgets.
	//
	// Non-nil result, so an empty answer marshals as [] and never as null.
	if len(orderIDs) == 0 {
		return []domain.TrackingWithHistory{}, nil
	}

	// Placeholders are GENERATED, never interpolated values: the ids are
	// caller-supplied, so they travel as bound parameters and cannot be SQL.
	args := make([]any, 0, len(orderIDs)+1)
	for _, id := range orderIDs {
		args = append(args, id)
	}
	args = append(args, cognitoSub)

	//nolint:gosec // the query is assembled from a placeholder count, never from caller data
	query := `
		SELECT ` + trackingColumns + `
		FROM tracking
		WHERE order_id IN (` + placeholders(len(orderIDs)) + `)
		  AND cognito_sub = ?
		  AND deleted_at IS NULL
		ORDER BY created_at DESC`

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("mysql: list trackings by order ids: %w", err)
	}
	defer rows.Close() //nolint:errcheck // the scan error below is the one that matters

	found := make([]trackingRow, 0, len(orderIDs))
	trackingIDs := make([]string, 0, len(orderIDs))
	for rows.Next() {
		var row trackingRow
		if err := rows.Scan(
			&row.id, &row.userID, &row.orderID, &row.status, &row.cognitoSub, &row.occurredAt,
		); err != nil {
			return nil, fmt.Errorf("mysql: scan tracking: %w", err)
		}
		found = append(found, row)
		trackingIDs = append(trackingIDs, row.id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("mysql: iterate trackings: %w", err)
	}

	history, err := r.historyFor(ctx, trackingIDs)
	if err != nil {
		return nil, err
	}

	out := make([]domain.TrackingWithHistory, 0, len(found))
	for _, row := range found {
		out = append(out, domain.TrackingWithHistory{
			Tracking: row.toDomain(),
			History:  history[row.id],
		})
	}
	return out, nil
}

// historyFor loads the live history of every tracking in trackingIDs, in ONE
// query, keyed by tracking id.
//
// Returns an empty map for an empty input for the same `IN ()` reason as above.
// A tracking with no history is absent from the map, and a nil slice read out of
// a map is an empty slice, so the caller needs no special case.
func (r *TrackingReader) historyFor(
	ctx context.Context, trackingIDs []string,
) (map[string][]domain.TrackingHistory, error) {
	out := make(map[string][]domain.TrackingHistory, len(trackingIDs))
	if len(trackingIDs) == 0 {
		return out, nil
	}

	args := make([]any, 0, len(trackingIDs))
	for _, id := range trackingIDs {
		args = append(args, id)
	}

	//nolint:gosec // assembled from a placeholder count, never from caller data
	query := `
		SELECT ` + historyColumns + `
		FROM tracking_history
		WHERE tracking_id IN (` + placeholders(len(trackingIDs)) + `)
		  AND deleted_at IS NULL
		` + historyOrder

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("mysql: list tracking history: %w", err)
	}
	defer rows.Close() //nolint:errcheck // the scan error below is the one that matters

	for rows.Next() {
		var (
			trackingID string
			status     string
			userID     string
			orderID    string
			cognitoSub sql.NullString
			occurredAt time.Time
		)
		if err := rows.Scan(&trackingID, &status, &userID, &orderID, &cognitoSub, &occurredAt); err != nil {
			return nil, fmt.Errorf("mysql: scan tracking history: %w", err)
		}
		out[trackingID] = append(out[trackingID], domain.TrackingHistory{
			TrackingID: trackingID,
			Status:     domain.Status(status),
			UserID:     userID,
			OrderID:    orderID,
			CognitoSub: cognitoSub.String,
			Datetime:   occurredAt,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("mysql: iterate tracking history: %w", err)
	}

	// Re-applied in Go over the rows the database returned. Redundant while the
	// FIELD() clause is present, and deliberately so: it is the assertion that
	// survives someone editing the SQL, and it costs a sort of at most five
	// elements.
	for id := range out {
		domain.SortHistory(out[id])
	}
	return out, nil
}

// placeholders renders "?, ?, ?" for n bound parameters.
//
// The ONLY thing ever concatenated into a query in this file, and it is derived
// from a COUNT — never from caller data — so no id can reach the SQL text.
func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// trackingRow is the scan target for the tracking SELECT.
//
// It carries neither shipping_address nor tags because neither column is
// selected: the read surface physically cannot return what it never fetched.
type trackingRow struct {
	id         string
	userID     string
	orderID    string
	status     string
	cognitoSub sql.NullString
	occurredAt time.Time
}

// toDomain maps the row onto the pure domain type. A NULL cognito_sub becomes
// "", which domain.Tracking documents as absent; such a row is unreachable over
// both scoped reads, since NULL matches no sub and an empty header is a 401.
func (r trackingRow) toDomain() domain.Tracking {
	return domain.Tracking{
		ID:         r.id,
		UserID:     r.userID,
		OrderID:    r.orderID,
		CognitoSub: r.cognitoSub.String,
		Status:     domain.Status(r.status),
		Datetime:   r.occurredAt,
	}
}
