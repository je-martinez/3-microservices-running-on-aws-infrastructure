package mysql

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// ErrEmptySoftDeleteIdentity is the repository's own refusal of an empty
// identity — a second guard, not a duplicate, because this line decides which
// rows die and any caller can reach it. The predicate is an OR, so one empty
// value matches every row with an empty string in that column: someone else's
// trackings. See [[soft-delete]]
var ErrEmptySoftDeleteIdentity = errors.New("soft delete by user requires both identities to be non-empty")

// softDeleteHistoryByUser stamps the CHILDREN of the user's trackings.
//
// CONTRACT: Select children THROUGH the FK, never by their own cognito_sub or
// user_id — a history row whose cognito_sub is NULL under a parent matched by
// user_id is exactly what the parent predicate exists to catch. Children first,
// mirroring the FK, so an interrupted run leaves no live history under a deleted
// tracking. The parent subquery is unfiltered on purpose; the per-statement
// deleted_at IS NULL is what makes the stamps idempotent.
//
// CONTRACT: Keep the `SELECT id FROM (…) AS parents` wrapper — MySQL rejects a
// subquery reading the table an UPDATE targets (error 1093). Never a SQL DELETE:
// the application user holds no DELETE privilege. See [[soft-delete]]
const softDeleteHistoryByUser = `
UPDATE tracking_history
   SET deleted_at = ?, deleted_by = ?
 WHERE tracking_id IN (
         SELECT id FROM (
           SELECT id FROM tracking
            WHERE cognito_sub COLLATE utf8mb4_bin = ?
               OR user_id     COLLATE utf8mb4_bin = ?
         ) AS parents
       )
   AND deleted_at IS NULL`

// softDeleteTrackingByUser stamps the PARENTS; its rowcount is the caller's.
//
// CONTRACT: The COLLATE is a safety control, not tuning. Both columns are
// case-INSENSITIVE while the ids are mixed-case and minted case-sensitively, so
// usr_AbC and usr_abc are two people MySQL cannot tell apart — an erasure keyed
// on one sweeps the other's trackings. Pinned at the predicate to keep the scope
// on the irreversible operation.
//
// CONTRACT: Match EITHER identity. cognito_sub is nullable on rows predating its
// migration, and it is not durable: re-registering mints a new one while the
// usr_ id never changes. See [[user-id-vs-cognito-sub-ownership-key]]
const softDeleteTrackingByUser = `
UPDATE tracking
   SET deleted_at = ?, deleted_by = ?
 WHERE (cognito_sub COLLATE utf8mb4_bin = ? OR user_id COLLATE utf8mb4_bin = ?)
   AND deleted_at IS NULL`

// softDeleteHistoryByTag is the tag equivalent over the same FK subquery.
// tracking_history carries no tags column, so the tag stays single-sourced.
//
// CONTRACT: JSON_QUOTE in SQL — never build the JSON in Go. JSON_CONTAINS needs
// valid JSON as its second argument (a bare bind is "Invalid JSON text"), and
// wrapping here keeps caller text a bound parameter. See [[soft-delete]]
const softDeleteHistoryByTag = `
UPDATE tracking_history
   SET deleted_at = ?, deleted_by = ?
 WHERE tracking_id IN (
         SELECT id FROM (
           SELECT id FROM tracking WHERE JSON_CONTAINS(tags, JSON_QUOTE(?))
         ) AS parents
       )
   AND deleted_at IS NULL`

const softDeleteTrackingByTag = `
UPDATE tracking
   SET deleted_at = ?, deleted_by = ?
 WHERE JSON_CONTAINS(tags, JSON_QUOTE(?))
   AND deleted_at IS NULL`

// The run-scoped pair: the same shape with one more JSON_CONTAINS, so a teardown
// deletes only the rows its OWN run created.
//
// CONTRACT: Use these, not the unscoped sweep, from a parallel E2E teardown. The
// unscoped pair deletes every E2E-tagged row on the machine, so one run's
// teardown lands inside another's live progression, whose next tick reads
// tracking_not_found and ABORTS — the remaining statuses never publish, which
// reads as a broken queue. See [[testing]]
//
// Both tags are BOUND PARAMETERS wrapped by JSON_QUOTE for the same reason the
// single-tag form is — the run id reaches here from a caller-controlled header.
const softDeleteHistoryByTagAndRun = `
UPDATE tracking_history
   SET deleted_at = ?, deleted_by = ?
 WHERE tracking_id IN (
         SELECT id FROM (
           SELECT id FROM tracking
            WHERE JSON_CONTAINS(tags, JSON_QUOTE(?))
              AND JSON_CONTAINS(tags, JSON_QUOTE(?))
         ) AS parents
       )
   AND deleted_at IS NULL`

