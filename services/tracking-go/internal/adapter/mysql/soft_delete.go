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
// identity, declared here beside the method that produces it.
//
// The use case already rejects empties, and this is deliberately a SECOND guard
// rather than a duplicated one: this is the line that actually decides which rows
// die, and it is reachable by any future caller that does not go through the
// HTTP boundary or the use case. The predicate is an OR, so an empty value on
// either side would match every row carrying an empty string in that column —
// someone else's trackings.
var ErrEmptySoftDeleteIdentity = errors.New("soft delete by user requires both identities to be non-empty")

// softDeleteHistoryByUser stamps the CHILDREN of the user's trackings.
//
// Children FIRST, mirroring the FK direction, so an interrupted unit of work can
// never leave a live history row under a deleted tracking.
//
// The parent-id subquery is deliberately NOT filtered on `deleted_at IS NULL`: an
// already-soft-deleted tracking may still have live history under it from a
// partial previous run, and those children should still be swept. The
// per-statement `deleted_at IS NULL` guard below is what keeps the stamps
// idempotent.
//
// The children are selected THROUGH the FK rather than by their own cognito_sub /
// user_id columns. A history row is owned by its tracking, and matching on the
// child's own columns would miss exactly the rows the parent predicate is written
// to catch — a history row whose cognito_sub is NULL under a parent matched by
// user_id.
//
// The derived-table wrapper `SELECT id FROM (…) AS parents` is REQUIRED: MySQL
// refuses a subquery that reads the same table an UPDATE targets (error 1093),
// and materialising it through a derived table is the standard way around that.
// The Python's ORM emits the equivalent.
//
// Never a SQL DELETE. The application database user is granted no DELETE
// privilege, so a hard delete would fail at the server anyway — the rows stay in
// the table and every read excludes them.
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

// softDeleteTrackingByUser stamps the PARENTS. Its rowcount is what the caller
// gets back.
//
// # The COLLATE is a SAFETY control, not a tuning knob
//
// Both columns are utf8mb4_unicode_ci — case-INSENSITIVE — while the ids they
// hold come from a mixed-case alphabet (A-Za-z0-9) minted by Users' Postgres,
// which compares case-SENSITIVELY. Postgres can legitimately issue usr_AbC… and
// usr_abc… as two different people that MySQL cannot tell apart, and an erasure
// keyed on one would sweep the other's trackings. Verified against the live
// database on 2026-08-26: an id with its case inverted matched a real row.
//
// Pinned at the PREDICATE rather than fixed in the schema, which keeps the change
// scoped to the irreversible operation. The user-scoped READS share the same root
// cause and are deliberately left alone: a read returning a neighbour's row is a
// bug, but a delete removing it is not recoverable without hand-written SQL.
//
// # Why the predicate matches EITHER identity
//
// cognito_sub is the ownership key every user-scoped read filters by, but the
// column is NULLABLE on rows created before the cognito_sub migration, and those
// rows still carry user_id. Matching only cognito_sub would silently leave a
// returning user's oldest trackings live and unreachable. And cognito_sub is not
// the durable identity in the first place — a user who deletes and re-registers
// gets a new one while their usr_ id never changes.
const softDeleteTrackingByUser = `
UPDATE tracking
   SET deleted_at = ?, deleted_by = ?
 WHERE (cognito_sub COLLATE utf8mb4_bin = ? OR user_id COLLATE utf8mb4_bin = ?)
   AND deleted_at IS NULL`

// softDeleteHistoryByTag is the tag equivalent, selecting the children through
// the same FK subquery.
//
// tracking_history has no tags column, deliberately, so the tag is single
// sourced: a history row is an E2E fixture exactly when its tracking is, with no
// second copy of the fact to drift.
//
// JSON_QUOTE in SQL, never string-building the JSON in Go: JSON_CONTAINS's second
// argument must be valid JSON, so a bare bind fails with "Invalid JSON text", and
// doing the wrapping here keeps the value a BOUND PARAMETER rather than putting
// caller-supplied text into the statement. Verified on MySQL 8.0.46: matches
// ["E2E Source"] and ["x","E2E Source"], does not match [] or ["other"].
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

// The run-scoped pair. Same shape with ONE more JSON_CONTAINS, so a teardown
// deletes only the rows ITS OWN run created.
//
// Why this exists: the unscoped sweep above deletes every E2E-tagged row on the
// machine. With playwright's workers:10 — and especially with overlapping runs —
// one run's teardown lands inside another's live TestMode progression, whose next
// tick then reads tracking_not_found and ABORTS. Every remaining status goes
// unpublished, so the events never exist, which is why the loss looked like a
// broken queue for as long as it did. Proven with a single-variable harness: 4
// concurrent trackings and no cleanup published 16/16; the same 4 with one
// cleanup at t=+17s published 12/16 with only DELIVERED missing.
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

// SoftDeleteByUser stamps deleted_at/deleted_by on every live tracking belonging
// to the user and on their live history, returning the PARENT statement's
// rowcount.
//
// History rows are not counted: there is one per transition and the caller has no
// use for that number — it would also make "how many shipments were erased"
// unanswerable from the response.
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

// SoftDeleteByTag stamps every live tracking carrying tag, and its live history,
// returning the PARENT statement's rowcount.
//
// Unscoped by any identity, deliberately: the E2E teardown runs globally with no
// user session. The safety scoping would have provided lives at creation (a row
// is tagged only when the request sent x-e2e-source AND E2E_TESTING_ENABLED was
// on) and at registration (the route does not exist unless that flag is on).
//
// Idempotent: a second call stamps nothing and returns 0, which is a success.
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
