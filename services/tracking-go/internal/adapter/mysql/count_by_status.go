package mysql

import (
	"context"
	"database/sql"
	"fmt"
)

// MetricsRepository answers the ONE aggregate query the metrics ticker runs.
//
// Its own type rather than a method on TrackingReader, for the reason every other
// repository here is split: a port is satisfied by an object that can do nothing
// else. Handing the metrics loop the reader would hand it the two ownership-scoped
// user reads as well — methods a background timer has no business being able to
// call, and which take a cognito_sub this caller does not have.
//
// It satisfies cloudwatch.StatusCounter structurally, without importing that
// package and without a shared repository interface.
type MetricsRepository struct {
	db *sql.DB
}

// NewMetricsRepository wires the repository over an open pool.
//
// Give it the READER pool. This query runs on a timer, forever, and scans the
// whole live table: sending it to the writer would spend the write path's
// connections on an observation.
func NewMetricsRepository(db *sql.DB) *MetricsRepository {
	return &MetricsRepository{db: db}
}

// countByStatusQuery groups the LIVE trackings by status.
//
// `deleted_at IS NULL` is the load-bearing clause. A soft-deleted tracking is not
// an order in flight, and counting it would make the gauge disagree with every
// user-facing read — all of which filter exactly the same way. The Python's
// query carries the identical filter.
//
// Counting trackings IS counting orders: tracking.order_id carries a UNIQUE
// constraint, so there is exactly one tracking per order and no double counting.
const countByStatusQuery = "SELECT status, COUNT(*) FROM tracking WHERE deleted_at IS NULL GROUP BY status"

// CountByStatus returns live tracking counts keyed by status.
//
// An EMPTY TABLE yields an empty map and no error: "nothing in flight" is a
// legitimate answer, and the ticker turns it into zeros for every series (which
// is what makes a dashboard render "no orders" instead of "Error Loading Data").
//
// Statuses this code has never heard of are returned as they are stored. The
// ticker's split treats anything that is not the terminal status as in flight, so
// a status added to the progression later lands in "still in flight" by default
// rather than disappearing from both series.
func (r *MetricsRepository) CountByStatus(ctx context.Context) (map[string]int64, error) {
	rows, err := r.db.QueryContext(ctx, countByStatusQuery)
	if err != nil {
		return nil, fmt.Errorf("counting trackings by status: %w", err)
	}
	defer func() { _ = rows.Close() }()

	counts := make(map[string]int64)
	for rows.Next() {
		var status string
		var count int64
		if err := rows.Scan(&status, &count); err != nil {
			return nil, fmt.Errorf("scanning a status count: %w", err)
		}
		counts[status] = count
	}
	// Checked SEPARATELY from the scan errors: rows.Next() returning false is
	// ambiguous between "no more rows" and "the iteration failed", and without
	// this the caller would publish a SHORT count as if it were the whole table —
	// a gauge that silently drops rows is worse than one that fails.
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating status counts: %w", err)
	}

	return counts, nil
}
