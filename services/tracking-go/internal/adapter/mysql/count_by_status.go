package mysql

import (
	"context"
	"database/sql"
	"fmt"
)

// MetricsRepository answers the ONE aggregate query the metrics ticker runs. It
// is its own type so the metrics loop cannot reach the ownership-scoped user
// reads, and satisfies cloudwatch.StatusCounter structurally.
type MetricsRepository struct {
	db *sql.DB
}

// NewMetricsRepository wires the repository over an open pool. Give it the
// READER pool: this scans the whole live table forever on a timer, and the
// writer's connections must not be spent on an observation.
func NewMetricsRepository(db *sql.DB) *MetricsRepository {
	return &MetricsRepository{db: db}
}

// countByStatusQuery groups the LIVE trackings by status.
//
// CONTRACT: Keep `deleted_at IS NULL`. A soft-deleted tracking is not an order
// in flight, and counting it makes the gauge disagree with every user-facing
// read. tracking.order_id is UNIQUE, so counting trackings counts orders.
// See [[soft-delete]]
const countByStatusQuery = "SELECT status, COUNT(*) FROM tracking WHERE deleted_at IS NULL GROUP BY status"

// CountByStatus returns live tracking counts keyed by status. An empty table
// yields an empty map and no error, which the ticker turns into zeros so a
// dashboard renders "no orders" rather than "Error Loading Data". Unknown
// statuses pass through as stored and land in "in flight" by default.
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
