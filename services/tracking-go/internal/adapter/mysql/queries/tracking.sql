-- Queries for the tracking and tracking_history tables.
--
-- CONTRACT: Backtick and alias `datetime` in every query — it is a MySQL type
-- keyword, so an unbackticked reference is a syntax error at an unhelpful spot.
--
-- CONTRACT: Every caller of a sqlc.slice query MUST short-circuit on an empty
-- slice. sqlc expands the placeholder once per element, so zero elements renders
-- `IN ()`, which MySQL rejects. Every read filters `deleted_at IS NULL`; the
-- application never issues DELETE. See [[soft-delete]]

-- name: GetTrackingByOrderID :one
-- CONTRACT: UNSCOPED, and a SEPARATE query from the scoped one below rather than
-- one with an optional parameter — Go's zero string is "", so an optional port
-- silently converts "unscoped" into "scoped to the empty string".
SELECT
  id,
  user_id,
  order_id,
  status,
  shipping_address,
  `datetime` AS occurred_at,
  created_by,
  created_at,
  updated_by,
  updated_at,
  deleted_by,
  deleted_at,
  cognito_sub,
  tags,
  tracking_number
FROM tracking
WHERE order_id = ?
  AND deleted_at IS NULL;

-- name: GetTrackingByOrderIDScoped :one
-- OWNERSHIP-SCOPED lookup for the user-facing REST reads.
--
-- CONTRACT: Scope by cognito_sub, NEVER by user_id. x-user-id carries the JWT
-- sub while user_id holds the internal usr_ id, so a user_id predicate 404s
-- every read including the caller's own while looking implemented.
SELECT
  id,
  user_id,
  order_id,
  status,
  shipping_address,
  `datetime` AS occurred_at,
  created_by,
  created_at,
  updated_by,
  updated_at,
  deleted_by,
  deleted_at,
  cognito_sub,
  tags,
  tracking_number
FROM tracking
WHERE order_id = ?
  AND cognito_sub = ?
  AND deleted_at IS NULL;

-- name: ListTrackingsByCognitoSub :many
-- The caller's own trackings. Scoped by cognito_sub for the reason above.
SELECT
  id,
  user_id,
  order_id,
  status,
  shipping_address,
  `datetime` AS occurred_at,
  created_by,
  created_at,
  updated_by,
  updated_at,
  deleted_by,
  deleted_at,
  cognito_sub,
  tags,
  tracking_number
FROM tracking
WHERE cognito_sub = ?
  AND deleted_at IS NULL
ORDER BY created_at DESC;

-- name: ListTrackingsByIDs :many
-- Batch fetch by primary key.
--
-- CONTRACT: The CALLER must short-circuit on an empty ids slice. sqlc expands
-- sqlc.slice once per element, so zero elements renders `IN ()`, which MySQL
-- rejects with a syntax error.
SELECT
  id,
  user_id,
  order_id,
  status,
  shipping_address,
  `datetime` AS occurred_at,
  created_by,
  created_at,
  updated_by,
  updated_at,
  deleted_by,
  deleted_at,
  cognito_sub,
  tags,
  tracking_number
FROM tracking
WHERE id IN (sqlc.slice('ids'))
  AND deleted_at IS NULL;

-- name: CreateTracking :exec
-- The ONLY path that brings a tracking into existence.
--
-- CONTRACT: Pass `datetime` and the audit timestamps from ONE minted `now`,
-- never several time.Now() calls — DATETIME has fsp 0 and ROUNDS rather than
-- truncating, so two calls a millisecond apart land on different seconds.
INSERT INTO tracking (
  id,
  user_id,
  order_id,
  status,
  shipping_address,
  `datetime`,
  created_by,
  created_at,
  updated_by,
  updated_at,
  cognito_sub,
  tags,
  tracking_number
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: UpdateTrackingStatus :execrows
-- Advance a tracking's status. Returns the affected-row count so the caller can
-- distinguish "updated" from "no such live tracking" without a second read.
UPDATE tracking
SET status      = ?,
    `datetime`  = ?,
    updated_by  = ?,
    updated_at  = ?
WHERE order_id = ?
  AND deleted_at IS NULL;

-- CONTRACT: DO NOT USE. soft_delete.go is the only correct erasure path; this
-- is kept only because removing it changes the generated Querier. It matches
-- cognito_sub ALONE, so a NULL-sub row survives erasure while the endpoint
-- answers 200, and it has no COLLATE utf8mb4_bin pin, so its case-insensitive
-- predicate sweeps a DIFFERENT user's row. See [[soft-delete]]
-- name: SoftDeleteTrackingsByCognitoSub :execrows
-- Account-deletion cascade. Soft delete only: stamps deleted_at/deleted_by and
-- never issues DELETE.
UPDATE tracking
SET deleted_at = ?,
    deleted_by = ?
WHERE cognito_sub = ?
  AND deleted_at IS NULL;

-- CONTRACT: DO NOT USE. soft_delete.go uses JSON_CONTAINS(tags, JSON_QUOTE(?));
-- CAST(? AS JSON) is not the same predicate. See [[soft-delete]]
-- name: ListE2ETrackingIDs :many
-- The e2e-cleanup selector; JSON_CONTAINS is MySQL's array membership test.
--
-- CONTRACT: The tag argument is the EXACT literal "E2E Source" — space, capitals
-- and all. A near-miss cleans up nothing while looking correct.
SELECT id
FROM tracking
WHERE JSON_CONTAINS(tags, CAST(? AS JSON))
  AND deleted_at IS NULL;

-- name: CreateTrackingHistory :exec
-- One row per transition. The composite PK (tracking_id, status) makes a
-- duplicate fail at INSERT, a second enforcement of the forward-only machine.
-- No id, no tags, no shipping_address: all three omissions are deliberate.
INSERT INTO tracking_history (
  tracking_id,
  status,
  user_id,
  order_id,
  `datetime`,
  created_by,
  created_at,
  updated_by,
  updated_at,
  cognito_sub
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: ListTrackingHistory :many
-- History for one tracking.
--
-- CONTRACT: Keep the FIELD() tiebreaker. ORDER BY datetime alone is not
-- deterministic — fsp 0 and one `now` per unit of work make ties common, and on
-- a tie MySQL may use the (tracking_id, status) key, which sorts alphabetically
-- and puts DELIVERED first. domain.SortHistory repeats the rule in Go.
SELECT
  tracking_id,
  status,
  user_id,
  order_id,
  `datetime` AS occurred_at,
  created_by,
  created_at,
  updated_by,
  updated_at,
  deleted_by,
  deleted_at,
  cognito_sub
FROM tracking_history
WHERE tracking_id = ?
  AND deleted_at IS NULL
ORDER BY
  `datetime` ASC,
  FIELD(status, 'PLACED', 'PROCESSING', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED') ASC;

-- CONTRACT: DO NOT USE. Beyond the two defects above, this filters history by
-- its OWN cognito_sub rather than the parent's id through the FK, so history
-- under a NULL-sub row is never swept — live children under a deleted parent.
-- See [[soft-delete]]
-- name: SoftDeleteTrackingHistoryByCognitoSub :execrows
-- History side of the account-deletion cascade.
UPDATE tracking_history
SET deleted_at = ?,
    deleted_by = ?
WHERE cognito_sub = ?
  AND deleted_at IS NULL;
