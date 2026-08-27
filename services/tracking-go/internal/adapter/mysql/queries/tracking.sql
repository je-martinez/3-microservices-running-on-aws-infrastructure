-- Queries for the tracking and tracking_history tables.
--
-- TWO RULES THAT APPLY TO EVERY QUERY IN THIS FILE:
--
-- 1. `datetime` is BACKTICKED and ALIASED. It is also a MySQL type keyword, so
--    an unbackticked reference is a syntax error reported at an unhelpful
--    location. Every SELECT aliases it to occurred_at so the generated Go field
--    is a legal, readable identifier.
--
-- 2. sqlc.slice() GENERATES INVALID SQL FOR AN EMPTY SLICE. sqlc expands the
--    placeholder once per element, so zero elements produces `IN ()`, which
--    MySQL rejects outright. Every caller of a query using sqlc.slice MUST
--    short-circuit to an empty result WITHOUT querying when the slice is empty.
--    The Python does exactly this. See ListTrackingsByIDs below.
--
-- Soft delete: every read filters `deleted_at IS NULL`. The application never
-- issues DELETE, and the database user has no DELETE grant.

-- name: GetTrackingByOrderID :one
-- UNSCOPED lookup, used by the internal/gRPC path. Deliberately a SEPARATE query
-- from the scoped one below rather than one query with an optional parameter:
-- Go's zero value for string is "", not nil, so an optional-parameter port
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
-- Scoped by cognito_sub, NEVER by user_id. The gateway injects the JWT `sub` as
-- the x-user-id header; user_id holds the internal usr_ id Orders resolved
-- through Users. Comparing a sub against a usr_ id never matches, so scoping by
-- user_id would answer 404 for every read — including the caller's own tracking —
-- while looking perfectly implemented.
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
-- !! THE CALLER MUST SHORT-CIRCUIT ON AN EMPTY ids SLICE !!
-- sqlc expands sqlc.slice('ids') once per element. With zero elements the
-- generated SQL is `IN ()`, which MySQL rejects with a syntax error. Return an
-- empty result WITHOUT calling this query when len(ids) == 0.
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
-- `datetime` and the audit timestamps are all passed in from ONE minted `now`,
-- never from several time.Now() calls: MySQL DATETIME here has fsp 0 and ROUNDS
-- fractional seconds rather than truncating, so two calls a millisecond apart
-- can land on different seconds.
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

-- name: SoftDeleteTrackingsByCognitoSub :execrows
-- Account-deletion cascade. Soft delete only: stamps deleted_at/deleted_by and
-- never issues DELETE.
UPDATE tracking
SET deleted_at = ?,
    deleted_by = ?
WHERE cognito_sub = ?
  AND deleted_at IS NULL;

-- name: ListE2ETrackingIDs :many
-- The e2e-cleanup selector. JSON_CONTAINS is how a MySQL JSON array is queried
-- for membership (verified against MySQL 8.0.46).
--
-- The tag argument must be the EXACT literal "E2E Source" — space, capitals and
-- all. Users' teardown selects on the same string; a near-miss would clean up
-- nothing while looking correct.
SELECT id
FROM tracking
WHERE JSON_CONTAINS(tags, CAST(? AS JSON))
  AND deleted_at IS NULL;

-- name: CreateTrackingHistory :exec
-- One row per transition. The composite PK (tracking_id, status) makes a
-- duplicate transition fail at INSERT — a second enforcement of the forward-only
-- state machine, independent of the application guard.
--
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
-- ORDER BY datetime alone is NOT deterministic: DATETIME has fsp 0 (second
-- resolution) and one unit of work stamps every row it writes from a single
-- `now`, so ties are common. On a tie MySQL is free to return primary-key order,
-- which for (tracking_id, status) is ALPHABETICAL — DELIVERED first. The FIELD()
-- tiebreaker maps each status to its progression position; domain.SortHistory
-- applies the same rule in Go for any path that assembles history in memory.
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

-- name: SoftDeleteTrackingHistoryByCognitoSub :execrows
-- History side of the account-deletion cascade.
UPDATE tracking_history
SET deleted_at = ?,
    deleted_by = ?
WHERE cognito_sub = ?
  AND deleted_at IS NULL;