const softDeleteTrackingByTagAndRun = `
UPDATE tracking
   SET deleted_at = ?, deleted_by = ?
 WHERE JSON_CONTAINS(tags, JSON_QUOTE(?))
   AND JSON_CONTAINS(tags, JSON_QUOTE(?))
   AND deleted_at IS NULL`

// SoftDeleteRepository owns the two mass soft-delete paths: the account-deletion
// cascade and the E2E teardown.
//
// They share ONE mechanism written once — children first, parents second, in a
// single transaction, count from the parent — because writing that twice is how
// the two drift and only one of them keeps the FK invariant.
type SoftDeleteRepository struct {
	db *sql.DB
}

// NewSoftDeleteRepository takes a *sql.DB rather than the DBTX the generated
// queries use, because both operations MUST own their own transaction: the two
// statements are one unit of work, and a caller handing in a bare connection
// could not express that.
func NewSoftDeleteRepository(db *sql.DB) *SoftDeleteRepository {
	return &SoftDeleteRepository{db: db}
}

// SoftDeleteByUser stamps deleted_at/deleted_by on every live tracking of the
// user and their live history, returning the PARENT statement's rowcount.
// History rows are not counted: one per transition would make "how many
// shipments were erased" unanswerable from the response.
func (r *SoftDeleteRepository) SoftDeleteByUser(
	ctx context.Context, cognitoSub, userID string, actor audit.Actor, now time.Time,
) (int64, error) {
	// Refused HERE as well as in the use case, because this is the line that
	// actually decides which rows die. See ErrEmptySoftDeleteIdentity.
	if cognitoSub == "" || userID == "" {
		return 0, ErrEmptySoftDeleteIdentity
	}

	return r.softDelete(ctx,
		statement{sql: softDeleteHistoryByUser, args: []any{now, string(actor), cognitoSub, userID}},
		statement{sql: softDeleteTrackingByUser, args: []any{now, string(actor), cognitoSub, userID}},
	)
}

// SoftDeleteByTag stamps every live tracking carrying tag and its live history,
// returning the PARENT rowcount. Idempotent: a second call returns 0.
//
// WHY: Unscoped by identity — the E2E teardown runs with no user session. The
// scoping lives at creation (x-e2e-source with E2E_TESTING_ENABLED) and at
// registration (no route without that flag).
func (r *SoftDeleteRepository) SoftDeleteByTag(
	ctx context.Context, tag string, actor audit.Actor, now time.Time,
) (int64, error) {
	return r.softDelete(ctx,
		statement{sql: softDeleteHistoryByTag, args: []any{now, string(actor), tag}},
		statement{sql: softDeleteTrackingByTag, args: []any{now, string(actor), tag}},
	)
}

// SoftDeleteByTags soft-deletes rows carrying BOTH tags.
//
// An empty second tag falls back to the single-tag sweep rather than matching
// nothing: the caller that omits a run id (a load test, a manual teardown, an
// internal-only suite run) means "everything", and silently deleting zero rows
// while reporting success is the worse failure of the two.
func (r *SoftDeleteRepository) SoftDeleteByTags(
	ctx context.Context, tag, secondTag string, actor audit.Actor, now time.Time,
) (int64, error) {
	if secondTag == "" {
		return r.SoftDeleteByTag(ctx, tag, actor, now)
	}
	return r.softDelete(ctx,
		statement{sql: softDeleteHistoryByTagAndRun, args: []any{now, string(actor), tag, secondTag}},
		statement{sql: softDeleteTrackingByTagAndRun, args: []any{now, string(actor), tag, secondTag}},
	)
}

type statement struct {
	sql  string
	args []any
}

// softDelete runs the children's statement then the parents' in ONE transaction,
// and returns the PARENT statement's rowcount.
//
// One transaction because the two statements are one unit of work: a crash
// between them, committed separately, would leave a live history row under a
// deleted tracking — an orphaned trail no read can reach through its parent.
func (r *SoftDeleteRepository) softDelete(ctx context.Context, children, parents statement) (int64, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin soft delete: %w", err)
	}
	// Rollback on every path that does not reach Commit. After a successful
	// commit this is a no-op returning ErrTxDone, which is why it is discarded.
	defer func() { _ = tx.Rollback() }()

	// Children FIRST, mirroring the FK direction.
	if _, err := tx.ExecContext(ctx, children.sql, children.args...); err != nil {
		return 0, fmt.Errorf("soft delete history: %w", err)
	}

	result, err := tx.ExecContext(ctx, parents.sql, parents.args...)
	if err != nil {
		return 0, fmt.Errorf("soft delete trackings: %w", err)
	}

	// The count is the PARENT statement's rowcount, read BEFORE the commit
	// because a sql.Result is only guaranteed valid while its transaction lives.
	deleted, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("soft delete rowcount: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit soft delete: %w", err)
	}
	return deleted, nil
}
